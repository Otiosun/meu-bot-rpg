'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let transferHandled = false;
let transferError = null;
let legacyCalls = 0;
let capturedServer = null;

const fakeHttp = {
    createServer(listener) {
        capturedServer = { listener };
        return capturedServer;
    },
};
const originalCreateServer = fakeHttp.createServer;

const legacy = {
    legacyExport: true,
    startSiteApiServer(options) {
        const server = fakeHttp.createServer((req, res) => {
            legacyCalls += 1;
            res.legacy = options.marker;
        });
        return server;
    },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'http') return fakeHttp;
    if (request === './siteApiServerLegacy') return legacy;
    if (request === './squadMembershipTransferHttp') {
        return {
            async handleSquadMembershipTransferHttp(req, res) {
                if (transferError) throw transferError;
                if (transferHandled) {
                    res.transfer = true;
                    return true;
                }
                return false;
            },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const wrapper = require('../helpers/clover/siteApiServer');
Module._load = originalLoad;

function reset() {
    transferHandled = false;
    transferError = null;
    legacyCalls = 0;
    capturedServer = null;
    fakeHttp.createServer = originalCreateServer;
}

test('wrapper preserva exportações legadas e restaura createServer', () => {
    reset();
    const server = wrapper.startSiteApiServer({ marker: 'legacy' });
    assert.equal(server, capturedServer);
    assert.equal(wrapper.legacyExport, true);
    assert.equal(fakeHttp.createServer, originalCreateServer);
});

test('rota não interceptada continua no listener legado', async () => {
    reset();
    const server = wrapper.startSiteApiServer({ marker: 'kept' });
    const res = { headersSent: false, setHeader() {}, end() {} };
    server.listener({ url: '/old-route' }, res);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(legacyCalls, 1);
    assert.equal(res.legacy, 'kept');
    assert.equal(res.transfer, undefined);
});

test('rota interceptada não executa o listener legado', async () => {
    reset();
    transferHandled = true;
    const server = wrapper.startSiteApiServer({ marker: 'legacy' });
    const res = { headersSent: false, setHeader() {}, end() {} };
    server.listener({ url: '/transfer' }, res);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(res.transfer, true);
    assert.equal(legacyCalls, 0);
});
