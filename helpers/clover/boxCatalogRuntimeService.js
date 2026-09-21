'use strict';

const {
    BoxCatalogVersionError,
    fingerprint,
    getActiveBoxCatalogVersion,
    validateBoxCatalogDefinition,
    validateBoxPityPolicy,
} = require('./boxCatalogVersionService');

const bootstrapByDb = new WeakMap();

function runtimeCatalogFromVersion(version) {
    if (!version) {
        throw new BoxCatalogVersionError(
            'active_box_catalog_missing',
            'Não existe versão ativa para esta Caixa.',
            503
        );
    }
    if (version.status !== 'active') {
        throw new BoxCatalogVersionError(
            'box_catalog_not_active',
            'A versão selecionada não está ativa.',
            503,
            { boxKey: version.boxKey, version: version.version, status: version.status }
        );
    }
    const catalog = validateBoxCatalogDefinition(version.catalog, { boxKey: version.boxKey });
    const pityPolicy = validateBoxPityPolicy(version.pityPolicy, version.boxKey);
    const calculated = fingerprint({ catalog, policy: pityPolicy });
    if (calculated !== version.fingerprint) {
        throw new BoxCatalogVersionError(
            'box_catalog_fingerprint_mismatch',
            'A versão ativa da Caixa não corresponde ao fingerprint persistido. Abertura bloqueada.',
            503,
            { boxKey: version.boxKey, version: version.version }
        );
    }
    return {
        ...catalog,
        pityPolicy,
        runtime: {
            persisted: true,
            fingerprint: version.fingerprint,
            source: version.source,
            activatedAt: version.activatedAt,
        },
    };
}

async function ensureRuntimeCatalogBootstrap(db) {
    if (!db || (typeof db !== 'object' && typeof db !== 'function')) {
        throw new BoxCatalogVersionError('box_catalog_db_missing', 'Banco indisponível para resolver catálogo.', 503);
    }
    const existing = bootstrapByDb.get(db);
    if (existing) return existing;
    const promise = (async () => {
        // getActiveBoxCatalogVersion executa o bootstrap fonte das duas Caixas.
        // Serializar esta primeira chamada evita duas requisições do mesmo runtime
        // disputarem a importação inicial da v3.
        await getActiveBoxCatalogVersion(db, 'simples');
        return true;
    })();
    bootstrapByDb.set(db, promise);
    try {
        return await promise;
    } catch (error) {
        bootstrapByDb.delete(db);
        throw error;
    }
}

async function getRuntimeBoxCatalog(db, boxKey) {
    await ensureRuntimeCatalogBootstrap(db);
    return runtimeCatalogFromVersion(await getActiveBoxCatalogVersion(db, boxKey));
}

async function getRuntimeBoxCatalogs(db) {
    await ensureRuntimeCatalogBootstrap(db);
    const result = {};
    for (const boxKey of ['simples', 'rara']) {
        result[boxKey] = runtimeCatalogFromVersion(await getActiveBoxCatalogVersion(db, boxKey));
    }
    return result;
}

module.exports = {
    ensureRuntimeCatalogBootstrap,
    getRuntimeBoxCatalog,
    getRuntimeBoxCatalogs,
    runtimeCatalogFromVersion,
};
