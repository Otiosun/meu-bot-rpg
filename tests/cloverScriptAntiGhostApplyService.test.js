const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const { ensureTargetResolverTables } = require('../helpers/clover/targetResolverSchemaGuard');
const { ensureTargetResolverSchema } = require('../helpers/clover/targetResolver');
const { ensurePlayerLifecycleSchema } = require('../helpers/clover/playerLifecycleService');
const {
    createSimulation,
} = require('../helpers/clover/cloverScriptService');
const {
    applySafeAntiGhostSimulation,
    shouldHandleSafeAntiGhostApply,
    validatePlan,
} = require('../helpers/clover/cloverScriptAntiGhostApplyService');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            ficha_status TEXT,
            historia_status TEXT DEFAULT 'aprovada',
            personagem_aparencia_status TEXT DEFAULT 'approved',
            jogo_status TEXT,
            esquadrao TEXT,
            is_shadow INTEGER DEFAULT 0,
            numero_roll_escolhido INTEGER DEFAULT NULL,
            canonical_player_id TEXT DEFAULT NULL,
            merged_into TEXT DEFAULT NULL,
            identity_status TEXT DEFAULT 'active'
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

        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            captain_player_id TEXT DEFAULT NULL,
            vice_captain_player_id TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL
        );

        CREATE TABLE clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await ensureTargetResolverTables(db);
    await ensureTargetResolverSchema(db);
    await ensurePlayerLifecycleSchema(db);
    return db;
}

async function seed(db, id = 'player@lid') {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status, esquadrao, is_shadow)
         VALUES (?, 'Nilo', 'Nilo', 'Arthur Pendragon', 'aprovada', 'liberado', 'Touros Negros', 0)`,
        [id]
    );
    await db.run(
        `INSERT INTO slot_reservations (player_id, category, option_key, status)
         VALUES (?, 'magic', 'fire', 'confirmed')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_spell_review_queue (player_id, status)
         VALUES (?, 'waiting')`,
        [id]
    );
    await db.run(
        `INSERT INTO clover_squads (squad_key, name, captain_player_id)
         VALUES ('touros_negros', 'Touros Negros', ?)`,
        [id]
    );
    await db.run('INSERT INTO clover_ph_ledger (player_id, amount) VALUES (?, 50)', [id]);
}

function script() {
    return [
        'LOTE id="antighost-safe-test" nome="Anti-ghost seguro" modo=rigido',
        '',
        'ALVO id="player@lid" confirmar=true',
        'ANTIGHOST remover motivo="Saída confirmada" confirmar=true',
        'FIM',
    ].join('\n');
}

test('plano protegido exige uma única remoção confirmada', () => {
    const target = { id: 'player@lid', personagem_nome: 'Arthur' };
    const action = { type: 'antighost', op: 'remove', confirm: true, reason: 'Teste' };
    const item = validatePlan({ blocks: [{ targets: [target], actions: [action] }] });
    assert.equal(item.target.id, 'player@lid');

    assert.throws(
        () => validatePlan({ blocks: [{ targets: [target, { id: 'other@lid' }], actions: [action] }] }),
        (error) => error.code === 'single_antighost_removal_required'
    );
    assert.throws(
        () => validatePlan({ blocks: [{ targets: [target], actions: [{ ...action, confirm: false }] }] }),
        (error) => error.code === 'confirmation_required'
    );
});

test('intercepta CS comum e mantém remoção anti-ghost fail-closed', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seed(db);

    const simulation = await createSimulation(db, script(), {
        actorId: OWNER,
        chatId: 'admin@g.us',
    });
    assert.match(simulation.code, /^CS-/);
    assert.equal(await shouldHandleSafeAntiGhostApply(db, {
        code: simulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
    }), true);

    await assert.rejects(
        () => applySafeAntiGhostSimulation(db, {
            code: simulation.code,
            actorId: OWNER,
            chatId: 'admin@g.us',
            sock: null,
        }),
        (error) => error.code === 'prereset_antighost_mutation_disabled' && error.manualOnly === true
    );

    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);
    assert.ok(player);
    assert.equal(player.personagem_nome, 'Arthur Pendragon');
    assert.equal(player.lifecycle_status, 'active');
    assert.equal(player.jogo_status, 'liberado');
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_ph_ledger WHERE player_id = ?', ['player@lid'])).total, 1);

    const run = await db.get('SELECT status, error FROM clover_script_runs WHERE code = ?', [simulation.code]);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /exige ação administrativa explícita/i);
    const action = await db.get(
        `SELECT action_type, status FROM clover_script_actions
         WHERE run_id = ? ORDER BY id DESC LIMIT 1`,
        [simulation.runId]
    );
    assert.equal(action.action_type, 'antighost_remove_safe');
    assert.equal(action.status, 'failed');
});

test('retry fail-closed não duplica auditoria nem altera ciclo do player', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seed(db);

    const simulation = await createSimulation(db, script(), {
        actorId: OWNER,
        chatId: 'admin@g.us',
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
            () => applySafeAntiGhostSimulation(db, {
                code: simulation.code,
                actorId: OWNER,
                chatId: 'admin@g.us',
                sock: null,
            }),
            (error) => error.code === 'prereset_antighost_mutation_disabled'
        );
    }

    const events = await db.get(
        `SELECT COUNT(*) AS total FROM clover_player_lifecycle_events
         WHERE player_id = ? AND operation_type = 'archive'`,
        ['player@lid']
    );
    assert.equal(events.total, 0);
    const failures = await db.get(
        `SELECT COUNT(*) AS total FROM clover_script_actions
         WHERE run_id = ? AND action_type = 'antighost_remove_safe' AND status = 'failed'`,
        [simulation.runId]
    );
    assert.equal(failures.total, 1);
    assert.equal((await db.get('SELECT status FROM clover_script_runs WHERE id = ?', [simulation.runId])).status, 'failed');
    assert.equal((await db.get('SELECT jogo_status FROM jogadores WHERE id = ?', ['player@lid'])).jogo_status, 'liberado');
});
