'use strict';

const MANA_HEXAGON_V4_VERSION = 47;
const MANA_HEXAGON_V4_KEY = '0047_mana_hexagon_v4_axes';

const ACTIVE_SIDES = "'controle', 'precisao', 'estabilidade', 'retencao', 'alcance', 'escala'";
const ALL_SIDES = `${ACTIVE_SIDES}, 'percepcao', 'emissao', 'pressao'`;

const CREATE_MAIN = `CREATE TABLE clover_mana_hexagon_v4 (
    player_id TEXT PRIMARY KEY,
    percepcao INTEGER DEFAULT 1 CHECK (percepcao BETWEEN 1 AND 5),
    retencao INTEGER NOT NULL DEFAULT 1 CHECK (retencao BETWEEN 1 AND 7),
    emissao INTEGER DEFAULT 1 CHECK (emissao BETWEEN 1 AND 5),
    controle INTEGER NOT NULL DEFAULT 1 CHECK (controle BETWEEN 1 AND 7),
    pressao INTEGER DEFAULT 1 CHECK (pressao BETWEEN 1 AND 5),
    alcance INTEGER NOT NULL DEFAULT 1 CHECK (alcance BETWEEN 1 AND 7),
    precisao INTEGER NOT NULL DEFAULT 1 CHECK (precisao BETWEEN 1 AND 7),
    estabilidade INTEGER NOT NULL DEFAULT 1 CHECK (estabilidade BETWEEN 1 AND 7),
    escala INTEGER NOT NULL DEFAULT 1 CHECK (escala BETWEEN 1 AND 7),
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT DEFAULT NULL
)`;
const CREATE_LEDGER = `CREATE TABLE clover_mana_hexagon_ledger_v4 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN (${ALL_SIDES})),
    old_value INTEGER CHECK (old_value BETWEEN 1 AND 7),
    new_value INTEGER NOT NULL CHECK (new_value BETWEEN 1 AND 7),
    reason TEXT DEFAULT NULL,
    created_by TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`;
const CREATE_PENDING = `CREATE TABLE clover_pending_hexagon_upgrades_v4 (
    player_id TEXT PRIMARY KEY,
    side TEXT NOT NULL CHECK (side IN (${ACTIVE_SIDES})),
    old_value INTEGER NOT NULL CHECK (old_value BETWEEN 1 AND 7),
    new_value INTEGER NOT NULL CHECK (new_value BETWEEN 1 AND 7),
    cost INTEGER NOT NULL,
    requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval = 0),
    created_by TEXT DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT DEFAULT NULL,
    metadata_json TEXT DEFAULT NULL
)`;

async function tableExists(db, name) {
    return Boolean(await db.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?", [name]));
}

async function rebuildMain(db) {
    const exists = await tableExists(db, 'clover_mana_hexagon');
    await db.exec(CREATE_MAIN);
    if (exists) {
        const columns = await db.all('PRAGMA table_info(clover_mana_hexagon)');
        const names = new Set(columns.map((column) => column.name));
        const value = (name, fallback = '1') => names.has(name) ? name : fallback;
        await db.exec(`INSERT INTO clover_mana_hexagon_v4
            (player_id, percepcao, retencao, emissao, controle, pressao, alcance,
             precisao, estabilidade, escala, updated_at, updated_by)
            SELECT player_id, ${value('percepcao')}, ${value('retencao')}, ${value('emissao')},
                   ${value('controle')}, ${value('pressao')}, ${value('alcance')},
                   ${value('precisao')}, ${value('estabilidade')}, ${value('escala')},
                   ${value('updated_at', 'CURRENT_TIMESTAMP')}, ${value('updated_by', 'NULL')}
            FROM clover_mana_hexagon`);
        await db.exec('DROP TABLE clover_mana_hexagon');
    }
    await db.exec('ALTER TABLE clover_mana_hexagon_v4 RENAME TO clover_mana_hexagon');
}

async function rebuildLedger(db) {
    const exists = await tableExists(db, 'clover_mana_hexagon_ledger');
    await db.exec(CREATE_LEDGER);
    if (exists) {
        await db.exec(`INSERT INTO clover_mana_hexagon_ledger_v4
            (id, player_id, side, old_value, new_value, reason, created_by, created_at)
            SELECT id, player_id, side, old_value, new_value, reason, created_by, created_at
            FROM clover_mana_hexagon_ledger`);
        await db.exec('DROP TABLE clover_mana_hexagon_ledger');
    }
    await db.exec('ALTER TABLE clover_mana_hexagon_ledger_v4 RENAME TO clover_mana_hexagon_ledger');
}

async function rebuildPending(db) {
    const exists = await tableExists(db, 'clover_pending_hexagon_upgrades');
    await db.exec(CREATE_PENDING);
    if (exists) {
        await db.exec('DROP TABLE clover_pending_hexagon_upgrades');
    }
    await db.exec('ALTER TABLE clover_pending_hexagon_upgrades_v4 RENAME TO clover_pending_hexagon_upgrades');
}

const MANA_HEXAGON_V4_MIGRATION = Object.freeze({
    version: MANA_HEXAGON_V4_VERSION,
    key: MANA_HEXAGON_V4_KEY,
    description: 'Atualiza o Hexagono ativo para seis eixos independentes em escala 1-7.',
    checksumMaterial: Object.freeze({ CREATE_MAIN, CREATE_LEDGER, CREATE_PENDING, revision: 1 }),
    async up(db) {
        await rebuildMain(db);
        await rebuildLedger(db);
        await rebuildPending(db);
        await db.exec(`
            CREATE INDEX idx_clover_mana_hexagon_ledger_player
                ON clover_mana_hexagon_ledger (player_id, created_at DESC, id DESC);
            CREATE INDEX idx_clover_mana_hexagon_ledger_side
                ON clover_mana_hexagon_ledger (side);
            CREATE INDEX idx_clover_pending_hexagon_upgrades_expires
                ON clover_pending_hexagon_upgrades (expires_at);
        `);
    },
});

module.exports = {
    MANA_HEXAGON_V4_KEY,
    MANA_HEXAGON_V4_MIGRATION,
    MANA_HEXAGON_V4_VERSION,
};
