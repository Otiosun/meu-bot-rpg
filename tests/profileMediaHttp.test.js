'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { after, test } = require('node:test');
const sharp = require('sharp');

const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-profile-media-http-files-'));
process.env.CLOVER_PROFILE_MEDIA_DIR = mediaRoot;

const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { PROFILE_MEDIA_MIGRATION } = require('../helpers/clover/schemaMigrationCatalog');
const { __test: siteApiTest } = require('../helpers/clover/siteApiServerBase');

after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-profile-media-http-db-'));
    const db = await openCloverDatabase({ filename: path.join(dir, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            site_profile_image_data TEXT DEFAULT NULL,
            site_profile_image_updated_at TEXT DEFAULT NULL
        )
    `);
    await PROFILE_MEDIA_MIGRATION.up(db);
    await db.run('INSERT INTO jogadores (id, nome) VALUES (?, ?)', ['player-1', 'Teste']);
    return db;
}

async function imageDataUrl() {
    const buffer = await sharp({
        create: {
            width: 1000,
            height: 500,
            channels: 4,
            background: { r: 70, g: 35, b: 100, alpha: 1 },
        },
    }).png().toBuffer();
    return `data:image/png;base64,${buffer.toString('base64')}`;
}

function request(method, body, headers = {}) {
    const req = body === undefined ? Readable.from([]) : Readable.from([JSON.stringify(body)]);
    req.method = method;
    req.headers = { ...headers };
    req.url = '/character/profile-media/banner';
    return req;
}

function response() {
    return {
        statusCode: null,
        headers: {},
        body: '',
        buffer: null,
        writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers || {};
        },
        end(chunk = '') {
            if (Buffer.isBuffer(chunk)) this.buffer = Buffer.from(chunk);
            else this.body += String(chunk || '');
        },
    };
}

async function route(db, method, parts, req, res) {
    return siteApiTest.routeAuthed(
        req,
        res,
        db,
        method,
        parts,
        { player: { id: 'player-1' } },
        `/${parts.join('/')}`,
    );
}

test('GET /character/profile-media inicia sem avatar nem banner', async (t) => {
    const db = await fixture(t);
    const req = request('GET');
    const res = response();

    const handled = await route(db, 'GET', ['character', 'profile-media'], req, res);

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.media.avatar, null);
    assert.equal(payload.media.banner, null);
    assert.equal(payload.media.legacyAvatarAvailable, false);
});

test('PUT salva banner e GET binário devolve WEBP privado com ETag', async (t) => {
    const db = await fixture(t);
    const putReq = request('PUT', {
        image: await imageDataUrl(),
        focalX: 0.25,
        focalY: 0.7,
        zoom: 1.2,
    });
    const putRes = response();

    assert.equal(
        await route(db, 'PUT', ['character', 'profile-media', 'banner'], putReq, putRes),
        true,
    );
    assert.equal(putRes.statusCode, 200);
    const saved = JSON.parse(putRes.body).media;
    assert.equal(saved.kind, 'banner');
    assert.equal(saved.focalX, 0.25);
    assert.equal(saved.focalY, 0.7);
    assert.equal(saved.zoom, 1.2);

    const getReq = request('GET');
    const getRes = response();
    assert.equal(
        await route(db, 'GET', ['character', 'profile-media', 'banner'], getReq, getRes),
        true,
    );
    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.headers['Content-Type'], 'image/webp');
    assert.equal(getRes.headers['Cache-Control'], 'private, max-age=86400');
    assert.equal(getRes.headers.ETag, `"${saved.sha256}"`);
    assert.ok(Buffer.isBuffer(getRes.buffer));
    assert.equal(getRes.buffer.length, saved.bytes);
});

test('GET binário respeita If-None-Match e responde 304 sem corpo', async (t) => {
    const db = await fixture(t);
    const putRes = response();
    await route(
        db,
        'PUT',
        ['character', 'profile-media', 'banner'],
        request('PUT', { image: await imageDataUrl() }),
        putRes,
    );
    const saved = JSON.parse(putRes.body).media;

    const req = request('GET', undefined, { 'if-none-match': `"${saved.sha256}"` });
    const res = response();
    await route(db, 'GET', ['character', 'profile-media', 'banner'], req, res);

    assert.equal(res.statusCode, 304);
    assert.equal(res.buffer, null);
    assert.equal(res.headers.ETag, `"${saved.sha256}"`);
});

test('PATCH atualiza apenas focal point e zoom', async (t) => {
    const db = await fixture(t);
    await route(
        db,
        'PUT',
        ['character', 'profile-media', 'banner'],
        request('PUT', { image: await imageDataUrl() }),
        response(),
    );

    const patchRes = response();
    await route(
        db,
        'PATCH',
        ['character', 'profile-media', 'banner'],
        request('PATCH', { focalX: 0.9, focalY: 0.1, zoom: 2.25 }),
        patchRes,
    );
    assert.equal(patchRes.statusCode, 200);
    const media = JSON.parse(patchRes.body).media;
    assert.equal(media.focalX, 0.9);
    assert.equal(media.focalY, 0.1);
    assert.equal(media.zoom, 2.25);
});

test('PUT com image null remove banner e GET seguinte falha como mídia ausente', async (t) => {
    const db = await fixture(t);
    await route(
        db,
        'PUT',
        ['character', 'profile-media', 'banner'],
        request('PUT', { image: await imageDataUrl() }),
        response(),
    );

    const removeRes = response();
    await route(
        db,
        'PUT',
        ['character', 'profile-media', 'banner'],
        request('PUT', { image: null }),
        removeRes,
    );
    assert.equal(JSON.parse(removeRes.body).removed, true);

    await assert.rejects(
        route(
            db,
            'GET',
            ['character', 'profile-media', 'banner'],
            request('GET'),
            response(),
        ),
        (error) => error?.status === 404 && error?.code === 'profile_media_not_found',
    );
});
