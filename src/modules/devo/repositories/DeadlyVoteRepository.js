const { BaseRepository } = require('./BaseRepository');

class DeadlyVoteRepository extends BaseRepository {
    constructor(db) {
        super(db, {
            tableName: 'deadly_votes',
            idPrefix: 'dv',
            insertColumns: [
                'title',
                'code',
                'status',
                'max_slots',
                'reserved_slots',
                'created_by_manager_id',
                'started_at',
                'ended_at',
            ],
            updateColumns: [
                'title',
                'code',
                'status',
                'max_slots',
                'reserved_slots',
                'started_at',
                'ended_at',
                'updated_at',
            ],
        });
    }

    async getByCode(code) {
        if (!this.db) return null;
        return this.db.get('SELECT * FROM deadly_votes WHERE code = ?', [code]);
    }

    async listVotes({ status = null, limit = 20 } = {}) {
        if (!this.db) return [];

        if (status) {
            return this.db.all(
                `SELECT *
                 FROM deadly_votes
                 WHERE status = ?
                 ORDER BY created_at DESC
                 LIMIT ?`,
                [status, limit]
            );
        }

        return this.list({ limit });
    }

    async markStarted(id) {
        if (!this.db) return { changes: 0, vote: null };

        const result = await this.db.run(
            `UPDATE deadly_votes
             SET status = 'em_andamento',
                 started_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status IN ('convocando', 'lotado')`,
            [id]
        );

        return {
            changes: Number(result?.changes || 0),
            vote: await this.getById(id),
        };
    }

    async markEnded(id) {
        if (!this.db) return { changes: 0, vote: null };

        const result = await this.db.run(
            `UPDATE deadly_votes
             SET status = 'resolucao_pendente',
                 ended_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status IN ('em_andamento', 'iniciado')`,
            [id]
        );

        return {
            changes: Number(result?.changes || 0),
            vote: await this.getById(id),
        };
    }

    async markCanceled(id) {
        if (!this.db) return { changes: 0, vote: null };

        const result = await this.db.run(
            `UPDATE deadly_votes
             SET status = 'cancelado',
                 ended_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status IN ('rascunho', 'preparado', 'convocando', 'lotado')`,
            [id]
        );

        return {
            changes: Number(result?.changes || 0),
            vote: await this.getById(id),
        };
    }

    async markClosedIfPendingResolution(id) {
        if (!this.db) return { changes: 0, vote: null };

        const result = await this.db.run(
            `UPDATE deadly_votes
             SET status = 'encerrado',
                 ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'resolucao_pendente'`,
            [id]
        );

        return {
            changes: Number(result?.changes || 0),
            vote: await this.getById(id),
        };
    }
}

module.exports = { DeadlyVoteRepository };
