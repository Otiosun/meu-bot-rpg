const { BaseRepository } = require('./BaseRepository');

function normalizeLimit(limit) {
    if (limit === null || limit === undefined) return null;
    const parsed = parseInt(limit, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return 20;
    return Math.min(parsed, 50);
}

class LifeLedgerRepository extends BaseRepository {
    constructor(db) {
        super(db, {
            tableName: 'life_ledger',
            idPrefix: 'life',
            insertColumns: [
                'record_id',
                'deadly_vote_id',
                'type',
                'amount_seconds',
                'reason',
                'created_by_manager_id',
            ],
            updateColumns: [],
        });
    }

    async listByRecordId(recordId, limit = null) {
        if (!this.db) return [];
        const safeLimit = normalizeLimit(limit);
        const params = [recordId];
        let limitClause = '';
        if (safeLimit) {
            limitClause = ' LIMIT ?';
            params.push(safeLimit);
        }

        return this.db.all(
            `SELECT
                ll.*,
                dv.title AS deadly_vote_title,
                dv.code AS deadly_vote_code
             FROM life_ledger ll
             LEFT JOIN deadly_votes dv ON dv.id = ll.deadly_vote_id
             WHERE ll.record_id = ?
             ORDER BY ll.created_at DESC, ll.id DESC${limitClause}`,
            params
        );
    }

    async listByDeadlyVoteId(deadlyVoteId, limit = 20) {
        if (!this.db) return [];
        return this.db.all(
            `SELECT
                ll.*,
                r.name AS record_name,
                r.user_id AS record_user_id,
                dv.title AS deadly_vote_title,
                dv.code AS deadly_vote_code
             FROM life_ledger ll
             LEFT JOIN records r ON r.id = ll.record_id
             LEFT JOIN deadly_votes dv ON dv.id = ll.deadly_vote_id
             WHERE ll.deadly_vote_id = ?
             ORDER BY ll.created_at DESC, ll.id DESC
             LIMIT ?`,
            [deadlyVoteId, normalizeLimit(limit) || 20]
        );
    }
}

module.exports = { LifeLedgerRepository };
