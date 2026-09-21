'use strict';

const { getRuntimeBoxCatalog } = require('./boxCatalogRuntimeService');
const {
    effectiveRelicChance,
    getBoxPityPolicy,
    qualityPityStatus,
} = require('./boxPityPolicy');
const {
    ensureBoxPitySchema,
    getOrCreatePityStateInTransaction,
    previewPlayerPityState,
} = require('./boxPityStateService');

class AdminBoxPityError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminBoxPityError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}
function valuesMatch(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

async function resolveRuntimeBox(db, payload = {}) {
    const boxKey = String(payload.boxKey || payload.box_key || '').trim().toLowerCase();
    if (!boxKey) throw new AdminBoxPityError('box_not_found', 'Tipo de Caixa inválido.', 404, { boxKey });
    try {
        return await getRuntimeBoxCatalog(db, boxKey);
    } catch (error) {
        if (error?.code === 'unknown_box_catalog_key' || error?.code === 'box_catalog_not_found') {
            throw new AdminBoxPityError('box_not_found', 'Tipo de Caixa inválido.', 404, { boxKey });
        }
        throw error;
    }
}

function normalizeCounter(value, label, maximum = 100000) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
        throw new AdminBoxPityError('invalid_pity_counter', `${label} precisa ser um inteiro entre 0 e ${maximum}.`, 400, { value });
    }
    return parsed;
}

function normalizePityCorrection(payload, box) {
    if (payload.qualityMissStreak === undefined && payload.quality_miss_streak === undefined) {
        throw new AdminBoxPityError('quality_pity_required', 'Informe o contador de pity de qualidade.', 400);
    }
    if (payload.relicMissStreak === undefined && payload.relic_miss_streak === undefined) {
        throw new AdminBoxPityError('relic_pity_required', 'Informe o contador de pity de relíquia.', 400);
    }
    const policy = getBoxPityPolicy(box);
    const qualityMissStreak = normalizeCounter(
        payload.qualityMissStreak ?? payload.quality_miss_streak,
        'Pity de qualidade',
        Math.max(0, Number(policy?.quality?.hardAtOpening || 1) - 1)
    );
    const relicMissStreak = normalizeCounter(
        payload.relicMissStreak ?? payload.relic_miss_streak,
        'Pity de relíquia'
    );
    return { qualityMissStreak, relicMissStreak };
}

async function rawStoredState(db, playerId, box) {
    await ensureBoxPitySchema(db);
    return db.get(
        `SELECT * FROM clover_box_pity_state
         WHERE player_id = ? AND box_key = ? AND catalog_version = ?`,
        [playerId, box.key, box.version]
    );
}

function comparableState(state) {
    if (!state) return null;
    return {
        boxKey: state.boxKey,
        catalogVersion: Number(state.catalogVersion || 0),
        qualityMissStreak: Number(state.qualityMissStreak || 0),
        relicMissStreak: Number(state.relicMissStreak || 0),
        lastRewardKey: state.lastRewardKey || null,
        lastOpeningId: state.lastOpeningId ? Number(state.lastOpeningId) : null,
        initializedFrom: state.initializedFrom || null,
    };
}

async function pitySnapshot(db, playerId, box) {
    const stored = await rawStoredState(db, playerId, box);
    const state = await previewPlayerPityState(db, playerId, box);
    return {
        stored: Boolean(stored),
        ...comparableState(state),
        quality: state.quality,
        relic: state.relic,
    };
}

function previewCorrectedState(before, box, correction) {
    return {
        ...before,
        stored: true,
        qualityMissStreak: correction.qualityMissStreak,
        relicMissStreak: correction.relicMissStreak,
        quality: qualityPityStatus(box, correction.qualityMissStreak),
        relic: effectiveRelicChance(box, correction.relicMissStreak),
    };
}

async function assertPityUnchanged(db, playerId, box, expected, code, message) {
    const current = await pitySnapshot(db, playerId, box);
    if (!valuesMatch(comparableState(current), comparableState(expected)) || Boolean(current.stored) !== Boolean(expected.stored)) {
        throw new AdminBoxPityError(code, message, 409, {
            boxKey: box.key,
            catalogVersion: box.version,
            characterScope: 'player',
        });
    }
    return current;
}

async function setPityCounters(db, playerId, box, counters) {
    await getOrCreatePityStateInTransaction(db, playerId, box);
    await db.run(
        `UPDATE clover_box_pity_state
         SET quality_miss_streak = ?, relic_miss_streak = ?, updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ? AND box_key = ? AND catalog_version = ?`,
        [counters.qualityMissStreak, counters.relicMissStreak, playerId, box.key, box.version]
    );
    return pitySnapshot(db, playerId, box);
}

function createAdminBoxPityExecutors() {
    return {
        'player.box.pity.correct': {
            async preview({ db, action, target }) {
                const box = await resolveRuntimeBox(db, action.payload || {});
                const before = await pitySnapshot(db, target.playerId, box);
                const correction = normalizePityCorrection(action.payload || {}, box);
                const after = previewCorrectedState(before, box, correction);
                return {
                    summary: `${target.characterName || 'Personagem'}: corrigir pity da ${box.name} v${box.version}`,
                    before,
                    after,
                    metadata: {
                        boxKey: box.key,
                        catalogVersion: box.version,
                        catalogFingerprint: box.runtime?.fingerprint || null,
                        scope: 'pity-counters-only',
                    },
                };
            },
            async apply({ db, action, target, before, after }) {
                const box = await resolveRuntimeBox(db, action.payload || {});
                if (Number(box.version) !== Number(before?.catalogVersion)) {
                    throw new AdminBoxPityError(
                        'box_catalog_changed_after_preview',
                        'A versão ativa da Caixa mudou depois da prévia. Gere uma nova prévia.',
                        409,
                        { draftedVersion: before?.catalogVersion, currentVersion: box.version }
                    );
                }
                await assertPityUnchanged(
                    db,
                    target.playerId,
                    box,
                    before,
                    'box_pity_changed_after_preview',
                    'O pity ou o histórico de abertura mudou depois da prévia. Gere uma nova prévia.'
                );
                const applied = await setPityCounters(db, target.playerId, box, {
                    qualityMissStreak: after.qualityMissStreak,
                    relicMissStreak: after.relicMissStreak,
                });
                return {
                    after: applied,
                    summary: `${target.characterName || 'Personagem'}: pity da ${box.name} v${box.version} corrigido.`,
                };
            },
            async undo({ db, action, target, before, after }) {
                const box = await resolveRuntimeBox(db, action.payload || {});
                if (Number(box.version) !== Number(after?.catalogVersion)) {
                    throw new AdminBoxPityError(
                        'box_catalog_changed_after_apply',
                        'A versão ativa da Caixa mudou depois da correção; o undo automático foi bloqueado.',
                        409,
                        { appliedVersion: after?.catalogVersion, currentVersion: box.version }
                    );
                }
                await assertPityUnchanged(
                    db,
                    target.playerId,
                    box,
                    after,
                    'box_pity_changed_after_apply',
                    'O pity ou o histórico de abertura recebeu alteração posterior; o undo automático foi bloqueado.'
                );
                if (!before.stored) {
                    await db.run(
                        `DELETE FROM clover_box_pity_state
                         WHERE player_id = ? AND box_key = ? AND catalog_version = ?`,
                        [target.playerId, box.key, box.version]
                    );
                    return;
                }
                await db.run(
                    `UPDATE clover_box_pity_state
                     SET quality_miss_streak = ?, relic_miss_streak = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE player_id = ? AND box_key = ? AND catalog_version = ?`,
                    [before.qualityMissStreak, before.relicMissStreak, target.playerId, box.key, box.version]
                );
            },
        },
    };
}

module.exports = {
    AdminBoxPityError,
    comparableState,
    createAdminBoxPityExecutors,
    normalizePityCorrection,
    pitySnapshot,
    previewCorrectedState,
    resolveRuntimeBox,
};