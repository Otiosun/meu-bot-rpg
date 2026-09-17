'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { canManagePlayer } = require('../helpers/clover/commandTargetUtils');

test('central group command authority preserves Owner and WhatsApp admin behavior', async () => {
    let metadataCalls = 0;
    const sock = {
        groupMetadata: async () => {
            metadataCalls += 1;
            return {
                participants: [
                    { lid: 'admin@lid', admin: 'admin' },
                    { id: 'member@s.whatsapp.net', admin: null },
                ],
            };
        },
    };

    assert.equal(await canManagePlayer(sock, 'private@s.whatsapp.net', '557998868223@s.whatsapp.net'), true);
    assert.equal(metadataCalls, 0);
    assert.equal(await canManagePlayer(sock, 'clover@g.us', 'admin@lid'), true);
    assert.equal(await canManagePlayer(sock, 'clover@g.us', 'member@s.whatsapp.net'), false);
    assert.equal(await canManagePlayer(sock, 'private@s.whatsapp.net', 'admin@lid'), false);
    assert.equal(metadataCalls, 2);
});

test('central group command authority fails closed when metadata is unavailable', async () => {
    const sock = {
        groupMetadata: async () => {
            throw new Error('metadata unavailable');
        },
    };

    assert.equal(await canManagePlayer(sock, 'clover@g.us', 'admin@lid'), false);
});

test('spell review scheduler registers a single process-wide timer', () => {
    const previousLifecycle = process.env.CLOVER_LIFECYCLE;
    const previousScheduler = global.__cloverSpellReviewFlowScheduler;
    const previousRuntime = global.runtimeClover;

    process.env.CLOVER_LIFECYCLE = 'CURRENT_WORLD';
    delete global.__cloverSpellReviewFlowScheduler;
    global.runtimeClover = { sockAtivo: null, dbAtivo: null, encerrando: false };

    const { startSpellReviewFlowScheduler } = require('../helpers/clover/spellReviewFlowOrchestrator');
    const first = startSpellReviewFlowScheduler({ intervalMs: 15000 });
    const second = startSpellReviewFlowScheduler({ intervalMs: 15000 });

    try {
        assert.equal(second, first);
        assert.ok(first.timer);
    } finally {
        clearInterval(first.timer);
        if (previousScheduler === undefined) delete global.__cloverSpellReviewFlowScheduler;
        else global.__cloverSpellReviewFlowScheduler = previousScheduler;
        if (previousRuntime === undefined) delete global.runtimeClover;
        else global.runtimeClover = previousRuntime;
        if (previousLifecycle === undefined) delete process.env.CLOVER_LIFECYCLE;
        else process.env.CLOVER_LIFECYCLE = previousLifecycle;
    }
});
