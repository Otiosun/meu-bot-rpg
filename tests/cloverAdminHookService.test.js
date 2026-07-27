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
    createHookExecutors,
    createHookTemplate,
    getHookTemplate,
    getPlayerHookAssignment,
    listHookTemplates,
    listPlayerHookAssignments,
} = require('../helpers/clover/adminHookService');
const { getAdminPlayerTraitOverview } = require('../helpers/clover/adminPlayerTraitOverviewService');

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
            historias_extras TEXT DEFAULT '[]',
            canonical_player_id TEXT,
            merged_into TEXT,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active'
        );

        CREATE TABLE clover_player_target_aliases (
            alias_key TEXT PRIMARY KEY,
            alias_label TEXT NOT NULL,
            player_id TEXT NOT NULL,
            alias_kind TEXT NOT NULL DEFAULT 'manual',
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        );

        CREATE TABLE clover_player_aliases (
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
    `);
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, nome, jogo_status, canonical_player_id, historias_extras)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['owner@lid', 'Administrador', 'Owner', 'Liberado', 'owner@lid', '[]']
    );
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, nome, jogo_status, canonical_player_id, historias_extras)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['player@lid', 'Edmund', 'Jogador', 'Liberado', 'player@lid', JSON.stringify([
            { type: 'gn', title: 'Gancho legado', description: 'Permanece como compatibilidade.' },
        ])]
    );
    return db;
}

const actor = { id: 'owner@lid', role: 'owner' };
const executors = createHookExecutors();

async function runToApplied(db, input) {
    const created = await createAdminOperation(db, input, actor);
    await simulateAdminOperation(db, created.operation.code, actor, { executors });
    await approveAdminOperation(db, created.operation.code, actor);
    return applyAdminOperation(db, created.operation.code, actor, { executors });
}

function operationInput(action, suffix, target = 'player@lid') {
    return {
        title: `Operação de gancho ${suffix}`,
        reason: 'Teste do módulo administrativo de Ganchos.',
        targets: [{ kind: 'player', playerId: target }],
        actions: [action],
        idempotencyKey: `hook:test:${suffix}`,
    };
}

test('cria, lista e consulta modelo estruturado de gancho', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const hook = await createHookTemplate(db, {
        id: 'HK-A1B2C3D4',
        canonicalKey: 'o_selo_partido',
        name: 'O Selo Partido',
        description: 'Uma marca antiga voltou a responder ao personagem.',
        objectiveText: 'Descobrir quem reativou o selo.',
        completionText: 'Registrar a origem e a consequência do selo.',
        category: 'misterio',
    }, { actorId: actor.id, operationCode: 'OP-ABC123' });

    assert.equal(hook.id, 'HK-A1B2C3D4');
    assert.equal(hook.category, 'misterio');
    const listed = await listHookTemplates(db, { query: 'selo' });
    assert.equal(listed.hooks.length, 1);
    assert.equal((await getHookTemplate(db, hook.id)).objectiveText, 'Descobrir quem reativou o selo.');
});

test('vincula gancho por OP, mostra na ficha e desfaz sem apagar legado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await createHookTemplate(db, {
        id: 'HK-11112222',
        name: 'A Carta que Não Foi Enviada',
        description: 'Uma carta selada reaparece entre os pertences.',
        objectiveText: 'Encontrar o destinatário correto.',
    }, { actorId: actor.id });

    const applied = await runToApplied(db, operationInput({
        type: 'player.hook.assign',
        payload: {
            hookId: 'HK-11112222',
            developmentText: 'A carta possui o brasão de uma família desconhecida.',
            privateNotes: 'Não revelar o remetente antes da segunda pista.',
            priority: 20,
        },
    }, 'assign'));

    assert.equal(applied.operation.status, 'applied');
    const assignments = await listPlayerHookAssignments(db, { playerId: 'player@lid', status: 'active' });
    assert.equal(assignments.assignments.length, 1);
    assert.equal(assignments.assignments[0].title, 'A Carta que Não Foi Enviada');
    assert.equal(assignments.assignments[0].privateNotes, 'Não revelar o remetente antes da segunda pista.');

    const overview = await getAdminPlayerTraitOverview(db, 'player@lid');
    assert.equal(overview.hooks.length, 2);
    assert.equal(overview.hooks[0].source, 'catalog_hook');
    assert.equal(overview.hooks[0].body, 'A carta possui o brasão de uma família desconhecida.');
    assert.equal(overview.hooks[1].title, 'Gancho legado');

    const undone = await undoAdminOperation(db, applied.operation.code, actor, { executors });
    assert.equal(undone.operation.status, 'undone');
    assert.equal((await listPlayerHookAssignments(db, { playerId: 'player@lid' })).assignments.length, 0);
    assert.equal((await getAdminPlayerTraitOverview(db, 'player@lid')).hooks[0].title, 'Gancho legado');
});

test('atualiza, conclui e remove vínculo com snapshots reversíveis', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await createHookTemplate(db, {
        id: 'HK-33334444',
        name: 'Vozes no Portão',
        description: 'Vozes surgem perto do portão ao anoitecer.',
        completionText: 'As vozes foram identificadas e o risco foi encerrado.',
    }, { actorId: actor.id });

    const assignedOp = await runToApplied(db, operationInput({
        type: 'player.hook.assign',
        payload: { hookId: 'HK-33334444' },
    }, 'lifecycle-assign'));
    const assignmentId = assignedOp.operation.units[0].after.id;

    const updatedOp = await runToApplied(db, operationInput({
        type: 'player.hook.update',
        payload: {
            assignmentId,
            developmentText: 'O som acompanha a troca da guarda.',
            priority: 50,
        },
    }, 'lifecycle-update'));
    assert.equal((await getPlayerHookAssignment(db, assignmentId)).priority, 50);

    const completedOp = await runToApplied(db, operationInput({
        type: 'player.hook.complete',
        payload: { assignmentId, completionNote: 'A origem era um artefato preso na muralha.' },
    }, 'lifecycle-complete'));
    assert.equal((await getPlayerHookAssignment(db, assignmentId)).status, 'completed');

    await undoAdminOperation(db, completedOp.operation.code, actor, { executors });
    assert.equal((await getPlayerHookAssignment(db, assignmentId)).status, 'active');

    const removedOp = await runToApplied(db, operationInput({
        type: 'player.hook.remove',
        payload: { assignmentId },
    }, 'lifecycle-remove'));
    assert.equal((await getPlayerHookAssignment(db, assignmentId)).status, 'removed');

    await undoAdminOperation(db, removedOp.operation.code, actor, { executors });
    assert.equal((await getPlayerHookAssignment(db, assignmentId)).status, 'active');
    assert.equal((await getPlayerHookAssignment(db, assignmentId)).developmentText, 'O som acompanha a troca da guarda.');

    await undoAdminOperation(db, updatedOp.operation.code, actor, { executors });
    assert.equal((await getPlayerHookAssignment(db, assignmentId)).priority, 0);
});

test('undo falha fechado quando vínculo sofreu alteração posterior', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await createHookTemplate(db, {
        id: 'HK-55556666',
        name: 'Pista Instável',
    }, { actorId: actor.id });

    const applied = await runToApplied(db, operationInput({
        type: 'player.hook.assign',
        payload: { hookId: 'HK-55556666' },
    }, 'safe-undo'));
    const assignmentId = applied.operation.units[0].after.id;
    await db.run(
        `UPDATE clover_player_hooks
         SET development_text = 'Alteração posterior', updated_at = ?
         WHERE id = ?`,
        [new Date(Date.now() + 1000).toISOString(), assignmentId]
    );

    await assert.rejects(
        () => undoAdminOperation(db, applied.operation.code, actor, { executors }),
        { code: 'hook_assignment_changed_since_apply' }
    );
    assert.equal((await getPlayerHookAssignment(db, assignmentId)).developmentText, 'Alteração posterior');
});

test('criação de catálogo por OP é removível enquanto não possui vínculos', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const applied = await runToApplied(db, operationInput({
        type: 'catalog.hook.create',
        payload: {
            id: 'HK-77778888',
            name: 'Gancho Criado por OP',
            objectiveText: 'Confirmar o ciclo completo.',
        },
    }, 'catalog-create', actor.id));

    assert.equal((await getHookTemplate(db, 'HK-77778888')).name, 'Gancho Criado por OP');
    await undoAdminOperation(db, applied.operation.code, actor, { executors });
    await assert.rejects(() => getHookTemplate(db, 'HK-77778888'), { code: 'hook_not_found' });
});
