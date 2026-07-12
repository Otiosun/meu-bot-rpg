const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const { ensureTargetResolverTables } = require('../helpers/clover/targetResolverSchemaGuard');
const { ensureTargetResolverSchema } = require('../helpers/clover/targetResolver');
const {
    applyResetSimulation,
    createResetSimulation,
    looksLikeResetScript,
    parseResetScript,
    shouldHandleResetApply,
} = require('../helpers/clover/cloverScriptResetFacade');
const { resetPlayer } = require('../helpers/clover/playerResetService');
const {
    expandSelectorScript,
} = require('../helpers/clover/cloverScriptSelectorFacade');
const { resolveCommand } = require('../helpers/commandRegistry');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            nome_real TEXT,
            personagem_nome TEXT,
            personagem_idade INTEGER,
            ficha_status TEXT,
            historia_status TEXT,
            personagem_aparencia_status TEXT,
            jogo_status TEXT,
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            dinheiro INTEGER DEFAULT 0,
            reino TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            patente TEXT DEFAULT '-',
            lifecycle_status TEXT DEFAULT 'active',
            is_shadow INTEGER DEFAULT 0,
            canonical_player_id TEXT DEFAULT NULL,
            merged_into TEXT DEFAULT NULL,
            identity_status TEXT DEFAULT 'active'
        );

        CREATE TABLE clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            kind TEXT NOT NULL,
            source TEXT,
            reason TEXT
        );
    `);
    await ensureTargetResolverTables(db);
    await ensureTargetResolverSchema(db);
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, nome_real, personagem_nome, personagem_idade,
          ficha_status, historia_status, personagem_aparencia_status, jogo_status,
          esquadrao, estrelas, dinheiro, reino, magia, grimorio, patente)
         VALUES ('player@lid', 'Nilo', 'Nilo', 'Nilo Rosa', 'Arthur Pendragon', 19,
                 'aprovada', 'aprovada', 'approved', 'liberado', '-', 2, 500,
                 'Clover', 'Fogo', 'Trevo 3 folhas', 'Cavaleiro')`
    );
    await db.run(
        `INSERT INTO clover_ph_ledger (player_id, amount, kind, source, reason)
         VALUES ('player@lid', 20, 'ganho', 'missao', 'Missão')`
    );
    return db;
}

function resetScript() {
    return [
        'LOTE id="safe-reset-test" nome="Reset seguro" modo=rigido',
        '',
        'ALVO id="player@lid" confirmar=true',
        'PLAYER resetar escopo=personagem preservar_identidade=true motivo="Troca de personagem" confirmar=true',
        'FIM',
    ].join('\n');
}

function restoreScript(resetCode) {
    return [
        'LOTE id="safe-reset-restore-test" nome="Restaurar reset" modo=rigido',
        '',
        `DESFAZER_RESET codigo=${resetCode} motivo="Reset aplicado por engano" confirmar=true`,
        'FIM',
    ].join('\n');
}

test('reconhece e analisa reset e restauração', () => {
    assert.equal(looksLikeResetScript(resetScript()), true);
    const parsedReset = parseResetScript(resetScript());
    assert.equal(parsedReset.kind, 'player_reset');
    assert.equal(parsedReset.action.preserveIdentity, true);

    const parsedRestore = parseResetScript(restoreScript('RS-ABC12345'));
    assert.equal(parsedRestore.kind, 'player_reset_restore');
    assert.equal(parsedRestore.action.sourceCode, 'RS-ABC12345');
});

test('exige preservação de identidade e confirmação', () => {
    const unsafe = [
        'ALVO id="player@lid" confirmar=true',
        'PLAYER resetar escopo=personagem motivo="Teste" confirmar=true',
        'FIM',
    ].join('\n');
    assert.throws(
        () => parseResetScript(unsafe),
        (error) => error.code === 'identity_preservation_required'
    );

    const noConfirm = [
        'ALVO id="player@lid"',
        'PLAYER resetar escopo=personagem preservar_identidade=true motivo="Teste"',
        'FIM',
    ].join('\n');
    assert.throws(
        () => parseResetScript(noConfirm),
        (error) => error.code === 'missing_confirm'
    );
});

test('simula e aplica reset com códigos CSR e RS auditáveis', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const simulation = await createResetSimulation(db, resetScript(), {
        actorId: OWNER,
        chatId: 'admin@g.us',
    });

    assert.equal(simulation.ok, true);
    assert.match(simulation.code, /^CSR-/);
    assert.match(simulation.operationCode, /^RS-/);
    assert.match(simulation.text, /nada foi aplicado/i);
    assert.equal((await db.get('SELECT personagem_nome FROM jogadores WHERE id = ?', ['player@lid'])).personagem_nome, 'Arthur Pendragon');
    assert.equal(await shouldHandleResetApply(db, {
        code: simulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
    }), true);

    const applied = await applyResetSimulation(db, {
        code: simulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
        sock: null,
    });

    assert.equal(applied.ok, true);
    assert.equal(applied.domainResult.code, simulation.operationCode);
    const player = await db.get('SELECT nome_real, personagem_nome, ficha_status, jogo_status FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(player.nome_real, 'Nilo Rosa');
    assert.equal(player.personagem_nome, '-');
    assert.equal(player.ficha_status, 'incompleta');
    assert.equal(player.jogo_status, 'bloqueado');
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_ph_ledger')).total, 0);

    const run = await db.get('SELECT status FROM clover_script_runs WHERE code = ?', [simulation.code]);
    assert.equal(run.status, 'applied');
    const action = await db.get('SELECT action_type, status FROM clover_script_actions WHERE run_id = ?', [simulation.runId]);
    assert.equal(action.action_type, 'player_reset');
    assert.equal(action.status, 'applied');
});

test('simula e aplica DESFAZER_RESET com códigos CSRR e RR', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const resetSimulation = await createResetSimulation(db, resetScript(), {
        actorId: OWNER,
        chatId: 'admin@g.us',
    });
    await applyResetSimulation(db, {
        code: resetSimulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
        sock: null,
    });

    const restoreSimulation = await createResetSimulation(db, restoreScript(resetSimulation.operationCode), {
        actorId: OWNER,
        chatId: 'admin@g.us',
    });
    assert.match(restoreSimulation.code, /^CSRR-/);
    assert.match(restoreSimulation.operationCode, /^RR-/);

    const restored = await applyResetSimulation(db, {
        code: restoreSimulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
        sock: null,
    });

    assert.equal(restored.ok, true);
    assert.equal(restored.domainResult.sourceCode, resetSimulation.operationCode);
    const player = await db.get('SELECT personagem_nome, ficha_status, jogo_status FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(player.personagem_nome, 'Arthur Pendragon');
    assert.equal(player.ficha_status, 'aprovada');
    assert.equal(player.jogo_status, 'liberado');
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_ph_ledger')).total, 1);
});

test('finaliza aplicação após interrupção entre o domínio e o registro CloverScript', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const simulation = await createResetSimulation(db, resetScript(), {
        actorId: OWNER,
        chatId: 'admin@g.us',
    });
    const domain = await resetPlayer(db, {
        playerId: 'player@lid',
        reason: 'Troca de personagem',
        actorId: OWNER,
        operationCode: simulation.operationCode,
    });
    assert.equal(domain.ok, true);

    const applied = await applyResetSimulation(db, {
        code: simulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
        sock: null,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.domainResult.recovered, true);
    assert.equal(applied.domainResult.code, simulation.operationCode);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_player_reset_events WHERE operation_code = ?', [simulation.operationCode])).total, 1);
});

test('seletor em massa recusa PLAYER resetar antes da expansão', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const mass = [
        'ALVOS onde jogo=liberado confirmar=true',
        'PLAYER resetar escopo=personagem preservar_identidade=true motivo="Teste" confirmar=true',
        'FIM',
    ].join('\n');
    await assert.rejects(
        expandSelectorScript(db, mass, { actorId: OWNER }),
        (error) => error.code === 'protected_action_selector_forbidden'
    );
});

test('comandos específicos de simular e aplicar mantêm prioridade', () => {
    const base = require('../comandos/cloverScript');
    const simulation = require('../comandos/cloverSimulation');
    const apply = require('../comandos/cloverApply');
    const commands = new Map([
        [base.nome, base],
        [simulation.nome, simulation],
        [apply.nome, apply],
    ]);

    const resolvedSimulation = resolveCommand('.#clover simular\nALVO id="x"\nFIM', commands);
    assert.equal(resolvedSimulation.command, simulation);
    const resolvedApply = resolveCommand('.#clover aplicar codigo=CSR-ABC123', commands);
    assert.equal(resolvedApply.command, apply);
});
