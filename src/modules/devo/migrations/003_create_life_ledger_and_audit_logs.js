const migration = {
    id: '003_create_life_ledger_and_audit_logs',
    name: 'Create Devo life ledger and audit logs',
    async up(db) {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS life_ledger (
                id TEXT PRIMARY KEY,
                record_id TEXT NOT NULL,
                deadly_vote_id TEXT,
                type TEXT NOT NULL
                    CHECK (type IN (
                        'ganho',
                        'perda',
                        'compra',
                        'aposta',
                        'divida',
                        'penalidade',
                        'recompensa',
                        'ajuste_admin'
                    )),
                amount_seconds INTEGER NOT NULL CHECK (amount_seconds <> 0),
                reason TEXT NOT NULL DEFAULT '',
                created_by_manager_id TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (record_id)
                    REFERENCES records (id)
                    ON DELETE CASCADE,
                FOREIGN KEY (deadly_vote_id)
                    REFERENCES deadly_votes (id)
                    ON DELETE SET NULL,
                FOREIGN KEY (created_by_manager_id)
                    REFERENCES manager_profiles (id)
                    ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_life_ledger_record
            ON life_ledger (record_id);

            CREATE INDEX IF NOT EXISTS idx_life_ledger_deadly_vote
            ON life_ledger (deadly_vote_id);

            CREATE INDEX IF NOT EXISTS idx_life_ledger_type
            ON life_ledger (type);

            CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY,
                actor_user_id TEXT NOT NULL,
                actor_manager_id TEXT,
                action TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (actor_manager_id)
                    REFERENCES manager_profiles (id)
                    ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user
            ON audit_logs (actor_user_id);

            CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_manager
            ON audit_logs (actor_manager_id);

            CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
            ON audit_logs (entity_type, entity_id);

            CREATE INDEX IF NOT EXISTS idx_audit_logs_action
            ON audit_logs (action);
        `);
    },
};

module.exports = migration;
