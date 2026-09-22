'use strict';

const { ensureInventoryV1 } = require('./inventoryService');
const {
    getBoxDashboard,
    getBoxHistory,
    getRelicState,
    publicCatalog,
} = require('./boxService');
const { getRuntimeBoxCatalogs } = require('./boxCatalogRuntimeService');
const { listBoxCatalogVersions } = require('./boxCatalogVersionService');
const { ensureBoxPitySchema } = require('./boxPityStateService');
const { getBoxPityPolicy } = require('./boxPityPolicy');
const { serializeBoxOpeningReceipt, operationCode } = require('./boxReceiptService');

const KNOWN_BOX_KEYS = Object.freeze(new Set(['simples', 'rara']));

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
    try { return JSON.parse(value); } catch { return fallback; }
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
    return KNOWN_BOX_KEYS.has(key) ? key : '';
}

function characterName(row) {
    return String(row?.personagem_nome || row?.display_name || row?.nome || 'Personagem não identificado').trim();
}

function versionKey(boxKey, version) {
    return `${String(boxKey || '').trim().toLowerCase()}:${Number(version || 0)}`;
}

function buildVersionLookup(versions = []) {
    return new Map((versions || []).map((entry) => [versionKey(entry.boxKey, entry.version), entry]));
}

function openingIntegrity(row, versions = null) {
    const issues = [];
    const result = safeJson(row?.result_json, null);
    const metadata = safeJson(row?.metadata_json, {});
    const knownKey = KNOWN_BOX_KEYS.has(String(row?.box_key || '').trim().toLowerCase());
    const version = versions?.get(versionKey(row?.box_key, row?.catalog_version)) || null;

    if (!knownKey) {
        issues.push({ code: 'unknown_box_key', severity: 'critical', message: 'A abertura referencia um tipo de Caixa desconhecido.' });
    } else if (versions && !version) {
        issues.push({ code: 'unknown_catalog_version', severity: 'critical', message: 'A abertura referencia uma versão de catálogo que não existe no repositório versionado.' });
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
    if (result?.rewardKey && row?.reward_key && String(result.rewardKey) !== String(row.reward_key)) {
        issues.push({ code: 'reward_key_mismatch', severity: 'high', message: 'A recompensa do recibo diverge da recompensa registrada na abertura.' });
    }
    const recordedFingerprint = metadata?.catalog?.fingerprint || null;
    if (version && recordedFingerprint && recordedFingerprint !== version.fingerprint) {
        issues.push({ code: 'catalog_fingerprint_mismatch', severity: 'critical', message: 'O fingerprint gravado na abertura diverge da versão persistida do catálogo.' });
    }

    return {
        ok: issues.length === 0,
        issues,
        metadataAvailable: Boolean(metadata && Object.keys(metadata).length),
    };
}

function serializeAdminOpening(row, versions = null) {
    const receipt = serializeBoxOpeningReceipt(row, false);
    const reward = receipt?.presentation?.reward || null;
    const version = versions?.get(versionKey(row.box_key, row.catalog_version)) || null;
    return {
        code: operationCode(row.id),
        status: row.status,
        box: {
            key: row.box_key,
            name: version?.catalog?.name || row.box_key,
            catalogVersion: Number(row.catalog_version || 0),
            catalogStatus: version?.status || null,
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
        integrity: openingIntegrity(row, versions),
    };
}

async function listAdminBoxOpenings(db, options = {}) {
    await ensureInventoryV1(db);
    const versions = buildVersionLookup(await listBoxCatalogVersions(db));
    const conditions = [];
    const params = [];
    const status = cleanStatus(options.status);
    const boxKey = cleanBoxKey(options.boxKey);
    const query = String(options.query || '').trim();

    if (status) { conditions.push('o.status = ?'); params.push(status); }
    if (boxKey) { conditions.push('o.box_key = ?'); params.push(boxKey); }
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
    return rows.map((row) => serializeAdminOpening(row, versions));
}

async function openingCounts(db) {
    await ensureInventoryV1(db);
    const rows = await db.all(`SELECT status, box_key, COUNT(*) AS total FROM clover_box_openings GROUP BY status, box_key`);
    const summary = { total: 0, completed: 0, failed: 0, pending: 0, byBox: {} };
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
    const [runtimeCatalogs, versions, relics, openings, summary] = await Promise.all([
        getRuntimeBoxCatalogs(db),
        listBoxCatalogVersions(db),
        getRelicState(db),
        listAdminBoxOpenings(db, options),
        openingCounts(db),
    ]);
    const catalogs = Object.values(runtimeCatalogs).map((box) => ({
        ...publicCatalog(box),
        policy: getBoxPityPolicy(box),
        source: {
            kind: 'persisted-version',
            editable: false,
            fingerprint: box.runtime?.fingerprint || null,
            message: 'Esta é a versão ativa persistida usada pelo motor de abertura. Alterações criam uma nova versão draft e nunca reescrevem a versão ativa.',
        },
    }));
    const validation = catalogs.map((catalog) => ({
        key: catalog.key,
        version: catalog.version,
        totalChance: catalog.totalChance,
        rewardCount: catalog.rewards.length,
        fingerprint: catalog.source.fingerprint,
    }));
    const integrityIssues = openings.flatMap((opening) => opening.integrity.issues.map((issue) => ({
        ...issue,
        openingCode: opening.code,
        boxName: opening.box.name,
        characterName: opening.characterName,
    })));

    return {
        ok: true,
        readOnlyCatalog: false,
        catalogVersioningAvailable: true,
        generatedAt: new Date().toISOString(),
        summary: {
            ...summary,
            catalogCount: catalogs.length,
            versionCount: versions.length,
            relicsClaimed: Number(relics.claimed || 0),
            relicsAvailable: Number(relics.available || 0),
            visibleIntegrityIssues: integrityIssues.length,
        },
        catalogs,
        versions: versions.map((entry) => ({
            boxKey: entry.boxKey,
            version: entry.version,
            status: entry.status,
            fingerprint: entry.fingerprint,
            source: entry.source,
            reason: entry.reason,
            createdAt: entry.createdAt,
            activatedAt: entry.activatedAt,
            catalog: entry.catalog,
            pityPolicy: entry.pityPolicy,
            createdBy: entry.createdBy || null,
            activatedBy: entry.activatedBy || null,
            archivedAt: entry.archivedAt || null,
        })),
        validation,
        relics: {
            total: Number(relics.total || 0),
            claimed: Number(relics.claimed || 0),
            available: Number(relics.available || 0),
            entries: (relics.relics || []).map((entry) => ({
                key: entry.key,
                name: entry.name,
                claimed: Boolean(entry.claimed),
                owner: entry.owner ? { characterName: entry.owner.characterName, claimedAt: entry.owner.claimedAt } : null,
            })),
        },
        openings,
        integrityIssues,
    };
}

async function resolvePlayer(db, playerId) {
    const id = String(playerId || '').trim();
    if (!id) throw new AdminBoxError('player_required', 'Jogador não informado.', 400);
    const row = await db.get(`SELECT id, personagem_nome, nome, display_name FROM jogadores WHERE id = ? LIMIT 1`, [id]);
    if (!row) throw new AdminBoxError('player_not_found', 'Jogador não encontrado.', 404);
    return row;
}

async function getAdminPlayerBoxState(db, playerId, options = {}) {
    const player = await resolvePlayer(db, playerId);
    const dashboard = await getBoxDashboard(db, player.id);
    const history = await getBoxHistory(db, player.id, boundedInteger(options.limit, 30, 100));
    const pity = Object.fromEntries((dashboard.boxes || []).map((box) => [box.key, box.pityState]));
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
    buildVersionLookup,
    getAdminBoxDashboard,
    getAdminPlayerBoxState,
    listAdminBoxOpenings,
    openingIntegrity,
    serializeAdminOpening,
};