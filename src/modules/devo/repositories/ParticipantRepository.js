const { BaseRepository, buildId } = require('./BaseRepository');

function normalizeLimit(limit) {
    if (limit === null || limit === undefined) return null;
    const parsed = parseInt(limit, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return 20;
    return Math.min(parsed, 50);
}

class ParticipantRepository extends BaseRepository {
    constructor(db) {
        super(db, {
            tableName: 'deadly_vote_participants',
            idPrefix: 'part',
            insertColumns: [
                'deadly_vote_id',
                'record_id',
                'invitation_id',
                'status',
                'joined_at',
                'resolved_at',
            ],
            updateColumns: ['status', 'joined_at', 'resolved_at', 'updated_at'],
        });
    }

    async listByDeadlyVoteId(deadlyVoteId) {
        if (!this.db) return [];
        return this.db.all(
            `SELECT *
             FROM deadly_vote_participants
             WHERE deadly_vote_id = ?
             ORDER BY created_at DESC`,
            [deadlyVoteId]
        );
    }

    async listByDeadlyVoteIdWithRecords(deadlyVoteId, limit = null) {
        if (!this.db) return [];
        const safeLimit = normalizeLimit(limit);
        const params = [deadlyVoteId];
        let limitClause = '';
        if (safeLimit) {
            limitClause = ' LIMIT ?';
            params.push(safeLimit);
        }
        const orderClause = safeLimit
            ? 'ORDER BY COALESCE(p.resolved_at, p.joined_at, p.created_at) DESC, p.created_at DESC'
            : 'ORDER BY COALESCE(p.joined_at, p.created_at) ASC, p.created_at ASC';

        return this.db.all(
            `SELECT
                p.*,
                r.name AS record_name,
                r.user_id AS record_user_id,
                r.status AS record_status
             FROM deadly_vote_participants p
             INNER JOIN records r ON r.id = p.record_id
             WHERE p.deadly_vote_id = ?
             ${orderClause}${limitClause}`,
            params
        );
    }

    async listByRecordIdWithVotes(recordId, limit = 20) {
        if (!this.db) return [];
        return this.db.all(
            `SELECT
                p.*,
                dv.title AS deadly_vote_title,
                dv.code AS deadly_vote_code,
                dv.status AS deadly_vote_status
             FROM deadly_vote_participants p
             INNER JOIN deadly_votes dv ON dv.id = p.deadly_vote_id
             WHERE p.record_id = ?
             ORDER BY COALESCE(p.resolved_at, p.joined_at, p.created_at) DESC, p.created_at DESC
             LIMIT ?`,
            [recordId, normalizeLimit(limit) || 20]
        );
    }

    async getByVoteAndRecord(deadlyVoteId, recordId) {
        if (!this.db) return null;
        return this.db.get(
            `SELECT *
             FROM deadly_vote_participants
             WHERE deadly_vote_id = ? AND record_id = ?`,
            [deadlyVoteId, recordId]
        );
    }

    async countByVoteAndStatus(deadlyVoteId, status) {
        if (!this.db) return 0;
        const row = await this.db.get(
            `SELECT COUNT(*) AS count
             FROM deadly_vote_participants
             WHERE deadly_vote_id = ? AND status = ?`,
            [deadlyVoteId, status]
        );
        return Number(row?.count || 0);
    }

    async countPendingResolution(deadlyVoteId) {
        return this.countByVoteAndStatus(deadlyVoteId, 'pendente_resolucao');
    }

    async createConfirmed({ deadlyVoteId, recordId, invitationId = null } = {}) {
        if (!this.db) return null;
        const id = buildId(this.idPrefix);

        await this.db.run(
            `INSERT INTO deadly_vote_participants (
                id,
                deadly_vote_id,
                record_id,
                invitation_id,
                status,
                joined_at
             )
             VALUES (?, ?, ?, ?, 'confirmado', CURRENT_TIMESTAMP)`,
            [id, deadlyVoteId, recordId, invitationId]
        );

        return this.getById(id);
    }

    async markConfirmedAsActive(deadlyVoteId) {
        if (!this.db) return { changes: 0 };

        const result = await this.db.run(
            `UPDATE deadly_vote_participants
             SET status = 'ativo',
                 updated_at = CURRENT_TIMESTAMP
             WHERE deadly_vote_id = ? AND status = 'confirmado'`,
            [deadlyVoteId]
        );

        return { changes: Number(result?.changes || 0) };
    }

    async markActiveAsPendingResolution(deadlyVoteId) {
        if (!this.db) return { changes: 0 };

        const result = await this.db.run(
            `UPDATE deadly_vote_participants
             SET status = 'pendente_resolucao',
                 updated_at = CURRENT_TIMESTAMP
             WHERE deadly_vote_id = ? AND status = 'ativo'`,
            [deadlyVoteId]
        );

        return { changes: Number(result?.changes || 0) };
    }

    async markRemoved(participantId) {
        if (!this.db) return { changes: 0, participant: null };

        const result = await this.db.run(
            `UPDATE deadly_vote_participants
             SET status = 'removido',
                 resolved_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'confirmado'`,
            [participantId]
        );

        return {
            changes: Number(result?.changes || 0),
            participant: await this.getById(participantId),
        };
    }

    async markResolved(participantId, resolutionStatus) {
        if (!this.db) return { changes: 0, participant: null };

        const result = await this.db.run(
            `UPDATE deadly_vote_participants
             SET status = ?,
                 resolved_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'pendente_resolucao'`,
            [resolutionStatus, participantId]
        );

        return {
            changes: Number(result?.changes || 0),
            participant: await this.getById(participantId),
        };
    }
}

module.exports = { ParticipantRepository };
