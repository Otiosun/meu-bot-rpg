'use strict';

const { validateDreamWorldDualAcquisition } = require('./dreamWorldsAcquisitionPolicy');
const {
    approveDreamRequest,
    createDreamWorld,
    ensureDreamWorldsSchema,
    previewDreamWorldStatusTransition,
    rejectDreamApplication,
    rejectDreamRequest,
    reviewDreamApplication,
    selectDreamApplication,
    serializeRequest,
    serializeWorld,
    transitionDreamWorldStatus,
    updateDreamWorldAcquisition,
} = require('./dreamWorldsService');
const {
    createResonanceFragment,
    getDreamRun,
    grantResonanceFragment,
    listAdminFragments,
    removeDreamSlot,
    transitionDreamRun,
    updateResonanceFragment,
} = require('./dreamWorldsOperationsService');
const {
    assignDreamSlotWithPolicy,
    replaceDreamSlotWithPolicy,
} = require('./dreamWorldsSlotPolicyService');

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


let dreamPreviewCounter = 0;

function requireValue(payload, keys, label) {
    for (const key of keys) {
        const value = payload?.[key];
        if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
    throw new AdminDreamWorldOperationError(
        'missing_dream_operation_field',
        `${label} é obrigatório.`,
        400,
        { field: label }
    );
}

function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])
    );
}

function stableSnapshot(value) {
    return JSON.stringify(canonicalValue(value ?? null));
}

function assertSameSnapshot(current, expected, code, label = 'O recurso') {
    if (stableSnapshot(current) === stableSnapshot(expected)) return;
    throw new AdminDreamWorldOperationError(
        code,
        `${label} mudou depois da prévia. Gere uma nova operação.`,
        409,
        { expected, current }
    );
}

async function previewWithRollback(db, readBefore, mutate, readAfter = null) {
    const before = readBefore ? await readBefore() : null;
    dreamPreviewCounter += 1;
    const savepoint = `admin_dream_preview_${dreamPreviewCounter}`;
    await db.exec(`SAVEPOINT ${savepoint}`);
    try {
        const result = await mutate();
        const after = readAfter ? await readAfter(result) : result;
        await db.exec(`ROLLBACK TO ${savepoint}`);
        await db.exec(`RELEASE ${savepoint}`);
        return { before, after };
    } catch (error) {
        await db.exec(`ROLLBACK TO ${savepoint}`).catch(() => null);
        await db.exec(`RELEASE ${savepoint}`).catch(() => null);
        throw error;
    }
}

async function readDreamRequestSnapshot(db, requestId) {
    await ensureDreamWorldsSchema(db);
    const row = await db.get(
        `SELECT request.*, world.status AS world_status, world.name AS world_name
           FROM clover_dream_requests request
           JOIN clover_dream_worlds world ON world.id = request.world_id
          WHERE request.id = ?`,
        [Number(requestId)]
    );
    if (!row) throw new AdminDreamWorldOperationError('request_not_found', 'Solicitação não encontrada.', 404, { requestId });
    return {
        ...serializeRequest(row),
        worldStatus: row.world_status,
        worldName: row.world_name,
    };
}

async function readDreamApplicationSnapshot(db, applicationInput) {
    await ensureDreamWorldsSchema(db);
    const raw = String(applicationInput ?? '').trim();
    const numericId = /^\d+$/.test(raw) ? Number(raw) : -1;
    const row = await db.get(
        `SELECT id, application_key, world_id, run_id, player_id, status,
                player_note, admin_note, submitted_at, reviewed_at, reviewed_by,
                selected_at, rejected_at, withdrawn_at, metadata_json
           FROM clover_dream_applications
          WHERE id = ? OR application_key = ?
          LIMIT 1`,
        [numericId, raw]
    );
    if (!row) throw new AdminDreamWorldOperationError('application_not_found', 'Candidatura não encontrada.', 404, { application: raw });
    return {
        id: Number(row.id),
        key: row.application_key,
        worldId: Number(row.world_id),
        runId: Number(row.run_id),
        playerId: row.player_id,
        status: row.status,
        playerNote: row.player_note || null,
        adminNote: row.admin_note || null,
        submittedAt: row.submitted_at || null,
        reviewedAt: row.reviewed_at || null,
        reviewedBy: row.reviewed_by || null,
        selectedAt: row.selected_at || null,
        rejectedAt: row.rejected_at || null,
        withdrawnAt: row.withdrawn_at || null,
        metadataJson: row.metadata_json || null,
    };
}

async function readDreamRunSnapshot(db, runInput) {
    return getDreamRun(db, runInput);
}

async function readDreamFragmentSnapshot(db, fragmentInput) {
    const raw = String(fragmentInput ?? '').trim();
    const rows = await listAdminFragments(db, {});
    const found = rows.find((entry) => (
        String(entry.id) === raw
        || String(entry.key || '').toLowerCase() === raw.toLowerCase()
        || String(entry.slug || '').toLowerCase() === raw.toLowerCase()
    ));
    if (!found) throw new AdminDreamWorldOperationError('fragment_not_found', 'Fragmento não encontrado.', 404, { fragment: raw });
    return found;
}

function genericExecutor({ label, readBefore, mutate, readAfter = null, staleCode = 'dream_resource_changed_after_preview' }) {
    return {
        async preview({ db, operation, action }) {
            const payload = action.payload || {};
            const result = await previewWithRollback(
                db,
                () => readBefore ? readBefore(db, payload) : null,
                () => mutate(db, operation, payload),
                readAfter ? (value) => readAfter(db, payload, value) : null
            );
            return {
                summary: typeof label === 'function' ? label(payload, result.after) : label,
                before: result.before,
                after: result.after,
                metadata: { undoSafe: false },
            };
        },

        async apply({ db, operation, action, before }) {
            const payload = action.payload || {};
            if (readBefore) {
                const current = await readBefore(db, payload);
                assertSameSnapshot(current, before, staleCode, 'O estado de Mundos dos Sonhos');
            }
            const result = await mutate(db, operation, payload);
            const after = readAfter ? await readAfter(db, payload, result) : result;
            return {
                before,
                after,
                summary: typeof label === 'function' ? label(payload, after) : label,
                metadata: { undoSafe: false },
            };
        },
    };
}

function createGenericDreamExecutors() {
    return {
        'system.dream_world.create': genericExecutor({
            label: (payload, after) => `${after?.name || payload.name || 'Fenda'}: criada pela Central ADM`,
            readBefore: null,
            mutate: (db, operation, payload) => createDreamWorld(db, {
                ...payload,
                metadata: { ...(payload.metadata || {}), adminOperation: operation.code, via: 'central_admin_op' },
            }, operation.actor.id),
        }),

        'system.dream_request.approve': genericExecutor({
            label: (_, after) => `${after?.request?.key || 'Solicitação'}: aprovada`,
            readBefore: (db, payload) => readDreamRequestSnapshot(db, requireValue(payload, ['requestId', 'request_id', 'request'], 'requestId')),
            mutate: (db, operation, payload) => approveDreamRequest(
                db,
                requireValue(payload, ['requestId', 'request_id', 'request'], 'requestId'),
                operation.actor.id,
                {
                    adminNote: payload.adminNote ?? payload.admin_note,
                    narratorIds: payload.narratorIds ?? payload.narrator_ids ?? [],
                    metadata: { ...(payload.metadata || {}), adminOperation: operation.code, via: 'central_admin_op' },
                },
                { transactionManaged: true }
            ),
            staleCode: 'dream_request_changed_after_preview',
        }),

        'system.dream_request.reject': genericExecutor({
            label: (_, after) => `${after?.key || 'Solicitação'}: recusada`,
            readBefore: (db, payload) => readDreamRequestSnapshot(db, requireValue(payload, ['requestId', 'request_id', 'request'], 'requestId')),
            mutate: (db, operation, payload) => rejectDreamRequest(
                db,
                requireValue(payload, ['requestId', 'request_id', 'request'], 'requestId'),
                operation.actor.id,
                { adminNote: payload.adminNote ?? payload.admin_note ?? payload.reason },
                { transactionManaged: true }
            ),
            staleCode: 'dream_request_changed_after_preview',
        }),

        'system.dream_application.review': genericExecutor({
            label: (_, after) => `${after?.key || 'Candidatura'}: em revisão`,
            readBefore: (db, payload) => readDreamApplicationSnapshot(db, requireValue(payload, ['application', 'applicationId', 'application_id'], 'application')),
            mutate: (db, operation, payload) => reviewDreamApplication(
                db, requireValue(payload, ['application', 'applicationId', 'application_id'], 'application'), operation.actor.id,
                { adminNote: payload.adminNote ?? payload.admin_note, reason: payload.reason },
                { transactionManaged: true }
            ),
            staleCode: 'dream_application_changed_after_preview',
        }),

        'system.dream_application.select': genericExecutor({
            label: (_, after) => `${after?.key || 'Candidatura'}: selecionada`,
            readBefore: (db, payload) => readDreamApplicationSnapshot(db, requireValue(payload, ['application', 'applicationId', 'application_id'], 'application')),
            mutate: (db, operation, payload) => selectDreamApplication(
                db, requireValue(payload, ['application', 'applicationId', 'application_id'], 'application'), operation.actor.id,
                { adminNote: payload.adminNote ?? payload.admin_note, reason: payload.reason, mode: payload.mode || 'invited' },
                { transactionManaged: true }
            ),
            staleCode: 'dream_application_changed_after_preview',
        }),

        'system.dream_application.reject': genericExecutor({
            label: (_, after) => `${after?.key || 'Candidatura'}: recusada`,
            readBefore: (db, payload) => readDreamApplicationSnapshot(db, requireValue(payload, ['application', 'applicationId', 'application_id'], 'application')),
            mutate: (db, operation, payload) => rejectDreamApplication(
                db, requireValue(payload, ['application', 'applicationId', 'application_id'], 'application'), operation.actor.id,
                { adminNote: payload.adminNote ?? payload.admin_note, reason: payload.reason },
                { transactionManaged: true }
            ),
            staleCode: 'dream_application_changed_after_preview',
        }),

        'system.dream_run.transition': genericExecutor({
            label: (payload, after) => `${after?.key || 'Incursão'}: ${payload.command || payload.action}`,
            readBefore: (db, payload) => readDreamRunSnapshot(db, requireValue(payload, ['run', 'runId', 'run_id'], 'run')),
            mutate: (db, operation, payload) => transitionDreamRun(
                db,
                requireValue(payload, ['run', 'runId', 'run_id'], 'run'),
                requireValue(payload, ['command', 'action'], 'command'),
                operation.actor.id,
                { reason: payload.reason, chapter: payload.chapter, allowBeyondKnown: Boolean(payload.allowBeyondKnown ?? payload.allow_beyond_known) },
                { transactionManaged: true }
            ),
            staleCode: 'dream_run_changed_after_preview',
        }),

        'system.dream_slot.assign': genericExecutor({
            label: (payload) => `Vaga ${payload.slotId ?? payload.slot_id}: atribuir participante`,
            readBefore: (db, payload) => readDreamRunSnapshot(db, requireValue(payload, ['run', 'runId', 'run_id'], 'run')),
            mutate: (db, operation, payload) => assignDreamSlotWithPolicy(
                db,
                requireValue(payload, ['run', 'runId', 'run_id'], 'run'),
                requireValue(payload, ['slotId', 'slot_id'], 'slotId'),
                requireValue(payload, ['playerId', 'player_id'], 'playerId'),
                operation.actor.id,
                { mode: payload.mode || 'invited', reason: payload.reason, source: 'central_admin_op', metadata: { ...(payload.metadata || {}), adminOperation: operation.code } },
                { transactionManaged: true }
            ),
            staleCode: 'dream_run_changed_after_preview',
        }),

        'system.dream_slot.remove': genericExecutor({
            label: (payload) => `Vaga ${payload.slotId ?? payload.slot_id}: remover participante`,
            readBefore: (db, payload) => readDreamRunSnapshot(db, requireValue(payload, ['run', 'runId', 'run_id'], 'run')),
            mutate: (db, operation, payload) => removeDreamSlot(
                db,
                requireValue(payload, ['run', 'runId', 'run_id'], 'run'),
                requireValue(payload, ['slotId', 'slot_id'], 'slotId'),
                operation.actor.id,
                { reason: payload.reason },
                { transactionManaged: true }
            ),
            staleCode: 'dream_run_changed_after_preview',
        }),

        'system.dream_slot.replace': genericExecutor({
            label: (payload) => `Vaga ${payload.slotId ?? payload.slot_id}: substituir participante`,
            readBefore: (db, payload) => readDreamRunSnapshot(db, requireValue(payload, ['run', 'runId', 'run_id'], 'run')),
            mutate: (db, operation, payload) => replaceDreamSlotWithPolicy(
                db,
                requireValue(payload, ['run', 'runId', 'run_id'], 'run'),
                requireValue(payload, ['slotId', 'slot_id'], 'slotId'),
                requireValue(payload, ['playerId', 'player_id'], 'playerId'),
                operation.actor.id,
                { mode: payload.mode || 'invited', reason: payload.reason },
                { transactionManaged: true }
            ),
            staleCode: 'dream_run_changed_after_preview',
        }),

        'system.dream_fragment.create': genericExecutor({
            label: (payload, after) => `${after?.name || payload.name || 'Fragmento'}: criado`,
            readBefore: null,
            mutate: (db, operation, payload) => createResonanceFragment(
                db,
                { ...payload, reason: payload.reason || operation.reason, metadata: { ...(payload.metadata || {}), adminOperation: operation.code, via: 'central_admin_op' } },
                operation.actor.id,
                { transactionManaged: true }
            ),
        }),

        'system.dream_fragment.update': genericExecutor({
            label: (_, after) => `${after?.name || 'Fragmento'}: atualizado`,
            readBefore: (db, payload) => readDreamFragmentSnapshot(db, requireValue(payload, ['fragment', 'fragmentId', 'fragment_id', 'slug'], 'fragment')),
            mutate: (db, operation, payload) => {
                const fragment = requireValue(payload, ['fragment', 'fragmentId', 'fragment_id', 'slug'], 'fragment');
                const patch = { ...payload };
                delete patch.fragment;
                delete patch.fragmentId;
                delete patch.fragment_id;
                delete patch.slug;
                return updateResonanceFragment(
                    db, fragment, { ...patch, reason: patch.reason || operation.reason }, operation.actor.id, { transactionManaged: true }
                );
            },
            staleCode: 'dream_fragment_changed_after_preview',
        }),

        'system.dream_fragment.grant': genericExecutor({
            label: (_, after) => `${after?.name || 'Fragmento'}: concedido`,
            readBefore: (db, payload) => readDreamFragmentSnapshot(db, requireValue(payload, ['fragment', 'fragmentId', 'fragment_id', 'slug'], 'fragment')),
            mutate: (db, operation, payload) => grantResonanceFragment(
                db,
                requireValue(payload, ['fragment', 'fragmentId', 'fragment_id', 'slug'], 'fragment'),
                requireValue(payload, ['playerId', 'player_id'], 'playerId'),
                operation.actor.id,
                { status: payload.status, reason: payload.reason || operation.reason, force: Boolean(payload.force) },
                { transactionManaged: true }
            ),
            staleCode: 'dream_fragment_changed_after_preview',
        }),
    };
}
function createAdminDreamWorldExecutors() {
    return {
        ...createGenericDreamExecutors(),
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
    createGenericDreamExecutors,
    previewWithRollback,
    readDreamApplicationSnapshot,
    readDreamFragmentSnapshot,
    readDreamRequestSnapshot,
    readDreamRunSnapshot,
};
