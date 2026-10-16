'use strict';

const HUMAN_PROTOTYPE_VERSION = 34;
const HUMAN_PROTOTYPE_KEY = '0034_human_prototype_evaluation';

const HUMAN_PROTOTYPES_TABLE_SQL = `
CREATE TABLE clover_human_prototypes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    idea TEXT NOT NULL,
    defect TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'testing'
        CHECK (status IN ('testing','completed','abandoned')),
    approved_submission_id INTEGER NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT DEFAULT NULL,
    abandoned_at TEXT DEFAULT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (approved_submission_id) REFERENCES clover_evaluation_submissions(id)
)`;

const HUMAN_PROTOTYPE_INDEXES = Object.freeze([
    `CREATE INDEX idx_clover_human_prototypes_player_status
     ON clover_human_prototypes (player_id, status, created_at ASC, id ASC)`,
    `CREATE UNIQUE INDEX idx_clover_human_prototypes_active_name
     ON clover_human_prototypes (player_id, normalized_name)
     WHERE status = 'testing'`,
]);

const HUMAN_PROTOTYPE_MIGRATION = Object.freeze({
    version: HUMAN_PROTOTYPE_VERSION,
    key: HUMAN_PROTOTYPE_KEY,
    description: 'Adiciona armazenamento objetivo de Prototipos Humanos aprovados pela fila universal.',
    checksumMaterial: Object.freeze({
        table: HUMAN_PROTOTYPES_TABLE_SQL.replace(/\s+/g, ' ').trim(),
        indexes: HUMAN_PROTOTYPE_INDEXES.map((sql) => sql.replace(/\s+/g, ' ').trim()),
        activeStatuses: ['testing'],
        revision: 'human-prototype-evaluation-v1',
    }),
    async up(db) {
        const existing = await db.get(
            `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'clover_human_prototypes'`
        );
        if (!existing) await db.exec(HUMAN_PROTOTYPES_TABLE_SQL);
        for (const sql of HUMAN_PROTOTYPE_INDEXES) await db.exec(sql);
    },
});

module.exports = {
    HUMAN_PROTOTYPE_INDEXES,
    HUMAN_PROTOTYPE_KEY,
    HUMAN_PROTOTYPE_MIGRATION,
    HUMAN_PROTOTYPE_VERSION,
    HUMAN_PROTOTYPES_TABLE_SQL,
};
