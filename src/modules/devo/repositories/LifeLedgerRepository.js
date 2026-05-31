const { BaseRepository } = require('./BaseRepository');

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

    async listByRecordId(recordId) {
        if (!this.db) return [];
        return this.db.all(
            `SELECT *
             FROM life_ledger
             WHERE record_id = ?
             ORDER BY created_at DESC`,
            [recordId]
        );
    }
}

module.exports = { LifeLedgerRepository };
