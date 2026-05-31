const { BaseRepository } = require('./BaseRepository');

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
}

module.exports = { AuditRepository };
