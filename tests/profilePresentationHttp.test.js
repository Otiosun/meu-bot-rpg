'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { PROFILE_PRESENTATION_MIGRATION } = require('../helpers/clover/schemaMigrationCatalog');
const { __test: siteApiTest } = require('../helpers/clover/siteApiServerBase');

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-profile-presentation-http-'));
    const db = await openCloverDatabase({ filename: path.join(dir, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    await db.exec('CREATE TABLE jogadores (id TEXT PRIMARY KEY, nome TEXT)');
    await PROFILE_PRESENTATION_MIGRATION.up(db);
    await db.run('INSERT INTO jogadores (id, nome) VALUES (?, ?)', ['player-1', 'Teste']);
    return db;
}

function request(method, body) {
    const req = body === undefined ? Readable.from([]) : Readable.from([JSON.stringify(body)]);
    req.method = method;
    req.headers = {};
    req.url = '/character/profile-presentation';
    return req;
}

function response() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers;
        },
        end(chunk = '') {
            this.body += String(chunk || '');
        },
    };
}

test('GET /character/profile-presentation devolve defaults compartilháveis', async (t) => {
    const db = await fixture(t);
    const req = request('GET');
    const res = response();

    const handled = await siteApiTest.routeAuthed(
        req,
        res,
        db,
        'GET',
        ['character', 'profile-presentation'],
        { player: { id: 'player-1' } },
        '/character/profile-presentation',
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.schemaVersion, 'profile-presentation.v1');
    assert.equal(payload.preferences.accent, 'gold');
    assert.equal(payload.updatedAt, null);
});

test('PUT /character/profile-presentation normaliza, persiste e GET lê o mesmo estado', async (t) => {
    const db = await fixture(t);
    const putReq = request('PUT', {
        preferences: {
            accent: 'azure',
            heroStyle: 'cover',
            motto: 'Registro azul',
            heroFacts: ['rank', 'magic', 'rank'],
            sectionOrder: ['history', 'identity'],
            hiddenSections: ['effects'],
            sectionStyle: 'minimal',
            showSectionIcons: false,
            showActiveTitle: false,
        },
    });
    const putRes = response();

    const handled = await siteApiTest.routeAuthed(
        putReq,
        putRes,
        db,
        'PUT',
        ['character', 'profile-presentation'],
        { player: { id: 'player-1' } },
        '/character/profile-presentation',
    );

    assert.equal(handled, true);
    assert.equal(putRes.statusCode, 200);
    const saved = JSON.parse(putRes.body);
    assert.equal(saved.preferences.accent, 'azure');
    assert.deepEqual(saved.preferences.heroFacts, ['rank', 'magic']);
    assert.deepEqual(saved.preferences.sectionOrder, ['history', 'identity', 'links', 'traits', 'effects']);
    assert.ok(saved.updatedAt);

    const getReq = request('GET');
    const getRes = response();
    await siteApiTest.routeAuthed(
        getReq,
        getRes,
        db,
        'GET',
        ['character', 'profile-presentation'],
        { player: { id: 'player-1' } },
        '/character/profile-presentation',
    );
    assert.deepEqual(JSON.parse(getRes.body).preferences, saved.preferences);
});

test('rota de apresentação não captura métodos fora do contrato GET|PUT', async (t) => {
    const db = await fixture(t);
    const handled = await siteApiTest.routeAuthed(
        request('POST', {}),
        response(),
        db,
        'POST',
        ['character', 'profile-presentation'],
        { player: { id: 'player-1' } },
        '/character/profile-presentation',
    );
    assert.equal(handled, false);
});
