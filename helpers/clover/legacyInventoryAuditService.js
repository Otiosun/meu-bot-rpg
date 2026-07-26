'use strict';

const { playerKey } = require('./auditPrivacy');
const {
    hasStandaloneSpecification,
    splitParentheticalItem,
} = require('./legacyInventoryNormalization');

const GENERIC_ITEM_NAMES = new Set([
    'feitico',
    'item magico',
    'item',
    'recompensa',
    'premio',
]);

const REVIEW_ALIASES = Object.freeze({
    'dungeon exclusiva': ['acesso_dungeon_exclusiva'],
    'pocao de mana simples': ['pocao_mana'],
    'caixa simples de servico': ['box_simple_v1'],
});

function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    if (!text || ['-', '—', '–', 'null', 'undefined'].includes(text.toLowerCase())) return null;
    return text;
}

function normalizedKey(value) {
    const text = cleanText(value);
    if (!text) return '';
    return text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [tableName]
    );
    return Boolean(row?.found);
}

async function tableColumns(db, tableName) {
    if (!await tableExists(db, tableName)) return new Set();
    const rows = await db.all(`PRAGMA table_info(${tableName})`);
    return new Set(rows.map((row) => row.name));
}

function selectedColumn(columns, name, fallback = 'NULL') {
    return columns.has(name) ? name : `${fallback} AS ${name}`;
}

function mapTemplate(row) {
    return {
        templateKey: row.template_key,
        itemName: row.item_name,
        description: cleanText(row.description),
        category: cleanText(row.category),
        kind: cleanText(row.kind),
        active: Number(row.active ?? 1),
        stackable: Number(row.stackable ?? 0),
        transferable: Number(row.transferable ?? 0),
        properties: record(parseJson(row.properties_json, {})),
        effects: record(parseJson(row.effects_json, {})),
    };
}

function mapItem(row) {
    return {
        id: Number(row.id),
        playerKey: playerKey(row.player_id),
        characterName: cleanText(row.character_name),
        itemName: cleanText(row.item_name),
        description: cleanText(row.description),
        quantity: Number(row.quantity || 0),
        category: cleanText(row.category),
        kind: cleanText(row.kind),
        source: cleanText(row.source),
        relatedId: cleanText(row.related_id),
        status: cleanText(row.status),
        createdAt: cleanText(row.created_at),
        origin: cleanText(row.origin),
        transferable: row.transferable === null || row.transferable === undefined
            ? null
            : Number(row.transferable),
        properties: record(parseJson(row.properties_json, {})),
        effects: record(parseJson(row.effects_json, {})),
    };
}

async function readTemplates(db) {
    if (!await tableExists(db, 'clover_item_templates')) return [];
    const columns = await tableColumns(db, 'clover_item_templates');
    if (!columns.has('template_key') || !columns.has('item_name')) return [];
    const rows = await db.all(`
        SELECT template_key, item_name,
               ${selectedColumn(columns, 'description')},
               ${selectedColumn(columns, 'category')},
               ${selectedColumn(columns, 'kind')},
               ${selectedColumn(columns, 'active', '1')},
               ${selectedColumn(columns, 'stackable', '0')},
               ${selectedColumn(columns, 'transferable', '0')},
               ${selectedColumn(columns, 'properties_json', "'{}'")},
               ${selectedColumn(columns, 'effects_json', "'{}'")}
        FROM clover_item_templates
        ORDER BY item_name ASC, template_key ASC
    `);
    return rows.map(mapTemplate);
}

async function readLegacyItems(db) {
    if (!await tableExists(db, 'clover_inventory_items')) return [];
    const columns = await tableColumns(db, 'clover_inventory_items');
    if (!columns.has('id') || !columns.has('player_id') || !columns.has('item_name')) return [];
    const playerColumns = await tableColumns(db, 'jogadores');
    const canJoinPlayer = playerColumns.has('id');
    const characterSelect = canJoinPlayer && playerColumns.has('personagem_nome')
        ? 'j.personagem_nome AS character_name'
        : 'NULL AS character_name';
    const join = canJoinPlayer ? 'LEFT JOIN jogadores j ON j.id = i.player_id' : '';
    const rows = await db.all(`
        SELECT i.id, i.player_id, i.item_name,
               ${columns.has('description') ? 'i.description' : 'NULL AS description'},
               ${columns.has('quantity') ? 'i.quantity' : '1 AS quantity'},
               ${columns.has('category') ? 'i.category' : 'NULL AS category'},
               ${columns.has('kind') ? 'i.kind' : 'NULL AS kind'},
               ${columns.has('source') ? 'i.source' : 'NULL AS source'},
               ${columns.has('related_id') ? 'i.related_id' : 'NULL AS related_id'},
               ${columns.has('status') ? 'i.status' : 'NULL AS status'},
               ${columns.has('created_at') ? 'i.created_at' : 'NULL AS created_at'},
               ${columns.has('origin') ? 'i.origin' : 'NULL AS origin'},
               ${columns.has('transferable') ? 'i.transferable' : 'NULL AS transferable'},
               ${columns.has('properties_json') ? 'i.properties_json' : "'{}' AS properties_json"},
               ${columns.has('effects_json') ? 'i.effects_json' : "'{}' AS effects_json"},
               ${characterSelect}
        FROM clover_inventory_items i
        ${join}
        WHERE ${columns.has('template_key') ? "i.template_key IS NULL OR TRIM(i.template_key) = ''" : '1 = 1'}
        ORDER BY i.player_id ASC, i.created_at ASC, i.id ASC
    `);
    return rows.map(mapItem);
}

function buildTemplateIndex(templates) {
    const byKey = new Map();
    const byName = new Map();
    for (const template of templates) {
        byKey.set(template.templateKey, template);
        const key = normalizedKey(template.itemName);
        const current = byName.get(key) || [];
        current.push(template);
        byName.set(key, current);
    }
    return { byKey, byName };
}

function structuralCompatibility(item, template) {
    const sameCategory = Boolean(item.category && template.category && normalizedKey(item.category) === normalizedKey(template.category));
    const sameKind = Boolean(item.kind && template.kind && normalizedKey(item.kind) === normalizedKey(template.kind));
    return { sameCategory, sameKind };
}

function existingTemplateCandidates(item, index) {
    const exact = index.byName.get(normalizedKey(item.itemName)) || [];
    const candidates = [];
    for (const template of exact) {
        const compatibility = structuralCompatibility(item, template);
        candidates.push({
            templateKey: template.templateKey,
            itemName: template.itemName,
            description: template.description,
            category: template.category,
            kind: template.kind,
            transferable: template.transferable,
            properties: template.properties,
            effects: template.effects,
            confidence: compatibility.sameCategory && compatibility.sameKind ? 'high' : 'medium',
            reason: compatibility.sameCategory && compatibility.sameKind
                ? 'Mesmo nome, categoria e tipo do modelo existente.'
                : 'Mesmo nome, mas categoria ou tipo precisam ser conferidos.',
            compatibility,
        });
    }
    for (const templateKey of REVIEW_ALIASES[normalizedKey(item.itemName)] || []) {
        const template = index.byKey.get(templateKey);
        if (!template) continue;
        const compatibility = structuralCompatibility(item, template);
        candidates.push({
            templateKey: template.templateKey,
            itemName: template.itemName,
            description: template.description,
            category: template.category,
            kind: template.kind,
            transferable: template.transferable,
            properties: template.properties,
            effects: template.effects,
            confidence: 'medium',
            reason: 'Correspondência semântica conhecida, mas a regra ou classificação não é idêntica.',
            compatibility,
        });
    }
    return candidates;
}

function groupIdentity(item) {
    return [
        normalizedKey(item.itemName),
        normalizedKey(item.description),
        normalizedKey(item.category),
        normalizedKey(item.kind),
    ].join('|');
}

function repeatedGroups(items) {
    const groups = new Map();
    for (const item of items) {
        const key = groupIdentity(item);
        const current = groups.get(key) || [];
        current.push(item);
        groups.set(key, current);
    }
    return [...groups.values()]
        .filter((group) => group.length > 1)
        .map((group) => ({
            itemName: group[0].itemName,
            description: group[0].description,
            category: group[0].category,
            kind: group[0].kind,
            origin: group[0].origin,
            transferable: group[0].transferable,
            properties: group[0].properties,
            effects: group[0].effects,
            count: group.length,
            inventoryItemIds: group.map((item) => item.id),
            playerKeys: [...new Set(group.map((item) => item.playerKey).filter(Boolean))],
            generic: GENERIC_ITEM_NAMES.has(normalizedKey(group[0].itemName)),
            standaloneSpecification: hasStandaloneSpecification(group[0]),
        }));
}

function unclosedParentheses(value) {
    const text = cleanText(value) || '';
    return (text.match(/\(/g) || []).length - (text.match(/\)/g) || []).length;
}

function fragmentPairs(items) {
    const buckets = new Map();
    for (const item of items) {
        const key = [item.playerKey, item.source, item.relatedId, item.createdAt].join('|');
        const current = buckets.get(key) || [];
        current.push(item);
        buckets.set(key, current);
    }
    const pairs = [];
    for (const group of buckets.values()) {
        const ordered = [...group].sort((left, right) => left.id - right.id);
        for (let index = 0; index < ordered.length - 1; index += 1) {
            const first = ordered[index];
            const second = ordered[index + 1];
            if (unclosedParentheses(first.itemName) <= 0) continue;
            const mergedName = `${first.itemName} ${second.itemName}`.replace(/\s+/g, ' ').trim();
            if (unclosedParentheses(mergedName) !== 0) continue;
            const normalized = splitParentheticalItem(
                mergedName,
                first.description || second.description || null
            );
            pairs.push({
                confidence: 'high',
                reason: 'Dois registros adjacentes da mesma origem formam um único item; conteúdo entre parênteses foi separado como descrição.',
                keepInventoryItemId: first.id,
                removeInventoryItemId: second.id,
                inventoryItemIds: [first.id, second.id],
                playerKey: first.playerKey,
                source: first.source,
                relatedId: first.relatedId,
                proposedItemName: normalized.itemName,
                proposedDescription: normalized.description,
            });
        }
    }
    return pairs;
}

function classifyItem(item, index, repeatedByItemId, fragmentedIds) {
    const generic = GENERIC_ITEM_NAMES.has(normalizedKey(item.itemName));
    const candidates = existingTemplateCandidates(item, index);
    const repeated = repeatedByItemId.get(item.id) || null;
    if (fragmentedIds.has(item.id)) return { classification: 'fragment', generic, candidates, repeated };
    if (generic) return { classification: 'manual_specification', generic, candidates, repeated };
    if (candidates.some((candidate) => candidate.confidence === 'high')) {
        return { classification: 'existing_template_high', generic, candidates, repeated };
    }
    if (repeated && repeated.count >= 2 && repeated.standaloneSpecification) {
        return { classification: 'repeated_consistent_item', generic, candidates, repeated };
    }
    if (hasStandaloneSpecification(item)) {
        return { classification: 'standalone_model_candidate', generic, candidates, repeated };
    }
    if (candidates.length > 0) return { classification: 'existing_template_review', generic, candidates, repeated };
    return { classification: 'manual_review', generic, candidates, repeated };
}

async function auditLegacyInventoryItems(db) {
    if (!db?.all || !db?.get) throw new TypeError('Banco inválido.');
    const [templates, items] = await Promise.all([readTemplates(db), readLegacyItems(db)]);
    const index = buildTemplateIndex(templates);
    const groups = repeatedGroups(items);
    const repeatedByItemId = new Map();
    for (const group of groups) {
        for (const id of group.inventoryItemIds) repeatedByItemId.set(id, group);
    }
    const fragments = fragmentPairs(items);
    const fragmentedIds = new Set(fragments.flatMap((pair) => pair.inventoryItemIds));
    const auditedItems = items.map((item) => ({
        ...item,
        ...classifyItem(item, index, repeatedByItemId, fragmentedIds),
    }));
    const byClassification = auditedItems.reduce((accumulator, item) => {
        accumulator[item.classification] = (accumulator[item.classification] || 0) + 1;
        return accumulator;
    }, {});

    return {
        generatedAt: new Date().toISOString(),
        readOnly: true,
        privacy: {
            playerIds: 'sha256-prefix',
            rawPlayerIdsIncluded: false,
            phoneNumbersIncluded: false,
        },
        summary: {
            templatesTotal: templates.length,
            legacyInventoryItems: items.length,
            repeatedGroups: groups.length,
            fragmentPairs: fragments.length,
            byClassification,
        },
        fragmentPairs: fragments,
        repeatedGroups: groups,
        items: auditedItems,
    };
}

module.exports = {
    GENERIC_ITEM_NAMES,
    REVIEW_ALIASES,
    auditLegacyInventoryItems,
    cleanText,
    existingTemplateCandidates,
    fragmentPairs,
    normalizedKey,
    repeatedGroups,
    tableColumns,
    tableExists,
};
