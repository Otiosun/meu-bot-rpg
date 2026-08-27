'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    PRE_RESET_TRANSITION_MIGRATION,
    inspectPreResetTransitionSchemaState,
} = require('../helpers/clover/preResetTransitionMigration');
const {
    PreResetTransitionError,
    applyAutoResetToUndecided,
    decideTransition,
    isPreResetTransitionEnabled,
} = require('../helpers/clover/preResetTransitionService');

async function createFixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec('PRAGMA foreign_keys = ON');
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            ficha_status TEXT DEFAULT 'incompleta',
            jogo_status TEXT DEFAULT 'bloqueado',
            personagem_nome TEXT DEFAULT '-',
            personagem_idade INTEGER,
            personagem_genero TEXT,
            personagem_aparencia TEXT DEFAULT '-',
            personagem_aparencia_status TEXT,
            personagem_aparencia_approved_by TEXT,
            personagem_aparencia_approved_at TEXT,
            reino TEXT,
            classe TEXT,
            raca TEXT,
            grimorio TEXT,
            familia TEXT,
            familia_key TEXT,
            magia TEXT,
            magia_key TEXT,
            aptidao_comum TEXT,
            aptidao_comum_key TEXT,
            marca_comum TEXT,
            marca_comum_key TEXT,
            aptidao_rara TEXT,
            aptidao_rara_key TEXT,
            marca_rara TEXT,
            marca_rara_key TEXT,
            anomalia TEXT,
            anomalia_key TEXT,
            numero_roll_escolhido INTEGER
        );
        CREATE TABLE player_rolls (
            player_id TEXT NOT NULL,
            roll_number INTEGER NOT NULL,
            kingdom TEXT,
            kingdom_key TEXT,
            social_class TEXT,
            social_class_key TEXT,
            race TEXT,
            race_key TEXT,
            grimoire TEXT,
            grimoire_key TEXT,
            grimoire_rank TEXT,
            magic_rarity TEXT,
            magic_rarity_key TEXT,
            roll_version TEXT,
            roll_payload TEXT,
            PRIMARY KEY (player_id, roll_number)
        );
        CREATE TABLE clover_prereset_characters (
            player_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            revision INTEGER NOT NULL,
            draft_json TEXT NOT NULL,
            draft_hash TEXT NOT NULL,
            created_by TEXT NOT NULL,
            updated_by TEXT NOT NULL,
            provenance_json TEXT,
            submitted_at TEXT,
            approved_at TEXT,
            locked_at TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await PRE_RESET_TRANSITION_MIGRATION.up(db);
    return db;
}

async function insertApprovedPlayer(db, id, overrides = {}) {
    const player = {
        id,
        ficha_status: 'aprovada',
        jogo_status: 'liberado',
        personagem_nome: 'Aster',
        personagem_idade: 19,
        personagem_genero: 'Masculino',
        personagem_aparencia: 'Cabelos negros, olhos dourados e manto verde.',
        personagem_aparencia_status: 'approved',
        personagem_aparencia_approved_by: 'adm@lid',
        personagem_aparencia_approved_at: '2026-08-20T12:00:00Z',
        reino: 'Clover',
        classe: 'Nobre',
        raca: 'Humano',
        grimorio: 'Três Folhas',
        familia: 'Silva',
        familia_key: 'silva',
        magia: 'Vento',
        magia_key: 'vento',
        numero_roll_escolhido: 2,
        ...overrides,
    };
    await db.run(
        `INSERT INTO jogadores (
            id,ficha_status,jogo_status,personagem_nome,personagem_idade,personagem_genero,
            personagem_aparencia,personagem_aparencia_status,personagem_aparencia_approved_by,
            personagem_aparencia_approved_at,reino,classe,raca,grimorio,familia,familia_key,
            magia,magia_key,numero_roll_escolhido
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        Object.values(player)
    );
}

async function insertRoll(db, playerId, rollNumber, values = {}) {
    const roll = {
        kingdom: 'Clover',
        kingdom_key: 'clover',
        social_class: 'Nobre',
        social_class_key: 'nobre',
        race: 'Humano',
        race_key: 'humano',
        grimoire: 'Três Folhas',
        grimoire_key: 'tres_folhas',
        grimoire_rank: 'comum',
        magic_rarity: 'comum',
        magic_rarity_key: 'comum',
        roll_version: 'v1',
        roll_payload: JSON.stringify({ seed: rollNumber }),
        ...values,
    };
    await db.run(
        `INSERT INTO player_rolls (
            player_id,roll_number,kingdom,kingdom_key,social_class,social_class_key,
            race,race_key,grimoire,grimoire_key,grimoire_rank,magic_rarity,
            magic_rarity_key,roll_version,roll_payload
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [playerId, rollNumber, ...Object.values(roll)]
    );
}

test('0034 nasce ausente, migra para schema exato e transicao exige duas chaves', async (t) => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());
    await db.exec('CREATE TABLE jogadores (id TEXT PRIMARY KEY)');
    assert.equal((await inspectPreResetTransitionSchemaState(db)).kind, 'absent');
    await PRE_RESET_TRANSITION_MIGRATION.up(db);
    assert.equal((await inspectPreResetTransitionSchemaState(db)).kind, 'exact');

    assert.equal(isPreResetTransitionEnabled({ PRE_RESET_LAUNCH_ENABLED: 'true' }), false);
    assert.equal(isPreResetTransitionEnabled({ PRE_RESET_RETURN_ENABLED: 'true' }), false);
    assert.equal(isPreResetTransitionEnabled({
        PRE_RESET_LAUNCH_ENABLED: 'true',
        PRE_RESET_RETURN_ENABLED: 'true',
    }), true);
});

test('MANTER reconstrói roll aprovado pelo histórico, ignora numero_roll_escolhido adulterado e congela tudo', async (t) => {
    const db = await createFixture();
    t.after(() => db.close());
    await insertApprovedPlayer(db, 'keep@lid', { numero_roll_escolhido: 2 });
    await insertRoll(db, 'keep@lid', 1);
    await insertRoll(db, 'keep@lid', 2, { kingdom: 'Diamond', kingdom_key: 'diamond' });

    const result = await decideTransition(db, 'keep@lid', 'keep@lid', {
        decision: 'keep',
        source: 'player',
        operationKey: 'retorno:test:keep:0001',
    });
    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.decision.status, 'keep');
    assert.equal(result.decision.baseline.roll.rollNumber, 1);
    assert.equal(result.decision.baseline.character.name, 'Aster');
    assert.equal(result.decision.baseline.character.appearance, 'Cabelos negros, olhos dourados e manto verde.');

    const future = await db.get('SELECT status, draft_json, provenance_json FROM clover_prereset_characters WHERE player_id = ?', ['keep@lid']);
    assert.equal(future.status, 'locked');
    assert.equal(JSON.parse(future.draft_json).rollNumber, 1);
    assert.equal(JSON.parse(future.provenance_json).baselineHash, result.decision.baselineHash);

    const playerAfter = await db.get('SELECT jogo_status, personagem_nome, numero_roll_escolhido FROM jogadores WHERE id = ?', ['keep@lid']);
    assert.deepEqual(playerAfter, { jogo_status: 'liberado', personagem_nome: 'Aster', numero_roll_escolhido: 2 });

    const replay = await decideTransition(db, 'keep@lid', 'keep@lid', {
        decision: 'keep',
        source: 'player',
        operationKey: 'retorno:test:keep:0001',
    });
    assert.equal(replay.duplicate, true);

    await assert.rejects(
        decideTransition(db, 'keep@lid', 'keep@lid', {
            decision: 'reset',
            source: 'player',
            operationKey: 'retorno:test:reset:0002',
        }),
        (error) => error instanceof PreResetTransitionError && error.code === 'transition_decision_irreversible'
    );

    await assert.rejects(
        db.run("UPDATE clover_prereset_transition_decisions SET status = 'reset' WHERE player_id = 'keep@lid'"),
        /prereset_transition_decision_irreversible/
    );
});

test('MANTER falha fechado quando mais de um roll histórico casa com a ficha aprovada', async (t) => {
    const db = await createFixture();
    t.after(() => db.close());
    await insertApprovedPlayer(db, 'ambiguous@lid');
    await insertRoll(db, 'ambiguous@lid', 1);
    await insertRoll(db, 'ambiguous@lid', 2);

    await assert.rejects(
        decideTransition(db, 'ambiguous@lid', 'ambiguous@lid', {
            decision: 'keep',
            source: 'player',
            operationKey: 'retorno:test:ambiguous:0001',
        }),
        (error) => error instanceof PreResetTransitionError && error.code === 'keep_baseline_roll_ambiguous'
    );
    assert.equal(await db.get('SELECT 1 FROM clover_prereset_transition_decisions WHERE player_id = ?', ['ambiguous@lid']), undefined);
    assert.equal(await db.get('SELECT 1 FROM clover_prereset_characters WHERE player_id = ?', ['ambiguous@lid']), undefined);
});

test('RESET só registra decisão: não destrói personagem nem cria future char', async (t) => {
    const db = await createFixture();
    t.after(() => db.close());
    await insertApprovedPlayer(db, 'reset@lid');
    await insertRoll(db, 'reset@lid', 1);

    const result = await decideTransition(db, 'reset@lid', 'reset@lid', {
        decision: 'reset',
        source: 'player',
        operationKey: 'retorno:test:reset:0001',
    });
    assert.equal(result.decision.status, 'reset');
    const playerAfter = await db.get('SELECT jogo_status, personagem_nome, personagem_aparencia FROM jogadores WHERE id = ?', ['reset@lid']);
    assert.deepEqual(playerAfter, {
        jogo_status: 'liberado',
        personagem_nome: 'Aster',
        personagem_aparencia: 'Cabelos negros, olhos dourados e manto verde.',
    });
    assert.equal(await db.get('SELECT 1 FROM clover_prereset_characters WHERE player_id = ?', ['reset@lid']), undefined);
});

test('AUTO_RESET de deadline é auditável e também não executa reset destrutivo', async (t) => {
    const db = await createFixture();
    t.after(() => db.close());
    await insertApprovedPlayer(db, 'auto@lid');
    await insertRoll(db, 'auto@lid', 1);

    const result = await applyAutoResetToUndecided(db);
    assert.equal(result.total, 1);
    const decision = await db.get('SELECT status, decision_source FROM clover_prereset_transition_decisions WHERE player_id = ?', ['auto@lid']);
    assert.deepEqual(decision, { status: 'auto_reset', decision_source: 'deadline' });
    const playerAfter = await db.get('SELECT jogo_status, personagem_nome FROM jogadores WHERE id = ?', ['auto@lid']);
    assert.deepEqual(playerAfter, { jogo_status: 'liberado', personagem_nome: 'Aster' });
});
