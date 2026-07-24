'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    assertNoLaterRaidProgressEntries,
} = require('../helpers/clover/adminOperationRegistry');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_raid_monthly_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category_key TEXT NOT NULL,
            month_key TEXT NOT NULL,
            scope_type TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            kind TEXT NOT NULL,
            operation_code TEXT DEFAULT NULL
        );
    `);
    return db;
}

function context(db, entryId = 1) {
    return {
        db,
        unit: {
            actionType: 'raid.progress.adjust',
            metadata: {
                scope: {
                    categoryKey: 'saga_pessoal',
                    monthKey: '2026-07',
                    scopeType: 'player',
                    scopeKey: 'player-one',
                },
            },
            after: { entryId },
        },
    };
}

test('undo é permitido quando não existe lançamento posterior no mesmo saldo', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO clover_raid_monthly_ledger
         (category_key, month_key, scope_type, scope_key, kind, operation_code)
         VALUES ('saga_pessoal', '2026-07', 'player', 'player-one', 'adjustment', 'OP-AAAAAA')`
    );

    await assert.doesNotReject(() => assertNoLaterRaidProgressEntries(context(db)));
});

test('undo é bloqueado mesmo quando lançamentos posteriores anulam o saldo entre si', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await db.exec(`
        INSERT INTO clover_raid_monthly_ledger
        (category_key, month_key, scope_type, scope_key, kind, operation_code)
        VALUES
        ('saga_pessoal', '2026-07', 'player', 'player-one', 'adjustment', 'OP-AAAAAA'),
        ('saga_pessoal', '2026-07', 'player', 'player-one', 'adjustment', 'OP-BBBBBB'),
        ('saga_pessoal', '2026-07', 'player', 'player-one', 'adjustment', 'OP-CCCCCC');
    `);

    await assert.rejects(
        () => assertNoLaterRaidProgressEntries(context(db)),
        (error) => {
            assert.equal(error?.code, 'raid_progress_changed_since_apply');
            assert.equal(error?.details?.laterEntryId, 2);
            assert.equal(error?.details?.laterOperationCode, 'OP-BBBBBB');
            return true;
        }
    );
});

test('lançamento posterior de outro escopo não bloqueia o undo', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await db.exec(`
        INSERT INTO clover_raid_monthly_ledger
        (category_key, month_key, scope_type, scope_key, kind, operation_code)
        VALUES
        ('saga_pessoal', '2026-07', 'player', 'player-one', 'adjustment', 'OP-AAAAAA'),
        ('saga_pessoal', '2026-07', 'player', 'player-two', 'adjustment', 'OP-BBBBBB');
    `);

    await assert.doesNotReject(() => assertNoLaterRaidProgressEntries(context(db)));
});
