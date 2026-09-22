'use strict';

const {
    activateTreeCatalogVersion,
    createTreeCatalogDraft,
    previewTreeCatalogActivation,
} = require('./skillTreeCatalogVersionService');

let previewCounter = 0;

async function previewDraftWithRollback(db, operation, payload) {
    previewCounter += 1;
    const savepoint = `admin_tree_catalog_preview_${previewCounter}`;
    await db.exec(`SAVEPOINT ${savepoint}`);
    try {
        const draft = await createTreeCatalogDraft(db, {
            treeId: payload.treeId ?? payload.tree_id ?? payload.catalog?.id,
            catalog: payload.catalog,
            reason: payload.reason || operation.reason,
            actorId: operation.actor.id,
        }, { transactionManaged: true });
        await db.exec(`ROLLBACK TO ${savepoint}`);
        await db.exec(`RELEASE ${savepoint}`);
        return draft;
    } catch (error) {
        await db.exec(`ROLLBACK TO ${savepoint}`).catch(() => null);
        await db.exec(`RELEASE ${savepoint}`).catch(() => null);
        throw error;
    }
}

function createSkillTreeCatalogExecutors() {
    return {
        'system.skill_tree.catalog.version.create': {
            async preview({ db, operation, action }) {
                const candidate = await previewDraftWithRollback(db, operation, action.payload || {});
                return {
                    summary: `${candidate.treeId}: criar versão draft v${candidate.version}`,
                    before: null,
                    after: candidate,
                    metadata: { undoSafe: false },
                };
            },
            async apply({ db, operation, action }) {
                const payload = action.payload || {};
                const created = await createTreeCatalogDraft(db, {
                    treeId: payload.treeId ?? payload.tree_id ?? payload.catalog?.id,
                    catalog: payload.catalog,
                    reason: payload.reason || operation.reason,
                    actorId: operation.actor.id,
                }, { transactionManaged: true });
                return {
                    before: null,
                    after: created,
                    summary: `${created.treeId}: versão draft v${created.version} criada.`,
                    metadata: { undoSafe: false },
                };
            },
        },

        'system.skill_tree.catalog.version.activate': {
            async preview({ db, operation, action }) {
                const payload = action.payload || {};
                const treeId = payload.treeId ?? payload.tree_id;
                const version = Number(payload.version);
                const preview = await previewTreeCatalogActivation(db, treeId, version, {
                    transactionManaged: true,
                    actorId: operation.actor.id,
                });
                return {
                    summary: `${preview.treeId}: ativar versão v${preview.candidate.version}`,
                    before: preview.active,
                    after: {
                        candidate: preview.candidate,
                        ownedNodeCount: preview.ownedNodeCount,
                        changedOwnedIds: preview.changedOwnedIds,
                        pendingPurchaseCount: preview.pendingPurchaseCount,
                    },
                    metadata: {
                        undoSafe: false,
                        requiresOwnedNodeAcknowledgement: preview.changedOwnedIds.length > 0,
                    },
                };
            },
            async apply({ db, operation, action }) {
                const payload = action.payload || {};
                const result = await activateTreeCatalogVersion(db, {
                    treeId: payload.treeId ?? payload.tree_id,
                    version: Number(payload.version),
                    actorId: operation.actor.id,
                    acknowledgeOwnedNodeChanges: payload.acknowledgeOwnedNodeChanges === true,
                }, { transactionManaged: true });
                return {
                    before: result.active,
                    after: result.activated,
                    summary: `${result.treeId}: versão v${result.activated.version} ativada.`,
                    metadata: {
                        changedOwnedIds: result.changedOwnedIds,
                        ownedNodeCount: result.ownedNodeCount,
                        undoSafe: false,
                    },
                };
            },
        },
    };
}

module.exports = {
    createSkillTreeCatalogExecutors,
    previewDraftWithRollback,
};
