'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { ensureCharacterBonusSchema } = require('../helpers/clover/characterBonusService');

// Isolate schema ownership from business projections; no runtime database is opened.
const counts = new WeakMap();
const originalLoad = Module._load;
let ensurePhState;
try {
    Module._load = function(request, parent, isMain) {
        if (parent?.filename.endsWith('phService.js') && request === '../../database') {
            return {
                async ensureCloverCharacterStatsSchema(db) { counts.get(db).stats += 1; },
                async ensureCloverPhLedgerSchema(db) { counts.get(db).ledger += 1; },
            };
        }
        if (parent?.filename.endsWith('phService.js') && request === './characterStats') {
            return { ensureCharacterStats: async () => ({ ph_accumulated: 15, ph_available: 15 }) };
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    ({ ensurePhState } = require('../helpers/clover/phService'));
} finally {
    Module._load = originalLoad;
}

test('bonus initialization is shared by concurrent callers, retained, and scoped to each connection', async () => {
    let release;
    let calls = 0;
    const pending = new Promise((resolve) => { release = resolve; });
    const db = { exec: async () => { calls += 1; await pending; } };
    const requests = Array.from({ length: 12 }, () => ensureCharacterBonusSchema(db));
    await Promise.resolve();
    assert.equal(calls, 1);
    release();
    await Promise.all(requests);
    await ensureCharacterBonusSchema(db);
    assert.equal(calls, 1);
    let otherCalls = 0;
    await ensureCharacterBonusSchema({ exec: async () => { otherCalls += 1; } });
    assert.equal(otherCalls, 1);
});

test('a failed bonus initialization reaches all waiters and can be retried', async () => {
    let calls = 0;
    const db = { exec: async () => { if (++calls === 1) throw new Error('initialization failed'); } };
    const result = await Promise.allSettled([ensureCharacterBonusSchema(db), ensureCharacterBonusSchema(db)]);
    assert.deepEqual(result.map((entry) => entry.status), ['rejected', 'rejected']);
    assert.equal(calls, 1);
    await ensureCharacterBonusSchema(db);
    assert.equal(calls, 2);
});

function phConnection(failFirst = false) {
    const state = { stats: 0, ledger: 0, index: 0 };
    const db = {
        async run(sql) {
            if (sql.includes('CREATE UNIQUE INDEX')) {
                state.index += 1;
                await new Promise((resolve) => setImmediate(resolve));
                if (failFirst && state.index === 1) throw new Error('index initialization failed');
            }
            return { changes: 0 };
        },
        async get() { return { ph_accumulated: 15, ph_available: 15 }; },
    };
    counts.set(db, state);
    return { db, state };
}

test('PH initialization is shared and retained per connection without skipping player state', async () => {
    const { db, state } = phConnection();
    await Promise.all(Array.from({ length: 12 }, (_, i) => ensurePhState(db, `player-${i}`)));
    await ensurePhState(db, 'another-player');
    assert.deepEqual(state, { stats: 1, ledger: 1, index: 1 });
    const other = phConnection();
    await ensurePhState(other.db, 'player');
    assert.deepEqual(other.state, { stats: 1, ledger: 1, index: 1 });
});

test('a failed PH initialization is shared and retried on the same connection', async () => {
    const { db, state } = phConnection(true);
    const result = await Promise.allSettled([ensurePhState(db, 'p1'), ensurePhState(db, 'p2')]);
    assert.deepEqual(result.map((entry) => entry.status), ['rejected', 'rejected']);
    await ensurePhState(db, 'p1');
    assert.deepEqual(state, { stats: 2, ledger: 2, index: 2 });
});
