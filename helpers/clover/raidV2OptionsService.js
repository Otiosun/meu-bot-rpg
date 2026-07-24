'use strict';

const { normalizeJid } = require('../groupAccess');
const { getAccessContext } = require('./accessControlService');
const { normalizeSquadKey } = require('./cavalierService');
const { getPlayerById } = require('./targetResolver');
const {
    RaidServiceError,
    ensureRaidV2Schema,
    getRaidCategoryCatalog,
    raidMonthKey,
    readMonthlyUsage,
    resolveRaidCategory,
} = require('./raidService');

async function requireNarrator(db, actorId) {
    const actor = normalizeJid(actorId);
    const context = await getAccessContext(db, actor);
    if (context.owner || context.roleKeys.includes('admin') || context.roleKeys.includes('narrator')) {
        return { actorId: actor, context };
    }
    throw new RaidServiceError(
        'narrator_required',
        'Apenas narradores podem consultar as opções de criação de raid.'
    );
}

function publicPlayer(row) {
    return {
        id: row.id,
        name: row.personagem_nome && row.personagem_nome !== '-'
            ? row.personagem_nome
            : row.nome && row.nome !== '-'
                ? row.nome
                : row.display_name || 'Personagem',
        magic: row.magia && row.magia !== '-' ? row.magia : null,
        squad: row.esquadrao && row.esquadrao !== '-' ? row.esquadrao : null,
        patent: row.patente && row.patente !== '-' ? row.patente : null,
        imagePath: row.site_profile_image_data || row.personagem_aparencia_image_path || null,
    };
}

function publicSquad(row) {
    return {
        key: row.squad_key,
        name: row.name,
        currentStars: Number(row.current_stars || 0),
        historicalStars: Number(row.historical_stars || 0),
    };
}

async function getRaidCreationOptions(db, actorId) {
    await ensureRaidV2Schema(db);
    await requireNarrator(db, actorId);

    const [players, squads] = await Promise.all([
        db.all(
            `SELECT id, nome, display_name, personagem_nome, magia, esquadrao, patente,
                    personagem_aparencia_image_path, site_profile_image_data
             FROM jogadores
             WHERE LOWER(COALESCE(jogo_status, '')) = 'liberado'
               AND COALESCE(NULLIF(TRIM(personagem_nome), ''), '-') <> '-'
             ORDER BY LOWER(personagem_nome), LOWER(nome), id`
        ),
        db.all(
            `SELECT squad_key, name, current_stars, historical_stars
             FROM clover_squads
             ORDER BY LOWER(name), squad_key`
        ),
    ]);

    return {
        categories: getRaidCategoryCatalog(),
        players: players.map(publicPlayer),
        squads: squads.map(publicSquad),
    };
}

async function resolvePreviewScope(db, definition, input = {}) {
    if (definition.scopeType === 'player') {
        const raw = String(input.scopePlayerId || input.scope_player_id || '').trim();
        if (!raw) return null;
        const player = await getPlayerById(db, raw);
        if (!player) throw new RaidServiceError('player_not_found', 'Jogador principal não encontrado.');
        return {
            type: 'player',
            playerId: player.id,
            playerName: player.personagem_nome || player.nome || 'Personagem',
            squadKey: null,
        };
    }

    if (definition.scopeType === 'squad') {
        const raw = String(input.scopeSquadKey || input.scope_squad_key || '').trim();
        if (!raw) return null;
        const key = normalizeSquadKey(raw);
        const squad = await db.get(
            `SELECT squad_key, name FROM clover_squads
             WHERE squad_key = ? OR LOWER(name) = LOWER(?)
             LIMIT 1`,
            [key, raw]
        );
        if (!squad) throw new RaidServiceError('squad_not_found', 'Esquadrão não encontrado.');
        return {
            type: 'squad',
            playerId: null,
            squadKey: squad.squad_key,
            squadName: squad.name,
        };
    }

    return { type: 'global', playerId: null, squadKey: null };
}

async function previewRaidMonthlyUsage(db, actorId, input = {}) {
    await ensureRaidV2Schema(db);
    await requireNarrator(db, actorId);
    const definition = resolveRaidCategory(input.category || input.categoria || 'saga_pessoal');
    const scope = await resolvePreviewScope(db, definition, input);
    if (!scope) {
        return {
            category: getRaidCategoryCatalog().find((entry) => entry.key === definition.key),
            scope: null,
            usage: null,
        };
    }
    const monthKey = raidMonthKey(input.referenceDate || input.reference_date || new Date());
    const usage = await readMonthlyUsage(db, definition, scope, monthKey);
    return {
        category: getRaidCategoryCatalog().find((entry) => entry.key === definition.key),
        scope,
        usage,
    };
}

module.exports = {
    getRaidCreationOptions,
    previewRaidMonthlyUsage,
};