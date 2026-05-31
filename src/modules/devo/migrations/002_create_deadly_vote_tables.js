const migration = {
    id: '002_create_deadly_vote_tables',
    name: 'Create Deadly Vote tables',
    async up(db) {
        await db.exec(`
            CREATE TABLE IF NOT EXISTS deadly_votes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                code TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'rascunho'
                    CHECK (status IN (
                        'rascunho',
                        'preparado',
                        'convocando',
                        'lotado',
                        'iniciado',
                        'em_andamento',
                        'resolucao_pendente',
                        'encerrado',
                        'cancelado',
                        'arquivado'
                    )),
                max_slots INTEGER NOT NULL DEFAULT 0 CHECK (max_slots >= 0),
                reserved_slots INTEGER NOT NULL DEFAULT 0 CHECK (reserved_slots >= 0),
                created_by_manager_id TEXT,
                started_at TEXT,
                ended_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by_manager_id)
                    REFERENCES manager_profiles (id)
                    ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_deadly_votes_status
            ON deadly_votes (status);

            CREATE INDEX IF NOT EXISTS idx_deadly_votes_created_by
            ON deadly_votes (created_by_manager_id);

            CREATE TRIGGER IF NOT EXISTS trg_deadly_votes_updated_at
            AFTER UPDATE ON deadly_votes
            FOR EACH ROW
            WHEN NEW.updated_at = OLD.updated_at
            BEGIN
                UPDATE deadly_votes
                SET updated_at = CURRENT_TIMESTAMP
                WHERE id = OLD.id;
            END;

            CREATE TABLE IF NOT EXISTS deadly_vote_invitations (
                id TEXT PRIMARY KEY,
                deadly_vote_id TEXT NOT NULL,
                record_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pendente'
                    CHECK (status IN (
                        'pendente',
                        'aceito',
                        'recusado',
                        'expirado',
                        'sem_vaga',
                        'revogado'
                    )),
                invited_by_manager_id TEXT,
                accepted_at TEXT,
                refused_at TEXT,
                expires_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (deadly_vote_id)
                    REFERENCES deadly_votes (id)
                    ON DELETE CASCADE,
                FOREIGN KEY (record_id)
                    REFERENCES records (id)
                    ON DELETE CASCADE,
                FOREIGN KEY (invited_by_manager_id)
                    REFERENCES manager_profiles (id)
                    ON DELETE SET NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_dv_invitations_vote_record
            ON deadly_vote_invitations (deadly_vote_id, record_id);

            CREATE INDEX IF NOT EXISTS idx_dv_invitations_record
            ON deadly_vote_invitations (record_id);

            CREATE INDEX IF NOT EXISTS idx_dv_invitations_status
            ON deadly_vote_invitations (status);

            CREATE TRIGGER IF NOT EXISTS trg_deadly_vote_invitations_updated_at
            AFTER UPDATE ON deadly_vote_invitations
            FOR EACH ROW
            WHEN NEW.updated_at = OLD.updated_at
            BEGIN
                UPDATE deadly_vote_invitations
                SET updated_at = CURRENT_TIMESTAMP
                WHERE id = OLD.id;
            END;

            CREATE TABLE IF NOT EXISTS deadly_vote_participants (
                id TEXT PRIMARY KEY,
                deadly_vote_id TEXT NOT NULL,
                record_id TEXT NOT NULL,
                invitation_id TEXT,
                status TEXT NOT NULL DEFAULT 'confirmado'
                    CHECK (status IN (
                        'confirmado',
                        'ativo',
                        'sobrevivente',
                        'morto',
                        'removido',
                        'desistente',
                        'pendente_resolucao'
                    )),
                joined_at TEXT,
                resolved_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (deadly_vote_id)
                    REFERENCES deadly_votes (id)
                    ON DELETE CASCADE,
                FOREIGN KEY (record_id)
                    REFERENCES records (id)
                    ON DELETE CASCADE,
                FOREIGN KEY (invitation_id)
                    REFERENCES deadly_vote_invitations (id)
                    ON DELETE SET NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_dv_participants_vote_record
            ON deadly_vote_participants (deadly_vote_id, record_id);

            CREATE INDEX IF NOT EXISTS idx_dv_participants_record
            ON deadly_vote_participants (record_id);

            CREATE INDEX IF NOT EXISTS idx_dv_participants_status
            ON deadly_vote_participants (status);

            CREATE TRIGGER IF NOT EXISTS trg_deadly_vote_participants_updated_at
            AFTER UPDATE ON deadly_vote_participants
            FOR EACH ROW
            WHEN NEW.updated_at = OLD.updated_at
            BEGIN
                UPDATE deadly_vote_participants
                SET updated_at = CURRENT_TIMESTAMP
                WHERE id = OLD.id;
            END;
        `);
    },
};

module.exports = migration;
