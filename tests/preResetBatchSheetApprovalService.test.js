'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    applyPreResetBatchSheetApproval,
    previewPreResetBatchSheetApproval,
} = require('../helpers/clover/preResetBatchSheetApprovalService');

async function fixture(t) {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());
    await db.exec(`
        CREATE TABLE jogadores(id TEXT PRIMARY KEY, personagem_aparencia TEXT, personagem_aparencia_status TEXT);
        CREATE TABLE clover_prereset_characters(player_id TEXT PRIMARY KEY,status TEXT,revision INTEGER,draft_json TEXT,updated_by TEXT,updated_at TEXT,approved_at TEXT);
        CREATE TABLE clover_prereset_sheet_notices(player_id TEXT,revision INTEGER,group_id TEXT,message_id TEXT,decision TEXT,reason TEXT,reviewed_by TEXT,reviewed_at TEXT);
    `);
    const targets = [
        { playerId: 'a@lid', name: 'A' },
        { playerId: 'b@lid', name: 'B' },
    ];
    for (const [index, target] of targets.entries()) {
        await db.run('INSERT INTO jogadores(id) VALUES (?)', [target.playerId]);
        await db.run("INSERT INTO clover_prereset_characters VALUES (?, 'submitted', 2, ?, NULL, NULL, NULL)",
            [target.playerId, JSON.stringify({ name: target.name, appearance: `aparencia-${index}` })]);
        await db.run("INSERT INTO clover_prereset_sheet_notices VALUES (?,2,'group','message-'||?,NULL,NULL,NULL,NULL)", [target.playerId, index]);
    }
    return { db, targets };
}

test('aprova lote atomicamente e repetir nao altera revisoes', async t => {
    const { db, targets } = await fixture(t);
    assert.equal((await previewPreResetBatchSheetApproval(db, { targets })).pending, 2);
    const first = await applyPreResetBatchSheetApproval(db, { targets, actorId: 'owner' });
    assert.equal(first.applied, 2);
    assert.deepEqual(await db.all('SELECT status,revision FROM clover_prereset_characters ORDER BY player_id'), [
        { status: 'approved', revision: 3 }, { status: 'approved', revision: 3 },
    ]);
    const second = await applyPreResetBatchSheetApproval(db, { targets, actorId: 'owner' });
    assert.equal(second.applied, 0);
    assert.equal(second.duplicate, true);
});

test('conflito de aparencia bloqueia o lote inteiro', async t => {
    const { db, targets } = await fixture(t);
    await db.run("INSERT INTO jogadores VALUES ('other','aparencia-0','approved')");
    const preview = await previewPreResetBatchSheetApproval(db, { targets });
    assert.equal(preview.ok, false);
    await assert.rejects(applyPreResetBatchSheetApproval(db, { targets, actorId: 'owner' }), { code: 'approval_preflight_blocked' });
    assert.equal((await db.get("SELECT COUNT(*) total FROM clover_prereset_characters WHERE status='approved'")).total, 0);
});

test('ficha locked ja conta como consolidada e nao e reaberta', async t => {
    const { db, targets } = await fixture(t);
    await db.run("UPDATE clover_prereset_characters SET status='locked' WHERE player_id='a@lid'");
    const preview = await previewPreResetBatchSheetApproval(db, { targets });
    assert.equal(preview.alreadyApproved, 1);
    const result = await applyPreResetBatchSheetApproval(db, { targets, actorId: 'owner' });
    assert.equal(result.applied, 1);
    assert.deepEqual(await db.get("SELECT status,revision FROM clover_prereset_characters WHERE player_id='a@lid'"), {
        status: 'locked', revision: 2,
    });
});
