'use strict';

function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
    return Array.isArray(value) ? value : [];
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

function parseJson(value, fallback) {
    if (!value) return fallback;
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

function candidateIdentity(candidate) {
    return [
        candidate.source,
        normalizedKey(candidate.description),
        cleanText(candidate.templateId) || '',
        cleanText(candidate.playerId) || '',
        cleanText(candidate.sourceRef) || '',
    ].join(':');
}

function addCandidate(bucket, candidateInput) {
    const description = cleanText(candidateInput.description);
    if (!description) return;
    const candidate = {
        source: candidateInput.source,
        confidence: candidateInput.confidence,
        reason: candidateInput.reason,
        description,
        effect: cleanText(candidateInput.effect),
        restrictions: cleanText(candidateInput.restrictions),
        templateId: cleanText(candidateInput.templateId),
        playerId: cleanText(candidateInput.playerId),
        characterName: cleanText(candidateInput.characterName),
        sourceRef: cleanText(candidateInput.sourceRef),
    };
    const identity = candidateIdentity(candidate);
    if (bucket.some((entry) => candidateIdentity(entry) === identity)) return;
    bucket.push(candidate);
}

function rankConfidence(value) {
    return { high: 3, medium: 2, low: 1 }[value] || 0;
}

function sortCandidates(candidates) {
    return [...candidates].sort((left, right) => {
        const confidence = rankConfidence(right.confidence) - rankConfidence(left.confidence);
        if (confidence !== 0) return confidence;
        return left.source.localeCompare(right.source, 'pt-BR');
    });
}

function buildTemplateIndex(templates) {
    const byId = new Map();
    const byName = new Map();
    for (const template of templates) {
        byId.set(template.id, template);
        const key = normalizedKey(template.name);
        if (!key) continue;
        const current = byName.get(key) || [];
        current.push(template);
        byName.set(key, current);
    }
    return { byId, byName };
}

function matchingTemplates(index, name, slotKey = null) {
    const matches = index.byName.get(normalizedKey(name)) || [];
    if (!slotKey) return matches;
    const normalizedSlot = cleanText(slotKey)?.toLowerCase();
    return matches.filter((template) => template.slotKey === normalizedSlot);
}

function traitOverrideFromMetadata(metadataValue) {
    const metadata = record(parseJson(metadataValue, {}));
    return record(metadata.traitOverride ?? metadata.trait_override);
}

function legacyEntries(value) {
    const parsed = parseJson(value, []);
    if (Array.isArray(parsed)) return parsed;
    const source = record(parsed);
    return [
        ...list(source.traits),
        ...list(source.tracos),
        ...list(source.items),
        ...list(source.entries),
    ];
}

async function readTemplates(db) {
    if (!await tableExists(db, 'clover_trait_templates')) return [];
    const rows = await db.all(`
        SELECT id, name, slot_key, description, effect_text, restrictions_text,
               status, canonical_key, trait_kind, source
        FROM clover_trait_templates
        ORDER BY slot_key ASC, name ASC, id ASC
    `);
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        slotKey: row.slot_key,
        description: cleanText(row.description),
        effect: cleanText(row.effect_text),
        restrictions: cleanText(row.restrictions_text),
        status: row.status,
        canonicalKey: row.canonical_key,
        traitKind: row.trait_kind,
        source: row.source,
        candidates: [],
    }));
}

async function collectAssignmentCandidates(db, index) {
    if (!await tableExists(db, 'clover_player_traits')) return;
    const playerColumns = await tableColumns(db, 'jogadores');
    const hasPlayers = playerColumns.has('id');
    const characterSelect = hasPlayers && playerColumns.has('personagem_nome')
        ? 'j.personagem_nome AS character_name'
        : 'NULL AS character_name';
    const join = hasPlayers ? 'LEFT JOIN jogadores j ON j.id = pt.player_id' : '';
    const rows = await db.all(`
        SELECT pt.id, pt.player_id, pt.trait_id, pt.slot_key, pt.value_text,
               pt.metadata_json, ${characterSelect}
        FROM clover_player_traits pt
        ${join}
        WHERE pt.active = 1
        ORDER BY pt.id ASC
    `);

    for (const row of rows) {
        const override = traitOverrideFromMetadata(row.metadata_json);
        const description = override.description ?? override.descricao;
        if (!cleanText(description)) continue;
        const exact = index.byId.get(row.trait_id);
        const targets = exact ? [exact] : matchingTemplates(index, row.value_text, row.slot_key);
        for (const template of targets) {
            addCandidate(template.candidates, {
                source: 'player_trait_override',
                confidence: exact ? 'high' : 'medium',
                reason: exact
                    ? 'Descrição pessoal ligada diretamente ao mesmo modelo de traço.'
                    : 'Descrição pessoal com mesmo nome e espaço de traço.',
                description,
                effect: override.effect ?? override.effectText ?? override.effect_text,
                restrictions: override.restrictions ?? override.restrictionsText ?? override.restrictions_text,
                templateId: row.trait_id,
                playerId: row.player_id,
                characterName: row.character_name,
                sourceRef: `clover_player_traits:${row.id}`,
            });
        }
    }
}

async function collectContentCandidates(db, index) {
    if (!await tableExists(db, 'clover_player_content')) return;
    const columns = await tableColumns(db, 'clover_player_content');
    if (!columns.has('title')) return;
    const selected = [
        'id', 'player_id', 'content_type', 'title',
        columns.has('body') ? 'body' : 'NULL AS body',
        columns.has('metadata_json') ? 'metadata_json' : "'{}' AS metadata_json",
    ];
    const rows = await db.all(`
        SELECT ${selected.join(', ')}
        FROM clover_player_content
        WHERE ${columns.has('active') ? 'active = 1 AND ' : ''}
              LOWER(COALESCE(content_type, '')) IN ('custom_trait','system_trait','trait','traco','traço')
        ORDER BY id ASC
    `);
    for (const row of rows) {
        const metadata = record(parseJson(row.metadata_json, {}));
        const slotKey = cleanText(metadata.slotKey ?? metadata.slot_key);
        const targets = matchingTemplates(index, row.title, slotKey);
        for (const template of targets) {
            addCandidate(template.candidates, {
                source: 'player_content',
                confidence: slotKey ? 'medium' : 'low',
                reason: slotKey
                    ? 'Conteúdo de traço com mesmo nome e espaço.'
                    : 'Conteúdo de traço com mesmo nome, sem espaço confirmado.',
                description: row.body,
                playerId: row.player_id,
                sourceRef: `clover_player_content:${row.id}`,
            });
        }
    }
}

async function collectLegacyExtraCandidates(db, index) {
    const columns = await tableColumns(db, 'jogadores');
    if (!columns.has('id') || !columns.has('historias_extras')) return;
    const nameSelect = columns.has('personagem_nome') ? 'personagem_nome' : 'NULL AS personagem_nome';
    const rows = await db.all(`
        SELECT id, ${nameSelect}, historias_extras
        FROM jogadores
        WHERE historias_extras IS NOT NULL AND TRIM(historias_extras) <> ''
        ORDER BY id ASC
    `);
    for (const row of rows) {
        legacyEntries(row.historias_extras).forEach((entry, indexInSource) => {
            const item = record(entry);
            const title = cleanText(item.title ?? item.name ?? item.nome ?? item.label);
            const description = cleanText(item.description ?? item.descricao ?? item.body ?? item.text);
            if (!title || !description) return;
            const type = normalizedKey(item.type ?? item.tipo);
            const slotKey = type.includes('anomalia') || type.includes('anomaly')
                ? 'extra_anomaly'
                : type.includes('traco') || type.includes('trait')
                    ? 'extra_trait'
                    : null;
            const targets = matchingTemplates(index, title, slotKey);
            for (const template of targets) {
                addCandidate(template.candidates, {
                    source: 'historias_extras',
                    confidence: slotKey ? 'medium' : 'low',
                    reason: slotKey
                        ? 'Registro legado com mesmo nome e categoria de traço.'
                        : 'Registro legado com mesmo nome, mas categoria não confirmada.',
                    description,
                    playerId: row.id,
                    characterName: row.personagem_nome,
                    sourceRef: `jogadores.historias_extras:${indexInSource}`,
                });
            }
        });
    }
}

async function collectBonusCandidates(db, index) {
    if (!await tableExists(db, 'clover_character_bonuses')) return;
    const columns = await tableColumns(db, 'clover_character_bonuses');
    if (!columns.has('name') || !columns.has('description')) return;
    const rows = await db.all(`
        SELECT id, player_id, name, type, description
        FROM clover_character_bonuses
        WHERE description IS NOT NULL AND TRIM(description) <> ''
        ORDER BY id ASC
    `);
    for (const row of rows) {
        const type = normalizedKey(row.type);
        if (type && !type.includes('traco') && !type.includes('trait') && !type.includes('anomalia')) continue;
        const targets = matchingTemplates(index, row.name);
        for (const template of targets) {
            addCandidate(template.candidates, {
                source: 'character_bonus',
                confidence: type ? 'medium' : 'low',
                reason: type
                    ? 'Bônus classificado como traço ou anomalia com mesmo nome.'
                    : 'Bônus com mesmo nome, sem classificação suficiente.',
                description: row.description,
                playerId: row.player_id,
                sourceRef: `clover_character_bonuses:${row.id}`,
            });
        }
    }
}

async function auditTraitDescriptions(db) {
    if (!db?.all || !db?.get) throw new TypeError('Banco inválido.');
    const templates = await readTemplates(db);
    const missing = templates.filter((template) => !template.description);
    const index = buildTemplateIndex(missing);

    await collectAssignmentCandidates(db, index);
    await collectContentCandidates(db, index);
    await collectLegacyExtraCandidates(db, index);
    await collectBonusCandidates(db, index);

    const audited = missing.map((template) => ({
        ...template,
        candidates: sortCandidates(template.candidates),
    }));
    const highConfidence = audited.filter((template) => template.candidates.some((candidate) => candidate.confidence === 'high'));
    const withCandidates = audited.filter((template) => template.candidates.length > 0);

    return {
        generatedAt: new Date().toISOString(),
        readOnly: true,
        summary: {
            templatesTotal: templates.length,
            templatesWithDescription: templates.length - missing.length,
            templatesMissingDescription: missing.length,
            missingWithCandidates: withCandidates.length,
            missingWithHighConfidenceCandidate: highConfidence.length,
            missingWithoutCandidate: missing.length - withCandidates.length,
        },
        templates: audited,
    };
}

module.exports = {
    auditTraitDescriptions,
    cleanText,
    normalizedKey,
    parseJson,
    tableColumns,
    tableExists,
};
