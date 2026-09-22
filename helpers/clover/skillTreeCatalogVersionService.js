'use strict';

const crypto = require('node:crypto');
const {
    getTree,
    hydrateTree,
    loadTreeSources,
    normalizeKey,
} = require('./treeLoader');

class SkillTreeCatalogVersionError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'SkillTreeCatalogVersionError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])
    );
}

function stableJson(value) {
    return JSON.stringify(canonicalValue(value));
}

function fingerprintCatalog(catalog) {
    return crypto.createHash('sha256').update(stableJson(catalog)).digest('hex');
}

function parseCatalog(value, label = 'catalog') {
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not_object');
        return parsed;
    } catch (error) {
        throw new SkillTreeCatalogVersionError(
            'invalid_tree_catalog_json',
            'O catálogo da Árvore não é um JSON válido.',
            400,
            { label, cause: error?.message || String(error) }
        );
    }
}

function validateCatalog(catalog, expectedTreeId = null, label = 'catalog') {
    const parsed = parseCatalog(catalog, label);
    let hydrated;
    try {
        hydrated = hydrateTree(parsed, `db:${label}`);
    } catch (error) {
        throw new SkillTreeCatalogVersionError(
            'invalid_tree_catalog',
            error?.message || 'Catálogo de Árvore inválido.',
            400,
            { label }
        );
    }
    if (expectedTreeId && normalizeKey(hydrated.id) !== normalizeKey(expectedTreeId)) {
        throw new SkillTreeCatalogVersionError(
            'tree_catalog_id_mismatch',
            'O ID do catálogo não corresponde à Árvore selecionada.',
            409,
            { expectedTreeId, observedTreeId: hydrated.id }
        );
    }
    return { parsed, hydrated };
}

async function catalogTablesAvailable(db) {
    if (!db?.get) return false;
    const row = await db.get(
        "SELECT COUNT(*) AS total FROM sqlite_schema WHERE type = 'table' AND name IN ('clover_skill_tree_catalog_versions', 'clover_skill_tree_catalog_active')"
    );
    return Number(row?.total || 0) === 2;
}

function sourceCatalogForTree(treeId) {
    const normalized = normalizeKey(treeId);
    const source = loadTreeSources().find(({ tree }) => normalizeKey(tree?.id) === normalized);
    if (!source) return null;
    validateCatalog(source.tree, treeId, source.filePath);
    return source.tree;
}

async function getActiveCatalogRow(db, treeId) {
    const normalized = normalizeKey(treeId);
    if (!normalized || !(await catalogTablesAvailable(db))) return null;
    return db.get(
        [
            'SELECT version.tree_id, version.version, version.status, version.fingerprint,',
            '       version.catalog_json, version.source, version.reason, version.created_by,',
            '       version.created_at, version.activated_at, version.archived_at,',
            '       active.updated_by, active.updated_at',
            '  FROM clover_skill_tree_catalog_active active',
            '  JOIN clover_skill_tree_catalog_versions version',
            '    ON version.tree_id = active.tree_id AND version.version = active.version',
            ' WHERE active.tree_id = ?',
            ' LIMIT 1',
        ].join('\n'),
        [normalized]
    );
}

function hydrateVersionRow(row) {
    if (!row) return null;
    const catalog = parseCatalog(row.catalog_json, `${row.tree_id}:v${row.version}`);
    return {
        treeId: row.tree_id,
        version: Number(row.version),
        status: row.status,
        fingerprint: row.fingerprint,
        catalog,
        source: row.source || null,
        reason: row.reason || null,
        createdBy: row.created_by || null,
        createdAt: row.created_at || null,
        activatedAt: row.activated_at || null,
        archivedAt: row.archived_at || null,
        updatedBy: row.updated_by || null,
        updatedAt: row.updated_at || null,
    };
}

async function getRuntimeTree(db, treeId = 'mana') {
    const fallback = getTree(treeId);
    if (!db || !(await catalogTablesAvailable(db))) return fallback;
    const row = await getActiveCatalogRow(db, treeId);
    if (!row) return fallback;
    const version = hydrateVersionRow(row);
    const { hydrated } = validateCatalog(version.catalog, treeId, `${version.treeId}:v${version.version}`);
    return {
        ...hydrated,
        catalogVersion: version.version,
        catalogFingerprint: version.fingerprint,
        catalogSource: 'database',
    };
}

async function withManagedTransaction(db, options, task) {
    const manages = options?.transactionManaged !== true;
    if (manages) await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await task();
        if (manages) await db.exec('COMMIT');
        return result;
    } catch (error) {
        if (manages) await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function ensureTreeCatalogSeed(db, treeId, actorId = 'system', options = {}) {
    const normalized = normalizeKey(treeId);
    if (!normalized) throw new SkillTreeCatalogVersionError('missing_tree_id', 'Informe a Árvore.');
    if (!(await catalogTablesAvailable(db))) {
        throw new SkillTreeCatalogVersionError(
            'tree_catalog_schema_unavailable',
            'O schema versionado de Árvores ainda não está disponível.',
            503
        );
    }
    const existing = await db.get(
        'SELECT tree_id, version FROM clover_skill_tree_catalog_versions WHERE tree_id = ? ORDER BY version ASC LIMIT 1',
        [normalized]
    );
    if (existing) return getActiveCatalogRow(db, normalized);
    const source = sourceCatalogForTree(normalized);
    if (!source) throw new SkillTreeCatalogVersionError('tree_not_found', 'Árvore não encontrada.', 404, { treeId });
    const fingerprint = fingerprintCatalog(source);
    return withManagedTransaction(db, options, async () => {
        await db.run(
            [
                'INSERT INTO clover_skill_tree_catalog_versions',
                '    (tree_id, version, status, fingerprint, catalog_json, source, reason, created_by, activated_at)',
                "VALUES (?, 1, 'active', ?, ?, 'filesystem_seed', ?, ?, CURRENT_TIMESTAMP)",
            ].join('\n'),
            [normalized, fingerprint, stableJson(source), 'Seed canônico do catálogo JSON atual.', actorId]
        );
        await db.run(
            [
                'INSERT INTO clover_skill_tree_catalog_active',
                '    (tree_id, version, fingerprint, updated_by, updated_at)',
                'VALUES (?, 1, ?, ?, CURRENT_TIMESTAMP)',
            ].join('\n'),
            [normalized, fingerprint, actorId]
        );
        return getActiveCatalogRow(db, normalized);
    });
}

async function listTreeCatalogVersions(db, treeId, options = {}) {
    const normalized = normalizeKey(treeId);
    if (!normalized) throw new SkillTreeCatalogVersionError('missing_tree_id', 'Informe a Árvore.');
    if (options.ensureSeed !== false) await ensureTreeCatalogSeed(db, normalized, options.actorId || 'system');
    const rows = await db.all(
        [
            'SELECT tree_id, version, status, fingerprint, catalog_json, source, reason, created_by,',
            '       created_at, activated_at, archived_at',
            '  FROM clover_skill_tree_catalog_versions',
            ' WHERE tree_id = ?',
            ' ORDER BY version DESC',
        ].join('\n'),
        [normalized]
    );
    return rows.map(hydrateVersionRow);
}

async function createTreeCatalogDraft(db, input = {}, options = {}) {
    const treeId = normalizeKey(input.treeId ?? input.tree_id ?? input.catalog?.id);
    if (!treeId) throw new SkillTreeCatalogVersionError('missing_tree_id', 'Informe a Árvore.');
    const actorId = String(input.actorId || input.createdBy || 'system').trim();
    const reason = String(input.reason || '').trim();
    if (!reason) throw new SkillTreeCatalogVersionError('missing_reason', 'Informe o motivo da nova versão.');
    await ensureTreeCatalogSeed(db, treeId, actorId, { transactionManaged: options.transactionManaged });
    const { parsed } = validateCatalog(input.catalog, treeId, `${treeId}:draft`);
    const fingerprint = fingerprintCatalog(parsed);
    const duplicate = await db.get(
        'SELECT version, status FROM clover_skill_tree_catalog_versions WHERE tree_id = ? AND fingerprint = ?',
        [treeId, fingerprint]
    );
    if (duplicate) {
        throw new SkillTreeCatalogVersionError(
            'tree_catalog_unchanged',
            'Já existe uma versão com exatamente este catálogo.',
            409,
            { treeId, version: Number(duplicate.version), status: duplicate.status }
        );
    }
    return withManagedTransaction(db, options, async () => {
        const row = await db.get(
            'SELECT COALESCE(MAX(version), 0) AS version FROM clover_skill_tree_catalog_versions WHERE tree_id = ?',
            [treeId]
        );
        const version = Number(row?.version || 0) + 1;
        await db.run(
            [
                'INSERT INTO clover_skill_tree_catalog_versions',
                '    (tree_id, version, status, fingerprint, catalog_json, source, reason, created_by)',
                "VALUES (?, ?, 'draft', ?, ?, 'admin', ?, ?)",
            ].join('\n'),
            [treeId, version, fingerprint, stableJson(parsed), reason, actorId]
        );
        const created = await db.get(
            'SELECT * FROM clover_skill_tree_catalog_versions WHERE tree_id = ? AND version = ?',
            [treeId, version]
        );
        return hydrateVersionRow(created);
    });
}

function nodeMap(catalog) {
    return new Map((catalog?.nodes || []).map((node) => [String(node.id), node]));
}

async function previewTreeCatalogActivation(db, treeId, version, options = {}) {
    const normalized = normalizeKey(treeId);
    await ensureTreeCatalogSeed(db, normalized, options.actorId || 'system', { transactionManaged: options.transactionManaged });
    const candidateRow = await db.get(
        'SELECT * FROM clover_skill_tree_catalog_versions WHERE tree_id = ? AND version = ?',
        [normalized, Number(version)]
    );
    if (!candidateRow) throw new SkillTreeCatalogVersionError('tree_catalog_version_not_found', 'Versão de Árvore não encontrada.', 404);
    if (candidateRow.status !== 'draft') {
        throw new SkillTreeCatalogVersionError('tree_catalog_version_not_draft', 'Somente versões draft podem ser ativadas.', 409);
    }
    const candidate = hydrateVersionRow(candidateRow);
    validateCatalog(candidate.catalog, normalized, `${normalized}:v${candidate.version}`);
    const activeRow = await getActiveCatalogRow(db, normalized);
    const active = hydrateVersionRow(activeRow);
    const ownedRows = await db.all(
        'SELECT DISTINCT node_id FROM clover_skill_nodes WHERE tree_id = ? ORDER BY node_id',
        [normalized]
    );
    const ownedIds = ownedRows.map((row) => String(row.node_id));
    const candidateNodes = nodeMap(candidate.catalog);
    const missingOwnedIds = ownedIds.filter((id) => !candidateNodes.has(id));
    if (missingOwnedIds.length) {
        throw new SkillTreeCatalogVersionError(
            'tree_catalog_removes_owned_nodes',
            'A versão candidata remove nós já possuídos por jogadores.',
            409,
            { missingOwnedIds }
        );
    }
    const pending = await db.get(
        'SELECT COUNT(*) AS total FROM clover_pending_skill_purchases WHERE tree_id = ?',
        [normalized]
    );
    const activeNodes = nodeMap(active?.catalog || {});
    const changedOwnedIds = ownedIds.filter((id) => {
        const before = activeNodes.get(id);
        const after = candidateNodes.get(id);
        return before && after && stableJson(before) !== stableJson(after);
    });
    return {
        treeId: normalized,
        active,
        candidate,
        ownedNodeCount: ownedIds.length,
        changedOwnedIds,
        pendingPurchaseCount: Number(pending?.total || 0),
    };
}

async function activateTreeCatalogVersion(db, input = {}, options = {}) {
    const treeId = normalizeKey(input.treeId ?? input.tree_id);
    const version = Number(input.version);
    const actorId = String(input.actorId || input.activatedBy || 'system').trim();
    if (!treeId || !Number.isInteger(version) || version <= 0) {
        throw new SkillTreeCatalogVersionError('invalid_tree_catalog_activation', 'Árvore/versão inválida.');
    }
    const preview = await previewTreeCatalogActivation(db, treeId, version, { transactionManaged: options.transactionManaged, actorId });
    if (preview.pendingPurchaseCount > 0) {
        throw new SkillTreeCatalogVersionError(
            'tree_catalog_pending_purchases',
            'Existem compras de nós pendentes. Aguarde/cancele antes de ativar a versão.',
            409,
            { pendingPurchaseCount: preview.pendingPurchaseCount }
        );
    }
    if (preview.changedOwnedIds.length && input.acknowledgeOwnedNodeChanges !== true) {
        throw new SkillTreeCatalogVersionError(
            'tree_catalog_owned_node_changes_require_ack',
            'A versão altera nós já aprendidos. Confirme explicitamente o impacto antes de ativar.',
            409,
            { changedOwnedIds: preview.changedOwnedIds }
        );
    }
    return withManagedTransaction(db, options, async () => {
        if (preview.active) {
            await db.run(
                [
                    "UPDATE clover_skill_tree_catalog_versions SET status = 'archived', archived_at = CURRENT_TIMESTAMP",
                    " WHERE tree_id = ? AND version = ? AND status = 'active'",
                ].join('\n'),
                [treeId, preview.active.version]
            );
        }
        await db.run(
            [
                "UPDATE clover_skill_tree_catalog_versions SET status = 'active', activated_at = CURRENT_TIMESTAMP, archived_at = NULL",
                " WHERE tree_id = ? AND version = ? AND status = 'draft'",
            ].join('\n'),
            [treeId, version]
        );
        await db.run(
            [
                'INSERT INTO clover_skill_tree_catalog_active (tree_id, version, fingerprint, updated_by, updated_at)',
                'VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
                'ON CONFLICT(tree_id) DO UPDATE SET',
                '    version = excluded.version, fingerprint = excluded.fingerprint,',
                '    updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP',
            ].join('\n'),
            [treeId, version, preview.candidate.fingerprint, actorId]
        );
        return {
            ...preview,
            activated: hydrateVersionRow(await getActiveCatalogRow(db, treeId)),
        };
    });
}

module.exports = {
    SkillTreeCatalogVersionError,
    activateTreeCatalogVersion,
    catalogTablesAvailable,
    createTreeCatalogDraft,
    ensureTreeCatalogSeed,
    fingerprintCatalog,
    getActiveCatalogRow,
    getRuntimeTree,
    hydrateVersionRow,
    listTreeCatalogVersions,
    previewTreeCatalogActivation,
    sourceCatalogForTree,
    stableJson,
    validateCatalog,
};
