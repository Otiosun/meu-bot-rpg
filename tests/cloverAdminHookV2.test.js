'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    AdminHookV2Error,
    assignmentStage,
    normalizeHookV2Spec,
} = require('../helpers/clover/adminHookV2Service');
const {
    createUniversalHookExecutors,
} = require('../helpers/clover/adminOperationRegistry');
const {
    getHookTemplate,
    getPlayerHookAssignment,
} = require('../helpers/clover/adminHookService');
const { handleAdminApiSupport } = require('../helpers/clover/adminApiSupport');

async function memoryDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            esquadrao TEXT,
            jogo_status TEXT
        );
    `);
    await db.run(
        'INSERT INTO jogadores (id, personagem_nome, nome, esquadrao, jogo_status) VALUES (?, ?, ?, ?, ?)',
        ['emil@lid', 'Emil', 'Emil', 'Kings of Sun', 'liberado']
    );
    return db;
}

function operation(code = 'OP-V20001') {
    return { code, actor: { id: 'owner@lid', role: 'owner' } };
}

function responseRecorder() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = value;
        },
        end(value = '') {
            this.body += String(value || '');
        },
    };
}

test('normaliza Gancho misto com efeitos manuais amplos', () => {
    const spec = normalizeHookV2Spec({
        presentationType: 'misto',
        visibility: 'oculto',
        trigger: { type: 'manual' },
        effects: [
            { type: 'titulo', event: 'concluir', delivery: 'manual', key: 'testemunha', name: 'A Testemunha' },
            { type: 'acesso', event: 'revelar', delivery: 'manual', key: 'arquivo_27', name: 'Arquivo 27' },
        ],
    });

    assert.equal(spec.version, 2);
    assert.equal(spec.presentationType, 'mixed');
    assert.equal(spec.visibility, 'hidden');
    assert.equal(spec.effects[0].type, 'title');
    assert.equal(spec.effects[1].type, 'access');
});

test('recusa automação sem executor OP- reversível', () => {
    assert.throws(
        () => normalizeHookV2Spec({
            effects: [
                { type: 'title', event: 'on_complete', delivery: 'operation', key: 'sem_executor', name: 'Sem Executor' },
            ],
        }),
        (error) => error instanceof AdminHookV2Error && error.code === 'hook_effect_not_reversible'
    );
});

test('persiste contrato V2 aprovado e controla ciclo do vínculo', async (t) => {
    const db = await memoryDb();
    t.after(() => db.close());
    const executors = createUniversalHookExecutors();

    const createActionForPreview = {
        type: 'catalog.hook.create',
        payload: {
            name: 'Carta Selada',
            category: 'misto',
            hookV2: {
                presentationType: 'mixed',
                visibility: 'hidden',
                trigger: { type: 'manual' },
                effects: [
                    { type: 'title', event: 'on_complete', delivery: 'manual', key: 'portador_da_carta', name: 'Portador da Carta' },
                ],
            },
        },
    };
    const createPreview = await executors['catalog.hook.create'].preview({
        db,
        operation: operation(),
        action: createActionForPreview,
        target: { playerId: 'owner@lid', characterName: 'Owner' },
    });
    assert.equal(createPreview.after.metadata.hookV2.presentationType, 'mixed');

    const created = await executors['catalog.hook.create'].apply({
        db,
        operation: operation(),
        action: {
            type: 'catalog.hook.create',
            payload: {
                name: 'Carta Selada',
                category: 'misto',
                hookV2: createActionForPreview.payload.hookV2,
            },
        },
        after: createPreview.after,
        target: { playerId: 'owner@lid', characterName: 'Owner' },
    });
    const hook = await getHookTemplate(db, created.after.id);
    assert.equal(hook.metadata.hookV2.version, 2);
    assert.equal(hook.metadata.hookV2.visibility, 'hidden');

    const assignPreview = await executors['player.hook.assign'].preview({
        db,
        operation: operation('OP-V20002'),
        action: { type: 'player.hook.assign', payload: { hookId: hook.id, priority: 5 } },
        target: { playerId: 'emil@lid', characterName: 'Emil' },
        unit: { id: 1 },
    });
    const assigned = await executors['player.hook.assign'].apply({
        db,
        operation: operation('OP-V20002'),
        action: { type: 'player.hook.assign', payload: { hookId: hook.id, priority: 5 } },
        after: assignPreview.after,
        target: { playerId: 'emil@lid', characterName: 'Emil' },
        unit: { id: 1 },
    });
    assert.equal(assignmentStage(assigned.after), 'assigned');
    assert.equal(assigned.after.metadata.hookV2SpecSnapshot.presentationType, 'mixed');

    const revealPreview = await executors['player.hook.update'].preview({
        db,
        operation: operation('OP-V20003'),
        action: {
            type: 'player.hook.update',
            payload: { assignmentId: assigned.after.id, lifecycleStage: 'revealed' },
        },
        target: { playerId: 'emil@lid', characterName: 'Emil' },
    });
    await executors['player.hook.update'].apply({
        db,
        operation: operation('OP-V20003'),
        action: { type: 'player.hook.update', payload: { assignmentId: assigned.after.id, lifecycleStage: 'revealed' } },
        before: revealPreview.before,
        after: revealPreview.after,
        target: { playerId: 'emil@lid', characterName: 'Emil' },
    });
    const revealed = await getPlayerHookAssignment(db, assigned.after.id);
    assert.equal(assignmentStage(revealed), 'revealed');

    const completePreview = await executors['player.hook.complete'].preview({
        db,
        operation: operation('OP-V20004'),
        action: { type: 'player.hook.complete', payload: { assignmentId: assigned.after.id } },
        target: { playerId: 'emil@lid', characterName: 'Emil' },
    });
    await executors['player.hook.complete'].apply({
        db,
        operation: operation('OP-V20004'),
        action: { type: 'player.hook.complete', payload: { assignmentId: assigned.after.id } },
        before: completePreview.before,
        after: completePreview.after,
        target: { playerId: 'emil@lid', characterName: 'Emil' },
    });
    const completed = await getPlayerHookAssignment(db, assigned.after.id);
    assert.equal(completed.status, 'completed');
    assert.equal(assignmentStage(completed), 'completed');
    assert.equal(completed.metadata.hookV2PendingEffects[0].type, 'title');

    await assert.rejects(
        () => executors['player.hook.update'].preview({
            db,
            operation: operation('OP-V20005'),
            action: {
                type: 'player.hook.update',
                payload: { assignmentId: assigned.after.id, lifecycleStage: 'revealed' },
            },
            target: { playerId: 'emil@lid', characterName: 'Emil' },
        }),
        (error) => error instanceof AdminHookV2Error && error.code === 'invalid_hook_transition'
    );
});

test('roteador canônico expõe schema oficial de Ganchos V2', async () => {
    const res = responseRecorder();
    const handled = await handleAdminApiSupport({
        method: 'GET',
        url: '/admin/hooks/schema',
        headers: { authorization: 'Bearer test' },
    }, res, {
        getDb: () => ({ fake: true }),
        authenticateSession: async () => ({ ok: true, player: { id: 'owner@lid' } }),
        accessResolver: async () => ({
            ok: true,
            actor: { id: 'owner@lid', role: 'owner', capabilities: ['catalog.view'] },
        }),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.version, 2);
    assert.ok(payload.presentationTypes.includes('mixed'));
    assert.equal(payload.automaticEffectActions.reward_package, 'reward.grant');
});
