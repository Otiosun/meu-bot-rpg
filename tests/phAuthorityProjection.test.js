'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { ensureCloverCharacterStatsSchema, ensureCloverPhLedgerSchema } = require('../database/legacy');
const { addPh, ensurePhState, recalculatePh } = require('../helpers/clover/phService');

test('PH summary is rebuilt from immutable ledger history without rewriting that history', async () => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    try {
        await db.exec("CREATE TABLE jogadores (id TEXT PRIMARY KEY, dinheiro INTEGER DEFAULT 0)");
        await db.run("INSERT INTO jogadores (id) VALUES ('ph-authority@s.whatsapp.net')");
        await ensureCloverCharacterStatsSchema(db);
        await ensureCloverPhLedgerSchema(db);
        await ensurePhState(db, 'ph-authority@s.whatsapp.net');
        await addPh(db, 'ph-authority@s.whatsapp.net', 17, 'authority_test', 'teste', 'system');
        const beforeLedger = await db.all('SELECT id, amount, kind, source, reason, related_id, created_by, metadata_json FROM clover_ph_ledger ORDER BY id');
        await db.run("UPDATE clover_character_stats SET ph_accumulated = 999, ph_available = 999 WHERE player_id = 'ph-authority@s.whatsapp.net'");
        const summary = await recalculatePh(db, 'ph-authority@s.whatsapp.net');
        const afterLedger = await db.all('SELECT id, amount, kind, source, reason, related_id, created_by, metadata_json FROM clover_ph_ledger ORDER BY id');
        assert.deepEqual(afterLedger, beforeLedger);
        assert.equal(summary.phAccumulated, 32);
        assert.equal(summary.phAvailable, 32);
    } finally {
        await db.close();
    }
});
