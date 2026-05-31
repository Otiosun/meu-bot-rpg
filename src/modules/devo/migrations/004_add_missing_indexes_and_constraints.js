const migration = {
    id: '004_add_missing_indexes_and_constraints',
    name: 'Add missing indexes and (safe) constraints for Devo',
    async up(db) {
        // ensure foreign keys are enforced while altering indexes
        try {
            await db.exec("PRAGMA foreign_keys = ON");
        } catch (e) {
            // ignore
        }

        // Create indexes that may be missing. IF NOT EXISTS prevents duplicate-name errors.
        await db.exec(`
            CREATE INDEX IF NOT EXISTS idx_records_user_id
            ON records (user_id);

            CREATE INDEX IF NOT EXISTS idx_records_status
            ON records (status);

            CREATE INDEX IF NOT EXISTS idx_deadly_votes_status
            ON deadly_votes (status);

            CREATE INDEX IF NOT EXISTS idx_dv_invitations_record
            ON deadly_vote_invitations (record_id);

            CREATE INDEX IF NOT EXISTS idx_dv_invitations_deadly_vote
            ON deadly_vote_invitations (deadly_vote_id);

            CREATE INDEX IF NOT EXISTS idx_dv_invitations_status
            ON deadly_vote_invitations (status);

            CREATE INDEX IF NOT EXISTS idx_dv_participants_deadly_vote
            ON deadly_vote_participants (deadly_vote_id);

            CREATE INDEX IF NOT EXISTS idx_life_ledger_record
            ON life_ledger (record_id);

            CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
            ON audit_logs (entity_type, entity_id);
        `);

        // Attempt to create a UNIQUE index on records.user_id only if there are no duplicates.
        const duplicates = await db.all(`SELECT user_id, COUNT(*) as c FROM records GROUP BY user_id HAVING c > 1`);
        if (duplicates && duplicates.length) {
            throw new Error('Found duplicate user_id values in records; cannot create UNIQUE index on records.user_id. Fix duplicates first.');
        }

        await db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_records_user_id_unique
            ON records (user_id);
        `);
    },
};

module.exports = migration;
