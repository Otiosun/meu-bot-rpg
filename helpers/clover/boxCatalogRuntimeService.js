'use strict';

const {
    BoxCatalogVersionError,
    fingerprint,
    getActiveBoxCatalogVersion,
    validateBoxCatalogDefinition,
    validateBoxPityPolicy,
} = require('./boxCatalogVersionService');

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

async function getRuntimeBoxCatalog(db, boxKey) {
    return runtimeCatalogFromVersion(await getActiveBoxCatalogVersion(db, boxKey));
}

async function getRuntimeBoxCatalogs(db) {
    const result = {};
    for (const boxKey of ['simples', 'rara']) {
        result[boxKey] = await getRuntimeBoxCatalog(db, boxKey);
    }
    return result;
}

module.exports = {
    getRuntimeBoxCatalog,
    getRuntimeBoxCatalogs,
    runtimeCatalogFromVersion,
};
