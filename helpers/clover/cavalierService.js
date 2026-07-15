const {
    ensureCloverInventorySchema,
    ensureCloverSquadSchema,
} = require('../../database');
const { normalizeText } = require('../textUtils');

const PATENT_THRESHOLDS = [
    { stars: 190, label: 'Cavaleiro Mágico Sênior de 1ª Classe' },
    { stars: 155, label: 'Cavaleiro Mágico Sênior de 2ª Classe' },
    { stars: 125, label: 'Cavaleiro Mágico Sênior de 3ª Classe' },
    { stars: 100, label: 'Cavaleiro Mágico Sênior de 4ª Classe' },
    { stars: 80, label: 'Cavaleiro Mágico Sênior de 5ª Classe' },
    { stars: 65, label: 'Cavaleiro Mágico Intermediário de 1ª Classe' },
    { stars: 52, label: 'Cavaleiro Mágico Intermediário de 2ª Classe' },
    { stars: 40, label: 'Cavaleiro Mágico Intermediário de 3ª Classe' },
    { stars: 30, label: 'Cavaleiro Mágico Intermediário de 4ª Classe' },
    { stars: 22, label: 'Cavaleiro Mágico Intermediário de 5ª Classe' },
    { stars: 15, label: 'Cavaleiro Mágico Júnior de 1ª Classe' },
    { stars: 10, label: 'Cavaleiro Mágico Júnior de 2ª Classe' },
    { stars: 6, label: 'Cavaleiro Mágico Júnior de 3ª Classe' },
    { stars: 3, label: 'Cavaleiro Mágico Júnior de 4ª Classe' },
    { stars: 0, label: 'Cavaleiro Mágico Júnior de 5ª Classe' },
];

function isFilled(value) {
    const text = String(value || '').trim();
    return Boolean(text) && text !== '-';
}

function formatNumber(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return '0';
    return new Intl.NumberFormat('pt-BR').format(number);
}

function formatYulls(value) {
    return `${formatNumber(value)}¥`;
}

function formatStars(value) {
    const amount = Number(value || 0);
    return `${formatNumber(amount)} ${amount === 1 ? 'estrela' : 'estrelas'}`;
}

function normalizeSquadKey(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function getRecommendedPatent(stars) {
    const total = Math.max(0, Number(stars || 0));
    return PATENT_THRESHOLDS.find((item) => total >= item.stars)?.label || PATENT_THRESHOLDS[PATENT_THRESHOLDS.length - 1].label;
}

function hasSquad(player = {}) {
    return isFilled(player.esquadrao);
}

function resolvePatent(player = {}) {
    if (!hasSquad(player)) return '-';
    if (isFilled(player.patente)) return String(player.patente).trim();
    return getRecommendedPatent(player.estrelas);
}

async function getInventoryItems(db, playerId, limit = 20) {
    await ensureCloverInventorySchema(db);
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    return db.all(
        `SELECT *
         FROM clover_inventory_items
         WHERE player_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [playerId, safeLimit]
    );
}

async function getInventoryPage(db, playerId, { page = 1, pageSize = 8 } = {}) {
    await ensureCloverInventorySchema(db);
    const safePageSize = Math.max(1, Math.min(20, Number(pageSize) || 8));
    const requestedPage = Math.max(1, Number(page) || 1);
    const totals = await db.get(
        `SELECT COUNT(*) AS records,
                COALESCE(SUM(quantity), 0) AS units
         FROM clover_inventory_items
         WHERE player_id = ?`,
        [playerId]
    );
    const totalRecords = Number(totals?.records || 0);
    const totalUnits = Number(totals?.units || 0);
    const totalPages = Math.max(1, Math.ceil(totalRecords / safePageSize));
    const valid = requestedPage <= totalPages;
    const start = valid ? (requestedPage - 1) * safePageSize : 0;
    const items = valid
        ? await db.all(
            `SELECT *
             FROM clover_inventory_items
             WHERE player_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?`,
            [playerId, safePageSize, start]
        )
        : [];

    return {
        playerId,
        items,
        page: requestedPage,
        pageSize: safePageSize,
        start,
        totalRecords,
        totalUnits,
        totalPages,
        valid,
    };
}

async function getInventoryItemByPosition(db, playerId, position) {
    await ensureCloverInventorySchema(db);
    const parsed = Number(position);
    const total = await db.get(
        `SELECT COUNT(*) AS records
         FROM clover_inventory_items
         WHERE player_id = ?`,
        [playerId]
    );
    const totalRecords = Number(total?.records || 0);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > totalRecords) {
        return { ok: false, code: 'position_out_of_range', position: parsed, totalRecords };
    }

    const item = await db.get(
        `SELECT *
         FROM clover_inventory_items
         WHERE player_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1 OFFSET ?`,
        [playerId, parsed - 1]
    );
    if (!item) return { ok: false, code: 'not_found', position: parsed, totalRecords };
    return { ok: true, item, position: parsed, totalRecords };
}

async function countInventoryItems(db, playerId) {
    await ensureCloverInventorySchema(db);
    const row = await db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS total
         FROM clover_inventory_items
         WHERE player_id = ?`,
        [playerId]
    );
    return Number(row?.total || 0);
}

async function getSquadSummary(db, squadName) {
    if (!isFilled(squadName)) return null;

    await ensureCloverSquadSchema(db);
    const squadKey = normalizeSquadKey(squadName);
    if (!squadKey) return null;

    const squad = await db.get(
        `SELECT *
         FROM clover_squads
         WHERE squad_key = ?`,
        [squadKey]
    );

    if (!squad) {
        return {
            key: squadKey,
            name: String(squadName).trim(),
            currentStars: 0,
            historicalStars: 0,
            blackStars: 0,
        };
    }

    return {
        key: squad.squad_key,
        name: squad.name,
        currentStars: Number(squad.current_stars || 0),
        historicalStars: Number(squad.historical_stars || 0),
        blackStars: Number(squad.black_stars || 0),
    };
}

async function getCavalierSummary(db, playerId) {
    const player = await db.get(
        `SELECT id, nome, personagem_nome, dinheiro, estrelas, esquadrao, patente
         FROM jogadores
         WHERE id = ?`,
        [playerId]
    );

    if (!player) return { ok: false, reason: 'missing_player' };

    const inventoryCount = await countInventoryItems(db, playerId);
    const squad = await getSquadSummary(db, player.esquadrao);

    return {
        ok: true,
        player,
        yulls: Number(player.dinheiro || 0),
        stars: Number(player.estrelas || 0),
        patent: resolvePatent(player),
        recommendedPatent: hasSquad(player) ? getRecommendedPatent(player.estrelas) : null,
        squad,
        inventoryCount,
    };
}

module.exports = {
    countInventoryItems,
    formatNumber,
    formatStars,
    formatYulls,
    getCavalierSummary,
    getInventoryItemByPosition,
    getInventoryItems,
    getInventoryPage,
    getRecommendedPatent,
    hasSquad,
    normalizeSquadKey,
    resolvePatent,
};
