'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    PREVIEW_PATH,
    handleCharacterPresentationPreview,
} = require('../helpers/clover/characterPresentationPreviewHttp');

function request(method = 'GET', path = PREVIEW_PATH, token = 'safe-token') {
    return {
        method,
        url: path,
        headers: token ? { authorization: `Bearer ${token}`, origin: 'https://example.test' } : {},
    };
}

function response() {
    const headers = new Map();
    return {
        statusCode: 200,
        body: '',
        ended: false,
        setHeader(name, value) {
            headers.set(String(name).toLowerCase(), String(value));
        },
        getHeader(name) {
            return headers.get(String(name).toLowerCase());
        },
        end(body = '') {
            this.body = String(body || '');
            this.ended = true;
        },
    };
}

function payload(res) {
    return res.body ? JSON.parse(res.body) : null;
}

test('ignora caminhos fora da rota de prévia', async () => {
    const res = response();
    const handled = await handleCharacterPresentationPreview(
        request('GET', '/character'),
        res,
        {}
    );
    assert.equal(handled, false);
    assert.equal(res.ended, false);
});

test('exige sessão válida antes de consultar a ficha', async () => {
    const res = response();
    let resolved = false;
    const handled = await handleCharacterPresentationPreview(
        request('GET', PREVIEW_PATH, ''),
        res,
        {
            getDb: () => ({}),
            authenticateSession: async () => ({ ok: false, reason: 'invalid_token' }),
            presentationPreview: async () => {
                resolved = true;
                return {};
            },
        }
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 401);
    assert.equal(payload(res).error, 'invalid_token');
    assert.equal(resolved, false);
    assert.equal(res.getHeader('cache-control'), 'private, no-store, max-age=0');
});

test('retorna somente a própria prévia em modo leitura', async () => {
    const res = response();
    let received = null;
    const handled = await handleCharacterPresentationPreview(
        request(),
        res,
        {
            getDb: () => ({ kind: 'db' }),
            authenticateSession: async (db, token) => {
                assert.equal(db.kind, 'db');
                assert.equal(token, 'safe-token');
                return { ok: true, player: { id: 'PLAYER-PRIVATE' } };
            },
            presentationPreview: async (db, playerId, options) => {
                received = { db, playerId, options };
                return {
                    presentation: {
                        schemaVersion: 'character-presentation.v1',
                        audience: 'player',
                        identity: { name: 'Personagem de Teste' },
                    },
                    comparison: {
                        version: 'character-presentation-comparison.v1',
                        readOnly: true,
                    },
                };
            },
        }
    );

    const body = payload(res);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.preview, true);
    assert.equal(body.readOnly, true);
    assert.equal(body.presentation.audience, 'player');
    assert.equal(body.comparison.readOnly, true);
    assert.equal(received.playerId, 'PLAYER-PRIVATE');
    assert.deepEqual(received.options, {
        audience: 'player',
        includeTechnical: false,
    });
    assert.equal(res.getHeader('x-clover-preview'), 'character-presentation.v1');
    assert.equal(res.getHeader('cache-control'), 'private, no-store, max-age=0');
});

test('bloqueia escrita e não autentica uma requisição POST', async () => {
    const res = response();
    let authenticated = false;
    const handled = await handleCharacterPresentationPreview(
        request('POST'),
        res,
        {
            getDb: () => ({}),
            authenticateSession: async () => {
                authenticated = true;
                return { ok: true, player: { id: 'PLAYER' } };
            },
        }
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 405);
    assert.equal(payload(res).error, 'method_not_allowed');
    assert.equal(authenticated, false);
});

test('sanitiza falha interna do gerador de prévia', async () => {
    const res = response();
    await handleCharacterPresentationPreview(request(), res, {
        getDb: () => ({}),
        authenticateSession: async () => ({ ok: true, player: { id: 'PLAYER' } }),
        presentationPreview: async () => {
            throw new Error('SQLITE_PRIVATE_PATH');
        },
    });

    assert.equal(res.statusCode, 500);
    assert.equal(payload(res).error, 'presentation_preview_failed');
    assert.equal(payload(res).message, 'Não foi possível gerar a prévia da ficha.');
    assert.doesNotMatch(res.body, /SQLITE_PRIVATE_PATH/);
});
