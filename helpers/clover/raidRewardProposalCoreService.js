'use strict';

const crypto = require('crypto');
const { isSameUser, normalizeJid } = require('../groupAccess');
const { getAccessContext, getRoleLabel, hasAccessPermission } = require('./accessControlService');
const { normalizeSquadKey } = require('./cavalierService');
const { resolvePlayerSquadMembership } = require('./squadMembershipReadService');
const { completeRaidForRewardProposal } = require('./raidService');

const PROPOSAL_SNAPSHOT_SCHEMA_VERSION = 2;

class RaidRewardProposalError extends Error {
    constructor(message, code = 'raid_reward_proposal_error', details = null) {
        super(message);
        this.name = 'RaidRewardProposalError';
        this.code = code;
        this.details = details;
    }
}

function filled(value) {
    const text = String(value || '').trim();
    return text && text !== '-' ? text : null;
}

function normalizeStatus(value) {
    const status = String(value || 'pending').trim().toLowerCase();
    if (['pending', 'returned', 'approved', 'rejected', 'delivered'].includes(status)) return status;
    return 'pending';
}

function normalizeDecision(value) {
    const decision = String(value || '').trim().toLowerCase();
    if (['approve', 'return', 'reject'].includes(decision)) return decision;
    throw new RaidRewardProposalError('Decisao invalida.', 'invalid_review_decision');
}

async function ensureRaidRewardProposalSchema(db) {
    void db;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((acc, key) => {
        acc[key] = stableValue(value[key]);
        return acc;
    }, {});
}

function stableStringify(value) {
    return JSON.stringify(stableValue(value));
}

function hashCanonicalSnapshot(canonical) {
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

function timingSafeHashEqual(left, right) {
    const leftBytes = Buffer.from(String(left || ''), 'hex');
    const rightBytes = Buffer.from(String(right || ''), 'hex');
    return leftBytes.length === 32
        && rightBytes.length === 32
        && crypto.timingSafeEqual(leftBytes, rightBytes);
}

async function buildProposalSnapshot(db, raidId) {
    const raid = await db.get('SELECT * FROM clover_raids WHERE id = ?', [raidId]);
    const raidSquadKey = normalizeSquadKey(raid?.scope_squad_key);
    const rewards = await db.all(
        `SELECT id, target_type, target_player_id, reward_type, amount, template_key,
                resource_key, label, reason, status
         FROM clover_raid_rewards
         WHERE raid_id = ? AND status = 'draft'
         ORDER BY id ASC`,
        [raidId]
    );
    const participants = await db.all(
        `SELECT p.player_id, p.status, p.finalization_status
         FROM clover_raid_participants p
         WHERE p.raid_id = ? AND p.status = 'active'
         ORDER BY p.player_id ASC, p.id ASC`,
        [raidId]
    );
    const snapshot = {
        version: PROPOSAL_SNAPSHOT_SCHEMA_VERSION,
        raidId: Number(raidId),
        rewards: rewards.map((reward) => ({
            id: Number(reward.id),
            targetType: reward.target_type,
            targetPlayerId: reward.target_player_id || null,
            rewardType: reward.reward_type,
            amount: Number(reward.amount),
            templateKey: reward.template_key || null,
            resourceKey: reward.resource_key || null,
            label: reward.label,
            reason: reward.reason || null,
            status: reward.status,
        })),
        participants: await Promise.all(participants.map(async (participant) => {
            const membership = raidSquadKey ? null : await resolvePlayerSquadMembership(db, participant.player_id);
            return {
            playerId: participant.player_id,
            status: participant.status,
            finalizationStatus: participant.finalization_status || 'pending',
            starBeneficiarySquadKey: raidSquadKey || (membership?.ok ? membership.squadKey : null),
            };
        })),
    };
    const canonical = stableStringify(snapshot);
    return {
        snapshot,
        canonical,
        hash: hashCanonicalSnapshot(canonical),
    };
}

async function assertProposalSnapshotFresh(db, row) {
    const version = Number(row.snapshot_version || 0);
    if (version !== PROPOSAL_SNAPSHOT_SCHEMA_VERSION) {
        throw new RaidRewardProposalError(
            'Esta proposta usa um snapshot legado. Devolva-a para que o host a reenvie com a elegibilidade atualizada.',
            'proposal_snapshot_legacy',
            { proposalId: String(row.id), snapshotVersion: version, requiredVersion: PROPOSAL_SNAPSHOT_SCHEMA_VERSION }
        );
    }

    const storedSnapshot = safeJsonParse(row.snapshot_json, null);
    if (!storedSnapshot || Number(storedSnapshot.version) !== PROPOSAL_SNAPSHOT_SCHEMA_VERSION) {
        throw new RaidRewardProposalError(
            'O snapshot armazenado da proposta esta inconsistente.',
            'proposal_snapshot_tampered',
            { proposalId: String(row.id) }
        );
    }

    const storedCanonical = stableStringify(storedSnapshot);
    const storedHash = hashCanonicalSnapshot(storedCanonical);
    if (!timingSafeHashEqual(row.snapshot_hash, storedHash)) {
        throw new RaidRewardProposalError(
            'O snapshot armazenado da proposta foi alterado ou esta corrompido.',
            'proposal_snapshot_tampered',
            { proposalId: String(row.id) }
        );
    }

    const current = await buildProposalSnapshot(db, row.raid_id);
    if (!timingSafeHashEqual(row.snapshot_hash, current.hash)) {
        throw new RaidRewardProposalError(
            'A proposta ficou desatualizada apos mudanca nas recompensas ou elegibilidade.',
            'proposal_stale',
            { proposalId: String(row.id) }
        );
    }
    return current;
}

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function starBeneficiarySquadsFromSnapshot(row) {
    const snapshot = safeJsonParse(row.snapshot_json, {});
    const pairs = {};
    for (const participant of snapshot?.participants || []) {
        if (!participant?.playerId) continue;
        pairs[participant.playerId] = participant.starBeneficiarySquadKey || null;
    }
    return pairs;
}

async function readProposalRow(db, proposalId) {
    await ensureRaidRewardProposalSchema(db);
    const id = Number(proposalId);
    const row = Number.isSafeInteger(id)
        ? await db.get(
            `SELECT p.*, r.raid_key, r.name AS raid_name, r.scope_squad_key, s.name AS squad_name
             FROM clover_raid_reward_proposals p
             JOIN clover_raids r ON r.id = p.raid_id
             LEFT JOIN clover_squads s ON s.squad_key = r.scope_squad_key
             WHERE p.id = ?`,
            [id]
        )
        : null;
    if (!row) throw new RaidRewardProposalError('Proposta nao encontrada.', 'proposal_not_found');
    return row;
}

async function proposerSummary(db, row) {
    const player = await db.get(
        `SELECT personagem_nome, display_name, nome FROM jogadores WHERE id = ?`,
        [row.proposed_by]
    ).catch(() => null);
    const context = await getAccessContext(db, row.proposed_by).catch(() => ({ roleKeys: [] }));
    const firstRole = context.owner ? 'owner' : context.roleKeys?.[0] || 'member';
    return {
        actorId: row.proposed_by,
        displayName: filled(player?.personagem_nome) || filled(player?.display_name) || filled(player?.nome) || 'Proponente',
        roleLabel: firstRole === 'owner' ? 'Owner' : getRoleLabel(firstRole),
    };
}

async function serializeProposal(db, row, actorId = null) {
    const rewards = await db.get(
        `SELECT COUNT(*) AS reward_count
         FROM clover_raid_rewards
         WHERE raid_id = ? AND status != 'cancelled'`,
        [row.raid_id]
    );
    const participants = await db.get(
        `SELECT COUNT(*) AS participant_count
         FROM clover_raid_participants
         WHERE raid_id = ? AND status IN ('joined', 'active', 'completed')`,
        [row.raid_id]
    );
    const actor = normalizeJid(actorId);
    const canReview = actor
        ? Boolean(await hasAccessPermission(db, actor, 'raid.reward.review'))
        : false;
    return {
        id: String(row.id),
        raidId: String(row.raid_id),
        raidName: row.raid_name,
        squad: row.scope_squad_key ? { key: row.scope_squad_key, name: row.squad_name || row.scope_squad_key } : null,
        proposer: await proposerSummary(db, row),
        status: normalizeStatus(row.status),
        participantCount: Number(participants?.participant_count || 0),
        rewardCount: Number(rewards?.reward_count || 0),
        proposedAt: row.proposed_at,
        canReview: Boolean(canReview && !isSameUser(actor, row.proposed_by)),
        selfReviewBlocked: Boolean(actor && isSameUser(actor, row.proposed_by)),
        duplicate: false,
    };
}

async function createRaidRewardProposal(db, { raidKey, actorId, metadata = {} }) {
    await ensureRaidRewardProposalSchema(db);
    const actor = normalizeJid(actorId);
    const raid = await db.get(
        `SELECT * FROM clover_raids WHERE raid_key = ? OR CAST(id AS TEXT) = ?`,
        [String(raidKey || '').trim().toUpperCase(), String(raidKey || '').trim()]
    );
    if (!raid) throw new RaidRewardProposalError('Raid nao encontrada.', 'raid_not_found');
    const activeHost = await db.get(
        `SELECT id FROM clover_raid_hosts
         WHERE raid_id = ? AND player_id = ? AND status = 'active'`,
        [raid.id, actor]
    );
    if (!activeHost) {
        throw new RaidRewardProposalError('Apenas host ativo pode propor recompensas desta raid.', 'raid_host_required');
    }
    const rewardCount = await db.get(
        "SELECT COUNT(*) AS total FROM clover_raid_rewards WHERE raid_id = ? AND status = 'draft'",
        [raid.id]
    );
    if (Number(rewardCount?.total || 0) < 1) {
        throw new RaidRewardProposalError('Adicione recompensas antes de propor revisao.', 'empty_reward_proposal');
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const snapshot = await buildProposalSnapshot(db, raid.id);
        const existing = await db.get(
            `SELECT * FROM clover_raid_reward_proposals
             WHERE raid_id = ? AND status IN ('pending', 'returned')
             ORDER BY id DESC LIMIT 1`,
            [raid.id]
        );
        if (existing?.status === 'pending') {
            await assertProposalSnapshotFresh(db, existing);
            await db.exec('COMMIT');
            const row = await readProposalRow(db, existing.id);
            return {
                ok: true,
                duplicate: true,
                proposal: { ...(await serializeProposal(db, row, actor)), duplicate: true },
            };
        }
        if (existing?.status === 'returned') {
            await db.run(
                `UPDATE clover_raid_reward_proposals
                 SET status = 'pending',
                     proposed_by = ?,
                     proposed_at = CURRENT_TIMESTAMP,
                     reviewed_by = NULL,
                     reviewed_at = NULL,
                     review_note = NULL,
                     delivery_key = NULL,
                     delivery_result_json = NULL,
                     snapshot_json = ?,
                     snapshot_hash = ?,
                     snapshot_version = ?,
                     metadata_json = ?
                 WHERE id = ? AND status = 'returned'`,
                [actor, snapshot.canonical, snapshot.hash, PROPOSAL_SNAPSHOT_SCHEMA_VERSION, JSON.stringify(metadata), existing.id]
            );
            await db.exec('COMMIT');
            const row = await readProposalRow(db, existing.id);
            return {
                ok: true,
                duplicate: false,
                resubmitted: true,
                proposal: await serializeProposal(db, row, actor),
            };
        }

        const inserted = await db.run(
            `INSERT INTO clover_raid_reward_proposals
             (raid_id, proposed_by, status, snapshot_json, snapshot_hash, snapshot_version, metadata_json)
             VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
            [raid.id, actor, snapshot.canonical, snapshot.hash, PROPOSAL_SNAPSHOT_SCHEMA_VERSION, JSON.stringify(metadata)]
        );
        await db.exec('COMMIT');
        const row = await readProposalRow(db, inserted.lastID);
        return { ok: true, duplicate: false, proposal: await serializeProposal(db, row, actor) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function listRaidRewardProposals(db, { actorId, status = 'pending' } = {}) {
    await ensureRaidRewardProposalSchema(db);
    const actor = normalizeJid(actorId);
    if (!actor || !await hasAccessPermission(db, actor, 'raid.reward.review')) {
        throw new RaidRewardProposalError('Voce nao pode consultar a fila de recompensas.', 'forbidden');
    }
    const normalizedStatus = normalizeStatus(status);
    const rows = await db.all(
        `SELECT p.*, r.raid_key, r.name AS raid_name, r.scope_squad_key, s.name AS squad_name
         FROM clover_raid_reward_proposals p
         JOIN clover_raids r ON r.id = p.raid_id
         LEFT JOIN clover_squads s ON s.squad_key = r.scope_squad_key
         WHERE p.status = ?
         ORDER BY p.proposed_at ASC, p.id ASC`,
        [normalizedStatus]
    );
    return Promise.all(rows.map((row) => serializeProposal(db, row, actor)));
}

async function requireReviewer(db, actorId, proposal) {
    const actor = normalizeJid(actorId);
    if (isSameUser(actor, proposal.proposed_by)) {
        throw new RaidRewardProposalError('Voce nao pode aprovar a propria proposta.', 'self_review_blocked');
    }
    if (!actor || !await hasAccessPermission(db, actor, 'raid.reward.review')) {
        throw new RaidRewardProposalError('Voce nao pode revisar recompensas de raid.', 'forbidden');
    }
    return actor;
}

async function reviewRaidRewardProposal(db, {
    proposalId,
    actorId,
    decision,
    note = null,
    beforeTransactionalReview = null,
}) {
    await ensureRaidRewardProposalSchema(db);
    let row = await readProposalRow(db, proposalId);
    const actor = await requireReviewer(db, actorId, row);
    const normalizedDecision = normalizeDecision(decision);
    const cleanNote = filled(note);

    if (normalizedDecision !== 'approve') {
        const status = normalizedDecision === 'return' ? 'returned' : 'rejected';
        await db.exec('BEGIN IMMEDIATE');
        try {
            row = await readProposalRow(db, proposalId);
            await requireReviewer(db, actor, row);
            if (row.status !== 'pending') {
                throw new RaidRewardProposalError(
                    'Apenas propostas pendentes podem ser devolvidas ou rejeitadas.',
                    'proposal_not_pending'
                );
            }
            const updatedRows = await db.run(
                `UPDATE clover_raid_reward_proposals
                 SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_note = ?
                 WHERE id = ? AND status = 'pending'`,
                [status, actor, cleanNote, row.id]
            );
            if (Number(updatedRows.changes || 0) !== 1) {
                throw new RaidRewardProposalError(
                    'Apenas propostas pendentes podem ser devolvidas ou rejeitadas.',
                    'proposal_not_pending'
                );
            }
            const updated = await readProposalRow(db, row.id);
            await db.exec('COMMIT');
            return { ok: true, duplicate: false, proposal: await serializeProposal(db, updated, actor) };
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => null);
            throw error;
        }
    }

    if (typeof beforeTransactionalReview === 'function') {
        await beforeTransactionalReview({ row, actor, decision: normalizedDecision });
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        row = await readProposalRow(db, proposalId);
        await requireReviewer(db, actor, row);
        if (row.status !== 'pending') {
            throw new RaidRewardProposalError(
                'Apenas propostas pendentes podem ser aprovadas.',
                'proposal_not_pending'
            );
        }
        await assertProposalSnapshotFresh(db, row);
        const deliveryKey = `raid_reward_proposal:${row.id}:v${row.snapshot_version}:${row.snapshot_hash}`;
        const completed = await completeRaidForRewardProposal(db, row.raid_key, actor, {
            idempotencyKey: deliveryKey,
            manageTransaction: false,
            proposalId: row.id,
            starBeneficiarySquads: starBeneficiarySquadsFromSnapshot(row),
        });
        await db.run(
            `UPDATE clover_raid_reward_proposals
             SET status = 'delivered',
                 reviewed_by = ?,
                 reviewed_at = CURRENT_TIMESTAMP,
                 review_note = ?,
                 delivery_key = ?,
                 delivery_result_json = ?
             WHERE id = ?`,
            [actor, cleanNote, deliveryKey, JSON.stringify(completed), row.id]
        );
        const updated = await readProposalRow(db, row.id);
        await db.exec('COMMIT');
        return {
            ok: true,
            duplicate: Boolean(completed.duplicate),
            proposal: await serializeProposal(db, updated, actor),
            delivery: completed,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    RaidRewardProposalError,
    createRaidRewardProposal,
    ensureRaidRewardProposalSchema,
    listRaidRewardProposals,
    reviewRaidRewardProposal,
};
