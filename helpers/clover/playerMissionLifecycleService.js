'use strict';

// R25: one authoritative mission definition (adminMissionService), one participation
// per player/mission, and one transactional reward receipt per approved participation.
const { getMission, fingerprint, ensureMissionSchema } = require('./adminMissionService');
const { isPublicMission } = require('./playerMissionBoardService');
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
            'INSERT INTO clover_mission_participations (mission_key, player_id, mission_revision, snapshot_json, snapshot_hash) VALUES (?, ?, ?, ?, ?)',
            [missionKey, playerId, snapshot.revision, JSON.stringify(snapshot), hash]
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
async function submitMission(db, { missionKey: key, playerId: id, text: submission }) {
    const missionKey = validKey(key), playerId = validPlayer(id);
    const text = String(submission || '').trim();
    if (text.length < 20 || text.length > 6000) fail('invalid_submission', 'Escreva um relato de 20 a 6.000 caracteres.', 400);
    return withMissionWrite(db, 'submit', async () => {
        const row = await findParticipation(db, missionKey, playerId);
        if (!row) fail('mission_not_joined', 'Inscreva-se nesta missão primeiro.', 404);
        assertSnapshot(row);
        if (row.status === 'submitted' && row.submission_text === text)
            return { duplicate: true, participation: publicParticipation(row) };
        if (!['in_progress','changes_requested'].includes(row.status))
            fail('mission_wrong_status', 'Inicie a missão antes de entregar; entregas já julgadas não podem ser alteradas.');
        await db.run(
            "UPDATE clover_mission_participations SET status='submitted', submission_text=?, submission_revision=submission_revision+1, submitted_at=CURRENT_TIMESTAMP, review_reason=NULL, reviewed_by=NULL, reviewed_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE mission_key=? AND player_id=?",
            [text, missionKey, playerId]
        );
        return { duplicate: false, participation: publicParticipation(await findParticipation(db, missionKey, playerId)) };
    });
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
async function reviewMission(db, { missionKey: key, playerId: id, actorId: reviewer, decision, reason = '' }, deps = {}) {
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
            const next = { approve: 'approved', return: 'changes_requested', reject: 'rejected' }[outcome];
            let receipt = null;
            if (outcome === 'approve') {
                const effects = await (deps.creditReward || creditDefaultReward)(db,
                    { missionKey, playerId, actorId, reward: snapshot.reward });
                await db.run(
                    'INSERT INTO clover_mission_payout_receipts (mission_key, player_id, snapshot_hash, reward_json, ph_ledger_id, yulls_ledger_id, stars_transaction_id, reviewed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [missionKey, playerId, current.snapshot_hash, JSON.stringify(snapshot.reward),
                        effects.phLedgerId || null, effects.yullsLedgerId || null, effects.starsTransactionId || null, actorId]
                );
                receipt = { reward: snapshot.reward };
            }
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
    getMyMission, joinMission, startMission, submitMission, listPendingReviews, reviewMission,
};
