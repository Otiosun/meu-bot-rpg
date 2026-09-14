'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const { once } = require('node:events');
const { registerDatabase, retireDatabase, snapshotDatabaseLifecycle } = require('../helpers/clover/databaseLifecycleGuard');

const originalLoad = Module._load;
let startSiteApiServer;
try {
    Module._load = function(request, parent, isMain) {
        if (request === './siteApiServerLegacy' && parent?.filename.endsWith('siteApiServer.js')) {
            return { startSiteApiServer: (options) => http.createServer(options.testListener) };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    ({ startSiteApiServer } = require('../helpers/clover/siteApiServer'));
} finally { Module._load = originalLoad; }

async function fixture(t, listener) {
    const db = registerDatabase({ closeCalls: 0, async close() { this.closeCalls += 1; } });
    const server = startSiteApiServer({ getDb: () => db, testListener: listener });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    return { db, url: `http://127.0.0.1:${server.address().port}/lease-test` };
}

function request(url) {
    let resolveResponse, rejectResponse;
    const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    const client = http.get(url, resolveResponse);
    client.on('error', rejectResponse);
    return { client, response };
}

test('HTTP lease survives handler return and retirement until response finish, then releases once', async (t) => {
    let heldResponse;
    const { db, url } = await fixture(t, (req, res) => { heldResponse = res; res.write('pending'); });
    const { client, response } = request(url);
    t.after(() => client.destroy());
    const received = await response;
    received.resume();
    const ended = once(received, 'end');
    assert.equal(snapshotDatabaseLifecycle(db).active, 1);
    const retirement = retireDatabase(db, { timeoutMs: 5000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(db.closeCalls, 0);
    heldResponse.end('done');
    await Promise.all([ended, retirement]);
    assert.equal(db.closeCalls, 1);
    assert.equal(snapshotDatabaseLifecycle(db).active, 0);
    assert.deepEqual(snapshotDatabaseLifecycle(db).labels, {});
});

test('client disconnect releases the HTTP lease on close before retirement closes the connection', async (t) => {
    let heldResponse;
    const { db, url } = await fixture(t, (req, res) => { heldResponse = res; res.write('pending'); });
    const { client, response } = request(url);
    t.after(() => client.destroy());
    await response;
    const closed = once(heldResponse, 'close');
    const retirement = retireDatabase(db, { timeoutMs: 5000 });
    assert.equal(db.closeCalls, 0);
    client.destroy();
    await Promise.all([closed, retirement]);
    assert.equal(db.closeCalls, 1);
    assert.equal(snapshotDatabaseLifecycle(db).active, 0);
});

test('retired database refuses new HTTP requests with 503 without calling the handler', async (t) => {
    let calls = 0;
    const { db, url } = await fixture(t, () => { calls += 1; });
    await retireDatabase(db);
    const { client, response } = request(url);
    t.after(() => client.destroy());
    const received = await response;
    received.resume();
    await once(received, 'end');
    assert.equal(received.statusCode, 503);
    assert.equal(calls, 0);
    assert.equal(snapshotDatabaseLifecycle(db).active, 0);
});

test('HTTP error response also releases the connection lease', async (t) => {
    const { db, url } = await fixture(t, () => { throw new Error('synthetic handler failure'); });
    const { client, response } = request(url);
    t.after(() => client.destroy());
    const received = await response;
    received.resume();
    await once(received, 'end');
    assert.equal(received.statusCode, 500);
    assert.equal(snapshotDatabaseLifecycle(db).active, 0);
    await retireDatabase(db);
    assert.equal(db.closeCalls, 1);
});
