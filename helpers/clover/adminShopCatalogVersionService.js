'use strict';

const {
    activateShopCatalogVersion,
    createDraftShopCatalogVersion,
    previewShopCatalogActivation,
} = require('./shopCatalogVersionService');

let previewCounter = 0;

async function previewDraftWithRollback(db, operation, payload) {
    previewCounter += 1;
    const savepoint = `admin_shop_catalog_preview_${previewCounter}`;
    await db.exec(`SAVEPOINT ${savepoint}`);
    try {
        const draft = await createDraftShopCatalogVersion(
            db,
            {
                catalog: payload.catalog,
                reason: payload.reason || operation.reason,
            },
            { actorId: operation.actor.id }
        );
        await db.exec(`ROLLBACK TO ${savepoint}`);
        await db.exec(`RELEASE ${savepoint}`);
        return draft;
    } catch (error) {
        await db.exec(`ROLLBACK TO ${savepoint}`).catch(() => null);
        await db.exec(`RELEASE ${savepoint}`).catch(() => null);
        throw error;
    }
}

function createShopCatalogVersionExecutors() {
    return {
        'system.shop.catalog.version.create': {
            async preview({ db, operation, action }) {
                const draft = await previewDraftWithRollback(db, operation, action.payload || {});
                return {
                    summary: `Criar catálogo de Lojas v${draft.version}`,
                    before: null,
                    after: draft,
                    metadata: { undoSafe: false },
                };
            },
            async apply({ db, operation, action }) {
                const payload = action.payload || {};
                const draft = await createDraftShopCatalogVersion(
                    db,
                    {
                        catalog: payload.catalog,
                        reason: payload.reason || operation.reason,
                    },
                    { actorId: operation.actor.id }
                );
                return {
                    summary: `Catálogo de Lojas v${draft.version} criado como draft.`,
                    before: null,
                    after: draft,
                    metadata: { undoSafe: false },
                };
            },
        },
        'system.shop.catalog.version.activate': {
            async preview({ db, action }) {
                const preview = await previewShopCatalogActivation(db, Number(action.payload?.version));
                return {
                    summary: `Ativar catálogo de Lojas v${preview.candidate.version}`,
                    before: preview.active,
                    after: {
                        candidate: preview.candidate,
                        pendingPurchaseCount: preview.pendingPurchaseCount,
                    },
                    metadata: {
                        undoSafe: false,
                        blockedByPendingPurchases: preview.pendingPurchaseCount > 0,
                    },
                };
            },
            async apply({ db, operation, action }) {
                const result = await activateShopCatalogVersion(
                    db,
                    {
                        version: Number(action.payload?.version),
                    },
                    {
                        actorId: operation.actor.id,
                        transactionManaged: true,
                    }
                );
                return {
                    summary: `Catálogo de Lojas v${result.activated.version} ativado.`,
                    before: result.previous,
                    after: result.activated,
                    metadata: { undoSafe: false },
                };
            },
        },
    };
}

module.exports = {
    createShopCatalogVersionExecutors,
    previewDraftWithRollback,
};
