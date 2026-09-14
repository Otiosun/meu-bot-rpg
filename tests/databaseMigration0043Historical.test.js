'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const database = require('../database');
const { CURRENT_SCHEMA_MIGRATIONS } = require('../helpers/clover/schemaMigrationPlan');
const { migrationChecksum } = require('../helpers/clover/schemaMigrationService');
const { RETURN_POINT_SHOP_AUTH_MIGRATION } = require('../helpers/clover/returnPointShopAuthMigration');

const HISTORICAL_CHECKSUM = 'eb472ea201df03af8c881c9a94d2bfb3c4da11a554f8d2fc1c6338d54a9eb814';

test('0043 preserves original applied checksum and pins checkout line endings', () => {
    assert.equal(migrationChecksum(RETURN_POINT_SHOP_AUTH_MIGRATION), HISTORICAL_CHECKSUM);
    const filename = 'helpers/clover/returnPointShopAuthMigration.js';
    const root = path.resolve(__dirname, '..');
    assert.match(execFileSync('git', ['check-attr', 'eol', '--', filename], { cwd:root, encoding:'utf8' }), /: eol: lf/);
    assert.ok(!fs.readFileSync(path.join(root, filename), 'utf8').includes('\r'));
});

test('historical 43 upgrades to latest without replacing its ledger, then reopens safely', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-0043-history-'));
    const filename = path.join(dir, 'copy.sqlite');
    let db;
    t.after(async () => {
        if (db) await db.close();
        fs.rmSync(dir, { recursive:true, force:true });
    });
    db = await database.criarBanco({ filename, migrations:CURRENT_SCHEMA_MIGRATIONS.filter(m => m.version <= 43) });
    const historical = await db.get('SELECT * FROM clover_schema_migrations WHERE version=43');
    assert.equal(historical.checksum, HISTORICAL_CHECKSUM);
    await db.close();
    db = null;
    for (let initialization = 0; initialization < 2; initialization++) {
        db = await database.criarBanco({ filename });
        assert.deepEqual(await db.get('SELECT * FROM clover_schema_migrations WHERE version=43'), historical);
        assert.equal((await db.get('PRAGMA user_version')).user_version, Math.max(...CURRENT_SCHEMA_MIGRATIONS.map(m => m.version)));
        assert.equal((await db.get('PRAGMA quick_check')).quick_check, 'ok');
        assert.deepEqual(await db.all('PRAGMA foreign_key_check'), []);
        await db.close();
        db = null;
    }
});
