'use strict';

const { randomUUID } = require('crypto');
const {
    getNodeDetails,
    getTreeState,
} = require('./skillTreeService');
const { spendPhInTransaction } = require('./phService');

const REVIEW_CLAIM_TTL_MS = 5 * 60 * 1000;
const VALID_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'cancelled']);

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
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function optionalText(value, maximum = 1000) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maximum) : null;
}

function requestKey() {
    return `SAR-${randomUUID()}`;
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
            requested_by TEXT DEFAULT NULL,
            requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            reviewed_by TEXT DEFAULT NULL,
            reviewed_at TEXT DEFAULT NULL,
            review_reason TEXT DEFAULT NULL,
            purchase_id INTEGER DEFAULT NULL,
            review_token TEXT DEFAULT NULL,
            review_started_at TEXT DEFAULT NULL,
            last_error TEXT DEFAULT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        )
    `);
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_skill_approval_one_pending
        ON clover_skill_approval_requests (player_id, tree_id, node_id)
        WHERE status = 'pending'
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_skill_approval_status_requested
        ON clover_skill_approval_requests (status, requested_at, id)
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_skill_approval_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER NOT NULL,
            request_key TEXT NOT NULL,
            action TEXT NOT NULL,
            actor_id TEXT DEFAULT NULL,
            from_status TEXT DEFAULT NULL,
            to_status TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (request_id) REFERENCES clover_skill_approval_requests(id)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_skill_approval_events_request
        ON clover_skill_approval_events (request_id, id)
    `);
}

function serializeRequest(row, details = null) {
    if (!row) return null;
    const metadata = safeJsonParse(row.metadata_json, {});
    return {
        id: Number(row.id),
        request_key: row.request_key,
        player_id: row.player_id,
        playerName: row.personagem_nome || row.player_name || null,
        tree_id: row.tree_id,
        node_id: row.node_id,
        status: row.status,
        cost: Number(row.cost || 0),
        baseCost: Number(row.base_cost || 0),
        discountPercent: Number(row.discount_percent || 0),
        requested_by: row.requested_by || null,
        requested_at: row.requested_at || null,
        reviewed_by: row.reviewed_by || null,
        reviewed_at: row.reviewed_at || null,
        review_reason: row.review_reason || null,
        purchase_id: row.purchase_id == null ? null : Number(row.purchase_id),
        review_token: row.review_token || null,
        review_started_at: row.review_started_at || null,
        last_error: row.last_error || null,
        metadata,
        tree: details?.state?.tree
            ? { id: details.state.tree.id, name: details.state.tree.name }
            : metadata.tree_name
                ? { name: metadata.tree_name }
                : null,
        node: details?.node
            ? { id: details.node.id, name: details.node.name }
            : metadata.node_name
                ? { name: metadata.node_name }
                : null,
    };
}

async function writeEvent(db, row, action, actorId, options = {}) {
    await db.run(
        `INSERT INTO clover_skill_approval_events
         (request_id, request_key, action, actor_id, from_status, to_status,
          reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            Number(row.id),
            row.request_key,
            action,
            actorId || 'system',
            options.fromStatus || row.status || null,
            options.toStatus || row.status || null,
            optionalText(options.reason),
            JSON.stringify(options.metadata || {}),
        ]
    );
}

async function getRequestRow(db, requestRef) {
    await ensureSkillApprovalSchema(db);
    const ref = String(requestRef || '').trim();
    if (!ref) return null;
    if (/^\d+$/.test(ref)) {
        return db.get(
            `SELECT r.*, j.personagem_nome
             FROM clover_skill_approval_requests r
             LEFT JOIN jogadores j ON j.id = r.player_id
             WHERE r.id = ?`,
            [Number(ref)]
        );
    }
    return db.get(
        `SELECT r.*, j.personagem_nome
         FROM clover_skill_approval_requests r
         LEFT JOIN jogadores j ON j.id = r.player_id
         WHERE r.request_key = ? COLLATE NOCASE`,
        [ref]
    );
}

async function getSkillApproval(db, requestRef) {
    const row = await getRequestRow(db, requestRef);
    if (!row) {
        throw new SkillApprovalError('approval_not_found', 'Pedido de aprovação não encontrado.', 404);
    }
    return serializeRequest(row);
}

async function listSkillApprovals(db, options = {}) {
    await ensureSkillApprovalSchema(db);
    const status = String(options.status || 'pending').trim().toLowerCase();
    if (!VALID_STATUSES.includes(status)) {
        throw new SkillApprovalError('invalid_approval_status', 'Status de aprovação inválido.', 400, {
            status,
            allowed: VALID_STATUSES,
        });
    }
    const limit = Math.max(1, Math.min(300, Number(options.limit) || 100));
    const rows = await db.all(
        `SELECT r.*, j.personagem_nome
         FROM clover_skill_approval_requests r
         LEFT JOIN jogadores j ON j.id = r.player_id
         WHERE r.status = ?
         ORDER BY r.requested_at ASC, r.id ASC
         LIMIT ?`,
        [status, limit]
    );
    return rows.map((row) => serializeRequest(row));
}

async function requestSkillApproval(db, playerId, treeId, nodeAlias, requestedBy = playerId) {
    await ensureSkillApprovalSchema(db);
    const details = await getNodeDetails(db, playerId, treeId, nodeAlias);
    if (!details.ok) {
        throw new SkillApprovalError(
            details.reason || 'node_not_found',
            'Nó não encontrado.',
            404,
            details
        );
    }
    if (details.nodeState.status === 'owned') {
        throw new SkillApprovalError('node_already_owned', 'Este nó já foi comprado.', 409);
    }
    if (details.nodeState.status !== 'approval') {
        throw new SkillApprovalError(
            'approval_not_required',
            'Este nó não exige aprovação humana neste estado.',
            409,
            { nodeStatus: details.nodeState.status }
        );
    }

    const existing = await db.get(
        `SELECT r.*, j.personagem_nome
         FROM clover_skill_approval_requests r
         LEFT JOIN jogadores j ON j.id = r.player_id
         WHERE r.player_id = ? AND r.tree_id = ? AND r.node_id = ? AND r.status = 'pending'
         ORDER BY r.id DESC LIMIT 1`,
        [playerId, details.state.tree.id, details.node.id]
    );
    if (existing) {
        return { ok: true, idempotent: true, request: serializeRequest(existing, details) };
    }

    const cost = Number(details.nodeState.effectiveCost ?? details.node.cost ?? 0);
    const baseCost = Number(details.node.cost || 0);
    const discountPercent = Number(details.nodeState.discount?.percent || 0);
    const metadata = {
        tree_name: details.state.tree.name || details.state.tree.id,
        node_name: details.node.name,
        discount_sources: details.nodeState.discount?.sources || [],
    };

    try {
        const inserted = await db.run(
            `INSERT INTO clover_skill_approval_requests
             (request_key, player_id, tree_id, node_id, status, cost, base_cost,
              discount_percent, requested_by, requested_at, metadata_json)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
            [
                requestKey(),
                playerId,
                details.state.tree.id,
                details.node.id,
                cost,
                baseCost,
                discountPercent,
                requestedBy,
                JSON.stringify(metadata),
            ]
        );
        const row = await getRequestRow(db, inserted.lastID);
        await writeEvent(db, row, 'requested', requestedBy, {
            fromStatus: null,
            toStatus: 'pending',
            metadata: { cost, baseCost, discountPercent },
        });
        return { ok: true, idempotent: false, request: serializeRequest(row, details) };
    } catch (error) {
        if (String(error?.message || '').includes('idx_clover_skill_approval_one_pending')) {
            const row = await db.get(
                `SELECT r.*, j.personagem_nome
                 FROM clover_skill_approval_requests r
                 LEFT JOIN jogadores j ON j.id = r.player_id
                 WHERE r.player_id = ? AND r.tree_id = ? AND r.node_id = ? AND r.status = 'pending'
                 ORDER BY r.id DESC LIMIT 1`,
                [playerId, details.state.tree.id, details.node.id]
            );
            if (row) return { ok: true, idempotent: true, request: serializeRequest(row, details) };
        }
        throw error;
    }
}

function staleClaim(row, now = Date.now()) {
    if (!row?.review_token || !row?.review_started_at) return false;
    const startedAt = new Date(row.review_started_at).getTime();
    return Number.isFinite(startedAt) && startedAt <= now - REVIEW_CLAIM_TTL_MS;
}

async function recoverStaleClaim(db, row, actorId = 'system') {
    if (!row || row.status !== 'pending' || !staleClaim(row)) return false;
    const updated = await db.run(
        `UPDATE clover_skill_approval_requests
         SET review_token = NULL,
             review_started_at = NULL,
             last_error = COALESCE(last_error, 'stale_review_claim_recovered')
         WHERE id = ? AND status = 'pending' AND review_token = ?`,
        [row.id, row.review_token]
    );
    if (Number(updated.changes || 0) !== 1) return false;
    await writeEvent(db, row, 'claim_recovered', actorId, {
        fromStatus: 'pending',
        toStatus: 'pending',
        reason: 'Claim de revisão expirado e liberado.',
    });
    return true;
}

async function claimApprovalReview(db, requestRef, actorId) {
    await ensureSkillApprovalSchema(db);
    let row = await getRequestRow(db, requestRef);
    if (!row) throw new SkillApprovalError('approval_not_found', 'Pedido de aprovação não encontrado.', 404);
    if (row.status !== 'pending') return { row, token: null, finalized: true };

    if (row.review_token) {
        await recoverStaleClaim(db, row, actorId);
        row = await getRequestRow(db, requestRef);
    }
    if (row.review_token) {
        throw new SkillApprovalError(
            'approval_review_in_progress',
            'Este pedido já está sendo revisado.',
            409,
            { reviewStartedAt: row.review_started_at }
        );
    }

    const token = randomUUID();
    const claimed = await db.run(
        `UPDATE clover_skill_approval_requests
         SET review_token = ?, review_started_at = CURRENT_TIMESTAMP, last_error = NULL
         WHERE id = ? AND status = 'pending' AND review_token IS NULL`,
        [token, row.id]
    );
    if (Number(claimed.changes || 0) !== 1) {
        throw new SkillApprovalError('approval_review_in_progress', 'Este pedido já está sendo revisado.', 409);
    }
    row = await getRequestRow(db, row.id);
    await writeEvent(db, row, 'review_claimed', actorId, {
        fromStatus: 'pending',
        toStatus: 'pending',
    });
    return { row, token, finalized: false };
}

async function releaseApprovalClaim(db, row, token, error = null) {
    if (!row || !token) return;
    await db.run(
        `UPDATE clover_skill_approval_requests
         SET review_token = NULL, review_started_at = NULL, last_error = ?
         WHERE id = ? AND status = 'pending' AND review_token = ?`,
        [optionalText(error?.code || error?.message || error), row.id, token]
    );
}

async function findApprovalPurchase(db, request) {
    const rows = await db.all(
        `SELECT id, metadata_json
         FROM clover_skill_nodes
         WHERE player_id = ? AND tree_id = ? AND node_id = ?
         ORDER BY id DESC`,
        [request.player_id, request.tree_id, request.node_id]
    );
    for (const row of rows || []) {
        const metadata = safeJsonParse(row.metadata_json, {});
        if (metadata.approval_request_key === request.request_key) return row;
    }
    return null;
}

async function buyApprovedNode(db, request, actorId) {
    const recovered = await findApprovalPurchase(db, request);
    if (recovered) {
        return {
            ok: true,
            idempotent: true,
            purchaseId: Number(recovered.id),
            state: await getTreeState(db, request.player_id, request.tree_id),
        };
    }

    await getTreeState(db, request.player_id, request.tree_id);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const details = await getNodeDetails(
            db,
            request.player_id,
            request.tree_id,
            request.node_id
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
            const purchase = await findApprovalPurchase(db, request);
            if (!purchase) {
                throw new SkillApprovalError(
                    'node_already_owned',
                    'O nó já foi comprado por outro fluxo; a aprovação não será associada automaticamente.',
                    409
                );
            }
            await db.exec('COMMIT');
            return {
                ok: true,
                idempotent: true,
                purchaseId: Number(purchase.id),
                state: await getTreeState(db, request.player_id, request.tree_id),
            };
        }
        if (details.nodeState.status !== 'approval') {
            throw new SkillApprovalError(
                'approval_revalidation_failed',
                'Os requisitos, custo ou PH mudaram desde o pedido. Gere/revise o pedido novamente.',
                409,
                { nodeStatus: details.nodeState.status }
            );
        }

        const cost = Number(details.nodeState.effectiveCost ?? details.node.cost ?? 0);
        const baseCost = Number(details.node.cost || 0);
        if (cost !== Number(request.cost || 0)) {
            throw new SkillApprovalError(
                'approval_cost_changed',
                'O custo do nó mudou desde o pedido. A aprovação foi bloqueada.',
                409,
                { requestedCost: Number(request.cost || 0), currentCost: cost }
            );
        }

        const inserted = await db.run(
            `INSERT INTO clover_skill_nodes
             (player_id, tree_id, node_id, purchased_at, purchased_by, source, metadata_json)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'skill_tree_approval', ?)`,
            [
                request.player_id,
                request.tree_id,
                request.node_id,
                actorId,
                JSON.stringify({
                    node_name: details.node.name,
                    cost,
                    base_cost: baseCost,
                    discount_percent: Number(details.nodeState.discount?.percent || 0),
                    discount_sources: details.nodeState.discount?.sources || [],
                    approval_request_key: request.request_key,
                    approval_request_id: Number(request.id),
                }),
            ]
        );

        const spend = await spendPhInTransaction(
            db,
            request.player_id,
            cost,
            `skill_tree:${request.tree_id}`,
            `Compra de no aprovada: ${details.node.name}`,
            actorId,
            {
                tree_id: request.tree_id,
                node_id: request.node_id,
                node_name: details.node.name,
                purchase_id: inserted.lastID,
                approval_request_key: request.request_key,
                base_cost: baseCost,
                discount_percent: Number(details.nodeState.discount?.percent || 0),
                discount_sources: details.nodeState.discount?.sources || [],
            },
            `${request.tree_id}:${request.node_id}`
        );
        await db.exec('COMMIT');
        return {
            ok: true,
            idempotent: false,
            purchaseId: Number(inserted.lastID),
            cost,
            spend,
            state: await getTreeState(db, request.player_id, request.tree_id),
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        const recoveredAfterRollback = await findApprovalPurchase(db, request);
        if (recoveredAfterRollback) {
            return {
                ok: true,
                idempotent: true,
                purchaseId: Number(recoveredAfterRollback.id),
                state: await getTreeState(db, request.player_id, request.tree_id),
            };
        }
        throw error;
    }
}

async function approveSkillApproval(db, requestRef, actorId, reason = null) {
    await ensureSkillApprovalSchema(db);
    let row = await getRequestRow(db, requestRef);
    if (!row) throw new SkillApprovalError('approval_not_found', 'Pedido de aprovação não encontrado.', 404);
    if (row.status === 'approved') {
        return { ok: true, idempotent: true, request: serializeRequest(row) };
    }
    if (row.status !== 'pending') {
        throw new SkillApprovalError(
            'approval_already_reviewed',
            'Este pedido já foi encerrado.',
            409,
            { status: row.status }
        );
    }

    const claim = await claimApprovalReview(db, requestRef, actorId);
    row = claim.row;
    let purchase;
    try {
        purchase = await buyApprovedNode(db, row, actorId);
    } catch (error) {
        await releaseApprovalClaim(db, row, claim.token, error);
        throw error;
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const updated = await db.run(
            `UPDATE clover_skill_approval_requests
             SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
                 review_reason = ?, purchase_id = ?, review_token = NULL,
                 review_started_at = NULL, last_error = NULL
             WHERE id = ? AND status = 'pending' AND review_token = ?`,
            [actorId, optionalText(reason), purchase.purchaseId, row.id, claim.token]
        );
        if (Number(updated.changes || 0) !== 1) {
            const current = await getRequestRow(db, row.id);
            if (current?.status === 'approved') {
                await db.exec('COMMIT');
                return { ok: true, idempotent: true, request: serializeRequest(current), purchase };
            }
            throw new SkillApprovalError('approval_claim_lost', 'O claim da aprovação não é mais válido.', 409);
        }
        const current = await getRequestRow(db, row.id);
        await writeEvent(db, current, 'approved', actorId, {
            fromStatus: 'pending',
            toStatus: 'approved',
            reason,
            metadata: { purchaseId: purchase.purchaseId, purchaseIdempotent: purchase.idempotent },
        });
        await db.exec('COMMIT');
        return { ok: true, idempotent: false, request: serializeRequest(current), purchase };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function rejectSkillApproval(db, requestRef, actorId, reason = null) {
    await ensureSkillApprovalSchema(db);
    let row = await getRequestRow(db, requestRef);
    if (!row) throw new SkillApprovalError('approval_not_found', 'Pedido de aprovação não encontrado.', 404);
    if (row.status === 'rejected') {
        return { ok: true, idempotent: true, request: serializeRequest(row) };
    }
    if (row.status !== 'pending') {
        throw new SkillApprovalError(
            'approval_already_reviewed',
            'Este pedido já foi encerrado.',
            409,
            { status: row.status }
        );
    }

    const claim = await claimApprovalReview(db, requestRef, actorId);
    row = claim.row;
    await db.exec('BEGIN IMMEDIATE');
    try {
        const updated = await db.run(
            `UPDATE clover_skill_approval_requests
             SET status = 'rejected', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
                 review_reason = ?, review_token = NULL, review_started_at = NULL,
                 last_error = NULL
             WHERE id = ? AND status = 'pending' AND review_token = ?`,
            [actorId, optionalText(reason), row.id, claim.token]
        );
        if (Number(updated.changes || 0) !== 1) {
            const current = await getRequestRow(db, row.id);
            if (current?.status === 'rejected') {
                await db.exec('COMMIT');
                return { ok: true, idempotent: true, request: serializeRequest(current) };
            }
            throw new SkillApprovalError('approval_claim_lost', 'O claim da rejeição não é mais válido.', 409);
        }
        const current = await getRequestRow(db, row.id);
        await writeEvent(db, current, 'rejected', actorId, {
            fromStatus: 'pending',
            toStatus: 'rejected',
            reason,
        });
        await db.exec('COMMIT');
        return { ok: true, idempotent: false, request: serializeRequest(current) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    REVIEW_CLAIM_TTL_MS,
    SkillApprovalError,
    VALID_STATUSES,
    approveSkillApproval,
    buyApprovedNode,
    claimApprovalReview,
    ensureSkillApprovalSchema,
    getSkillApproval,
    listSkillApprovals,
    recoverStaleClaim,
    rejectSkillApproval,
    requestSkillApproval,
    serializeRequest,
    staleClaim,
    writeEvent,
};
