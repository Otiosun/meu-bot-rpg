'use strict';

const { validateDreamWorldDualAcquisition } = require('./dreamWorldsAcquisitionPolicy');
const {
    ensureDreamWorldsSchema,
    previewDreamWorldStatusTransition,
    serializeWorld,
    transitionDreamWorldStatus,
    updateDreamWorldAcquisition,
} = require('./dreamWorldsService');

class AdminDreamWorldOperationError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminDreamWorldOperationError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function worldInput(payload = {}) {
    const value = payload.world
        ?? payload.worldId
        ?? payload.world_id
        ?? payload.slug
        ?? payload.worldKey
        ?? payload.world_key;
    const clean = String(value ?? '').trim();
    if (!clean) {
        throw new AdminDreamWorldOperationError(
            'missing_dream_world',
            'Informe a Fenda que será alterada.',
            400
        );
    }
    return clean;
}

async function readDreamWorldSnapshot(db, input) {
    await ensureDreamWorldsSchema(db);
    const raw = String(input ?? '').trim();
    const numericId = /^\d+$/.test(raw) ? Number(raw) : -1;
    const row = await db.get(
        `SELECT *
           FROM clover_dream_worlds
          WHERE id = ? OR slug = ? OR world_key = ?
          LIMIT 1`,
        [numericId, raw, raw]
    );
    if (!row) {
        throw new AdminDreamWorldOperationError(
            'world_not_found',
            'Mundo dos Sonhos não encontrado.',
            404,
            { world: raw }
        );
    }
    return serializeWorld(row);
}

function stableWorldState(world) {
    return JSON.stringify({
        id: world?.id ?? null,
        key: world?.key ?? null,
        slug: world?.slug ?? null,
        status: world?.status ?? null,
        price: world?.price ?? null,
        announcedAt: world?.announcedAt ?? null,
        purchaseOpensAt: world?.purchaseOpensAt ?? null,
        purchaseClosesAt: world?.purchaseClosesAt ?? null,
    });
}

function assertSameWorld(current, expected, code) {
    if (stableWorldState(current) === stableWorldState(expected)) return;
    throw new AdminDreamWorldOperationError(
        code,
        'A Fenda mudou depois da prévia. Gere uma nova operação.',
        409,
        { expected, current }
    );
}

function normalizeAcquisitionPayload(payload = {}) {
    let acquisition;
    try {
        acquisition = validateDreamWorldDualAcquisition({
            yullsPrice: payload.yullsPrice ?? payload.yulls_price,
            manualPaymentEnabled:
                payload.manualPaymentEnabled
                ?? payload.manual_payment_enabled
                ?? true,
            manualPriceLabel:
                payload.manualPriceLabel
                ?? payload.manual_price_label,
        });
    } catch (error) {
        throw new AdminDreamWorldOperationError(
            error?.code || 'invalid_acquisition_policy',
            error?.message || 'Política de aquisição inválida.',
            400,
            error?.details || null
        );
    }
    return {
        ...acquisition,
        reason: String(payload.reason || '').trim() || 'Ajuste pela Central ADM',
    };
}

function createAdminDreamWorldExecutors() {
    return {
        'system.dream_world.acquisition.update': {
            async preview({ db, action }) {
                const input = worldInput(action.payload || {});
                const before = await readDreamWorldSnapshot(db, input);
                const acquisition = normalizeAcquisitionPayload(action.payload || {});
                const after = {
                    ...before,
                    price: {
                        ...(before.price || {}),
                        yulls: acquisition.yullsPrice,
                        manualEnabled: acquisition.manualPaymentEnabled,
                        manualLabel: acquisition.manualPriceLabel,
                    },
                };
                return {
                    summary: `${before.name}: ajustar aquisição da Fenda`,
                    before,
                    after,
                    metadata: { world: input, reason: acquisition.reason },
                };
            },

            async apply({ db, operation, action, before }) {
                const input = worldInput(action.payload || {});
                const current = await readDreamWorldSnapshot(db, input);
                assertSameWorld(current, before, 'dream_world_changed_after_preview');
                const acquisition = normalizeAcquisitionPayload(action.payload || {});
                const updated = await updateDreamWorldAcquisition(
                    db,
                    input,
                    operation.actor.id,
                    acquisition,
                    { transactionManaged: true }
                );
                return {
                    before,
                    after: updated,
                    summary: `${updated.name}: aquisição atualizada.`,
                };
            },

            async undo({ db, operation, action, before, after }) {
                const input = worldInput(action.payload || {});
                const current = await readDreamWorldSnapshot(db, input);
                assertSameWorld(current, after, 'dream_world_changed_since_apply');
                await updateDreamWorldAcquisition(
                    db,
                    input,
                    operation.actor.id,
                    {
                        yullsPrice: before.price?.yulls,
                        manualPaymentEnabled: before.price?.manualEnabled,
                        manualPriceLabel: before.price?.manualLabel,
                        reason: `Desfazer ${operation.code}`,
                    },
                    { transactionManaged: true }
                );
            },
        },

        'system.dream_world.status.transition': {
            async preview({ db, action }) {
                const input = worldInput(action.payload || {});
                const result = await previewDreamWorldStatusTransition(db, input, {
                    status: action.payload?.status,
                    reason: action.payload?.reason,
                });
                return {
                    summary: `${result.before.name}: ${result.before.status} → ${result.targetStatus}`,
                    before: result.before,
                    after: result.after,
                    metadata: {
                        world: input,
                        targetStatus: result.targetStatus,
                        reason: result.reason || null,
                        undoSafe: false,
                    },
                };
            },

            async apply({ db, operation, action, before }) {
                const input = worldInput(action.payload || {});
                const preview = await previewDreamWorldStatusTransition(db, input, {
                    status: action.payload?.status,
                    reason: action.payload?.reason,
                });
                assertSameWorld(preview.before, before, 'dream_world_changed_after_preview');

                const updated = await transitionDreamWorldStatus(
                    db,
                    input,
                    operation.actor.id,
                    {
                        status: action.payload?.status,
                        reason: action.payload?.reason,
                        metadata: {
                            adminOperation: operation.code,
                            via: 'central_admin_op',
                        },
                    },
                    { transactionManaged: true }
                );
                return {
                    before,
                    after: updated,
                    summary: `${updated.name}: estado alterado para ${updated.status}.`,
                    metadata: { undoSafe: false },
                };
            },
        },
    };
}

module.exports = {
    AdminDreamWorldOperationError,
    assertSameWorld,
    createAdminDreamWorldExecutors,
    normalizeAcquisitionPayload,
    readDreamWorldSnapshot,
    stableWorldState,
    worldInput,
};
