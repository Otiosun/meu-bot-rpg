
'use strict';

const { randomUUID } = require('node:crypto');
const { buyNode, getNodeDetails } = require('./skillTreeService');
const { getTree } = require('./treeLoader');
const { getTreeMutationBlock } = require('./treeMaintenancePolicy');

const REVIEW_CLAIM_STALE_MINUTES = 5;
const VALID_STATUSES = new Set(['pending', 'approved', 'rejected', 'cancelled']);

class SkillApprovalError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'SkillApprovalError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
}

async function ensureSkillApprovalSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_skill_approval_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_key TEXT NOT NULL UNIQUE,
            player_id TEXT NOT NULL,
            tree_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
            cost INTEGER NOT NULL DEFAULT 0,
            base_cost INTEGER NOT NULL DEFAULT 0,
            discount_percent INTEGER NOT NULL DEFAULT 0,
            requested_by TEXT NOT NULL,
            requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            reviewed_by TEXT DEFAULT NULL,
            reviewed_at TEXT DEFAULT NULL,
            review_reason TEXT DEFAULT NULL,
            purchase_id INTEGER DEFAULT NULL,
            review_token TEXT DEFAULT NULL,
            review_started_at TEXT DEFAULT NULL,
            last_error TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_clover_skill_approval_one_pending
            ON clover_skill_approval_requests(player_id, tree_id, node_id)
            WHERE status = 'pending';
        CREATE INDEX IF NOT EXISTS idx_clover_skill_approval_status_requested
            ON clover_skill_approval_requests(status, requested_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS clover_skill_approval_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER NOT NULL,
            request_key TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('requested', 'approved', 'rejected', 'claim_recovered')),
            actor_id TEXT NOT NULL,
            from_status TEXT DEFAULT NULL,
            to_status TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_clover_skill_approval_events_request
            ON clover_skill_approval_events(request_id, id);
    `);
}

function buildRequestKey() {
    return `SAR-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
}

function normalizeStatus(status) {
    const clean = String(status || 'pending').trim().toLowerCase();
    if (!VALID_STATUSES.has(clean)) {
        throw new SkillApprovalError('invalid_approval_status', 'Status de aprovação inválido.', 400);
    }
    return clean;
}

function serializeRequest(row) {
    if (!row) return null;
    const tree = getTree(row.tree_id);
    const node = tree?.nodesById?.[row.node_id] || null;
    return {
        id: Number(row.id),
        request_key: row.request_key,
        player_id: row.player_id,
        playerName: row.player_name || null,
        tree_id: row.tree_id,
        node_id: row.node_id,
        status: row.status,
        cost: Number(row.cost || 0),
        baseCost: Number(row.base_cost || 0),
        discountPercent: Number(row.discount_percent || 0),
        requested_at: row.requested_at || null,
        requested_by: row.requested_by || null,
        reviewed_at: row.reviewed_at || null,
        reviewed_by: row.reviewed_by || null,
        review_reason: row.review_reason || null,
        purchase_id: row.purchase_id == null ? null : Number(row.purchase_id),
        last_error: row.last_error || null,
        metadata: safeJsonParse(row.metadata_json, {}),
        tree: tree ? { id: tree.id, name: tree.name } : null,
        node: node ? { id: node.id, name: node.name } : null,
    };
}

async function readRequestRow(db, requestRef) {
    await ensureSkillApprovalSchema(db);
    const raw = String(requestRef ?? '').trim();
    if (!raw) return null;
    const numeric = /^\d+$/.test(raw) ? Number(raw) : null;
    return db.get(
        `SELECT r.*, COALESCE(NULLIF(p.personagem_nome, ''), NULLIF(p.nome, ''), NULLIF(p.display_name, '')) AS player_name
           FROM clover_skill_approval_requests r
           LEFT JOIN jogadores p ON p.id = r.player_id
          WHERE ${numeric === null ? 'r.request_key = ?' : 'r.id = ?'} LIMIT 1`,
        [numeric === null ? raw.toUpperCase() : numeric]
    );
}

async function recordEvent(db, row, action, actorId, fromStatus, toStatus, reason = null, metadata = null) {
    await db.run(
        `INSERT INTO clover_skill_approval_events
         (request_id, request_key, action, actor_id, from_status, to_status, reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.request_key, action, String(actorId || 'system'), fromStatus || null, toStatus || null, reason || null, metadata ? JSON.stringify(metadata) : null]
    );
}

async function clearStaleClaims(db) {
    await ensureSkillApprovalSchema(db);
    const staleRows = await db.all(
        `SELECT * FROM clover_skill_approval_requests
          WHERE status = 'pending' AND review_token IS NOT NULL
            AND datetime(review_started_at) <= datetime('now', ?)`,
        [`-${REVIEW_CLAIM_STALE_MINUTES} minutes`]
    );
    for (const row of staleRows) {
        const result = await db.run(
            `UPDATE clover_skill_approval_requests
                SET review_token = NULL, review_started_at = NULL, last_error = COALESCE(last_error, 'stale_review_claim_recovered')
              WHERE id = ? AND status = 'pending' AND review_token = ?`,
            [row.id, row.review_token]
        );
        if (Number(result?.changes || 0) === 1) {
            await recordEvent(db, row, 'claim_recovered', 'system', 'pending', 'pending', 'Claim de revisão expirado e liberado.');
        }
    }
    return staleRows.length;
}

async function requestSkillApproval(db, playerId, treeId, nodeAlias, requestedBy = playerId, options = {}) {
    const maintenance = getTreeMutationBlock(options);
    if (maintenance) throw new SkillApprovalError(maintenance.reason, maintenance.message, 409);

    await ensureSkillApprovalSchema(db);
    const details = await getNodeDetails(db, playerId, treeId, nodeAlias);
    if (!details.ok) throw new SkillApprovalError(details.reason || 'node_not_found', 'Nó não encontrado.', 404, details);
    if (details.nodeState.status !== 'approval') {
        throw new SkillApprovalError('approval_not_available', 'Este nó não está disponível para solicitar aprovação agora.', 409, { node: details.node, nodeState: details.nodeState });
    }

    const existing = await db.get(
        `SELECT r.*, COALESCE(NULLIF(p.personagem_nome, ''), NULLIF(p.nome, ''), NULLIF(p.display_name, '')) AS player_name
           FROM clover_skill_approval_requests r LEFT JOIN jogadores p ON p.id = r.player_id
          WHERE r.player_id = ? AND r.tree_id = ? AND r.node_id = ? AND r.status = 'pending' LIMIT 1`,
        [playerId, details.state.tree.id, details.node.id]
    );
    if (existing) return { ok: true, created: false, request: serializeRequest(existing) };

    const requestKey = buildRequestKey();
    const cost = Number(details.nodeState.effectiveCost ?? details.node.cost ?? 0);
    const baseCost = Number(details.node.cost || 0);
    const discountPercent = Number(details.nodeState.discount?.percent || 0);
    const metadata = { node_name: details.node.name, tree_name: details.state.tree.name, discount_sources: details.nodeState.discount?.sources || [] };

    let insert;
    try {
        insert = await db.run(
            `INSERT INTO clover_skill_approval_requests
             (request_key, player_id, tree_id, node_id, status, cost, base_cost, discount_percent, requested_by, metadata_json)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
            [requestKey, playerId, details.state.tree.id, details.node.id, cost, baseCost, discountPercent, requestedBy, JSON.stringify(metadata)]
        );
    } catch (error) {
        if (!String(error?.message || '').includes('UNIQUE')) throw error;
        const raced = await db.get(
            `SELECT r.*, COALESCE(NULLIF(p.personagem_nome, ''), NULLIF(p.nome, ''), NULLIF(p.display_name, '')) AS player_name
               FROM clover_skill_approval_requests r LEFT JOIN jogadores p ON p.id = r.player_id
              WHERE r.player_id = ? AND r.tree_id = ? AND r.node_id = ? AND r.status = 'pending' LIMIT 1`,
            [playerId, details.state.tree.id, details.node.id]
        );
        if (raced) return { ok: true, created: false, request: serializeRequest(raced) };
        throw error;
    }
    const row = await readRequestRow(db, insert.lastID);
    await recordEvent(db, row, 'requested', requestedBy, null, 'pending', null, metadata);
    return { ok: true, created: true, request: serializeRequest(row) };
}

async function listSkillApprovalRequests(db, { status = 'pending', limit = 200 } = {}) {
    await ensureSkillApprovalSchema(db);
    await clearStaleClaims(db);
    const normalizedStatus = normalizeStatus(status);
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    const rows = await db.all(
        `SELECT r.*, COALESCE(NULLIF(p.personagem_nome, ''), NULLIF(p.nome, ''), NULLIF(p.display_name, '')) AS player_name
           FROM clover_skill_approval_requests r LEFT JOIN jogadores p ON p.id = r.player_id
          WHERE r.status = ? ORDER BY datetime(r.requested_at) DESC, r.id DESC LIMIT ?`,
        [normalizedStatus, safeLimit]
    );
    return rows.map(serializeRequest);
}

async function claimApprovalReview(db, row) {
    await clearStaleClaims(db);
    const token = randomUUID();
    const result = await db.run(
        `UPDATE clover_skill_approval_requests SET review_token = ?, review_started_at = CURRENT_TIMESTAMP, last_error = NULL
          WHERE id = ? AND status = 'pending' AND review_token IS NULL`,
        [token, row.id]
    );
    if (Number(result?.changes || 0) !== 1) {
        const current = await readRequestRow(db, row.id);
        if (current?.status === 'approved') return { alreadyApproved: true, row: current };
        throw new SkillApprovalError('approval_review_busy', 'Este pedido já está sendo revisado.', 409);
    }
    return { token };
}

async function findApprovalPurchase(db, request) {
    const rows = await db.all(
        `SELECT id, metadata_json
           FROM clover_skill_nodes
          WHERE player_id = ? AND tree_id = ? AND node_id = ?
          ORDER BY id DESC`,
        [request.player_id, request.tree_id, request.node_id]
    ).catch(() => []);

    for (const candidate of rows || []) {
        const metadata = safeJsonParse(candidate.metadata_json, {});
        if (metadata.approval_request_key === request.request_key) {
            return candidate;
        }
    }
    return null;
}

async function approveSkillApproval(db, requestRef, actorId, reason = null, options = {}) {
    const maintenance = getTreeMutationBlock(options);
    if (maintenance) throw new SkillApprovalError(maintenance.reason, maintenance.message, 409);

    await ensureSkillApprovalSchema(db);
    let row = await readRequestRow(db, requestRef);
    if (!row) throw new SkillApprovalError('approval_not_found', 'Pedido de aprovação não encontrado.', 404);
    if (row.status === 'approved') return { ok: true, idempotent: true, request: serializeRequest(row) };
    if (row.status !== 'pending') throw new SkillApprovalError('approval_already_reviewed', 'Este pedido já foi encerrado.', 409, { status: row.status });

    const claim = await claimApprovalReview(db, row);
    if (claim.alreadyApproved) return { ok: true, idempotent: true, request: serializeRequest(claim.row) };

    let purchase;
    try {
        const recoveredPurchase = await findApprovalPurchase(db, row);
        if (recoveredPurchase) {
            purchase = {
                ok: true,
                idempotent: true,
                purchaseId: Number(recoveredPurchase.id),
                reason: 'already_owned',
            };
        } else {
            const details = await getNodeDetails(
                db,
                row.player_id,
                row.tree_id,
                row.node_id
            );

            if (!details.ok) {
                throw new SkillApprovalError(
                    details.reason || 'node_not_found',
                    'Nó não encontrado durante a aprovação.',
                    404,
                    details
                );
            }

            if (details.nodeState.status === 'owned') {
                throw new SkillApprovalError(
                    'node_already_owned',
                    'O nó já foi comprado por outro fluxo; a aprovação não será associada automaticamente.',
                    409
                );
            }

            if (details.nodeState.status !== 'approval') {
                throw new SkillApprovalError(
                    'approval_revalidation_failed',
                    'Os requisitos, custo ou PH mudaram desde o pedido. Gere/revise o pedido novamente.',
                    409,
                    { nodeStatus: details.nodeState.status }
                );
            }

            const currentCost = Number(
                details.nodeState.effectiveCost
                ?? details.node.cost
                ?? 0
            );
            const requestedCost = Number(row.cost || 0);

            if (currentCost !== requestedCost) {
                throw new SkillApprovalError(
                    'approval_cost_changed',
                    'O custo do nó mudou desde o pedido. A aprovação foi bloqueada.',
                    409,
                    { requestedCost, currentCost }
                );
            }

            purchase = await buyNode(db, row.player_id, row.tree_id, row.node_id, actorId, {
                source: 'skill_tree_approval', allowApproval: true,
                maintenanceMode: options.maintenanceMode,
                metadata: { approval_request_key: row.request_key, approval_requested_by: row.requested_by },
            });
        }
    } catch (error) {
        await db.run(`UPDATE clover_skill_approval_requests SET review_token = NULL, review_started_at = NULL, last_error = ? WHERE id = ? AND review_token = ?`, [String(error?.code || error?.message || 'approval_purchase_error'), row.id, claim.token]).catch(() => null);
        throw error;
    }

    if (!purchase.ok && purchase.reason !== 'already_owned') {
        await db.run(`UPDATE clover_skill_approval_requests SET review_token = NULL, review_started_at = NULL, last_error = ? WHERE id = ? AND review_token = ?`, [String(purchase.reason || 'approval_revalidation_failed'), row.id, claim.token]);
        throw new SkillApprovalError('approval_revalidation_failed', 'A compra não pôde ser aplicada após revalidar PH e requisitos.', 409, { reason: purchase.reason, nodeState: purchase.nodeState || null });
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const updated = await db.run(
            `UPDATE clover_skill_approval_requests
                SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_reason = ?, purchase_id = ?,
                    review_token = NULL, review_started_at = NULL, last_error = NULL
              WHERE id = ? AND status = 'pending' AND review_token = ?`,
            [actorId, reason || null, purchase.purchaseId || null, row.id, claim.token]
        );
        if (Number(updated?.changes || 0) !== 1) throw new SkillApprovalError('approval_finalize_conflict', 'O pedido mudou durante a aprovação.', 409);
        row = await db.get('SELECT * FROM clover_skill_approval_requests WHERE id = ?', [row.id]);
        await recordEvent(db, row, 'approved', actorId, 'pending', 'approved', reason, { purchase_id: purchase.purchaseId || null, already_owned: purchase.reason === 'already_owned' });
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
    row = await readRequestRow(db, row.id);
    return { ok: true, idempotent: false, request: serializeRequest(row), purchase };
}

async function rejectSkillApproval(db, requestRef, actorId, reason = null) {
    await ensureSkillApprovalSchema(db);
    await clearStaleClaims(db);
    let row = await readRequestRow(db, requestRef);
    if (!row) throw new SkillApprovalError('approval_not_found', 'Pedido de aprovação não encontrado.', 404);
    if (row.status === 'rejected') return { ok: true, idempotent: true, request: serializeRequest(row) };
    if (row.status !== 'pending') throw new SkillApprovalError('approval_already_reviewed', 'Este pedido já foi encerrado.', 409, { status: row.status });

    await db.exec('BEGIN IMMEDIATE');
    try {
        const updated = await db.run(
            `UPDATE clover_skill_approval_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
                    review_reason = ?, review_token = NULL, review_started_at = NULL, last_error = NULL
              WHERE id = ? AND status = 'pending' AND review_token IS NULL`,
            [actorId, reason || null, row.id]
        );
        if (Number(updated?.changes || 0) !== 1) throw new SkillApprovalError('approval_review_busy', 'Este pedido já está sendo revisado.', 409);
        row = await db.get('SELECT * FROM clover_skill_approval_requests WHERE id = ?', [row.id]);
        await recordEvent(db, row, 'rejected', actorId, 'pending', 'rejected', reason);
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
    row = await readRequestRow(db, row.id);
    return { ok: true, idempotent: false, request: serializeRequest(row) };
}

module.exports = {
    REVIEW_CLAIM_STALE_MINUTES, SkillApprovalError, approveSkillApproval, clearStaleClaims,
    ensureSkillApprovalSchema, listSkillApprovalRequests, readRequestRow, rejectSkillApproval,
    requestSkillApproval, serializeRequest,
};
