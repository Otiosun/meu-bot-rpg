const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    applyLifecycleSimulation,
    createLifecycleSimulation,
    looksLikeLifecycleScript,
    parseLifecycleScript,
    shouldHandleLifecycleApply,
} = require('../helpers/clover/cloverScriptLifecycleService');
const { ensureCloverScriptSchema } = require('../helpers/clover/cloverScriptService');
const { ensurePlayerLifecycleSchema } = require('../helpers/clover/playerLifecycleService');
const { OWNER_NUMBERS } = require('../helpers/groupAccess');

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
            canonical_player_id TEXT DEFAULT NULL,
            merged_into TEXT DEFAULT NULL,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active'
        );

        CREATE TABLE player_rolls (
            player_id TEXT NOT NULL,
            roll_number INTEGER NOT NULL,
            kingdom TEXT DEFAULT '-',
            social_class TEXT DEFAULT '-',
            race TEXT DEFAULT '-',
            grimoire TEXT DEFAULT '-',
            magic_rarity TEXT DEFAULT '-',
            PRIMARY KEY (player_id, roll_number)
        );

        CREATE TABLE player_onboarding (
            player_id TEXT PRIMARY KEY,
            current_step TEXT DEFAULT 'inicio'
        );

        CREATE TABLE pending_profile_confirmations (
            player_id TEXT PRIMARY KEY,
            payload TEXT
        );

        CREATE TABLE pending_magic_confirmations (
            player_id TEXT PRIMARY KEY,
            magic_label TEXT
        );
    `);
    await ensureCloverScriptSchema(db);
    await ensurePlayerLifecycleSchema(db);
    return db;
}

async function addPlayer(db, id = 'player@lid', character = 'Arthur Pendragon') {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, historia_status,
          personagem_aparencia_status, jogo_status, esquadrao, is_shadow)
         VALUES (?, 'Nilo', 'Nilo', ?, 'aprovada', 'aprovada', 'approved', 'liberado', '-', 0)`,
        [id, character]
    );
}

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;

function archiveScript(extra = '') {
    return [
        'LOTE id="archive-test" nome="Archive test" modo=rigido',
        '',
        'ALVO id="player@lid" confirmar=true',
        `PLAYER arquivar motivo="Saiu da comunidade" confirmar=true${extra}`,
        'FIM',
    ].join('\n');
}

test('reconhece e analisa sintaxe protegida de ciclo de vida', () => {
    const script = archiveScript();
    assert.equal(looksLikeLifecycleScript(script), true);

    const parsed = parseLifecycleScript(script);
    assert.equal(parsed.kind, 'lifecycle');
    assert.equal(parsed.blocks.length, 1);
    assert.equal(parsed.blocks[0].actions[0].op, 'archive');
    assert.equal(parsed.blocks[0].actions[0].confirm, true);
});

test('erro de bloco aponta FIM ausente em vez de ação ALVO desconhecida', () => {
    const script = [
        'ALVO id="player@lid" confirmar=true',
        'PLAYER arquivar motivo="Teste" confirmar=true',
        'ALVO id="outro@lid" confirmar=true',
        'PLAYER arquivar motivo="Teste" confirmar=true',
        'FIM',
    ].join('\n');

    assert.throws(
        () => parseLifecycleScript(script),
        (error) => error.code === 'missing_fim' && /faltou FIM/i.test(error.message)
    );
});

test('recusa ação protegida sem confirmar=true', () => {
    const script = [
        'ALVO id="player@lid"',
        'PLAYER arquivar motivo="Teste seguro"',
        'FIM',
    ].join('\n');

    assert.throws(
        () => parseLifecycleScript(script),
        (error) => error.code === 'missing_confirm'
    );
});

test('simula sem alterar e aplica arquivamento pelo mesmo comando CloverScript', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db);

    const simulation = await createLifecycleSimulation(db, archiveScript(), {
        actorId: OWNER,
        chatId: 'admin@g.us',
    });

    assert.equal(simulation.ok, true);
    assert.match(simulation.code, /^CSL-/);
    assert.match(simulation.text, /nada foi aplicado ainda/i);
    assert.match(simulation.text, /PH, inventário, grimório, personagem e histórico serão preservados/i);

    const before = await db.get('SELECT lifecycle_status, jogo_status FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(before.lifecycle_status, 'active');
    assert.equal(before.jogo_status, 'liberado');

    assert.equal(await shouldHandleLifecycleApply(db, {
        code: simulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
    }), true);

    const applied = await applyLifecycleSimulation(db, {
        code: simulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
        sock: null,
    });

    assert.equal(applied.ok, true);
    assert.match(applied.text, /CLOVERSCRIPT APLICADO/i);
    assert.match(applied.text, /LC-/);

    const after = await db.get('SELECT lifecycle_status, jogo_status FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(after.lifecycle_status, 'archived');
    assert.equal(after.jogo_status, 'arquivado');

    const run = await db.get('SELECT status FROM clover_script_runs WHERE code = ?', [simulation.code]);
    assert.equal(run.status, 'applied');

    const action = await db.get('SELECT action_type, status FROM clover_script_actions WHERE run_id = ?', [simulation.runId]);
    assert.equal(action.action_type, 'lifecycle');
    assert.equal(action.status, 'applied');
});

test('reativação simulada restaura o mesmo player sem criar cadastro novo', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db);

    const first = await createLifecycleSimulation(db, archiveScript(), {
        actorId: OWNER,
        chatId: 'admin@g.us',
    });
    await applyLifecycleSimulation(db, {
        code: first.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
    });

    const reactivateScript = [
        'LOTE id="reactivate-test" nome="Reactivate test" modo=rigido',
        '',
        'ALVO id="player@lid" confirmar=true',
        'PLAYER reativar motivo="Retorno aprovado" confirmar=true',
        'FIM',
    ].join('\n');
    const simulation = await createLifecycleSimulation(db, reactivateScript, {
        actorId: OWNER,
        chatId: 'admin@g.us',
    });
    assert.match(simulation.text, /PLAYER reativar/i);

    const result = await applyLifecycleSimulation(db, {
        code: simulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
    });
    assert.equal(result.ok, true);

    const players = await db.all('SELECT id, lifecycle_status, jogo_status FROM jogadores');
    assert.equal(players.length, 1);
    assert.equal(players[0].id, 'player@lid');
    assert.equal(players[0].lifecycle_status, 'active');
    assert.equal(players[0].jogo_status, 'liberado');
});

test('recusa lote de ciclo de vida com mais de um player', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db, 'player@lid', 'Arthur');
    await addPlayer(db, 'outro@lid', 'Yuno');

    const script = [
        'ALVOS id="player@lid" confirmar=true',
        'PLAYER arquivar motivo="Teste" confirmar=true',
        'FIM',
        '',
        'ALVO id="outro@lid" confirmar=true',
        'PLAYER arquivar motivo="Teste" confirmar=true',
        'FIM',
    ].join('\n');

    await assert.rejects(
        createLifecycleSimulation(db, script, {
            actorId: OWNER,
            chatId: 'admin@g.us',
        }),
        (error) => error.code === 'single_lifecycle_action_required'
    );
});
