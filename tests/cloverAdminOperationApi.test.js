'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { handleAdminApiSupport } = require('../helpers/clover/adminApiSupport');
const { createTraitTemplate } = require('../helpers/clover/adminTraitService');

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
         VALUES ('111@lid', 'Killian', 'Nilo', 'Liberado', 'Antigo', '111@lid')`
    );
    await createTraitTemplate(db, {
        id: 'TR-1234ABCD',
        name: 'Corpo de Rotina',
        slotKey: 'aptidao_comum',
        description: 'Traço de teste.',
    }, { actorId: '111@lid' });
    return db;
}

function responseRecorder() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        end(value = '') { this.body += String(value || ''); },
    };
}

function request(method, url, body = null, headers = {}) {
    const stream = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
    stream.method = method;
    stream.url = url;
    stream.headers = {
        authorization: 'Bearer test',
        ...(body === null ? {} : { 'content-type': 'application/json' }),
        ...headers,
    };
    return stream;
}

function options(db, capabilities = [
    'operation.view',
    'operation.draft',
    'operation.simulate',
    'operation.apply',
    'operation.undo',
    'player.view',
    'player.manage',
    'catalog.view',
    'catalog.manage.traits',
]) {
    return {
        getDb: () => db,
        authenticateSession: async () => ({
            ok: true,
            player: { id: '111@lid', personagem_nome: 'Killian' },
        }),
        accessResolver: async () => ({
            ok: true,
            actor: { id: '111@lid', role: 'owner', capabilities },
        }),
    };
}

async function call(db, method, url, body = null, headers = {}, customOptions = {}) {
    const res = responseRecorder();
    const handled = await handleAdminApiSupport(
        request(method, url, body, headers),
        res,
        { ...options(db), ...customOptions }
    );
    return { handled, status: res.statusCode, payload: res.body ? JSON.parse(res.body) : null };
}

test('API executa criação, simulação, aprovação, aplicação, consulta e undo', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const draft = {
        title: 'Atribuir Corpo de Rotina',
        reason: 'Atualização administrativa aprovada',
        targets: [{ kind: 'player', playerId: '111@lid' }],
        actions: [{ type: 'player.trait.assign', payload: { traitId: 'TR-1234ABCD' } }],
    };

    const created = await call(db, 'POST', '/admin/operations', draft, {
        'idempotency-key': 'api:trait:assign:1',
    });
    assert.equal(created.status, 201);
    assert.match(created.payload.operation.code, /^OP-[A-F0-9]{6}$/);
    const code = created.payload.operation.code;

    const simulated = await call(db, 'POST', `/admin/operations/${code}/simulate`, {});
    assert.equal(simulated.status, 200);
    assert.equal(simulated.payload.operation.status, 'simulated');
    assert.equal(simulated.payload.operation.preview.unitCount, 1);

    const approved = await call(db, 'POST', `/admin/operations/${code}/approve`, {});
    assert.equal(approved.payload.operation.status, 'approved');

    const applied = await call(db, 'POST', `/admin/operations/${code}/apply`, {});
    assert.equal(applied.payload.operation.status, 'applied');
    assert.equal((await db.get("SELECT aptidao_comum FROM jogadores WHERE id = '111@lid'")).aptidao_comum, 'Corpo de Rotina');

    const detail = await call(db, 'GET', `/admin/operations/${code}`);
    assert.equal(detail.payload.operation.events.length, 5);
    assert.equal(detail.payload.operation.units[0].status, 'applied');

    const undone = await call(db, 'POST', `/admin/operations/${code}/undo`, {
        reason: 'Reversão de teste',
    });
    assert.equal(undone.payload.operation.status, 'undone');
    assert.equal((await db.get("SELECT aptidao_comum FROM jogadores WHERE id = '111@lid'")).aptidao_comum, 'Antigo');

    const list = await call(db, 'GET', '/admin/operations?q=Corpo');
    assert.equal(list.payload.operations.length, 1);
    assert.equal(list.payload.operations[0].code, code);
});

test('API lista catálogo de traços e bloqueia criação sem capacidades da ação', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const traits = await call(db, 'GET', '/admin/traits?q=Rotina');
    assert.equal(traits.status, 200);
    assert.equal(traits.payload.traits[0].id, 'TR-1234ABCD');

    const res = responseRecorder();
    await handleAdminApiSupport(
        request('POST', '/admin/operations', {
            title: 'Operação proibida',
            reason: 'Teste de permissão',
            targets: [{ kind: 'player', playerId: '111@lid' }],
            actions: [{ type: 'player.trait.assign', payload: { traitId: 'TR-1234ABCD' } }],
            idempotencyKey: 'forbidden:1',
        }),
        res,
        options(db, ['operation.view', 'operation.draft'])
    );

    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'forbidden_actions');
});

test('undo exige motivo explícito', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const created = await call(db, 'POST', '/admin/operations', {
        title: 'Atribuir traço',
        reason: 'Teste',
        targets: [{ kind: 'player', playerId: '111@lid' }],
        actions: [{ type: 'player.trait.assign', payload: { traitId: 'TR-1234ABCD' } }],
        idempotencyKey: 'undo:reason:1',
    });
    const code = created.payload.operation.code;
    await call(db, 'POST', `/admin/operations/${code}/simulate`, {});
    await call(db, 'POST', `/admin/operations/${code}/approve`, {});
    await call(db, 'POST', `/admin/operations/${code}/apply`, {});

    const undone = await call(db, 'POST', `/admin/operations/${code}/undo`, {});
    assert.equal(undone.status, 400);
    assert.equal(undone.payload.error, 'missing_undo_reason');
});