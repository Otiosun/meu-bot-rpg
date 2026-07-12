const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const { ensureCloverScriptSchema } = require('../helpers/clover/cloverScriptService');
const {
    applyUndoSimulation,
    createUndoSimulation,
    looksLikeUndoScript,
    parseUndoScript,
    shouldHandleUndoApply,
} = require('../helpers/clover/cloverScriptUndoService');
const {
    archivePlayer,
    ensurePlayerLifecycleSchema,
} = require('../helpers/clover/playerLifecycleService');
const { ensurePlayerLifecycleUndoSchema } = require('../helpers/clover/playerLifecycleUndoService');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            personagem_idade INTEGER DEFAULT NULL,
            personagem_genero TEXT DEFAULT '-',
            personagem_aparencia TEXT DEFAULT '-',
            personagem_aparencia_status TEXT DEFAULT 'approved',
            ficha_status TEXT DEFAULT 'aprovada',
            historia_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado',
            esquadrao TEXT DEFAULT '-',
            numero_roll_escolhido INTEGER DEFAULT NULL,
            dinheiro INTEGER DEFAULT 0,
            estrelas INTEGER DEFAULT 0,
            is_shadow INTEGER DEFAULT 0
        );
    `);
    await ensureCloverScriptSchema(db);
    await ensurePlayerLifecycleSchema(db);
    await ensurePlayerLifecycleUndoSchema(db);
    return db;
}

async function seedArchivedPlayer(db) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, historia_status,
          personagem_aparencia_status, jogo_status, esquadrao, is_shadow)
         VALUES ('player@lid', 'Nilo', 'Nilo', 'Arthur Pendragon', 'aprovada',
                 'aprovada', 'approved', 'liberado', '-', 0)`
    );
    return archivePlayer(db, {
        playerId: 'player@lid',
        reason: 'Arquivamento de teste',
        actorId: OWNER,
    });
}

function undoScript(sourceCode, confirm = true) {
    return [
        'LOTE id="undo-test" nome="Undo test" modo=rigido',
        '',
        `DESFAZER codigo=${sourceCode} motivo="Correção administrativa"${confirm ? ' confirmar=true' : ''}`,
        'FIM',
    ].join('\n');
}

test('reconhece e analisa a sintaxe DESFAZER', () => {
    const script = undoScript('LC-ABC123');
    assert.equal(looksLikeUndoScript(script), true);
    const parsed = parseUndoScript(script);
    assert.equal(parsed.kind, 'lifecycle_undo');
    assert.equal(parsed.action.sourceCode, 'LC-ABC123');
    assert.equal(parsed.action.confirm, true);
});

test('recusa DESFAZER sem confirmação forte', () => {
    assert.throws(
        () => parseUndoScript(undoScript('LC-ABC123', false)),
        (error) => error.code === 'missing_confirm'
    );
});

test('simula por código LC sem alterar o player e aplica por CSU', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const archived = await seedArchivedPlayer(db);
    assert.equal(archived.ok, true);

    const simulation = await createUndoSimulation(db, undoScript(archived.code), {
        actorId: OWNER,
        chatId: 'admin@g.us',
    });
    assert.equal(simulation.ok, true);
    assert.match(simulation.code, /^CSU-/);
    assert.match(simulation.text, /nada foi aplicado/i);
    assert.match(simulation.text, new RegExp(archived.code));

    const before = await db.get('SELECT lifecycle_status, jogo_status FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(before.lifecycle_status, 'archived');

    assert.equal(await shouldHandleUndoApply(db, {
        code: simulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
    }), true);

    const applied = await applyUndoSimulation(db, {
        code: simulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
        sock: null,
    });
    assert.equal(applied.ok, true);
    assert.match(applied.text, /evento de ciclo desfeito/i);
    assert.match(applied.text, /LU-/);

    const after = await db.get('SELECT lifecycle_status, jogo_status FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(after.lifecycle_status, 'active');
    assert.equal(after.jogo_status, 'liberado');

    const run = await db.get('SELECT status FROM clover_script_runs WHERE code = ?', [simulation.code]);
    assert.equal(run.status, 'applied');
    const action = await db.get('SELECT action_type, status FROM clover_script_actions WHERE run_id = ?', [simulation.runId]);
    assert.equal(action.action_type, 'lifecycle_undo');
    assert.equal(action.status, 'applied');
});

test('resolve código CSL aplicado até o evento LC correspondente', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const archived = await seedArchivedPlayer(db);

    const run = await db.run(
        `INSERT INTO clover_script_runs
         (code, mode, script_hash, script_text, plan_json, status, created_by, chat_id, created_at, applied_at)
         VALUES ('CSL-SOURCE', 'rigido', 'hash', 'script', '{}', 'applied', ?, 'admin@g.us', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [OWNER]
    );
    await db.run(
        `INSERT INTO clover_script_actions
         (run_id, player_id, action_type, summary, status, before_json, after_json, created_at)
         VALUES (?, 'player@lid', 'lifecycle', 'archive', 'applied', '{}', ?, CURRENT_TIMESTAMP)`,
        [run.lastID, JSON.stringify({ lifecycleCode: archived.code })]
    );

    const simulation = await createUndoSimulation(db, undoScript('CSL-SOURCE'), {
        actorId: OWNER,
        chatId: 'admin@g.us',
    });
    assert.equal(simulation.ok, true);
    assert.equal(simulation.plan.undo.lifecycleEventCode, archived.code);
});

test('bloqueia código CloverScript comum sem evento de ciclo compatível', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seedArchivedPlayer(db);

    await db.run(
        `INSERT INTO clover_script_runs
         (code, mode, script_hash, script_text, plan_json, status, created_by, chat_id, created_at, applied_at)
         VALUES ('CS-COMUM', 'rigido', 'hash', 'script', '{}', 'applied', ?, 'admin@g.us', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [OWNER]
    );

    await assert.rejects(
        createUndoSimulation(db, undoScript('CS-COMUM'), {
            actorId: OWNER,
            chatId: 'admin@g.us',
        }),
        (error) => error.code === 'unsupported_undo_source'
    );
});
