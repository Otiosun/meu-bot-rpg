const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { runDevoMigrations } = require('../src/modules/devo/migrations/migrationRunner');
const { createDevoRepositories } = require('../src/modules/devo/repositories');
const { handleDevoMessage } = require('../src/modules/devo');

async function main() {
    const tmpDir = path.resolve('./temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const dbPath = path.join(tmpDir, 'devo-record-test.sqlite');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    console.log('Creating temp DB at', dbPath);
    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec('PRAGMA foreign_keys = ON');

    try {
        console.log('Running migrations...');
        await runDevoMigrations(db, { databasePath: dbPath, backup: false });
        await db.exec(`
            CREATE TABLE IF NOT EXISTS jogadores (
                id TEXT PRIMARY KEY,
                numero_roll_escolhido INTEGER UNIQUE
            );
        `);
        await db.run('INSERT INTO jogadores (id, numero_roll_escolhido) VALUES (?, ?)', ['user_for_record', 77]);
        await db.run('INSERT INTO jogadores (id, numero_roll_escolhido) VALUES (?, ?)', ['other_user_for_record', 88]);

        const repos = createDevoRepositories(db);

        console.log('Creating fake manager...');
        const manager = await repos.manager.create({ user_id: 'mgr_user_1', codename: 'mgr1', number: 1, permission_level: 1, active: 1 });
        console.log('Manager:', manager.id);

        const messages = [];
        const mockSock = {
            sendMessage: async (idChat, message, opts) => {
                messages.push({ idChat, message, opts });
                return { ok: true };
            },
        };

        const baseContext = { sock: mockSock, idChat: 'test-chat', db, m: null, isGroup: false, groupEnabled: true, legacyBcEnabled: false };

        function lastReply() {
            return messages[messages.length - 1]?.message?.text || '';
        }

        async function send(idJogador, texto) {
            await handleDevoMessage({ ...baseContext, idJogador, texto });
            return lastReply();
        }

        function assertReplyIncludes(reply, expected, label) {
            assert.ok(
                reply.includes(expected),
                `${label}\nExpected reply to include: ${expected}\nActual reply: ${reply}`
            );
        }

        console.log('\n== Test 1: manager creates Records for other users ==');
        let reply = await send('mgr_user_1', '#devo record criar user_for_record | Test Record');
        assertReplyIncludes(reply, 'Record criado:', 'manager should create first record');
        const created = (await repos.record.listByUserId('user_for_record')) || [];
        console.log('Records for user_for_record:', created.length, created.map((r) => r.id));
        assert.equal(created.length, 1);
        const record = created[0];

        reply = await send('mgr_user_1', '#devo record criar other_user_for_record | Other Record');
        assertReplyIncludes(reply, 'Record criado:', 'manager should create second record');
        const otherCreated = (await repos.record.listByUserId('other_user_for_record')) || [];
        assert.equal(otherCreated.length, 1);

        console.log('\n== Test 2: duplicate is denied ==');
        reply = await send('mgr_user_1', '#devo record criar user_for_record | Test Record Dup');
        const afterDup = (await repos.record.listByUserId('user_for_record')) || [];
        console.log('Records count after duplicate attempt:', afterDup.length);
        console.log('Last reply:', reply);
        assert.equal(afterDup.length, 1);
        assertReplyIncludes(reply, 'record already exists for user', 'duplicate record should be denied');

        console.log('\n== Test 3: common player sees own Record without target ==');
        reply = await send('user_for_record', '#devo record ver');
        console.log('Last reply (player sees own):', reply);
        assertReplyIncludes(reply, 'Record: *Test Record*', 'player should see own record without target');

        console.log('\n== Test 4: common player using own userId target is denied ==');
        reply = await send('user_for_record', '#devo record ver user_for_record');
        console.log('Last reply (own userId denied):', reply);
        assertReplyIncludes(reply, 'Permiss', 'player should not view with explicit own userId target');

        console.log('\n== Test 5: common player using own number target is denied ==');
        reply = await send('user_for_record', '#devo record ver 77');
        console.log('Last reply (own number denied):', reply);
        assertReplyIncludes(reply, 'Permiss', 'player should not view with explicit own number target');

        console.log('\n== Test 6: common player using other userId target is denied ==');
        reply = await send('user_for_record', '#devo record ver other_user_for_record');
        console.log('Last reply (other userId denied):', reply);
        assertReplyIncludes(reply, 'Permiss', 'player should not view another user target');

        console.log('\n== Test 7: common player trying to list is denied ==');
        reply = await send('user_for_record', '#devo record listar');
        console.log('Last reply (list denied):', reply);
        assertReplyIncludes(reply, 'Permiss', 'player should not list records');

        console.log('\n== Test 8: manager lists Records ==');
        reply = await send('mgr_user_1', '#devo record listar 10');
        console.log('Last reply (manager list):', reply);
        assertReplyIncludes(reply, 'Records encontrados:', 'manager should list records');

        console.log('\n== Test 9: manager views Record by id, userId, and number ==');
        reply = await send('mgr_user_1', `#devo record ver ${record.id}`);
        console.log('View by id reply:', reply);
        assertReplyIncludes(reply, 'Record: *Test Record*', 'manager should view by record id');

        reply = await send('mgr_user_1', '#devo record ver user_for_record');
        console.log('View by userId reply:', reply);
        assertReplyIncludes(reply, 'Record: *Test Record*', 'manager should view by userId');

        reply = await send('mgr_user_1', '#devo record ver 77');
        console.log('View by number reply:', reply);
        assertReplyIncludes(reply, 'Record: *Test Record*', 'manager should view by resolved number');

        console.log('\n== Test 10: manager self-create by resolved number is denied ==');
        reply = await send('mgr_user_1', '#devo record criar 1 | Manager Self Record');
        console.log('Self-create by number reply:', reply);
        const managerRecords = (await repos.record.listByUserId('mgr_user_1')) || [];
        assert.equal(managerRecords.length, 0);
        assertReplyIncludes(reply, 'Auto-cadastro', 'self-create by resolved manager number should be denied');
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
