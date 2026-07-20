'use strict';

const CONTENT_TYPES = Object.freeze([
    'system_trait',
    'custom_trait',
    'narrative_hook',
    'narrative_item',
]);

const MECHANICAL_STATUSES = Object.freeze([
    'not_applicable',
    'catalog_managed',
    'pending_balance',
    'approved',
    'disabled',
]);

const REVIEW_STATUSES = Object.freeze([
    'draft',
    'approved',
    'rejected',
    'archived',
]);

const LEGACY_TRAIT_FIELDS = Object.freeze([
    ['aptidao_comum', 'aptidao_comum_key'],
    ['aptidao_rara', 'aptidao_rara_key'],
    ['marca_comum', 'marca_comum_key'],
    ['marca_rara', 'marca_rara_key'],
    ['anomalia', 'anomalia_key'],
]);

function nonEmpty(value) {
    const text = String(value ?? '').trim();
    return Boolean(text) && !['-', '—', 'n/a', 'null', 'undefined'].includes(text.toLowerCase());
}

function normalizeContentKey(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
}

function parseJson(value, fallback = null) {
    if (value == null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function ensureCloverPlayerContentSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_player_content (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            content_type TEXT NOT NULL
                CHECK (content_type IN ('system_trait', 'custom_trait', 'narrative_hook', 'narrative_item')),
            content_key TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT DEFAULT NULL,
            raw_source_text TEXT DEFAULT NULL,
            mechanical_status TEXT NOT NULL DEFAULT 'not_applicable'
                CHECK (mechanical_status IN ('not_applicable', 'catalog_managed', 'pending_balance', 'approved', 'disabled')),
            review_status TEXT NOT NULL DEFAULT 'draft'
                CHECK (review_status IN ('draft', 'approved', 'rejected', 'archived')),
            linked_content_id INTEGER DEFAULT NULL,
            version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            source TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            UNIQUE (player_id, content_type, content_key, version),
            FOREIGN KEY (linked_content_id) REFERENCES clover_player_content(id)
        )
    `);

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_player_content_active_key
        ON clover_player_content (player_id, content_type, content_key)
        WHERE active = 1
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_player_content_player
        ON clover_player_content (player_id, active, content_type, id)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_player_content_linked
        ON clover_player_content (linked_content_id)
        WHERE linked_content_id IS NOT NULL
    `);
}

function assertContentRecord(record) {
    if (!record || typeof record !== 'object') throw new Error('Registro canônico inválido.');
    if (!String(record.playerId || '').includes('@')) throw new Error('playerId canônico inválido.');
    if (!CONTENT_TYPES.includes(record.contentType)) throw new Error(`contentType inválido: ${record.contentType}`);
    if (!MECHANICAL_STATUSES.includes(record.mechanicalStatus)) {
        throw new Error(`mechanicalStatus inválido: ${record.mechanicalStatus}`);
    }
    if (!REVIEW_STATUSES.includes(record.reviewStatus)) {
        throw new Error(`reviewStatus inválido: ${record.reviewStatus}`);
    }
    const key = normalizeContentKey(record.contentKey || record.title);
    if (!key) throw new Error('contentKey vazio.');
    if (!nonEmpty(record.title)) throw new Error('Título canônico vazio.');
    return { ...record, contentKey: key };
}

function compactContentRow(row) {
    return {
        id: Number(row.id),
        playerId: row.player_id,
        contentType: row.content_type,
        contentKey: row.content_key,
        title: row.title,
        body: row.body,
        rawSourceText: row.raw_source_text,
        mechanicalStatus: row.mechanical_status,
        reviewStatus: row.review_status,
        linkedContentId: row.linked_content_id == null ? null : Number(row.linked_content_id),
        version: Number(row.version || 1),
        active: Number(row.active || 0) === 1,
        source: row.source,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: parseJson(row.metadata_json, {}),
    };
}

async function listCanonicalPlayerContent(db, playerId, { includeInactive = false } = {}) {
    await ensureCloverPlayerContentSchema(db);
    const rows = await db.all(
        `SELECT *
         FROM clover_player_content
         WHERE player_id = ?
           ${includeInactive ? '' : 'AND active = 1'}
         ORDER BY content_type ASC, title COLLATE NOCASE ASC, version DESC, id DESC`,
        [playerId]
    );
    return rows.map(compactContentRow);
}

function legacyContentFromPlayer(player) {
    if (!player) return { traits: [], narrativeHook: null, extraStories: [] };
    const traits = LEGACY_TRAIT_FIELDS.map(([labelField, keyField]) => ({
        source: 'legacy_profile',
        labelField,
        keyField,
        title: player[labelField] ?? null,
        key: player[keyField] ?? null,
    })).filter((item) => nonEmpty(item.title) || nonEmpty(item.key));

    return {
        traits,
        narrativeHook: nonEmpty(player.gancho_narrativo) ? player.gancho_narrativo : null,
        extraStories: parseJson(player.historias_extras, []),
    };
}

function groupCanonicalContent(records) {
    const grouped = {
        systemTraits: [],
        customTraits: [],
        narrativeHooks: [],
        narrativeItems: [],
    };
    for (const record of records || []) {
        if (record.contentType === 'system_trait') grouped.systemTraits.push(record);
        else if (record.contentType === 'custom_trait') grouped.customTraits.push(record);
        else if (record.contentType === 'narrative_hook') grouped.narrativeHooks.push(record);
        else if (record.contentType === 'narrative_item') grouped.narrativeItems.push(record);
    }
    return grouped;
}

async function getCombinedPlayerContent(db, playerId, { includeInactive = false } = {}) {
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!player) return null;
    const canonical = await listCanonicalPlayerContent(db, playerId, { includeInactive });
    return {
        playerId,
        legacy: legacyContentFromPlayer(player),
        canonical: groupCanonicalContent(canonical),
        canonicalRecords: canonical,
    };
}

module.exports = {
    CONTENT_TYPES,
    MECHANICAL_STATUSES,
    REVIEW_STATUSES,
    assertContentRecord,
    compactContentRow,
    ensureCloverPlayerContentSchema,
    getCombinedPlayerContent,
    groupCanonicalContent,
    legacyContentFromPlayer,
    listCanonicalPlayerContent,
    normalizeContentKey,
};