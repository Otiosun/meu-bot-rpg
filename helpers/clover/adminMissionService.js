'use strict';

const crypto = require('crypto');

const MISSION_RANK_GUIDE = Object.freeze({
    E: Object.freeze({ ph: [3, 8], stars: [0, 1], yulls: [500, 900] }),
    D: Object.freeze({ ph: [8, 12], stars: [1, 1], yulls: [900, 1500] }),
    C: Object.freeze({ ph: [12, 20], stars: [1, 2], yulls: [1500, 2500] }),
    B: Object.freeze({ ph: [25, 40], stars: [2, 3], yulls: [2500, 4000] }),
    A: Object.freeze({ ph: [45, 70], stars: [3, 5], yulls: [4000, 6000] }),
    S: Object.freeze({ ph: [80, 120], stars: [5, 8], yulls: [6000, 9000] }),
});

const MISSION_TYPES = new Set([
    'combat',
    'escort',
    'investigation',
    'defense',
    'diplomacy',
    'support',
]);

const MISSION_MODES = new Set(['official', 'auto_narrated']);
const MISSION_STATUSES = new Set(['draft', 'published', 'closed', 'archived']);

class AdminMissionError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminMissionError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function cleanText(value, maximum, { required = false } = {}) {
    const text = String(value ?? '').trim();
    if (required && !text) {
        throw new AdminMissionError('mission_field_required', 'Campo obrigatório ausente.', 400);
    }
    if (text.length > maximum) {
        throw new AdminMissionError('mission_field_too_long', 'Um campo da missão excede o limite.', 400);
    }
    return text || null;
}

function cleanKey(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.:-]{2,119}$/.test(key)) {
        throw new AdminMissionError(
            'invalid_mission_key',
            'Código da missão inválido. Use letras, números, ponto, hífen, sublinhado ou dois-pontos.',
            400
        );
    }
    return key;
}

function boundedInteger(value, label, options = {}) {
    if ((value === null || value === undefined || value === '') && options.nullable) return null;
    const number = Number(value);
    const min = options.min ?? 0;
    const max = options.max ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(number) || number < min || number > max) {
        throw new AdminMissionError('invalid_mission_number', `${label} inválido.`, 400, { label, value });
    }
    return number;
}

function normalizeIsoDate(value, { required = false } = {}) {
    const text = String(value ?? '').trim();
    if (!text) {
        if (required) throw new AdminMissionError('mission_deadline_required', 'Prazo é obrigatório para publicar a missão.', 400);
        return null;
    }
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
        throw new AdminMissionError('invalid_mission_deadline', 'Prazo da missão inválido.', 400);
    }
    return date.toISOString();
}

function normalizeRange(value, label, fallback) {
    const source = value === undefined ? fallback : value;
    if (!Array.isArray(source) || source.length !== 2) {
        throw new AdminMissionError('invalid_mission_reward_range', `${label} precisa de mínimo e máximo.`, 400);
    }
    const min = boundedInteger(source[0], `${label} mínimo`, { min: 0, max: 1000000000 });
    const max = boundedInteger(source[1], `${label} máximo`, { min, max: 1000000000 });
    return [min, max];
}

function normalizeReward(rank, value = {}) {
    const guide = MISSION_RANK_GUIDE[rank];
    const reward = {
        ph: normalizeRange(value.ph, 'PH', guide.ph),
        stars: normalizeRange(value.stars, 'Estrelas', guide.stars),
        yulls: normalizeRange(value.yulls, 'Yulls', guide.yulls),
        extra: cleanText(value.extra, 1000),
        exceptionalAnnouncement: cleanText(value.exceptionalAnnouncement, 1000),
    };
    if (reward.yulls[1] > 7000 && !reward.exceptionalAnnouncement) {
        throw new AdminMissionError(
            'exceptional_mission_reward_requires_announcement',
            'Recompensa acima de 7.000 Yulls exige anúncio/justificativa excepcional.',
            400,
            { yullsMax: reward.yulls[1] }
        );
    }
    return reward;
}

function normalizeMissionDraft(input = {}, options = {}) {
    const rank = String(input.rank || '').trim().toUpperCase();
    if (!MISSION_RANK_GUIDE[rank]) {
        throw new AdminMissionError('invalid_mission_rank', 'Rank da missão deve ser E, D, C, B, A ou S.', 400);
    }
    const missionType = String(input.missionType || input.type || '').trim().toLowerCase();
    if (!MISSION_TYPES.has(missionType)) {
        throw new AdminMissionError(
            'invalid_mission_type',
            'Tipo de missão inválido.',
            400,
            { allowed: [...MISSION_TYPES] }
        );
    }
    const mode = String(input.mode || 'official').trim().toLowerCase();
    if (!MISSION_MODES.has(mode)) {
        throw new AdminMissionError('invalid_mission_mode', 'Modo de missão inválido.', 400);
    }

    const mission = {
        missionKey: cleanKey(input.missionKey),
        title: cleanText(input.title, 180, { required: true }),
        rank,
        mode,
        location: cleanText(input.location, 240, { required: true }),
        missionType,
        risk: cleanText(input.risk, 1200, { required: true }),
        slots: boundedInteger(input.slots, 'Vagas', { min: 1, max: 500, nullable: true }),
        deadlineAt: normalizeIsoDate(input.deadlineAt, { required: Boolean(options.forPublish) }),
        reward: normalizeReward(rank, input.reward || {}),
        specialConditions: cleanText(input.specialConditions, 3000),
        failureConsequence: cleanText(input.failureConsequence, 3000),
        description: cleanText(input.description, 6000, { required: true }),
        countsForSalary: input.countsForSalary !== false,
        metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
            ? JSON.parse(JSON.stringify(input.metadata))
            : {},
    };

    if (options.forPublish) {
        // R23: published contracts must advertise exact, immutable base rewards.
        // Drafts may retain legacy ranges for editing, but cannot be published with them.
        for (const currency of ['ph', 'stars', 'yulls']) {
            const [minimum, maximum] = mission.reward[currency];
            if (minimum !== maximum) {
                throw new AdminMissionError(
                    'mission_fixed_reward_required',
                    'A recompensa-base publicada deve ter valor exato para PH, Estrelas e Yulls.',
                    400,
                    { currency }
                );
            }
        }
        // Extra rewards need a separate, authorized bonus operation; they cannot be promised as base payout.
        if (mission.reward.extra) {
            throw new AdminMissionError(
                'mission_extra_reward_requires_separate_bonus',
                'Bônus adicionais exigem operação separada e não podem integrar o pacote-base publicado.',
                400
            );
        }
        if (!mission.deadlineAt) {
            throw new AdminMissionError('mission_deadline_required', 'Prazo é obrigatório para publicar a missão.', 400);
        }
        if (new Date(mission.deadlineAt).getTime() <= Date.now()) {
            throw new AdminMissionError('mission_deadline_in_past', 'Não é possível publicar missão com prazo vencido.', 409);
        }
    }
    return mission;
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function fingerprint(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

async function ensureMissionSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_missions (
            mission_key TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'closed', 'archived')),
            revision INTEGER NOT NULL DEFAULT 1,
            title TEXT NOT NULL,
            rank TEXT NOT NULL,
            mode TEXT NOT NULL,
            location TEXT NOT NULL,
            mission_type TEXT NOT NULL,
            risk TEXT NOT NULL,
            slots INTEGER DEFAULT NULL,
            deadline_at TEXT DEFAULT NULL,
            reward_json TEXT NOT NULL,
            special_conditions TEXT DEFAULT NULL,
            failure_consequence TEXT DEFAULT NULL,
            description TEXT NOT NULL,
            counts_for_salary INTEGER NOT NULL DEFAULT 1,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_by TEXT DEFAULT NULL,
            updated_by TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            published_at TEXT DEFAULT NULL,
            closed_at TEXT DEFAULT NULL,
            archived_at TEXT DEFAULT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_clover_missions_status_deadline
            ON clover_missions(status, deadline_at);
        CREATE INDEX IF NOT EXISTS idx_clover_missions_rank_status
            ON clover_missions(rank, status);
    `);
}

function parseJson(value, fallback) {
    try {
        const parsed = JSON.parse(value);
        return parsed ?? fallback;
    } catch {
        return fallback;
    }
}

function mapMission(row) {
    if (!row) return null;
    return {
        missionKey: row.mission_key,
        status: row.status,
        revision: Number(row.revision || 0),
        title: row.title,
        rank: row.rank,
        mode: row.mode,
        location: row.location,
        missionType: row.mission_type,
        risk: row.risk,
        slots: row.slots === null ? null : Number(row.slots),
        deadlineAt: row.deadline_at || null,
        reward: parseJson(row.reward_json, {}),
        specialConditions: row.special_conditions || null,
        failureConsequence: row.failure_consequence || null,
        description: row.description,
        countsForSalary: Boolean(row.counts_for_salary),
        metadata: parseJson(row.metadata_json, {}),
        createdBy: row.created_by || null,
        updatedBy: row.updated_by || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        publishedAt: row.published_at || null,
        closedAt: row.closed_at || null,
        archivedAt: row.archived_at || null,
    };
}

async function getMission(db, missionKey) {
    await ensureMissionSchema(db);
    return mapMission(await db.get(
        'SELECT * FROM clover_missions WHERE mission_key = ?',
        [cleanKey(missionKey)]
    ));
}

async function listMissions(db, filters = {}) {
    await ensureMissionSchema(db);
    const clauses = [];
    const params = [];
    if (filters.status && MISSION_STATUSES.has(String(filters.status))) {
        clauses.push('status = ?');
        params.push(String(filters.status));
    }
    if (filters.rank && MISSION_RANK_GUIDE[String(filters.rank).toUpperCase()]) {
        clauses.push('rank = ?');
        params.push(String(filters.rank).toUpperCase());
    }
    const rows = await db.all(
        `SELECT * FROM clover_missions
         ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY
           CASE status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 WHEN 'closed' THEN 2 ELSE 3 END,
           COALESCE(deadline_at, '9999-12-31T23:59:59.999Z') ASC,
           updated_at DESC`,
        params
    );
    return rows.map(mapMission);
}

function missionData(mission) {
    return {
        missionKey: mission.missionKey,
        title: mission.title,
        rank: mission.rank,
        mode: mission.mode,
        location: mission.location,
        missionType: mission.missionType,
        risk: mission.risk,
        slots: mission.slots,
        deadlineAt: mission.deadlineAt,
        reward: mission.reward,
        specialConditions: mission.specialConditions,
        failureConsequence: mission.failureConsequence,
        description: mission.description,
        countsForSalary: mission.countsForSalary,
        metadata: mission.metadata,
    };
}

async function insertMissionInTransaction(db, mission, actorId) {
    const current = await getMission(db, mission.missionKey);
    if (current) {
        throw new AdminMissionError('mission_key_exists', 'Já existe missão com este código.', 409);
    }
    await db.run(
        `INSERT INTO clover_missions
         (mission_key, status, revision, title, rank, mode, location, mission_type, risk, slots,
          deadline_at, reward_json, special_conditions, failure_consequence, description,
          counts_for_salary, metadata_json, created_by, updated_by, created_at, updated_at)
         VALUES (?, 'draft', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
            mission.missionKey,
            mission.title,
            mission.rank,
            mission.mode,
            mission.location,
            mission.missionType,
            mission.risk,
            mission.slots,
            mission.deadlineAt,
            JSON.stringify(mission.reward),
            mission.specialConditions,
            mission.failureConsequence,
            mission.description,
            mission.countsForSalary ? 1 : 0,
            JSON.stringify(mission.metadata || {}),
            actorId || null,
            actorId || null,
        ]
    );
    return getMission(db, mission.missionKey);
}

async function updateMissionInTransaction(db, missionKey, expectedRevision, nextData, actorId) {
    const current = await getMission(db, missionKey);
    if (!current) throw new AdminMissionError('mission_not_found', 'Missão não encontrada.', 404);
    if (current.revision !== Number(expectedRevision)) {
        throw new AdminMissionError(
            'mission_revision_conflict',
            'A missão mudou depois da prévia.',
            409,
            { expectedRevision, currentRevision: current.revision }
        );
    }
    if (current.status !== 'draft') {
        throw new AdminMissionError(
            'mission_not_editable',
            'Somente uma missão em rascunho pode ter conteúdo editado.',
            409,
            { status: current.status }
        );
    }
    const normalized = normalizeMissionDraft(
        { ...nextData, missionKey: current.missionKey },
        { forPublish: false }
    );
    const revision = current.revision + 1;
    const result = await db.run(
        `UPDATE clover_missions SET
            revision = ?, title = ?, rank = ?, mode = ?, location = ?, mission_type = ?,
            risk = ?, slots = ?, deadline_at = ?, reward_json = ?, special_conditions = ?,
            failure_consequence = ?, description = ?, counts_for_salary = ?, metadata_json = ?,
            updated_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE mission_key = ? AND revision = ? AND status = 'draft'`,
        [
            revision,
            normalized.title,
            normalized.rank,
            normalized.mode,
            normalized.location,
            normalized.missionType,
            normalized.risk,
            normalized.slots,
            normalized.deadlineAt,
            JSON.stringify(normalized.reward),
            normalized.specialConditions,
            normalized.failureConsequence,
            normalized.description,
            normalized.countsForSalary ? 1 : 0,
            JSON.stringify(normalized.metadata || {}),
            actorId || null,
            current.missionKey,
            current.revision,
        ]
    );
    if (Number(result?.changes || 0) !== 1) {
        throw new AdminMissionError('mission_revision_conflict', 'A missão mudou durante a aplicação.', 409);
    }
    return getMission(db, current.missionKey);
}

const ALLOWED_TRANSITIONS = Object.freeze({
    draft: new Set(['published', 'archived']),
    published: new Set(['closed']),
    closed: new Set(['archived']),
    archived: new Set(),
});

async function transitionMissionInTransaction(db, missionKey, expectedRevision, nextStatus, actorId) {
    const current = await getMission(db, missionKey);
    if (!current) throw new AdminMissionError('mission_not_found', 'Missão não encontrada.', 404);
    if (current.revision !== Number(expectedRevision)) {
        throw new AdminMissionError('mission_revision_conflict', 'A missão mudou depois da prévia.', 409);
    }
    const status = String(nextStatus || '').trim().toLowerCase();
    if (!MISSION_STATUSES.has(status) || !ALLOWED_TRANSITIONS[current.status]?.has(status)) {
        throw new AdminMissionError(
            'invalid_mission_transition',
            `Transição inválida: ${current.status} → ${status || '?'}.`,
            409
        );
    }
    if (status === 'published') {
        normalizeMissionDraft(missionData(current), { forPublish: true });
    }

    const revision = current.revision + 1;
    const result = await db.run(
        `UPDATE clover_missions
         SET status = ?, revision = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP,
             published_at = CASE WHEN ? = 'published' THEN CURRENT_TIMESTAMP ELSE published_at END,
             closed_at = CASE WHEN ? = 'closed' THEN CURRENT_TIMESTAMP ELSE closed_at END,
             archived_at = CASE WHEN ? = 'archived' THEN CURRENT_TIMESTAMP ELSE archived_at END
         WHERE mission_key = ? AND revision = ? AND status = ?`,
        [
            status,
            revision,
            actorId || null,
            status,
            status,
            status,
            current.missionKey,
            current.revision,
            current.status,
        ]
    );
    if (Number(result?.changes || 0) !== 1) {
        throw new AdminMissionError('mission_revision_conflict', 'A missão mudou durante a aplicação.', 409);
    }
    return getMission(db, current.missionKey);
}

async function restoreMissionSnapshotInTransaction(db, expectedCurrent, snapshot, actorId) {
    const current = await getMission(db, snapshot.missionKey);
    if (!current) throw new AdminMissionError('mission_not_found', 'Missão não encontrada.', 404);
    // An accepted mission freezes its published contract for every participant.
    // Undo may reopen a closed mission, but may not demote or rewrite a
    // published mission to draft after the first player registration.
    const participationTable = await db.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clover_mission_participations'"
    );
    if (participationTable) {
        const count = await db.get(
            'SELECT COUNT(*) AS total FROM clover_mission_participations WHERE mission_key = ?',
            [snapshot.missionKey]
        );
        if (Number(count?.total || 0) > 0 && (
            snapshot.status === 'draft'
            || fingerprint(missionData(current)) !== fingerprint(missionData(snapshot))
        )) {
            throw new AdminMissionError(
                'mission_published_contract_locked',
                'Esta missão já recebeu inscrições; o contrato publicado não pode ser alterado ou despublicado.',
                409
            );
        }
    }
    if (
        current.revision !== expectedCurrent.revision
        || fingerprint(missionData(current)) !== fingerprint(missionData(expectedCurrent))
        || current.status !== expectedCurrent.status
    ) {
        throw new AdminMissionError(
            'mission_changed_since_apply',
            'A missão recebeu outra alteração depois desta operação; undo bloqueado.',
            409
        );
    }

    const revision = current.revision + 1;
    const data = missionData(snapshot);
    await db.run(
        `UPDATE clover_missions SET
            status = ?, revision = ?, title = ?, rank = ?, mode = ?, location = ?, mission_type = ?,
            risk = ?, slots = ?, deadline_at = ?, reward_json = ?, special_conditions = ?,
            failure_consequence = ?, description = ?, counts_for_salary = ?, metadata_json = ?,
            updated_by = ?, updated_at = CURRENT_TIMESTAMP,
            published_at = ?, closed_at = ?, archived_at = ?
         WHERE mission_key = ? AND revision = ?`,
        [
            snapshot.status,
            revision,
            data.title,
            data.rank,
            data.mode,
            data.location,
            data.missionType,
            data.risk,
            data.slots,
            data.deadlineAt,
            JSON.stringify(data.reward),
            data.specialConditions,
            data.failureConsequence,
            data.description,
            data.countsForSalary ? 1 : 0,
            JSON.stringify(data.metadata || {}),
            actorId || null,
            snapshot.publishedAt || null,
            snapshot.closedAt || null,
            snapshot.archivedAt || null,
            snapshot.missionKey,
            current.revision,
        ]
    );
    return getMission(db, snapshot.missionKey);
}

function assertSystemTarget(target) {
    if (target?.kind === 'system' && target?.systemKey === 'clover') return;
    throw new AdminMissionError('invalid_system_target', 'Missões exigem alvo system:clover.', 400);
}

function createMissionExecutors() {
    return {
        'system.mission.create': {
            async preview({ db, action, target }) {
                assertSystemTarget(target);
                const mission = normalizeMissionDraft(action.payload || {}, { forPublish: false });
                if (await getMission(db, mission.missionKey)) {
                    throw new AdminMissionError('mission_key_exists', 'Já existe missão com este código.', 409);
                }
                return {
                    summary: `Criar missão ${mission.title} como rascunho`,
                    before: null,
                    after: { ...mission, status: 'draft', revision: 1 },
                    metadata: { undoSafe: true, rankGuide: MISSION_RANK_GUIDE[mission.rank] },
                };
            },
            async apply({ db, operation, action, target, after }) {
                assertSystemTarget(target);
                const mission = normalizeMissionDraft(action.payload || {}, { forPublish: false });
                if (fingerprint(missionData({ ...mission })) !== fingerprint(missionData(after))) {
                    throw new AdminMissionError('mission_snapshot_mismatch', 'A missão divergiu da prévia.', 409);
                }
                const created = await insertMissionInTransaction(db, mission, operation.actor.id);
                return {
                    summary: `Missão ${created.title} criada como rascunho.`,
                    before: null,
                    after: created,
                };
            },
            async undo({ db, after }) {
                const current = await getMission(db, after.missionKey);
                if (!current) return;
                if (current.status !== 'draft' || current.revision !== 1) {
                    throw new AdminMissionError(
                        'mission_changed_since_apply',
                        'A missão mudou depois da criação; remoção automática bloqueada.',
                        409
                    );
                }
                await db.run(
                    `DELETE FROM clover_missions
                     WHERE mission_key = ? AND status = 'draft' AND revision = 1`,
                    [after.missionKey]
                );
            },
        },

        'system.mission.update': {
            async preview({ db, action, target }) {
                assertSystemTarget(target);
                const missionKey = cleanKey(action.payload?.missionKey);
                const before = await getMission(db, missionKey);
                if (!before) throw new AdminMissionError('mission_not_found', 'Missão não encontrada.', 404);
                if (before.status !== 'draft') {
                    throw new AdminMissionError('mission_not_editable', 'Somente rascunhos podem ser editados.', 409);
                }
                const next = normalizeMissionDraft(
                    {
                        ...missionData(before),
                        ...(action.payload?.changes || {}),
                        missionKey,
                    },
                    { forPublish: false }
                );
                return {
                    summary: `Atualizar rascunho ${before.title}`,
                    before,
                    after: { ...before, ...next, revision: before.revision + 1 },
                    metadata: { undoSafe: true },
                };
            },
            async apply({ db, operation, action, target, before, after }) {
                assertSystemTarget(target);
                const updated = await updateMissionInTransaction(
                    db,
                    before.missionKey,
                    before.revision,
                    missionData(after),
                    operation.actor.id
                );
                return {
                    summary: `Missão ${updated.title} atualizada.`,
                    before,
                    after: updated,
                };
            },
            async undo({ db, operation, before, after }) {
                await restoreMissionSnapshotInTransaction(db, after, before, operation.actor.id);
            },
        },

        'system.mission.status.transition': {
            async preview({ db, action, target }) {
                assertSystemTarget(target);
                const missionKey = cleanKey(action.payload?.missionKey);
                const before = await getMission(db, missionKey);
                if (!before) throw new AdminMissionError('mission_not_found', 'Missão não encontrada.', 404);
                const nextStatus = String(action.payload?.status || '').trim().toLowerCase();
                if (!MISSION_STATUSES.has(nextStatus) || !ALLOWED_TRANSITIONS[before.status]?.has(nextStatus)) {
                    throw new AdminMissionError(
                        'invalid_mission_transition',
                        `Transição inválida: ${before.status} → ${nextStatus || '?'}.`,
                        409
                    );
                }
                if (nextStatus === 'published') {
                    normalizeMissionDraft(missionData(before), { forPublish: true });
                }
                return {
                    summary: `${before.title}: ${before.status} → ${nextStatus}`,
                    before,
                    after: {
                        ...before,
                        status: nextStatus,
                        revision: before.revision + 1,
                    },
                    metadata: { undoSafe: true },
                };
            },
            async apply({ db, operation, action, target, before }) {
                assertSystemTarget(target);
                const updated = await transitionMissionInTransaction(
                    db,
                    before.missionKey,
                    before.revision,
                    action.payload?.status,
                    operation.actor.id
                );
                return {
                    summary: `${updated.title}: status ${updated.status}.`,
                    before,
                    after: updated,
                };
            },
            async undo({ db, operation, before, after }) {
                await restoreMissionSnapshotInTransaction(db, after, before, operation.actor.id);
            },
        },
    };
}

module.exports = {
    ADMIN_MISSION_TYPES: Object.freeze([...MISSION_TYPES]),
    MISSION_RANK_GUIDE,
    MISSION_STATUSES: Object.freeze([...MISSION_STATUSES]),
    AdminMissionError,
    createMissionExecutors,
    ensureMissionSchema,
    fingerprint,
    getMission,
    listMissions,
    mapMission,
    missionData,
    normalizeMissionDraft,
    restoreMissionSnapshotInTransaction,
    transitionMissionInTransaction,
    updateMissionInTransaction,
};
