'use strict';

const {
    TRAIT_SLOTS,
    ensureAdminTraitSchema,
    getPlayerTraitState,
    getTraitTemplate,
    slugifyTraitKey,
} = require('./adminTraitService');

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

async function listPlayerExtraTraitsSafe(db, player) {
    const rows = await db.all(
        `SELECT pt.*
         FROM clover_player_traits pt
         WHERE pt.player_id = ?
           AND pt.active = 1
           AND pt.slot_key IN ('extra_trait', 'extra_anomaly')
         ORDER BY pt.slot_key ASC, pt.position ASC, pt.id ASC`,
        [player.id]
    );

    const result = [];
    for (const row of rows) {
        const trait = await getTraitTemplate(db, row.trait_id, { nullIfMissing: true });
        result.push({
            playerId: player.id,
            characterName: player.personagem_nome || player.id,
            slotKey: row.slot_key,
            value: row.value_text,
            source: trait ? 'catalog' : 'legacy',
            assignment: {
                id: row.id,
                traitId: row.trait_id,
                valueText: row.value_text,
                slotKey: row.slot_key,
                position: Number(row.position || 0),
                operationCode: row.operation_code,
                assignedBy: row.assigned_by,
                assignedAt: row.assigned_at,
                source: row.source || null,
                legacyRef: row.legacy_ref || null,
                metadata: parseJson(row.metadata_json, {}),
            },
            trait,
        });
    }
    return result;
}

function mapContent(row) {
    return {
        id: row.id,
        type: row.content_type,
        key: row.content_key,
        title: row.title,
        body: row.body || null,
        rawSourceText: row.raw_source_text || null,
        mechanicalStatus: row.mechanical_status,
        reviewStatus: row.review_status,
        version: Number(row.version || 1),
        source: row.source || null,
        metadata: parseJson(row.metadata_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function mapLegacyExtra(player, entry, index) {
    const type = String(entry?.type || entry?.tipo || '').trim().toLowerCase();
    const title = String(entry?.title || '').trim();
    const description = String(entry?.description || '').trim() || null;
    if (!title) return null;
    const slotKey = type === 'anomalia' || type === 'anomaly' ? 'extra_anomaly' : 'extra_trait';
    return {
        playerId: player.id,
        characterName: player.personagem_nome || player.id,
        slotKey,
        value: title,
        source: 'legacy',
        assignment: null,
        trait: {
            id: null,
            name: title,
            slotKey,
            description,
            status: 'legacy',
            version: 0,
            metadata: {
                legacyType: type,
                legacyIndex: index,
            },
        },
    };
}

function mergeLegacyHooks(player, content, extras) {
    const hooks = content.filter((item) => item.type === 'narrative_hook');
    const known = new Set(hooks.map((item) => item.key || slugifyTraitKey(item.title)));
    extras.forEach((entry, index) => {
        const type = String(entry?.type || entry?.tipo || '').trim().toLowerCase();
        if (type !== 'gn') return;
        const title = String(entry?.title || '').trim();
        if (!title) return;
        const key = slugifyTraitKey(title);
        if (known.has(key)) return;
        known.add(key);
        hooks.push({
            id: null,
            type: 'narrative_hook',
            key,
            title,
            body: String(entry?.description || '').trim() || null,
            rawSourceText: null,
            mechanicalStatus: 'not_applicable',
            reviewStatus: 'legacy',
            version: 0,
            source: 'legacy_historias_extras',
            metadata: { legacyIndex: index },
            createdAt: null,
            updatedAt: null,
        });
    });
    return hooks;
}

async function getAdminPlayerTraitOverview(db, playerId) {
    await ensureAdminTraitSchema(db);

    const player = await db.get(
        'SELECT id, personagem_nome, historias_extras FROM jogadores WHERE id = ?',
        [playerId]
    );
    if (!player) {
        const error = new Error('Jogador não encontrado.');
        error.code = 'player_not_found';
        error.status = 404;
        throw error;
    }

    const slots = [];
    for (const slotKey of TRAIT_SLOTS) {
        const state = await getPlayerTraitState(db, playerId, slotKey);
        const trait = state.assignment?.traitId
            ? await getTraitTemplate(db, state.assignment.traitId, { nullIfMissing: true })
            : null;
        slots.push({
            ...state,
            trait,
            source: trait ? 'catalog' : state.value ? 'legacy' : 'empty',
        });
    }

    const legacyExtras = parseJson(player.historias_extras, []);
    const normalizedExtras = await listPlayerExtraTraitsSafe(db, player);
    const extraTraits = normalizedExtras.filter((item) => item.slotKey === 'extra_trait');
    const extraAnomalies = normalizedExtras.filter((item) => item.slotKey === 'extra_anomaly');

    if (!normalizedExtras.length && Array.isArray(legacyExtras)) {
        legacyExtras.forEach((entry, index) => {
            const type = String(entry?.type || entry?.tipo || '').trim().toLowerCase();
            if (!['traço', 'traco', 'traço novo', 'traco_novo', 'traco novo', 'anomalia', 'anomaly'].includes(type)) return;
            const mapped = mapLegacyExtra(player, entry, index);
            if (!mapped) return;
            if (mapped.slotKey === 'extra_anomaly') extraAnomalies.push(mapped);
            else extraTraits.push(mapped);
        });
    }

    let content = [];
    if (await tableExists(db, 'clover_player_content')) {
        const rows = await db.all(
            `SELECT * FROM clover_player_content
             WHERE player_id = ? AND active = 1
             ORDER BY content_type ASC, created_at ASC, id ASC`,
            [playerId]
        );
        content = rows.map(mapContent);
    }
    const hooks = mergeLegacyHooks(player, content, Array.isArray(legacyExtras) ? legacyExtras : []);

    let bonuses = [];
    if (await tableExists(db, 'clover_character_bonuses')) {
        const rows = await db.all(
            `SELECT id, name, type, value, description, status, source, reason, expires_at,
                    created_by, created_at, updated_at, metadata_json
             FROM clover_character_bonuses
             WHERE player_id = ? AND LOWER(status) IN ('ativo', 'active')
             ORDER BY created_at ASC, id ASC`,
            [playerId]
        );
        bonuses = rows.map((row) => ({
            id: row.id,
            name: row.name,
            type: row.type,
            value: row.value,
            description: row.description,
            status: row.status,
            source: row.source,
            reason: row.reason,
            expiresAt: row.expires_at,
            metadata: parseJson(row.metadata_json, {}),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));
    }

    let attempts = [];
    if (await tableExists(db, 'clover_trait_attempts')) {
        attempts = await db.all(
            `SELECT id, attempt_number, category, status, result, chosen_key, created_at
             FROM clover_trait_attempts
             WHERE player_id = ?
             ORDER BY attempt_number ASC, id ASC`,
            [playerId]
        );
        attempts = attempts.map((row) => ({
            id: row.id,
            attemptNumber: Number(row.attempt_number),
            category: row.category,
            status: row.status,
            result: row.result,
            chosenKey: row.chosen_key,
            createdAt: row.created_at,
        }));
    }

    const customTraits = content.filter((item) => item.type === 'custom_trait');
    const systemTraitReferences = content.filter((item) => item.type === 'system_trait');
    const narrativeItems = content.filter((item) => item.type === 'narrative_item');

    return {
        available: true,
        status: 'active',
        playerId: player.id,
        characterName: player.personagem_nome || player.id,
        slots,
        extraTraits,
        extraAnomalies,
        hooks,
        customTraits,
        systemTraitReferences,
        narrativeItems,
        bonuses,
        attempts,
        summary: {
            fixedFilled: slots.filter((item) => item.source !== 'empty').length,
            fixedEmpty: slots.filter((item) => item.source === 'empty').length,
            extraTraits: extraTraits.length,
            extraAnomalies: extraAnomalies.length,
            hooks: hooks.length,
            customTraits: customTraits.length,
            systemTraitReferences: systemTraitReferences.length,
            narrativeItems: narrativeItems.length,
            bonuses: bonuses.length,
            attempts: attempts.length,
        },
    };
}

module.exports = {
    getAdminPlayerTraitOverview,
    listPlayerExtraTraitsSafe,
    mapLegacyExtra,
    tableExists,
};
