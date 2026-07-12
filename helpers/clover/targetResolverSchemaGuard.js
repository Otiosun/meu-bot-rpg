async function addColumnIfMissing(db, tableName, columnName, definition) {
    const columns = await db.all(`PRAGMA table_info(${tableName})`).catch(() => []);
    if ((columns || []).some((column) => column.name === columnName)) return false;
    await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    return true;
}

async function ensureTargetResolverTables(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_player_target_aliases (
            alias_key TEXT PRIMARY KEY,
            alias_label TEXT NOT NULL,
            player_id TEXT NOT NULL,
            alias_kind TEXT NOT NULL DEFAULT 'manual',
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_clover_player_target_aliases_player
        ON clover_player_target_aliases (player_id, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_clover_player_target_aliases_kind
        ON clover_player_target_aliases (alias_kind);

        CREATE TABLE IF NOT EXISTS clover_player_aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id_destino TEXT NOT NULL,
            alias_type TEXT NOT NULL,
            alias_value TEXT NOT NULL,
            source TEXT DEFAULT 'manual',
            confidence INTEGER DEFAULT 100,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(alias_type, alias_value)
        );

        CREATE INDEX IF NOT EXISTS idx_clover_player_aliases_player
        ON clover_player_aliases (player_id_destino, active, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_clover_player_aliases_lookup
        ON clover_player_aliases (alias_type, alias_value, active);
    `);

    await addColumnIfMissing(db, 'jogadores', 'canonical_player_id', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'jogadores', 'merged_into', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'jogadores', 'is_shadow', 'INTEGER DEFAULT 0');
    await addColumnIfMissing(db, 'jogadores', 'identity_status', "TEXT DEFAULT 'active'");
}

module.exports = {
    ensureTargetResolverTables,
};
