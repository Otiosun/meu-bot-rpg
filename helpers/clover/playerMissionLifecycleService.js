'use strict';

// R25: one authoritative mission definition (adminMissionService), one participation
// per player/mission, and one transactional reward receipt per approved participation.
const { randomBytes } = require('node:crypto');
const { getMission, fingerprint, ensureMissionSchema } = require('./adminMissionService');
const { isPublicMission } = require('./playerMissionBoardService');
const { findMissionSceneClaim, findLegacySceneEvaluation } = require('./missionSceneClaims');
const { runEconomyMutationExclusive } = require('./economyMutationQueue');
const { addPhInTransaction, recalculatePh } = require('./phService');
const { addYullsInTransaction, ensureYullsState } = require('./yullsService');
const { ensurePlayerStarRewardSchema, grantPlayerStarsInTransaction } = require('./playerStarRewardService');

class MissionParticipationError extends Error {
    constructor(code, message, status = 409) {
        super(message);
        this.name = 'MissionParticipationError';
        this.code = code;
        this.status = status;
    }
}
function fail(code, message, status) {
    throw new MissionParticipationError(code, message, status);
}
function validKey(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.:-]{2,119}$/.test(key)) fail('mission_not_found', 'Missão não disponível.', 404);
    return key;
}
function validPlayer(value) {
    const id = String(value || '').trim();
    if (!id || id.length > 255) fail('invalid_player', 'Identidade de jogador inválida.', 400);
    return id;
}
function exactReward(value) {
    const result = {};
    for (const field of ['ph', 'yulls', 'stars']) {
        const range = value?.[field];
        if (!Array.isArray(range) || range.length !== 2 ||
            !Number.isSafeInteger(range[0]) || range[0] < 0 || range[0] !== range[1]) {
            fail('mission_reward_not_fixed', 'Esta missão ainda não possui recompensa-base exata. Solicite ajuste à administração.');
        }
        result[field] = range[0];
    }
    // Legacy free-text "extra" is not an item-grant contract. Never silently promise it.
    if (value.extra) {
        fail('mission_extra_not_automated', 'Esta missão inclui extras sem pagamento automático configurado.');
    }
    return result;
}
function snapshotMission(mission) {
    const reward = exactReward(mission.reward);
    const snapshot = {
        missionKey: mission.missionKey,
        revision: mission.revision,
        title: mission.title,
        rank: mission.rank,
        mode: mission.mode,
        location: mission.location,
        missionType: mission.missionType,
        risk: mission.risk,
        slots: mission.slots,
        countsForSalary: mission.countsForSalary,
        description: mission.description,
        specialConditions: mission.specialConditions,
        failureConsequence: mission.failureConsequence,
        deadlineAt: mission.deadlineAt,
        reward,
    };
    return { snapshot, hash: fingerprint(snapshot) };
}
function assertSnapshot(participation) {
    let snapshot;
    try { snapshot = JSON.parse(participation.snapshot_json); } catch {}
    if (!snapshot || fingerprint(snapshot) !== participation.snapshot_hash ||
        snapshot.missionKey !== participation.mission_key ||
        snapshot.revision !== Number(participation.mission_revision)) {
        fail('mission_snapshot_corrupt', 'O registro da missão falhou na verificação de integridade.');
    }
    exactReward({
        ph: [snapshot.reward?.ph, snapshot.reward?.ph],
        yulls: [snapshot.reward?.yulls, snapshot.reward?.yulls],
        stars: [snapshot.reward?.stars, snapshot.reward?.stars],
    });
    return snapshot;
}
async function ensureMissionParticipationSchema(db) {
    await ensureMissionSchema(db);
    await db.exec([
        'CREATE TABLE IF NOT EXISTS clover_mission_participations (',
        '  mission_key TEXT NOT NULL, player_id TEXT NOT NULL, mission_revision INTEGER NOT NULL,',
        '  snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL,',
        "  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','in_progress','submitted','changes_requested','approved','rejected')),",
        '  submission_text TEXT, submission_revision INTEGER NOT NULL DEFAULT 0,',
        '  submitted_at TEXT, review_reason TEXT, reviewed_by TEXT, reviewed_at TEXT,',
        '  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
        '  PRIMARY KEY(mission_key, player_id),',
        '  FOREIGN KEY(mission_key) REFERENCES clover_missions(mission_key)',
        ');',
        'CREATE INDEX IF NOT EXISTS idx_clover_mission_participations_status ON clover_mission_participations(status, submitted_at);',
        'CREATE TABLE IF NOT EXISTS clover_mission_scene_claims (',
        '  scene_key TEXT PRIMARY KEY, mission_key TEXT NOT NULL, player_id TEXT NOT NULL,',
        '  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
        '  FOREIGN KEY(mission_key, player_id) REFERENCES clover_mission_participations(mission_key,player_id)',
        ');',
        'CREATE INDEX IF NOT EXISTS idx_clover_mission_scene_claims_participation ON clover_mission_scene_claims(mission_key,player_id);',
        'CREATE TABLE IF NOT EXISTS clover_mission_submission_history (',
        '  mission_key TEXT NOT NULL, player_id TEXT NOT NULL, submission_revision INTEGER NOT NULL,',
        '  submission_text TEXT NOT NULL, submitted_at TEXT NOT NULL,',
        '  PRIMARY KEY(mission_key, player_id, submission_revision),',
        '  FOREIGN KEY(mission_key, player_id) REFERENCES clover_mission_participations(mission_key,player_id)',
        ');',
        'CREATE TABLE IF NOT EXISTS clover_mission_review_refs (',
        '  review_code TEXT PRIMARY KEY, mission_key TEXT NOT NULL, player_id TEXT NOT NULL, submission_revision INTEGER NOT NULL,',
        '  UNIQUE(mission_key,player_id,submission_revision),',
        '  FOREIGN KEY(mission_key,player_id,submission_revision) REFERENCES clover_mission_submission_history(mission_key,player_id,submission_revision)',
        ');',
        'CREATE TABLE IF NOT EXISTS clover_mission_review_history (',
        '  mission_key TEXT NOT NULL, player_id TEXT NOT NULL, submission_revision INTEGER NOT NULL,',
        "  decision TEXT NOT NULL CHECK(decision IN ('approve','return','reject')), reason TEXT, actor_id TEXT NOT NULL,",
        '  reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
        '  PRIMARY KEY(mission_key, player_id, submission_revision),',
        '  FOREIGN KEY(mission_key, player_id, submission_revision) REFERENCES clover_mission_submission_history(mission_key,player_id,submission_revision)',
        ');',
        'CREATE TABLE IF NOT EXISTS clover_mission_payout_receipts (',
        '  mission_key TEXT NOT NULL, player_id TEXT NOT NULL, snapshot_hash TEXT NOT NULL,',
        '  reward_json TEXT NOT NULL, ph_ledger_id INTEGER, yulls_ledger_id INTEGER,',
        '  stars_transaction_id INTEGER, reviewed_by TEXT NOT NULL,',
        '  paid_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
        '  PRIMARY KEY(mission_key, player_id),',
        '  FOREIGN KEY(mission_key, player_id) REFERENCES clover_mission_participations(mission_key,player_id)',
        ');',
    ].join('\n'));
}
async function withMissionWrite(db, label, action) {
    return runEconomyMutationExclusive(async () => {
        await ensureMissionParticipationSchema(db);
        await db.exec('BEGIN IMMEDIATE');
        try {
            const result = await action();
            await db.exec('COMMIT');
            return result;
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => null);
            throw error;
        }
    }, { operation: 'mission:' + label });
}
async function findParticipation(db, missionKey, playerId) {
    return db.get('SELECT * FROM clover_mission_participations WHERE mission_key = ? AND player_id = ?',
        [missionKey, playerId]);
}
function publicParticipation(row) {
    if (!row) return null;
    const snapshot = assertSnapshot(row);
    return {
        missionKey: row.mission_key,
        playerId: row.player_id,
        status: row.status,
        missionRevision: row.mission_revision,
        title: snapshot.title,
        deadlineAt: snapshot.deadlineAt,
        mode: snapshot.mode,
        reward: snapshot.reward,
        submissionRevision: row.submission_revision,
        submissionText: row.submission_text || null,
        submittedAt: row.submitted_at || null,
        reviewReason: row.review_reason || null,
        reviewedAt: row.reviewed_at || null,
        createdAt: row.created_at,
    };
}
async function getMyMission(db, missionKeyInput, playerIdInput) {
    const missionKey = validKey(missionKeyInput);
    const playerId = validPlayer(playerIdInput);
    await ensureMissionParticipationSchema(db);
    return publicParticipation(await findParticipation(db, missionKey, playerId));
}
async function listMyMissions(db, playerIdInput, { page = 1, limit = 6 } = {}) {
    const playerId = validPlayer(playerIdInput);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) fail('invalid_mission_page', 'Página inválida.', 400);
    const size = Math.min(20, Math.max(1, Number.isSafeInteger(limit) ? limit : 6));
    await ensureMissionParticipationSchema(db);
    const count = await db.get('SELECT COUNT(*) AS total FROM clover_mission_participations WHERE player_id=?', [playerId]);
    const total = Number(count.total);
    const rows = await db.all(
        "SELECT * FROM clover_mission_participations WHERE player_id=? ORDER BY CASE status WHEN 'changes_requested' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'registered' THEN 2 WHEN 'submitted' THEN 3 ELSE 4 END, updated_at DESC, mission_key ASC LIMIT ? OFFSET ?",
        [playerId, size, (page - 1) * size]
    );
    return { total, page, pages: Math.max(1, Math.ceil(total / size)), missions: rows.map(publicParticipation) };
}
async function joinMission(db, { missionKey: key, playerId: id, now = new Date() }) {
    const missionKey = validKey(key), playerId = validPlayer(id);
    return withMissionWrite(db, 'join', async () => {
        const existing = await findParticipation(db, missionKey, playerId);
        if (existing) return { duplicate: true, participation: publicParticipation(existing) };
        const mission = await getMission(db, missionKey);
        if (!isPublicMission(mission, now)) fail('mission_not_found', 'Missão não disponível.', 404);
        const player = await db.get('SELECT id FROM jogadores WHERE id = ?', [playerId]);
        if (!player) fail('player_not_found', 'Jogador não encontrado.', 404);
        const { snapshot, hash } = snapshotMission(mission);
        if (mission.slots !== null) {
            const row = await db.get(
                'SELECT COUNT(*) AS total FROM clover_mission_participations WHERE mission_key = ? AND status != ?',
                [missionKey, 'rejected']
            );
            if (Number(row.total) >= mission.slots) fail('mission_full', 'Todas as vagas desta missão foram preenchidas.');
        }
        if (mission.mode === 'auto_narrated') {
            const start = new Date(now.getTime() - 7 * 86400000).toISOString();
            const row = await db.get(
                "SELECT COUNT(*) AS total FROM clover_mission_participations WHERE player_id = ? AND json_extract(snapshot_json, '$.mode') = 'auto_narrated' AND datetime(created_at) >= datetime(?)",
                [playerId, start]
            );
            if (Number(row.total) >= 2) fail('mission_weekly_limit', 'Limite de duas inscrições autonarradas em sete dias atingido.');
        }
        await db.run(
            'INSERT INTO clover_mission_participations (mission_key, player_id, mission_revision, snapshot_json, snapshot_hash, status) VALUES (?, ?, ?, ?, ?, ?)',
            [missionKey, playerId, snapshot.revision, JSON.stringify(snapshot), hash, mission.mode === 'auto_narrated' ? 'in_progress' : 'registered']
        );
        return { duplicate: false, participation: publicParticipation(await findParticipation(db, missionKey, playerId)) };
    });
}
async function startMission(db, { missionKey: key, playerId: id }) {
    const missionKey = validKey(key), playerId = validPlayer(id);
    return withMissionWrite(db, 'start', async () => {
        const row = await findParticipation(db, missionKey, playerId);
        if (!row) fail('mission_not_joined', 'Inscreva-se nesta missão primeiro.', 404);
        assertSnapshot(row);
        if (row.status === 'in_progress') return { duplicate: true, participation: publicParticipation(row) };
        if (row.status !== 'registered') fail('mission_wrong_status', 'Esta participação não pode ser iniciada novamente.');
        await db.run("UPDATE clover_mission_participations SET status='in_progress', updated_at=CURRENT_TIMESTAMP WHERE mission_key=? AND player_id=?",
            [missionKey, playerId]);
        return { duplicate: false, participation: publicParticipation(await findParticipation(db, missionKey, playerId)) };
    });
}
async function submitMission(db, { missionKey: key, playerId: id, text: submission, sourceSceneKey = null }) {
    const missionKey = validKey(key), playerId = validPlayer(id);
    const sceneKey = sourceSceneKey == null ? null : String(sourceSceneKey).trim();
    if (sceneKey !== null && (!sceneKey || sceneKey.length > 1024 || !/^[^\s]+$/.test(sceneKey))) fail('invalid_mission_scene', 'Referência de atuação inválida.', 400);
    const text = String(submission || '').trim();
    if (text.length < 20 || text.length > 6000) fail('invalid_submission', 'Escreva um relato de 20 a 6.000 caracteres.', 400);
    return withMissionWrite(db, 'submit', async () => {
        const row = await findParticipation(db, missionKey, playerId);
        if (!row) fail('mission_not_joined', 'Inscreva-se nesta missão primeiro.', 404);
        assertSnapshot(row);
        const duplicate = row.status === 'submitted' && row.submission_text === text;
        if (!duplicate && !['in_progress','changes_requested'].includes(row.status))
            fail('mission_wrong_status', 'Inicie a missão antes de entregar; entregas já julgadas não podem ser alteradas.');
        if (sceneKey) {
            if (await findLegacySceneEvaluation(db, sceneKey))
                fail('mission_scene_already_evaluated', 'Esta atuação já recebeu uma avaliação. Não pode receber a mesma recompensa por outra via.');
            const claim = await findMissionSceneClaim(db, sceneKey);
            if (claim && (claim.mission_key !== missionKey || claim.player_id !== playerId))
                fail('mission_scene_already_claimed', 'Esta atuação já está vinculada a outra participação.');
            if (!claim) await db.run(
                'INSERT INTO clover_mission_scene_claims(scene_key,mission_key,player_id) VALUES (?,?,?)',
                [sceneKey,missionKey,playerId]
            );
        }
        if (duplicate) return { duplicate: true, participation: publicParticipation(row) };
        await db.run(
            "UPDATE clover_mission_participations SET status='submitted', submission_text=?, submission_revision=submission_revision+1, submitted_at=CURRENT_TIMESTAMP, review_reason=NULL, reviewed_by=NULL, reviewed_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE mission_key=? AND player_id=?",
            [text, missionKey, playerId]
        );
        const current = await findParticipation(db, missionKey, playerId);
        await db.run(
            'INSERT INTO clover_mission_submission_history (mission_key, player_id, submission_revision, submission_text, submitted_at) VALUES (?,?,?,?,?)',
            [missionKey, playerId, current.submission_revision, current.submission_text, current.submitted_at]
        );
        const reviewCode = 'MR-' + randomBytes(6).toString('hex').toUpperCase();
        await db.run('INSERT INTO clover_mission_review_refs(review_code,mission_key,player_id,submission_revision) VALUES (?,?,?,?)',
            [reviewCode,missionKey,playerId,current.submission_revision]);
        return { duplicate: false, participation: publicParticipation(current) };
    });
}
async function getMissionReviewDossier(db, key, id, { staff = false } = {}) {
    const missionKey = validKey(key), playerId = validPlayer(id);
    await ensureMissionParticipationSchema(db);
    const row = await findParticipation(db, missionKey, playerId);
    if (!row) return null;
    const participation = publicParticipation(row);
    const contract = assertSnapshot(row);
    const submissions = await db.all(
        'SELECT submission_revision AS revision, submission_text AS text, submitted_at AS submittedAt FROM clover_mission_submission_history WHERE mission_key=? AND player_id=? ORDER BY submission_revision',
        [missionKey, playerId]
    );
    const reviews = await db.all(
        'SELECT submission_revision AS revision, decision, reason, reviewed_at AS reviewedAt' + (staff ? ', actor_id AS actorId' : '') +
        ' FROM clover_mission_review_history WHERE mission_key=? AND player_id=? ORDER BY submission_revision',
        [missionKey, playerId]
    );
    return { participation, contract, submissions, reviews };
}
async function listPendingReviews(db, { limit = 30 } = {}) {
    await ensureMissionParticipationSchema(db);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
    const rows = await db.all(
        "SELECT * FROM clover_mission_participations WHERE status='submitted' ORDER BY submitted_at ASC LIMIT ?",
        [safeLimit]
    );
    return rows.map(publicParticipation);
}
async function prepareDefaultPayout(db, playerId, reward) {
    if (reward.ph > 0) await recalculatePh(db, playerId);
    if (reward.yulls > 0) await ensureYullsState(db, playerId);
    if (reward.stars > 0) await ensurePlayerStarRewardSchema(db);
}
async function creditDefaultReward(db, { missionKey, playerId, actorId, reward }) {
    const key = 'mission:' + missionKey + ':' + playerId;
    const reason = 'Missão aprovada: ' + missionKey;
    const ph = reward.ph > 0
        ? await addPhInTransaction(db, playerId, reward.ph, 'clover_mission', reason, actorId, { missionKey }, key) : null;
    const yulls = reward.yulls > 0
        ? await addYullsInTransaction(db, playerId, reward.yulls, 'clover_mission', reason, actorId,
            { relatedId: key, idempotencyKey: key + ':yulls' }) : null;
    const stars = reward.stars > 0
        ? await grantPlayerStarsInTransaction(db, {
            transactionKey: key + ':stars', playerId, amount: reward.stars,
            source: 'clover_mission', reason, relatedId: key, createdBy: actorId,
        }) : null;
    return {
        phLedgerId: ph?.ledgerId || null,
        yullsLedgerId: yulls?.ledgerId || null,
        starsTransactionId: stars?.transactionId || null,
    };
}
// Reuse the established activity writer. A contract approval is not a legacy
// quick-evaluation row: do not invent a numeric evaluation ID, a scene date, or
// trigger the return bonus/recruitment/salary policies implicitly.
async function recordDefaultMissionActivity(db, { missionKey, playerId, submissionRevision, submittedAt, mode }) {
    const { recordEvaluationActivity, parseSqliteDate } = require('./antiGhostService');
    if (!parseSqliteDate(submittedAt)) fail('mission_submission_date_invalid','A data da entrega é inválida. Solicite reconciliação.');
    await recordEvaluationActivity({
        db, playerId, evaluationId: null,
        modalityKey: mode === 'auto_narrated' ? 'missao_auto_narrada' : 'missao',
        sceneSentAt: submittedAt,
        metadata: {
            source: 'clover_mission',
            mission_key: missionKey,
            submission_revision: submissionRevision,
            activity_date_source: 'mission_submission',
        },
    });
}
async function reviewMission(db, { missionKey: key, playerId: id, actorId: reviewer, decision, reason = '', expectedSubmissionRevision = null }, deps = {}) {
    const missionKey = validKey(key), playerId = validPlayer(id), actorId = validPlayer(reviewer);
    if (actorId === playerId) fail('mission_self_review_forbidden', 'Um revisor não pode avaliar a própria missão.', 403);
    const outcome = String(decision || '').trim().toLowerCase();
    if (!['approve', 'return', 'reject'].includes(outcome)) fail('invalid_review', 'Decisão inválida.', 400);
    const note = String(reason || '').trim();
    if (note.length > 2000 || (outcome !== 'approve' && note.length < 5))
        fail('invalid_review_reason', 'A devolução ou reprovação exige justificativa de 5 a 2.000 caracteres.', 400);
    return runEconomyMutationExclusive(async () => {
        await ensureMissionParticipationSchema(db);
        const before = await findParticipation(db, missionKey, playerId);
        if (!before) fail('mission_not_joined', 'Participação inexistente.', 404);
        const snapshot = assertSnapshot(before);
        if (expectedSubmissionRevision !== null && (!Number.isSafeInteger(expectedSubmissionRevision)
            || expectedSubmissionRevision < 1 || expectedSubmissionRevision !== Number(before.submission_revision))) {
            fail('mission_review_conflict', 'A entrega mudou. Consulte a versão atual antes de avaliar.');
        }
        if (before.status === 'approved' && outcome === 'approve') {
            const receipt = await db.get('SELECT * FROM clover_mission_payout_receipts WHERE mission_key=? AND player_id=?',
                [missionKey, playerId]);
            if (!receipt) fail('mission_receipt_missing', 'Aprovação sem recibo; requer reconciliação.');
            return { duplicate: true, participation: publicParticipation(before), receipt: {
                reward: JSON.parse(receipt.reward_json), paidAt: receipt.paid_at,
            } };
        }
        if (before.status !== 'submitted') fail('mission_wrong_status', 'Apenas entregas pendentes podem ser avaliadas.');
        if (outcome === 'approve') {
            await (deps.preparePayout || prepareDefaultPayout)(db, playerId, snapshot.reward);
        }
        await db.exec('BEGIN IMMEDIATE');
        try {
            const current = await findParticipation(db, missionKey, playerId);
            if (current.status !== 'submitted' || current.submission_revision !== before.submission_revision ||
                current.snapshot_hash !== before.snapshot_hash) {
                fail('mission_review_conflict', 'A entrega mudou durante a avaliação.');
            }
            // The current submission must have a durable version before a review is recorded.
            // Earlier development snapshots are not fabricated into a full history.
            const submission = await db.get(
                'SELECT submission_text FROM clover_mission_submission_history WHERE mission_key=? AND player_id=? AND submission_revision=?',
                [missionKey, playerId, current.submission_revision]
            );
            if (!submission || submission.submission_text !== current.submission_text) {
                fail('mission_submission_history_missing', 'A entrega não possui registro íntegro. Solicite revisão administrativa.');
            }
            const next = { approve: 'approved', return: 'changes_requested', reject: 'rejected' }[outcome];
            let receipt = null;
            if (outcome === 'approve') {
                const claims = await db.all('SELECT scene_key FROM clover_mission_scene_claims WHERE mission_key=? AND player_id=?', [missionKey,playerId]);
                for (const claim of claims) {
                    if (await findLegacySceneEvaluation(db, claim.scene_key))
                        fail('mission_scene_already_evaluated', 'Uma atuação deste contrato já recebeu avaliação tradicional. Encaminhe à administração.');
                }
                const effects = await (deps.creditReward || creditDefaultReward)(db,
                    { missionKey, playerId, actorId, reward: snapshot.reward });
                await db.run(
                    'INSERT INTO clover_mission_payout_receipts (mission_key, player_id, snapshot_hash, reward_json, ph_ledger_id, yulls_ledger_id, stars_transaction_id, reviewed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [missionKey, playerId, current.snapshot_hash, JSON.stringify(snapshot.reward),
                        effects.phLedgerId || null, effects.yullsLedgerId || null, effects.starsTransactionId || null, actorId]
                );
                await (deps.recordActivity || recordDefaultMissionActivity)(db, {
                    missionKey, playerId, submissionRevision: current.submission_revision,
                    submittedAt: current.submitted_at, mode: snapshot.mode,
                });
                const { recordMissionServiceInTransaction } = require('./adminService');
                const service = await (deps.recordService || recordMissionServiceInTransaction)(db, {
                    missionKey,playerId,evaluatorId:actorId,mode:snapshot.mode,countsForSalary:snapshot.countsForSalary,
                });
                receipt = { reward: snapshot.reward, servicePoints: service?.skipped ? 0 : Number(service?.points || 0) };
            }
            await db.run(
                'INSERT INTO clover_mission_review_history (mission_key, player_id, submission_revision, decision, reason, actor_id) VALUES (?,?,?,?,?,?)',
                [missionKey, playerId, current.submission_revision, outcome, note || null, actorId]
            );
            await db.run(
                'UPDATE clover_mission_participations SET status=?, review_reason=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE mission_key=? AND player_id=?',
                [next, note || null, actorId, missionKey, playerId]
            );
            await db.exec('COMMIT');
            return { duplicate: false, participation: publicParticipation(await findParticipation(db, missionKey, playerId)), receipt };
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => null);
            throw error;
        }
    }, { operation: 'mission:review' });
}
module.exports = {
    MissionParticipationError, ensureMissionParticipationSchema, exactReward,
    getMyMission, listMyMissions, joinMission, startMission, submitMission, getMissionReviewDossier, listPendingReviews, reviewMission,
};
