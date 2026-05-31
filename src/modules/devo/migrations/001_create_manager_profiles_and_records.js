const migration = {
    id: '001_create_manager_profiles_and_records',
    name: 'Create Devo manager profiles and records',
    async up(db) {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS manager_profiles (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL UNIQUE,
                codename TEXT NOT NULL,
                animal TEXT,
                number INTEGER,
                permission_level INTEGER NOT NULL DEFAULT 0,
                active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_profiles_number
            ON manager_profiles (number)
            WHERE number IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_manager_profiles_active
            ON manager_profiles (active);

            CREATE TRIGGER IF NOT EXISTS trg_manager_profiles_updated_at
            AFTER UPDATE ON manager_profiles
            FOR EACH ROW
            WHEN NEW.updated_at = OLD.updated_at
            BEGIN
                UPDATE manager_profiles
                SET updated_at = CURRENT_TIMESTAMP
                WHERE id = OLD.id;
            END;

            CREATE TABLE IF NOT EXISTS records (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'ativo'
                    CHECK (status IN ('ativo', 'morto', 'suspenso', 'inativo')),
                life_status TEXT NOT NULL DEFAULT 'ativo'
                    CHECK (life_status IN ('ativo', 'critico', 'esgotado', 'congelado')),
                life_remaining_seconds INTEGER NOT NULL DEFAULT 0
                    CHECK (life_remaining_seconds >= 0),
                life_expires_at TEXT,
                current_arcano_id TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_records_user_id
            ON records (user_id);

            CREATE INDEX IF NOT EXISTS idx_records_status
            ON records (status);

            CREATE INDEX IF NOT EXISTS idx_records_life_status
            ON records (life_status);

            CREATE TRIGGER IF NOT EXISTS trg_records_updated_at
            AFTER UPDATE ON records
            FOR EACH ROW
            WHEN NEW.updated_at = OLD.updated_at
            BEGIN
                UPDATE records
                SET updated_at = CURRENT_TIMESTAMP
                WHERE id = OLD.id;
            END;
        `);
    },
};

module.exports = migration;
