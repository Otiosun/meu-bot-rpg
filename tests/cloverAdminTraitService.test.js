'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    applyAdminOperation,
    approveAdminOperation,
    createAdminOperation,
    simulateAdminOperation,
    undoAdminOperation,
} = require('../helpers/clover/adminOperationService');
const {
    createTraitExecutors,
    createTraitTemplate,
    getPlayerTraitState,
    getTraitTemplate,
    listTraitTemplates,
} = require('../helpers/clover/adminTraitService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            esquadrao TEXT,
            jogo_status TEXT,
            aptidao_comum TEXT,
            marca_comum TEXT,
            aptidao_rara TEXT,
            marca_rara TEXT,
            anomalia TEXT,
            canonical_player_id TEXT,
            merged_into TEXT,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active'
        )
    `);
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, nome, jogo_status, aptidao_comum, canonical_player_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['111@lid', 'Killian', 'Nilo', 'Liberado', 'Corpo de Rotina', '111@lid']
    );
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, nome, jogo_status, aptidao_comum, canonical_player_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['222@lid', 'Artorius', 'Jogador Dois', 'Liberado', 'Aptidão Antiga', '222@lid']
    );
    return db;
}

const actor = { id: '111@lid', role: 'owner' };
const executors = createTraitExecutors();

async function runToApplied(db, input) {
    const created = await createAdminOperation(db, input, actor);
    await simulateAdminOperation(db, created.operation.code, actor, { executors });
    await approveAdminOperation(db, created.operation.code, actor);
    return applyAdminOperation(db, created.operation.code, actor, { executors });
}

test('cria e lista modelo de traço estruturado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const trait = await createTraitTemplate(db, {
        id: 'TR-A1B2C3D4',
        name: 'A Espada Cega',
        slotKey: 'aptidao_comum',
        description: 'Traço de desenvolvimento de Artorius.',
        effectText: '+10% quando age segundo a rotina construída.',
        restrictionsText: 'Não ativa por improviso vazio.',
    }, { actorId: actor.id, operationCode: 'OP-000001' });

    assert.equal(trait.id, 'TR-A1B2C3D4');
    assert.equal(trait.slotKey, 'aptidao_comum');
    const list = await listTraitTemplates(db, { query: 'Espada' });
    assert.equal(list.traits.length, 1);
    assert.equal(list.traits[0].name, 'A Espada Cega');
});

test('atribui traço por OP e desfaz restaurando ficha e vínculo anterior', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await createTraitTemplate(db, {
        id: 'TR-11112222',
        name: 'A Espada Cega',
        slotKey: 'aptidao_comum',
        description: 'Modelo estruturado.',
    }, { actorId: actor.id });

    const applied = await runToApplied(db, {
        title: 'Atribuir A Espada Cega',
        reason: 'Atualização aprovada do personagem',
        targets: [{ kind: 'player', playerId: '222@lid' }],
        actions: [{ type: 'player.trait.assign', payload: { traitId: 'TR-11112222' } }],
        idempotencyKey: 'trait:assign:artorius:1',
    });

    assert.equal(applied.operation.status, 'applied');
    assert.equal((await db.get('SELECT aptidao_comum FROM jogadores WHERE id = ?', ['222@lid'])).aptidao_comum, 'A Espada Cega');
    const assigned = await getPlayerTraitState(db, '222@lid', 'aptidao_comum');
    assert.equal(assigned.assignment.traitId, 'TR-11112222');
    assert.equal(assigned.assignment.operationCode, applied.operation.code);

    const undone = await undoAdminOperation(db, applied.operation.code, actor, { executors });
    assert.equal(undone.operation.status, 'undone');
    assert.equal((await db.get('SELECT aptidao_comum FROM jogadores WHERE id = ?', ['222@lid'])).aptidao_comum, 'Aptidão Antiga');
    const restored = await getPlayerTraitState(db, '222@lid', 'aptidao_comum');
    assert.equal(restored.assignment, null);
});

test('criação de catálogo também percorre OP com snapshot reversível', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const applied = await runToApplied(db, {
        title: 'Criar traço de sistema',
        reason: 'Novo traço aprovado para o catálogo',
        targets: [{ kind: 'player', playerId: actor.id }],
        actions: [{
            type: 'catalog.trait.create',
            payload: {
                id: 'TR-ABCDEF12',
                name: 'Aqueles que Lutam por Amor',
                slotKey: 'aptidao_comum',
                description: 'Traço de Lucien.',
                effectText: '+10% quando a música fortalece um vínculo real.',
            },
        }],
        idempotencyKey: 'trait:create:lucien:1',
    });

    assert.equal((await getTraitTemplate(db, 'TR-ABCDEF12')).name, 'Aqueles que Lutam por Amor');
    await undoAdminOperation(db, applied.operation.code, actor, { executors });
    await assert.rejects(() => getTraitTemplate(db, 'TR-ABCDEF12'), { code: 'trait_not_found' });
});