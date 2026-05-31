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
    const dbPath = path.join(tmpDir, 'devo-dv-test.sqlite');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    console.log('Creating temp DB at', dbPath);
    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec('PRAGMA foreign_keys = ON');

    try {
        console.log('Running migrations...');
        await runDevoMigrations(db, { databasePath: dbPath, backup: false });

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

        console.log('\n== Test 1: manager creates DV with explicit code ==');
        let reply = await send('mgr_user_1', '#devo dv criar First Vote | vagas=3 | codigo=alpha-1');
        console.log('Create explicit reply:', reply);
        assertReplyIncludes(reply, 'Deadly Vote criado:', 'manager should create DV with explicit code');
        assertReplyIncludes(reply, 'Codigo: ALPHA-1', 'explicit code should be normalized');
        const explicitVote = await repos.deadlyVote.getByCode('ALPHA-1');
        assert.ok(explicitVote);
        assert.equal(explicitVote.status, 'rascunho');
        assert.equal(explicitVote.max_slots, 3);
        assert.equal(explicitVote.reserved_slots, 0);
        assert.equal(explicitVote.created_by_manager_id, manager.id);

        console.log('\n== Test 2: manager creates DV without code ==');
        reply = await send('mgr_user_1', '#devo dv criar Generated Vote | vagas=4');
        console.log('Create generated reply:', reply);
        assertReplyIncludes(reply, 'Deadly Vote criado:', 'manager should create DV without explicit code');
        const generatedVote = (await repos.deadlyVote.listVotes({ limit: 10 })).find((vote) => vote.title === 'Generated Vote');
        assert.ok(generatedVote);
        assert.ok(/^DV[A-F0-9]{6}$/.test(generatedVote.code), `unexpected generated code: ${generatedVote.code}`);

        console.log('\n== Test 3: common player cannot create DV ==');
        reply = await send('common_player', '#devo dv criar Player Vote | vagas=2 | codigo=PLAYER1');
        console.log('Player create denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'player should not create DV');
        assert.equal((await repos.deadlyVote.getByCode('PLAYER1')) || null, null);

        console.log('\n== Test 4: common player cannot view DV ==');
        reply = await send('common_player', '#devo dv ver ALPHA-1');
        console.log('Player view denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'player should not view DV');

        console.log('\n== Test 5: common player cannot list DVs ==');
        reply = await send('common_player', '#devo dv listar');
        console.log('Player list denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'player should not list DVs');

        console.log('\n== Test 6: owner without ManagerProfile creates with null manager id ==');
        const ownerUserId = '557998868223@s.whatsapp.net';
        reply = await send(ownerUserId, '#devo dv criar Owner Vote | vagas=5 | codigo=OWNER1');
        console.log('Owner create reply:', reply);
        assertReplyIncludes(reply, 'Deadly Vote criado:', 'owner should create DV without manager profile');
        const ownerVote = await repos.deadlyVote.getByCode('OWNER1');
        assert.ok(ownerVote);
        assert.equal(ownerVote.created_by_manager_id, null);

        console.log('\n== Test 7: manager views DV by id ==');
        reply = await send('mgr_user_1', `#devo dv ver ${explicitVote.id}`);
        console.log('View by id reply:', reply);
        assertReplyIncludes(reply, 'Deadly Vote: *First Vote*', 'manager should view by id');

        console.log('\n== Test 8: manager views DV by code ==');
        reply = await send('mgr_user_1', '#devo dv ver alpha-1');
        console.log('View by code reply:', reply);
        assertReplyIncludes(reply, 'Deadly Vote: *First Vote*', 'manager should view by code');

        console.log('\n== Test 9: manager lists all DVs ==');
        reply = await send('mgr_user_1', '#devo dv listar 10');
        console.log('List all reply:', reply);
        assertReplyIncludes(reply, 'Deadly Votes encontrados:', 'manager should list all DVs');
        assertReplyIncludes(reply, 'First Vote', 'list should include explicit vote');
        assertReplyIncludes(reply, 'Generated Vote', 'list should include generated vote');
        assertReplyIncludes(reply, 'Owner Vote', 'list should include owner vote');

        console.log('\n== Test 10: manager lists DVs by status ==');
        reply = await send('mgr_user_1', '#devo dv listar rascunho 10');
        console.log('List by status reply:', reply);
        assertReplyIncludes(reply, 'Deadly Votes encontrados:', 'manager should list DVs by status');
        assertReplyIncludes(reply, 'rascunho', 'status list should include rascunho DVs');

        console.log('\n== Test 11: missing vagas fails ==');
        reply = await send('mgr_user_1', '#devo dv criar Missing Slots | codigo=NOSLOTS');
        console.log('Missing vagas reply:', reply);
        assertReplyIncludes(reply, 'maxSlots must be an integer >= 1', 'missing vagas should fail');
        assert.equal((await repos.deadlyVote.getByCode('NOSLOTS')) || null, null);

        console.log('\n== Test 12: invalid vagas fails ==');
        reply = await send('mgr_user_1', '#devo dv criar Invalid Slots | vagas=0 | codigo=ZEROSLOTS');
        console.log('Invalid vagas reply:', reply);
        assertReplyIncludes(reply, 'maxSlots must be an integer >= 1', 'invalid vagas should fail');
        assert.equal((await repos.deadlyVote.getByCode('ZEROSLOTS')) || null, null);

        console.log('\n== Test 13: duplicate code fails ==');
        reply = await send('mgr_user_1', '#devo dv criar Duplicate Code | vagas=2 | codigo=alpha-1');
        console.log('Duplicate code reply:', reply);
        assertReplyIncludes(reply, 'deadly vote code already exists', 'duplicate code should fail');
        const duplicateRows = (await repos.deadlyVote.listVotes({ limit: 20 })).filter((vote) => vote.code === 'ALPHA-1');
        assert.equal(duplicateRows.length, 1);
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
