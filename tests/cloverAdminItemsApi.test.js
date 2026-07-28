'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    handleAdminItemsReadApi,
    parseItemDetailPath,
} = require('../helpers/clover/adminItemsReadApi');
const { handleCharacterPresentationPreview } = require('../helpers/clover/characterPresentationPreviewHttp');

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

function request(url = '/admin/items', method = 'GET') {
    return { method, url, headers: { authorization: 'Bearer test' } };
}

function options(db, capabilities = ['catalog.view']) {
    return {
        getDb: () => db,
        authenticateSession: async () => ({
            ok: true,
            player: { id: '222@lid', personagem_nome: 'Avaliador' },
        }),
        accessResolver: async () => ({
            ok: true,
            actor: { id: '222@lid', role: 'admin', capabilities },
        }),
    };
}

function rawItem(overrides = {}) {
    return {
        template_key: 'custom_flor_lunar',
        catalog_version: 2,
        item_name: 'Flor Lunar',
        description: 'Ingrediente colhido à noite.',
        category: 'material',
        kind: 'ingrediente',
        origin: 'Clover',
        base_price: 200,
        default_quality: 'comum',
        default_durability: null,
        stackable: 1,
        transferable: 1,
        requestable: 1,
        marketable: 1,
        duplicable: 1,
        is_custom: 1,
        active: 1,
        properties_json: '{}',
        effects_json: '{}',
        metadata_json: '{}',
        created_by: '222@lid',
        updated_by: '222@lid',
        ...overrides,
    };
}

function readDb(rows = [rawItem()]) {
    return {
        writes: 0,
        lastSql: '',
        lastParams: null,
        async all(sql, params) {
            this.lastSql = sql;
            this.lastParams = params;
            return rows;
        },
        async get(sql, params) {
            this.lastSql = sql;
            this.lastParams = params;
            return rows[0] || null;
        },
        async run() {
            this.writes += 1;
            throw new Error('GET administrativo não pode escrever');
        },
        async exec() {
            this.writes += 1;
            throw new Error('GET administrativo não pode executar schema ou seed');
        },
    };
}

test('listagem aplica archived, custom, q e limit sem escrita', async () => {
    const db = readDb();
    const res = responseRecorder();
    await handleAdminItemsReadApi(
        request('/admin/items?archived=true&custom=1&limit=1&q=lunar'),
        res,
        options(db)
    );

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).items[0].key, 'custom_flor_lunar');
    assert.match(db.lastSql, /is_custom = 1/);
    assert.doesNotMatch(db.lastSql, /active = 1/);
    assert.match(db.lastSql, /LOWER\(COALESCE\(item_name/);
    assert.equal(db.lastParams.at(-1), 1);
    assert.equal(db.writes, 0);
});

test('detalhe aceita código URL-encoded e inclui arquivado', async () => {
    const db = readDb([rawItem({ active: 0 })]);
    const res = responseRecorder();
    await handleAdminItemsReadApi(
        request('/admin/items/custom_flor%5Flunar'),
        res,
        options(db)
    );

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).item.key, 'custom_flor_lunar');
    assert.equal(db.lastParams[0], 'custom_flor_lunar');
    assert.doesNotMatch(db.lastSql, /active = 1/);
    assert.equal(db.writes, 0);
});

test('modelo inexistente retorna 404 item_template_not_found', async () => {
    const res = responseRecorder();
    await handleAdminItemsReadApi(
        request('/admin/items/custom_inexistente'),
        res,
        options(readDb([]))
    );
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'item_template_not_found');
});

test('perfil sem catalog.view recebe 403 missing_capability', async () => {
    const res = responseRecorder();
    await handleAdminItemsReadApi(
        request('/admin/items'),
        res,
        options(readDb(), ['player.view'])
    );
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'missing_capability');
});

test('parser aceita somente um segmento de detalhe', () => {
    assert.equal(parseItemDetailPath('/admin/items/custom_flor_lunar'), 'custom_flor_lunar');
    assert.equal(parseItemDetailPath('/admin/items'), null);
    assert.equal(parseItemDetailPath('/admin/items/custom_flor_lunar/extra'), null);
});

test('método diferente de GET recebe 405', async () => {
    const res = responseRecorder();
    await handleAdminItemsReadApi(request('/admin/items', 'POST'), res, options(readDb()));
    assert.equal(res.statusCode, 405);
    assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});

test('rota desconhecida não é capturada', async () => {
    const res = responseRecorder();
    const handled = await handleAdminItemsReadApi(request('/admin/traits'), res, options(readDb()));
    assert.equal(handled, false);
    assert.equal(res.body, '');
});

test('ponte do servidor encaminha /admin/items sem afetar rotas desconhecidas', async () => {
    const db = readDb();
    const itemRes = responseRecorder();
    const handledItem = await handleCharacterPresentationPreview(
        request('/admin/items?limit=1'),
        itemRes,
        options(db)
    );
    assert.equal(handledItem, true);
    assert.equal(itemRes.statusCode, 200);
    assert.equal(JSON.parse(itemRes.body).items[0].key, 'custom_flor_lunar');

    const unknownRes = responseRecorder();
    const handledUnknown = await handleCharacterPresentationPreview(
        request('/unrelated'),
        unknownRes,
        options(db)
    );
    assert.equal(handledUnknown, false);
    assert.equal(unknownRes.body, '');
});
