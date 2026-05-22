const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

async function ensureColumn(db, table, column, definition) {
    const columns = await db.all(`PRAGMA table_info(${table})`);
    const hasColumn = columns.some((item) => item.name === column);
    if (!hasColumn) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

async function criarBanco() {
    const db = await open({ filename: './banco.sqlite', driver: sqlite3.Database });
    
    await db.exec(`
        CREATE TABLE IF NOT EXISTS jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            idade TEXT DEFAULT '-',
            reino TEXT DEFAULT '-',
            classe TEXT DEFAULT '-',
            familia TEXT DEFAULT '-',
            raca TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            formas TEXT DEFAULT '-',
            historia TEXT DEFAULT '-',
            aparencia TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            atributos_max INTEGER DEFAULT 10,
            forca INTEGER DEFAULT 0,
            velocidade INTEGER DEFAULT 0,
            resistencia INTEGER DEFAULT 0,
            reflexos INTEGER DEFAULT 0,
            poder_magico INTEGER DEFAULT 0,
            mana INTEGER DEFAULT 0,
            pontos INTEGER DEFAULT 5,
            agilidade INTEGER DEFAULT 0
        )
    `);

    await ensureColumn(db, 'jogadores', 'display_name', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'nome_real', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'idade_real', 'INTEGER DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'gosta_de_fazer', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'personagem_nome', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'personagem_idade', 'INTEGER DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'personagem_aparencia', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'personagem_genero', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'jogadores', 'numero_roll_escolhido', 'INTEGER DEFAULT NULL');
    await ensureColumn(db, 'jogadores', 'ficha_status', "TEXT DEFAULT 'incompleta'");
    await ensureColumn(db, 'jogadores', 'ultima_recepcao_em', 'TEXT DEFAULT NULL');

    await db.exec(`
        CREATE TABLE IF NOT EXISTS player_progress (
            player_id TEXT PRIMARY KEY,
            ph_total INTEGER DEFAULT 0,
            ph_bonus INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS player_skill_trees (
            player_id TEXT NOT NULL,
            tree TEXT NOT NULL,
            ph_spent INTEGER DEFAULT 0,
            unlocked_node_ids TEXT DEFAULT '[]',
            narrative_flags TEXT DEFAULT '[]',
            last_purchase TEXT DEFAULT NULL,
            last_prox_options TEXT DEFAULT '[]',
            purchase_history TEXT DEFAULT '[]',
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (player_id, tree)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_player_skill_trees_tree
        ON player_skill_trees (tree)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS player_onboarding (
            player_id TEXT PRIMARY KEY,
            started_at TEXT DEFAULT CURRENT_TIMESTAMP,
            welcome_sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
            current_step TEXT DEFAULT 'inicio'
        )
    `);

    await ensureColumn(db, 'player_onboarding', 'step_payload', "TEXT DEFAULT '{}'");

    await db.exec(`
        CREATE TABLE IF NOT EXISTS player_rolls (
            player_id TEXT NOT NULL,
            roll_number INTEGER NOT NULL,
            kingdom TEXT DEFAULT '-',
            social_class TEXT NOT NULL,
            family TEXT DEFAULT '-',
            race TEXT NOT NULL,
            grimoire TEXT NOT NULL,
            grimoire_rank TEXT DEFAULT '-',
            grimoire_symbol TEXT DEFAULT '-',
            magic_rarity TEXT NOT NULL,
            magic_scope TEXT DEFAULT '-',
            summary TEXT DEFAULT '-',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (player_id, roll_number)
        )
    `);

    await ensureColumn(db, 'player_rolls', 'kingdom', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'player_rolls', 'grimoire_rank', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'player_rolls', 'grimoire_symbol', "TEXT DEFAULT '-'");
    await ensureColumn(db, 'player_rolls', 'magic_scope', "TEXT DEFAULT '-'");

    await db.exec(`
        CREATE TABLE IF NOT EXISTS pending_profile_confirmations (
            player_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_player_rolls_player
        ON player_rolls (player_id)
    `);
    
    return db;
}

module.exports = { criarBanco };
