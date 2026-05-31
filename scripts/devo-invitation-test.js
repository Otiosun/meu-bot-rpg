const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { runDevoMigrations } = require('../src/modules/devo/migrations/migrationRunner');
const { createDevoRepositories } = require('../src/modules/devo/repositories');
const { InvitationService } = require('../src/modules/devo/services/InvitationService');
const { handleDevoMessage } = require('../src/modules/devo');

async function main() {
    const tmpDir = path.resolve('./temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const dbPath = path.join(tmpDir, 'devo-invitation-test.sqlite');
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

        const repos = createDevoRepositories(db);
        const invitationService = new InvitationService({ db, repositories: repos });

        console.log('Creating fixtures...');
        const manager = await repos.manager.create({ user_id: 'mgr_user_1', codename: 'mgr1', number: 1, permission_level: 1, active: 1 });
        const recordA = await repos.record.create({ user_id: 'user_a', name: 'Record A', status: 'ativo' });
        const recordB = await repos.record.create({ user_id: 'user_b', name: 'Record B', status: 'ativo' });
        const recordPhone = await repos.record.create({ user_id: '557999999999@s.whatsapp.net', name: 'Phone Record', status: 'ativo' });
        const recordInactive = await repos.record.create({ user_id: 'user_inactive', name: 'Inactive Record', status: 'suspenso' });
        await db.run('INSERT INTO jogadores (id, numero_roll_escolhido) VALUES (?, ?)', ['user_b', 77]);

        const draftVote = await repos.deadlyVote.create({ title: 'Draft Vote', code: 'DRAFT1', status: 'rascunho', max_slots: 5, reserved_slots: 0, created_by_manager_id: manager.id });
        const preparedVote = await repos.deadlyVote.create({ title: 'Prepared Vote', code: 'PREP1', status: 'preparado', max_slots: 5, reserved_slots: 0, created_by_manager_id: manager.id });
        const callingVote = await repos.deadlyVote.create({ title: 'Calling Vote', code: 'CALL1', status: 'convocando', max_slots: 5, reserved_slots: 0, created_by_manager_id: manager.id });
        const multiVote = await repos.deadlyVote.create({ title: 'Multi Vote', code: 'MULTI1', status: 'rascunho', max_slots: 5, reserved_slots: 0, created_by_manager_id: manager.id });
        const inactiveVote = await repos.deadlyVote.create({ title: 'Inactive Vote', code: 'INACTIVE1', status: 'rascunho', max_slots: 5, reserved_slots: 0, created_by_manager_id: manager.id });
        const endedVote = await repos.deadlyVote.create({ title: 'Ended Vote', code: 'END1', status: 'encerrado', max_slots: 5, reserved_slots: 0, created_by_manager_id: manager.id });
        const rollbackVote = await repos.deadlyVote.create({ title: 'Rollback Vote', code: 'ROLLBACK1', status: 'rascunho', max_slots: 5, reserved_slots: 0, created_by_manager_id: manager.id });

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

        async function countInvitations(voteId, recordId) {
            const row = await db.get(
                'SELECT COUNT(*) AS count FROM deadly_vote_invitations WHERE deadly_vote_id = ? AND record_id = ?',
                [voteId, recordId]
            );
            return Number(row?.count || 0);
        }

        async function assertNoParticipants(voteId, label) {
            const rows = await repos.participant.listByDeadlyVoteId(voteId);
            assert.equal(rows.length, 0, label);
        }

        console.log('\n== Test 1: manager invites by recordId ==');
        let reply = await send('mgr_user_1', `#devo dv convocar DRAFT1 ${recordA.id}`);
        console.log('Invite by recordId reply:', reply);
        assertReplyIncludes(reply, 'Novos convites: 1', 'manager should invite by recordId');
        const draftInvitation = await repos.invitation.getByVoteAndRecord(draftVote.id, recordA.id);
        assert.ok(draftInvitation);
        assert.equal(draftInvitation.status, 'pendente');
        assert.equal(draftInvitation.expires_at, null);
        assert.equal((await repos.deadlyVote.getById(draftVote.id)).status, 'convocando');
        assert.equal((await repos.deadlyVote.getById(draftVote.id)).reserved_slots, 0);
        await assertNoParticipants(draftVote.id, 'inviting should not create participants');

        console.log('\n== Test 2: manager invites by userId/JID ==');
        reply = await send('mgr_user_1', '#devo dv convocar PREP1 user_b');
        console.log('Invite by userId reply:', reply);
        assertReplyIncludes(reply, 'Novos convites: 1', 'manager should invite by userId');
        assert.equal(await countInvitations(preparedVote.id, recordB.id), 1);
        assert.equal((await repos.deadlyVote.getById(preparedVote.id)).status, 'convocando');

        console.log('\n== Test 3: manager invites by number ==');
        reply = await send('mgr_user_1', '#devo dv convocar CALL1 77');
        console.log('Invite by number reply:', reply);
        assertReplyIncludes(reply, 'Novos convites: 1', 'manager should invite by number');
        assert.equal(await countInvitations(callingVote.id, recordB.id), 1);
        assert.equal((await repos.deadlyVote.getById(callingVote.id)).status, 'convocando');

        console.log('\n== Test 4: manager invites multiple targets ==');
        reply = await send('mgr_user_1', `#devo dv convocar MULTI1 ${recordA.id} user_b 557999999999`);
        console.log('Invite multiple reply:', reply);
        assertReplyIncludes(reply, 'Novos convites: 3', 'manager should invite multiple targets');
        assert.equal(await countInvitations(multiVote.id, recordA.id), 1);
        assert.equal(await countInvitations(multiVote.id, recordB.id), 1);
        assert.equal(await countInvitations(multiVote.id, recordPhone.id), 1);

        console.log('\n== Test 5: duplicate invitation does not duplicate ==');
        reply = await send('mgr_user_1', `#devo dv convocar DRAFT1 ${recordA.id}`);
        console.log('Duplicate invite reply:', reply);
        assertReplyIncludes(reply, 'Novos convites: 0', 'duplicate should not create a new invitation');
        assertReplyIncludes(reply, 'Duplicados: 1', 'duplicate should be reported');
        assert.equal(await countInvitations(draftVote.id, recordA.id), 1);

        console.log('\n== Test 6: common player cannot invite ==');
        reply = await send('user_a', `#devo dv convocar CALL1 ${recordA.id}`);
        console.log('Player invite denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'player should not invite');

        console.log('\n== Test 7: common player sees only own pending convocations ==');
        reply = await send('user_a', '#devo convocacoes');
        console.log('Player own convocations reply:', reply);
        assertReplyIncludes(reply, 'Convocacoes pendentes:', 'player should see own pending convocations');
        assertReplyIncludes(reply, 'DRAFT1', 'player should see own DRAFT1 invitation');

        console.log('\n== Test 8: common player with explicit target is denied ==');
        reply = await send('user_a', `#devo convocacoes ${recordB.id}`);
        console.log('Player target denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'player should not view target convocations');

        console.log('\n== Test 9: manager sees convocations for another Record ==');
        reply = await send('mgr_user_1', `#devo convocacoes ${recordA.id}`);
        console.log('Manager target convocations reply:', reply);
        assertReplyIncludes(reply, 'Convocacoes pendentes:', 'manager should see target convocations');
        assertReplyIncludes(reply, 'DRAFT1', 'manager should see DRAFT1 invitation');

        console.log('\n== Test 10: rascunho/preparado become convocando and convocando remains ==');
        assert.equal((await repos.deadlyVote.getById(draftVote.id)).status, 'convocando');
        assert.equal((await repos.deadlyVote.getById(preparedVote.id)).status, 'convocando');
        assert.equal((await repos.deadlyVote.getById(callingVote.id)).status, 'convocando');

        console.log('\n== Test 11: closed DV status denies invitation ==');
        reply = await send('mgr_user_1', `#devo dv convocar END1 ${recordA.id}`);
        console.log('Ended vote invite reply:', reply);
        assertReplyIncludes(reply, 'nao aceita convocacoes', 'ended vote should deny invitations');
        assert.equal(await countInvitations(endedVote.id, recordA.id), 0);

        console.log('\n== Test 12: inactive Record is skipped and does not open DV ==');
        reply = await send('mgr_user_1', `#devo dv convocar INACTIVE1 ${recordInactive.id}`);
        console.log('Inactive record reply:', reply);
        assertReplyIncludes(reply, 'Novos convites: 0', 'inactive record should not create invitation');
        assertReplyIncludes(reply, 'Ignorados: 1', 'inactive record should be skipped');
        assert.equal(await countInvitations(inactiveVote.id, recordInactive.id), 0);
        assert.equal((await repos.deadlyVote.getById(inactiveVote.id)).status, 'rascunho');

        console.log('\n== Test 13: reserved_slots and participants remain untouched ==');
        for (const vote of [draftVote, preparedVote, callingVote, multiVote]) {
            const current = await repos.deadlyVote.getById(vote.id);
            assert.equal(current.reserved_slots, 0, `${vote.code} reserved_slots should remain 0`);
            await assertNoParticipants(vote.id, `${vote.code} should have no participants`);
        }

        console.log('\n== Test 14: expires_at remains null ==');
        const allInvitations = await db.all('SELECT * FROM deadly_vote_invitations');
        assert.ok(allInvitations.length > 0);
        for (const invitation of allInvitations) {
            assert.equal(invitation.expires_at, null, `${invitation.id} should not expire yet`);
        }

        console.log('\n== Test 15: transaction rolls back if insert fails ==');
        try {
            await invitationService.createPendingInvitations({
                voteIdOrCode: 'ROLLBACK1',
                targets: [recordPhone.id],
                invitedByManagerId: 'mgr_missing',
                actorUserId: 'mgr_user_1',
            });
            assert.fail('Expected rollback test to fail');
        } catch (err) {
            console.log('Expected rollback failure:', err.message);
        }
        assert.equal(await countInvitations(rollbackVote.id, recordPhone.id), 0);
        assert.equal((await repos.deadlyVote.getById(rollbackVote.id)).status, 'rascunho');
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
