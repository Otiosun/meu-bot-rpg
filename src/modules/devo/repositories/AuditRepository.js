const { BaseRepository } = require('./BaseRepository');

function normalizeLimit(limit, fallback = 20, max = 50) {
    const parsed = parseInt(limit, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

class AuditRepository extends BaseRepository {
    constructor(db) {
        super(db, {
            tableName: 'audit_logs',
            idPrefix: 'audit',
            insertColumns: [
                'actor_user_id',
                'actor_manager_id',
                'action',
                'entity_type',
                'entity_id',
                'payload_json',
            ],
            updateColumns: [],
        });
    }

    async record(event = {}) {
        return this.create({
            actor_user_id: event.actorUserId || 'system',
            actor_manager_id: event.actorManagerId || null,
            action: event.action || event.type || 'devo.event',
            entity_type: event.entityType || 'system',
            entity_id: event.entityId || null,
            payload_json: JSON.stringify(event.payload || event),
        });
    }

    async listByEntity(entityType, entityId, { limit = 20 } = {}) {
        if (!this.db) return [];
        return this.db.all(
            `SELECT *
             FROM audit_logs
             WHERE entity_type = ? AND entity_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
            [entityType, entityId, normalizeLimit(limit)]
        );
    }
}

module.exports = { AuditRepository };
