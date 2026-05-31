const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { runDevoMigrations } = require('../src/modules/devo/migrations/migrationRunner');
const { createDevoRepositories } = require('../src/modules/devo/repositories');
const { LifeService } = require('../src/modules/devo/services/LifeService');

async function main() {
    const tmpDir = path.resolve('./temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const dbPath = path.join(tmpDir, 'devo-life-test.sqlite');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    console.log('Creating temp DB at', dbPath);
    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec("PRAGMA foreign_keys = ON");

    console.log('Running migrations...');
    await runDevoMigrations(db, { databasePath: dbPath, backup: false });

    const repos = createDevoRepositories(db);
    const lifeService = new LifeService({ db, repositories: repos });

    console.log('Creating fake manager...');
    const manager = await repos.manager.create({ user_id: 'mgr_user_1', codename: 'mgr1', number: 1, permission_level: 1, active: 1 });
    console.log('Manager:', manager.id);

    console.log('Creating fake record...');
    const record = await repos.record.create({ user_id: 'user_for_record', name: 'Test Record', status: 'ativo' });
    console.log('Record:', record.id);

    console.log('\n== Add 3600s ==');
    const addRes = await lifeService.addLife(record.id, 3600, 'initial grant', { managerId: manager.id, actorUserId: 'user_for_record', type: 'ganho' });
    console.log('Add result:', addRes);

    console.log('\n== Subtract 1200s ==');
    const subRes = await lifeService.subtractLife(record.id, 1200, 'penalty', { managerId: manager.id, actorUserId: 'user_for_record', type: 'penalidade' });
    console.log('Subtract result:', subRes);

    console.log('\n== Attempt invalid operation (missing manager) to verify rollback ==');
    const beforeLedger = (await repos.lifeLedger.listByRecordId(record.id)) || [];
    console.log('Ledger count before invalid op:', beforeLedger.length);
    try {
        await lifeService.addLife(record.id, 100, 'should fail', { managerId: 'mgr_nonexistent', actorUserId: 'user_for_record', type: 'ganho' });
        console.log('Unexpected: invalid op succeeded');
    } catch (err) {
        console.log('Expected failure:', err.message);
    }
    const afterLedger = (await repos.lifeLedger.listByRecordId(record.id)) || [];
    console.log('Ledger count after invalid op:', afterLedger.length);

    if (afterLedger.length !== beforeLedger.length) {
        console.error('Rollback failed: ledger count changed');
    } else {
        console.log('Rollback confirmed: ledger unchanged');
    }

    console.log('\nFinal life summary:');
    const summary = await lifeService.getLifeSummary(record.id, 10);
    console.log(JSON.stringify(summary, null, 2));

    await db.close();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
