'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
    authorizeItemMediaUpload,
    parseRoute,
} = require('../helpers/clover/adminMediaHttp');
const { AdminMediaError } = require('../helpers/clover/adminMediaService');

function request(headers = {}) {
    const req = Readable.from([]);
    req.headers = headers;
    return req;
}

test('media routes only recognize item upload and canonical MEDIA ids', () => {
    assert.deepEqual(parseRoute('/admin/media/items'), { kind: 'upload-item' });
    assert.deepEqual(parseRoute('/media/MEDIA-ABCDEF0123456789ABCDEF01'), {
        kind: 'read',
        assetId: 'MEDIA-ABCDEF0123456789ABCDEF01',
    });
    assert.equal(parseRoute('/media/../../secret'), null);
    assert.equal(parseRoute('/admin/media'), null);
});

test('item media upload requires canonical catalog.manage.items capability', async () => {
    await assert.rejects(
        () => authorizeItemMediaUpload(
            {},
            request({ authorization: 'Bearer test' }),
            {
                authenticateSession: async () => ({ ok: true, player: { id: 'admin@test' } }),
                accessResolver: async () => ({
                    ok: true,
                    actor: { id: 'admin@test', capabilities: ['catalog.view'] },
                }),
            }
        ),
        (error) => (
            error instanceof AdminMediaError
            && error.code === 'missing_capability'
            && error.status === 403
        )
    );
});

test('item media upload accepts actor with item catalog management', async () => {
    const actor = await authorizeItemMediaUpload(
        {},
        request({ authorization: 'Bearer test' }),
        {
            authenticateSession: async () => ({ ok: true, player: { id: 'admin@test' } }),
            accessResolver: async () => ({
                ok: true,
                actor: {
                    id: 'admin@test',
                    displayName: 'ADM',
                    capabilities: ['catalog.view', 'catalog.manage.items'],
                },
            }),
        }
    );

    assert.equal(actor.id, 'admin@test');
});

test('invalid session fails before any capability decision', async () => {
    await assert.rejects(
        () => authorizeItemMediaUpload(
            {},
            request(),
            {
                authenticateSession: async () => ({ ok: false, reason: 'invalid_session' }),
            }
        ),
        (error) => error instanceof AdminMediaError && error.status === 401
    );
});
