'use strict';

const { ensureInventoryV1 } = require('./inventoryService');
const {
    BOX_CATALOGS,
    getBoxCatalog,
    validateBoxCatalogs,
} = require('./seasonalEventCatalog');
const {
    getBoxDashboard,
    getBoxHistory,
    getRelicState,
    publicCatalog,
} = require('./boxService');
const { ensureBoxPitySchema, previewPlayerPityState } = require('./boxPityStateService');
const { getBoxPityPolicy } = require('./boxPityPolicy');
const { serializeBoxOpeningReceipt, operationCode } = require('./boxReceiptService');

class AdminBoxError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminBoxError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function safeJson(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function boundedInteger(value, fallback = 50, maximum = 200) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(maximum, Math.trunc(parsed)));
}

function cleanStatus(value) {
    const status = String(value || '').trim().toLowerCase();
    return ['pending', 'completed', 'failed'].includes(status) ? status : '';
}

function cleanBoxKey(value) {
    const key = String(value || '').trim().toLowerCase();
    return getBoxCatalog(key) ? key : '';
}

function characterName(row) {
    return String(
        row?.personagem_nome
        || row?.display_name
        || row?.nome
        || 'Personagem não identificado'
    ).trim();
}

function openingIntegrity(row) {
    const issues = [];
    const result = safeJson(row?.result_json, null);
    const metadata = safeJson(row?.metadata_json, {});
    const catalog = getBoxCatalog(row?.box_key);

    if (!catalog) {
        issues.push({ code: 'unknown_box_key', severity: 'critical', message: 'A abertura referencia um tipo de Caixa inexistente no catálogo atual.' });
    }
    if (row?.status === 'completed' && !result) {
        issues.push({ code: 'completed_without_result', severity: 'critical', message: 'A abertura está concluída, mas não possui resultado serializado.' });
    }
    if (row?.status === 'completed' && !row?.reward_key) {
        issues.push({ code: 'completed_without_reward_key', severity: 'critical', message: 'A abertura está concluída, mas não possui recompensa identificada.' });
    }
    if (row?.status === 'failed') {
        issues.push({ code: 'failed_opening', severity: 'high', message: 'A abertura terminou em falha e exige revisão antes de qualquer compensação.' });
    }
    if (row?.status === 'pending') {
        issues.push({ code: 'pending_opening', severity: 'medium', message: 'A abertura permanece pendente; não rerrole antes de verificar os efeitos já persistidos.' });
    }
    if (catalog && Number(row?.catalog_version || 0) > Number(catalog.version || 0)) {
        issues.push({ code: 'future_catalog_version', severity: 'high', message: 'A abertura referencia uma versão de catálogo acima da versão conhecida pelo runtime candidato.' });
    }
    if (result?.rewardKey && row?.reward_key && String(result.rewardKey) !== String(row.reward_key)) {
        issues.push({ code: 'reward_key_mismatch', severity: 'high', message: 'A recompensa do recibo diverge da recompensa registrada na abertura.' });
    }

    return {
        ok: issues.length === 0,
        issues,
        metadataAvailable: Boolean(metadata && Object.keys(metadata).length),
    };
}

function serializeAdminOpening(row) {
    const receipt = serializeBoxOpeningReceipt(row, false);
    const reward = receipt?.presentation?.reward || null;
    return {
        code: operationCode(row.id),
        status: row.status,
        box: {
            key: row.box_key,
            name: getBoxCatalog(row.box_key)?.name || row.box_key,
            catalogVersion: Number(row.catalog_version || 0),
        },
        characterName: characterName(row),
        reward: reward ? {
            type: reward.type || null,
            name: reward.name || row.reward_key || 'Recompensa',
            quantity: Number(reward.quantity || 0) || null,
            destination: reward.destination?.label || null,
        } : null,
        rewardKey: row.reward_key || null,
        rollBasisPoints: Number(row.roll_basis_points || 0) || null,
        openedAt: row.created_at || null,
        completedAt: row.completed_at || null,
        recoverable: receipt?.presentation?.recoverable !== false,
        integrity: openingIntegrity(row),
    };
}

async function listAdminBoxOpenings(db, options = {}) {
    await ensureInventoryV1(db);
    const conditions = [];
    const params = [];
    const status = cleanStatus(options.status);
    const boxKey = cleanBoxKey(options.boxKey);
    const query = String(options.query || '').trim();

    if (status) {
        conditions.push('o.status = ?');
        params.push(status);
    }
    if (boxKey) {
        conditions.push('o.box_key = ?');
        params.push(boxKey);
    }
    if (query) {
        const pattern = `%${query}%`;
        conditions.push(`(
            CAST(o.id AS TEXT) LIKE ?
            OR LOWER(COALESCE(o.reward_key, '')) LIKE LOWER(?)
            OR LOWER(COALESCE(p.personagem_nome, '')) LIKE LOWER(?)
            OR LOWER(COALESCE(p.nome, '')) LIKE LOWER(?)
            OR LOWER(COALESCE(p.display_name, '')) LIKE LOWER(?)
        )`);
        params.push(pattern, pattern, pattern, pattern, pattern);
    }

    const limit = boundedInteger(options.limit, 50, 200);
    params.push(limit);
    const rows = await db.all(
        `SELECT o.*, p.personagem_nome, p.nome, p.display_name
         FROM clover_box_openings o
         LEFT JOIN jogadores p ON p.id = o.player_id
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY o.created_at DESC, o.id DESC
         LIMIT ?`,
        params
    );
    return rows.map(serializeAdminOpening);
}

async function openingCounts(db) {
    await ensureInventoryV1(db);
    const rows = await db.all(
        `SELECT status, box_key, COUNT(*) AS total
         FROM clover_box_openings
         GROUP BY status, box_key`
    );
    const summary = {
        total: 0,
        completed: 0,
        failed: 0,
        pending: 0,
        byBox: {},
    };
    for (const row of rows) {
        const total = Number(row.total || 0);
        summary.total += total;
        if (Object.prototype.hasOwnProperty.call(summary, row.status)) summary[row.status] += total;
        summary.byBox[row.box_key] = Number(summary.byBox[row.box_key] || 0) + total;
    }
    return summary;
}

async function getAdminBoxDashboard(db, options = {}) {
    await ensureInventoryV1(db);
    await ensureBoxPitySchema(db);
    const catalogs = Object.values(BOX_CATALOGS).map((box) => ({
        ...publicCatalog(box),
        policy: getBoxPityPolicy(box.key),
        source: {
            kind: 'code',
            editable: false,
            message: 'Catálogo e política de pity ainda são definidos no runtime. Alterações precisam de versionamento canônico antes de edição pela Central.',
        },
    }));
    const [relics, openings, summary] = await Promise.all([
        getRelicState(db),
        listAdminBoxOpenings(db, options),
        openingCounts(db),
    ]);
    const validation = validateBoxCatalogs();
    const integrityIssues = openings.flatMap((opening) => (
        opening.integrity.issues.map((issue) => ({
            ...issue,
            openingCode: opening.code,
            boxName: opening.box.name,
            characterName: opening.characterName,
        }))
    ));

    return {
        ok: true,
        readOnlyCatalog: true,
        generatedAt: new Date().toISOString(),
        summary: {
            ...summary,
            catalogCount: catalogs.length,
            relicsClaimed: Number(relics.claimed || 0),
            relicsAvailable: Number(relics.available || 0),
            visibleIntegrityIssues: integrityIssues.length,
        },
        catalogs,
        validation,
        relics: {
            total: Number(relics.total || 0),
            claimed: Number(relics.claimed || 0),
            available: Number(relics.available || 0),
            entries: (relics.relics || []).map((entry) => ({
                key: entry.key,
                name: entry.name,
                claimed: Boolean(entry.claimed),
                owner: entry.owner ? {
                    characterName: entry.owner.characterName,
                    claimedAt: entry.owner.claimedAt,
                } : null,
            })),
        },
        openings,
        integrityIssues,
    };
}

async function resolvePlayer(db, playerId) {
    const id = String(playerId || '').trim();
    if (!id) throw new AdminBoxError('player_required', 'Jogador não informado.', 400);
    const row = await db.get(
        `SELECT id, personagem_nome, nome, display_name
         FROM jogadores WHERE id = ? LIMIT 1`,
        [id]
    );
    if (!row) throw new AdminBoxError('player_not_found', 'Jogador não encontrado.', 404);
    return row;
}

async function getAdminPlayerBoxState(db, playerId, options = {}) {
    const player = await resolvePlayer(db, playerId);
    const dashboard = await getBoxDashboard(db, player.id);
    const history = await getBoxHistory(db, player.id, boundedInteger(options.limit, 30, 100));
    const pity = {};
    for (const box of Object.values(BOX_CATALOGS)) {
        pity[box.key] = await previewPlayerPityState(db, player.id, box.key);
    }
    return {
        ok: true,
        characterName: characterName(player),
        boxes: dashboard.boxes || [],
        pity,
        history: (history || []).map((opening) => ({
            code: opening.operation?.code || null,
            status: opening.status,
            box: opening.box,
            reward: opening.presentation?.reward || null,
            pity: opening.pity || null,
            openedAt: opening.openedAt || null,
            completedAt: opening.completedAt || null,
            duplicate: Boolean(opening.duplicate),
        })),
    };
}

module.exports = {
    AdminBoxError,
    getAdminBoxDashboard,
    getAdminPlayerBoxState,
    listAdminBoxOpenings,
    openingIntegrity,
    serializeAdminOpening,
};