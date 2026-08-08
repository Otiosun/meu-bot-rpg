'use strict';

const { RELIC_POOL } = require('./seasonalEventCatalog');
const {
    BoxCatalogVersionError,
    createDraftBoxCatalogVersion,
    deleteUnusedDraftBoxCatalogVersion,
    fingerprint,
    getActiveBoxCatalogVersion,
    listBoxCatalogVersions,
    validateBoxCatalogDefinition,
    validateBoxPityPolicy,
} = require('./boxCatalogVersionService');

class AdminBoxCatalogError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminBoxCatalogError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function text(value, maximum = 2000) {
    const result = String(value || '').trim();
    return result ? result.slice(0, maximum) : '';
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}
function same(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function normalizedRelicPool(catalog) {
    const reward = (catalog?.rewards || []).find((entry) => entry.pityTier === 'ultra_relic');
    return [...new Set((reward?.pool || []).map((value) => String(value || '').trim()).filter(Boolean))].sort();
}

function assertActivationCompatibility(active, candidate) {
    if (!active || !candidate) {
        throw new AdminBoxCatalogError('box_catalog_activation_state_missing', 'Estado de ativação incompleto.', 409);
    }
    if (candidate.status !== 'draft') {
        throw new AdminBoxCatalogError('box_catalog_candidate_not_draft', 'Somente uma versão draft pode ser ativada.', 409);
    }
    if (active.boxKey !== candidate.boxKey) {
        throw new AdminBoxCatalogError('box_catalog_key_mismatch', 'A versão candidata pertence a outro tipo de Caixa.', 409);
    }
    if (active.catalog?.templateKey !== candidate.catalog?.templateKey) {
        throw new AdminBoxCatalogError(
            'box_catalog_template_change_blocked',
            'Uma nova versão não pode trocar o item físico consumido por este tipo de Caixa.',
            409,
            { expected: active.catalog?.templateKey, received: candidate.catalog?.templateKey }
        );
    }
    const canonicalPool = [...RELIC_POOL].sort();
    const candidatePool = normalizedRelicPool(candidate.catalog);
    if (!same(candidatePool, canonicalPool)) {
        throw new AdminBoxCatalogError(
            'box_catalog_relic_pool_change_blocked',
            'O pool global de relíquias não pode ser alterado por uma versão de Caixa.',
            409,
            { expectedCount: canonicalPool.length, receivedCount: candidatePool.length }
        );
    }
    const catalog = validateBoxCatalogDefinition(candidate.catalog, { boxKey: candidate.boxKey });
    const policy = validateBoxPityPolicy(candidate.pityPolicy, candidate.boxKey);
    const expectedFingerprint = fingerprint({ catalog, policy });
    if (candidate.fingerprint !== expectedFingerprint) {
        throw new AdminBoxCatalogError(
            'box_catalog_candidate_fingerprint_mismatch',
            'A versão candidata não corresponde ao fingerprint salvo.',
            409
        );
    }
    return { catalog, policy, fingerprint: expectedFingerprint };
}

async function findVersion(db, boxKey, version) {
    const versions = await listBoxCatalogVersions(db, boxKey);
    const numeric = Number(version);
    return versions.find((entry) => entry.version === numeric) || null;
}

function actorId(operation) {
    return operation?.actor?.id || operation?.actorId || null;
}

function createBoxCatalogVersionExecutors() {
    return {
        'system.box.catalog.version.create': {
            async preview({ db, action, target }) {
                if (target?.kind !== 'system' || target?.systemKey !== 'clover') {
                    throw new AdminBoxCatalogError('invalid_system_target', 'Esta ação exige o alvo global do Clover.', 400);
                }
                const input = action.payload || {};
                const boxKey = text(input.boxKey || input.catalog?.key, 80).toLowerCase();
                const active = await getActiveBoxCatalogVersion(db, boxKey);
                if (!active) throw new AdminBoxCatalogError('active_box_catalog_missing', 'Não existe versão ativa para esta Caixa.', 409);
                const versions = await listBoxCatalogVersions(db, boxKey);
                const nextVersion = Math.max(...versions.map((entry) => entry.version), 0) + 1;
                const catalog = validateBoxCatalogDefinition({ ...(input.catalog || {}), key: boxKey, version: nextVersion }, { boxKey });
                const policy = validateBoxPityPolicy(input.pityPolicy || input.policy, boxKey);
                const candidate = {
                    boxKey,
                    version: nextVersion,
                    status: 'draft',
                    catalog,
                    pityPolicy: policy,
                    fingerprint: fingerprint({ catalog, policy }),
                };
                assertActivationCompatibility(active, candidate);
                return {
                    summary: `Criar ${active.catalog?.name || boxKey} v${nextVersion} como draft`,
                    before: { active, maxVersion: nextVersion - 1 },
                    after: candidate,
                    metadata: { scope: 'box-catalog-version', immutableDraft: true },
                };
            },
            async apply({ db, operation, action, target, before, after }) {
                if (target?.kind !== 'system' || target?.systemKey !== 'clover') {
                    throw new AdminBoxCatalogError('invalid_system_target', 'Esta ação exige o alvo global do Clover.', 400);
                }
                const currentActive = await getActiveBoxCatalogVersion(db, after.boxKey);
                const versions = await listBoxCatalogVersions(db, after.boxKey);
                const currentMax = Math.max(...versions.map((entry) => entry.version), 0);
                if (currentActive?.version !== before.active?.version || currentActive?.fingerprint !== before.active?.fingerprint || currentMax !== before.maxVersion) {
                    throw new AdminBoxCatalogError('box_catalog_changed_after_preview', 'O catálogo mudou depois da prévia. Gere uma nova OP-.', 409);
                }
                const created = await createDraftBoxCatalogVersion(
                    db,
                    { boxKey: after.boxKey, catalog: after.catalog, pityPolicy: after.pityPolicy },
                    actorId(operation),
                    text(operation?.reason || action.payload?.reason, 2000)
                );
                if (created.version !== after.version || created.fingerprint !== after.fingerprint) {
                    throw new AdminBoxCatalogError('box_catalog_created_snapshot_mismatch', 'A versão criada divergiu da prévia.', 409);
                }
                return { after: created, summary: `${created.catalog.name} v${created.version} criada como draft.` };
            },
            async undo({ db, after }) {
                await deleteUnusedDraftBoxCatalogVersion(db, after.boxKey, after.version);
            },
        },

        'system.box.catalog.version.activate': {
            async preview({ db, action, target }) {
                if (target?.kind !== 'system' || target?.systemKey !== 'clover') {
                    throw new AdminBoxCatalogError('invalid_system_target', 'Esta ação exige o alvo global do Clover.', 400);
                }
                const boxKey = text(action.payload?.boxKey, 80).toLowerCase();
                const version = Number(action.payload?.version);
                const active = await getActiveBoxCatalogVersion(db, boxKey);
                const candidate = await findVersion(db, boxKey, version);
                if (!candidate) throw new AdminBoxCatalogError('box_catalog_version_not_found', 'Versão candidata não encontrada.', 404);
                assertActivationCompatibility(active, candidate);
                return {
                    summary: `Ativar ${candidate.catalog.name} v${candidate.version} no lugar da v${active.version}`,
                    before: { active },
                    after: { candidate },
                    metadata: {
                        scope: 'box-catalog-activation',
                        previousVersion: active.version,
                        candidateVersion: candidate.version,
                    },
                };
            },
            async apply({ db, operation, action, target, before, after }) {
                if (target?.kind !== 'system' || target?.systemKey !== 'clover') {
                    throw new AdminBoxCatalogError('invalid_system_target', 'Esta ação exige o alvo global do Clover.', 400);
                }
                const boxKey = after.candidate.boxKey;
                const active = await getActiveBoxCatalogVersion(db, boxKey);
                const candidate = await findVersion(db, boxKey, after.candidate.version);
                if (!active || active.version !== before.active.version || active.fingerprint !== before.active.fingerprint) {
                    throw new AdminBoxCatalogError('box_catalog_active_changed_after_preview', 'A versão ativa mudou depois da prévia.', 409);
                }
                if (!candidate || candidate.fingerprint !== after.candidate.fingerprint) {
                    throw new AdminBoxCatalogError('box_catalog_candidate_changed_after_preview', 'A versão candidata mudou depois da prévia.', 409);
                }
                assertActivationCompatibility(active, candidate);
                const timestamp = new Date().toISOString();
                await db.run(
                    `UPDATE clover_box_catalog_versions
                     SET status = 'archived', archived_at = ?, activated_by = COALESCE(activated_by, ?)
                     WHERE box_key = ? AND version = ? AND status = 'active'`,
                    [timestamp, actorId(operation), boxKey, active.version]
                );
                const activated = await db.run(
                    `UPDATE clover_box_catalog_versions
                     SET status = 'active', activated_at = ?, activated_by = ?, archived_at = NULL
                     WHERE box_key = ? AND version = ? AND status = 'draft'`,
                    [timestamp, actorId(operation), boxKey, candidate.version]
                );
                if (Number(activated?.changes || 0) !== 1) {
                    throw new AdminBoxCatalogError('box_catalog_activation_race', 'A versão candidata não pôde ser ativada de forma exclusiva.', 409);
                }
                return {
                    after: { candidate: await getActiveBoxCatalogVersion(db, boxKey), previous: active },
                    summary: `${candidate.catalog.name} v${candidate.version} ativada.`,
                };
            },
            async undo({ db, before, after }) {
                const boxKey = before.active.boxKey;
                const candidateVersion = after.candidate.version;
                const active = await getActiveBoxCatalogVersion(db, boxKey);
                if (!active || active.version !== candidateVersion || active.fingerprint !== after.candidate.fingerprint) {
                    throw new AdminBoxCatalogError('box_catalog_changed_after_activation', 'A versão ativa mudou depois da ativação; undo bloqueado.', 409);
                }
                const openings = await db.get(
                    'SELECT COUNT(*) AS total FROM clover_box_openings WHERE box_key = ? AND catalog_version = ?',
                    [boxKey, candidateVersion]
                );
                const pity = await db.get(
                    'SELECT COUNT(*) AS total FROM clover_box_pity_state WHERE box_key = ? AND catalog_version = ?',
                    [boxKey, candidateVersion]
                );
                if (Number(openings?.total || 0) > 0 || Number(pity?.total || 0) > 0) {
                    throw new AdminBoxCatalogError(
                        'box_catalog_activation_already_used',
                        'A versão ativa já foi usada por abertura ou pity; desfazer automaticamente foi bloqueado. Crie uma nova versão compensatória.',
                        409,
                        { openings: Number(openings?.total || 0), pityStates: Number(pity?.total || 0) }
                    );
                }
                const timestamp = new Date().toISOString();
                await db.run(
                    `UPDATE clover_box_catalog_versions
                     SET status = 'draft', activated_at = NULL, activated_by = NULL, archived_at = NULL
                     WHERE box_key = ? AND version = ? AND status = 'active'`,
                    [boxKey, candidateVersion]
                );
                const restored = await db.run(
                    `UPDATE clover_box_catalog_versions
                     SET status = 'active', activated_at = ?, archived_at = NULL
                     WHERE box_key = ? AND version = ? AND status = 'archived'`,
                    [timestamp, boxKey, before.active.version]
                );
                if (Number(restored?.changes || 0) !== 1) {
                    throw new AdminBoxCatalogError('box_catalog_previous_restore_failed', 'A versão anterior não pôde ser restaurada.', 409);
                }
            },
        },
    };
}

module.exports = {
    AdminBoxCatalogError,
    assertActivationCompatibility,
    createBoxCatalogVersionExecutors,
    findVersion,
    normalizedRelicPool,
};
