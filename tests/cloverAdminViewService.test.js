const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureCloverScriptSchema } = require('../helpers/clover/cloverScriptService');
const { ensureCloverScriptJobSchema } = require('../helpers/clover/cloverScriptJobService');
const { ensurePlayerLifecycleSchema } = require('../helpers/clover/playerLifecycleService');
const { ensureTargetResolverTables } = require('../helpers/clover/targetResolverSchemaGuard');
const {
    createCloverAdminView,
    splitView,
} = require('../helpers/clover/cloverAdminViewService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            nome_real TEXT DEFAULT '-',
            display_name TEXT,
            personagem_nome TEXT,
            ficha_status TEXT,
            historia_status TEXT,
            personagem_aparencia_status TEXT,
            jogo_status TEXT,
            esquadrao TEXT,
            patente TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active',
            canonical_player_id TEXT DEFAULT NULL,
            merged_into TEXT DEFAULT NULL
        );

        CREATE TABLE clover_character_stats (
            player_id TEXT PRIMARY KEY,
            stage_key TEXT DEFAULT '9',
            pb_total INTEGER DEFAULT 10,
            pb_spent INTEGER DEFAULT 0,
            ph_accumulated INTEGER DEFAULT 0,
            ph_available INTEGER DEFAULT 0,
            forca INTEGER DEFAULT 0,
            velocidade INTEGER DEFAULT 0,
            agilidade INTEGER DEFAULT 0,
            resistencia INTEGER DEFAULT 0,
            poder_magico INTEGER DEFAULT 0,
            distribution_status TEXT DEFAULT 'confirmed',
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE clover_antighost_activity (
            player_id TEXT PRIMARY KEY,
            community_status TEXT DEFAULT 'unknown',
            last_activity_at TEXT DEFAULT NULL,
            last_activity_kind TEXT DEFAULT NULL,
            candidate_at TEXT DEFAULT NULL,
            last_notice_level TEXT DEFAULT NULL,
            exempt_until TEXT DEFAULT NULL,
            exempt_reason TEXT DEFAULT NULL
        );

        CREATE TABLE clover_spell_review_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL,
            requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
            called_at TEXT DEFAULT NULL,
            closed_at TEXT DEFAULT NULL,
            closed_by TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL
        );

        CREATE TABLE slot_reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            category TEXT NOT NULL,
            option_key TEXT NOT NULL,
            status TEXT NOT NULL,
            source TEXT DEFAULT '-',
            roll_number INTEGER DEFAULT NULL,
            expires_at TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            confirmed_at TEXT DEFAULT NULL
        );

        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            group_id TEXT DEFAULT NULL,
            captain_name TEXT DEFAULT NULL,
            captain_player_id TEXT DEFAULT NULL,
            vice_captain_player_id TEXT DEFAULT NULL,
            historical_stars INTEGER DEFAULT 0,
            current_stars INTEGER DEFAULT 0,
            black_stars INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await ensureTargetResolverTables(db);
    await ensurePlayerLifecycleSchema(db);
    await ensureCloverScriptSchema(db);
    await ensureCloverScriptJobSchema(db);
    return db;
}

async function seed(db) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, nome_real, display_name, personagem_nome, ficha_status, historia_status,
          personagem_aparencia_status, jogo_status, esquadrao, patente, estrelas)
         VALUES ('player@lid', 'Nilo', 'Nilo', 'Nilo', 'Arthur Pendragon', 'aprovada',
                 'aprovada', 'approved', 'liberado', 'Touros Negros', 'Cavaleiro Novato', 3)`
    );
    await db.run(
        `INSERT INTO clover_character_stats
         (player_id, stage_key, pb_total, pb_spent, ph_accumulated, ph_available)
         VALUES ('player@lid', '7', 20, 5, 120, 80)`
    );
    await db.run(
        `INSERT INTO clover_antighost_activity
         (player_id, community_status, last_activity_at, last_activity_kind)
         VALUES ('player@lid', 'in', '2026-07-12 10:00:00', 'message')`
    );
    await db.run(
        `INSERT INTO slot_reservations (player_id, category, option_key, status)
         VALUES ('player@lid', 'magic', 'fire', 'confirmed')`
    );
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, captain_player_id, historical_stars, current_stars)
         VALUES ('touros_negros', 'Touros Negros', 'player@lid', 10, 4)`
    );
    await db.run(
        `INSERT INTO clover_player_target_aliases
         (alias_key, alias_label, player_id, alias_kind)
         VALUES ('name:arthur_pendragon', 'Arthur Pendragon', 'player@lid', 'manual')`
    );
}

test('analisa os tipos de consulta', () => {
    assert.equal(splitView('player nome="Arthur"').type, 'player');
    assert.equal(splitView('fila').type, 'queue');
    assert.equal(splitView('lote codigo=CS-X').type, 'batch');
    assert.equal(splitView('esquadrao nome="Touros"').type, 'squad');
    assert.equal(splitView('integridade').type, 'integrity');
});

test('visão de player reúne identidade, status, PH, vínculos e aliases sem alterar saldos', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seed(db);

    const before = await db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', ['player@lid']);
    const result = await createCloverAdminView(db, 'player nome="Arthur Pendragon"');
    const after = await db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', ['player@lid']);

    assert.equal(result.ok, true);
    assert.equal(result.type, 'player');
    assert.deepEqual(result.mentions, ['player@lid']);
    assert.match(result.text, /Arthur Pendragon/);
    assert.match(result.text, /PH disponível:\* 80/);
    assert.match(result.text, /Reservas ativas:\* 1/);
    assert.match(result.text, /Arthur Pendragon \[manual\]/);
    assert.deepEqual(after, before);
});

test('visão de fila evidencia entrada órfã sem corrigi-la', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seed(db);
    await db.run(
        `INSERT INTO clover_spell_review_queue (player_id, status)
         VALUES ('apagado@lid', 'waiting')`
    );

    const before = await db.get('SELECT COUNT(*) AS total FROM clover_spell_review_queue');
    const result = await createCloverAdminView(db, 'fila');
    const after = await db.get('SELECT COUNT(*) AS total FROM clover_spell_review_queue');

    assert.equal(result.ok, true);
    assert.match(result.text, /Bloqueantes:\* 1/);
    assert.match(result.text, /Cadastro do player não existe/);
    assert.equal(after.total, before.total);
});

test('visão de lote mostra ações e JOB persistido', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seed(db);

    const run = await db.run(
        `INSERT INTO clover_script_runs
         (code, batch_id, batch_name, mode, script_hash, script_text, plan_json,
          status, created_by, chat_id, created_at, applied_by, applied_at)
         VALUES ('CS-VIEW01', 'evento-view', 'Evento view', 'rigido', 'hash', 'script', ?,
                 'applied', 'owner@lid', 'admin@g.us', CURRENT_TIMESTAMP, 'owner@lid', CURRENT_TIMESTAMP)`,
        [JSON.stringify({ blocks: [{ targets: [{ id: 'player@lid' }], actions: [{ type: 'ph' }] }] })]
    );
    await db.run(
        `INSERT INTO clover_script_actions
         (run_id, player_id, action_type, summary, status, created_at)
         VALUES (?, 'player@lid', 'ph', 'Arthur: PH +12', 'applied', CURRENT_TIMESTAMP)`,
        [run.lastID]
    );
    await db.run(
        `INSERT INTO clover_script_jobs
         (code, run_id, simulation_code, actor_id, chat_id, status,
          total_actions, completed_actions, failed_actions, lifecycle)
         VALUES ('JOB-VIEW01', ?, 'CS-VIEW01', 'owner@lid', 'admin@g.us', 'completed', 1, 1, 0, 0)`,
        [run.lastID]
    );

    const result = await createCloverAdminView(db, 'lote codigo=CS-VIEW01');
    assert.equal(result.ok, true);
    assert.match(result.text, /Evento view/);
    assert.match(result.text, /JOB-VIEW01/);
    assert.match(result.text, /Arthur: PH \+12/);
});

test('visão de esquadrão lista placar e membros', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seed(db);

    const result = await createCloverAdminView(db, 'esquadrao nome="Touros Negros"');
    assert.equal(result.ok, true);
    assert.match(result.text, /Touros Negros/);
    assert.match(result.text, /Estrelas atuais:\* 4/);
    assert.match(result.text, /Arthur Pendragon/);
});

test('resumo de integridade é somente leitura', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seed(db);
    await db.run(
        `INSERT INTO clover_spell_review_queue (player_id, status)
         VALUES ('apagado@lid', 'waiting')`
    );

    const result = await createCloverAdminView(db, 'integridade');
    assert.equal(result.ok, true);
    assert.match(result.text, /INTEGRIDADE CLOVER/);
    assert.match(result.text, /Críticos:\* [1-9]/);
});
