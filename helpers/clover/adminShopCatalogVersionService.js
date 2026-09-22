'use strict';

const {
    ShopCatalogVersionError,
    activateShopCatalogVersion,
    createDraftShopCatalogVersion,
    deleteUnusedDraftShopCatalogVersion,
    fingerprint,
    getActiveShopCatalogVersion,
    getShopCatalogVersion,
    listShopCatalogVersions,
    pendingPurchaseCount,
    validateShopCatalogDefinition,
} = require('./shopCatalogVersionService');

function assertSystemTarget(target) {
    if (target?.kind === 'system' && target?.systemKey === 'clover') return;
    throw new ShopCatalogVersionError(
        'invalid_system_target',
        'Esta ação exige o alvo global system:clover.',
        400
    );
}

function activeSnapshot(active) {
    return active
        ? { version: active.version, fingerprint: active.fingerprint }
        : null;
}

function sameActive(active, snapshot) {
    if (!active && !snapshot) return true;
    return Boolean(
        active
        && snapshot
        && active.version === snapshot.version
        && active.fingerprint === snapshot.fingerprint
    );
}

async function buildDraftPreview(db, operation, payload) {
    const [active, versions] = await Promise.all([
        getActiveShopCatalogVersion(db),
        listShopCatalogVersions(db),
    ]);
    if (!active) {
        throw new ShopCatalogVersionError(
            'active_shop_catalog_missing',
            'Não existe uma versão ativa de Lojas para servir de base.',
            409
        );
    }

    const maxVersion = Math.max(...versions.map((entry) => Number(entry.version || 0)), 0);
    const catalog = validateShopCatalogDefinition(payload.catalog);
    return {
        before: {
            active: activeSnapshot(active),
            maxVersion,
        },
        candidate: {
            version: maxVersion + 1,
            status: 'draft',
            catalog,
            fingerprint: fingerprint(catalog),
        },
        reason: payload.reason || operation.reason,
    };
}

function createShopCatalogVersionExecutors() {
    return {
        'system.shop.catalog.version.create': {
            async preview({ db, operation, action, target }) {
                assertSystemTarget(target);
                const planned = await buildDraftPreview(db, operation, action.payload || {});
                return {
                    summary: `Criar catálogo de Lojas v${planned.candidate.version} como draft`,
                    before: planned.before,
                    after: planned.candidate,
                    metadata: {
                        scope: 'shop-catalog-version',
                        immutableDraft: true,
                        undoSafe: true,
                    },
                };
            },

            async apply({ db, operation, action, target, before, after }) {
                assertSystemTarget(target);

                const [active, versions] = await Promise.all([
                    getActiveShopCatalogVersion(db),
                    listShopCatalogVersions(db),
                ]);
                const maxVersion = Math.max(...versions.map((entry) => Number(entry.version || 0)), 0);

                if (!sameActive(active, before?.active) || maxVersion !== Number(before?.maxVersion)) {
                    throw new ShopCatalogVersionError(
                        'shop_catalog_changed_after_preview',
                        'O catálogo de Lojas mudou depois da prévia. Gere uma nova OP-.',
                        409,
                        {
                            expectedActive: before?.active || null,
                            currentActive: activeSnapshot(active),
                            expectedMaxVersion: before?.maxVersion ?? null,
                            currentMaxVersion: maxVersion,
                        }
                    );
                }

                const created = await createDraftShopCatalogVersion(
                    db,
                    {
                        catalog: after?.catalog ?? action.payload?.catalog,
                        reason: action.payload?.reason || operation.reason,
                    },
                    { actorId: operation.actor.id }
                );

                if (
                    created.version !== Number(after?.version)
                    || created.fingerprint !== after?.fingerprint
                ) {
                    throw new ShopCatalogVersionError(
                        'shop_catalog_created_snapshot_mismatch',
                        'A versão criada divergiu da prévia. A operação foi bloqueada.',
                        409
                    );
                }

                return {
                    summary: `Catálogo de Lojas v${created.version} criado como draft.`,
                    before,
                    after: created,
                    metadata: { scope: 'shop-catalog-version', undoSafe: true },
                };
            },

            async undo({ db, after }) {
                await deleteUnusedDraftShopCatalogVersion(db, after.version);
            },
        },

        'system.shop.catalog.version.activate': {
            async preview({ db, action, target }) {
                assertSystemTarget(target);
                const preview = await (async () => {
                    const candidate = await getShopCatalogVersion(db, Number(action.payload?.version));
                    if (!candidate) {
                        throw new ShopCatalogVersionError(
                            'shop_catalog_version_not_found',
                            'Versão de Lojas não encontrada.',
                            404
                        );
                    }
                    if (candidate.status !== 'draft') {
                        throw new ShopCatalogVersionError(
                            'shop_catalog_candidate_not_draft',
                            'Somente uma versão draft pode ser ativada.',
                            409
                        );
                    }
                    const [active, pending] = await Promise.all([
                        getActiveShopCatalogVersion(db),
                        pendingPurchaseCount(db),
                    ]);
                    if (!active) {
                        throw new ShopCatalogVersionError(
                            'active_shop_catalog_missing',
                            'Não existe versão ativa de Lojas.',
                            409
                        );
                    }
                    return { active, candidate, pendingPurchaseCount: pending };
                })();

                return {
                    summary: `Ativar catálogo de Lojas v${preview.candidate.version} no lugar da v${preview.active.version}`,
                    before: {
                        active: preview.active,
                    },
                    after: {
                        candidate: preview.candidate,
                        pendingPurchaseCount: preview.pendingPurchaseCount,
                    },
                    metadata: {
                        scope: 'shop-catalog-activation',
                        undoSafe: false,
                        recovery: 'create_compensating_version',
                        blockedByPendingPurchases: preview.pendingPurchaseCount > 0,
                    },
                };
            },

            async apply({ db, operation, action, target, before, after }) {
                assertSystemTarget(target);

                const [active, candidate, pending] = await Promise.all([
                    getActiveShopCatalogVersion(db),
                    getShopCatalogVersion(db, Number(after?.candidate?.version ?? action.payload?.version)),
                    pendingPurchaseCount(db),
                ]);

                if (
                    !active
                    || active.version !== before?.active?.version
                    || active.fingerprint !== before?.active?.fingerprint
                ) {
                    throw new ShopCatalogVersionError(
                        'shop_catalog_active_changed_after_preview',
                        'A versão ativa de Lojas mudou depois da prévia.',
                        409
                    );
                }
                if (
                    !candidate
                    || candidate.status !== 'draft'
                    || candidate.fingerprint !== after?.candidate?.fingerprint
                ) {
                    throw new ShopCatalogVersionError(
                        'shop_catalog_candidate_changed_after_preview',
                        'A versão candidata de Lojas mudou depois da prévia.',
                        409
                    );
                }
                if (pending > 0) {
                    throw new ShopCatalogVersionError(
                        'shop_catalog_pending_purchases',
                        'Existem compras aguardando confirmação. Resolva-as antes da ativação.',
                        409,
                        { pendingPurchaseCount: pending }
                    );
                }

                const result = await activateShopCatalogVersion(
                    db,
                    { version: candidate.version },
                    {
                        actorId: operation.actor.id,
                        transactionManaged: true,
                    }
                );

                return {
                    summary: `Catálogo de Lojas v${result.activated.version} ativado.`,
                    before: { active: result.previous },
                    after: { candidate: result.activated },
                    metadata: {
                        scope: 'shop-catalog-activation',
                        undoSafe: false,
                        recovery: 'create_compensating_version',
                    },
                };
            },
        },
    };
}

module.exports = {
    assertSystemTarget,
    buildDraftPreview,
    createShopCatalogVersionExecutors,
};
