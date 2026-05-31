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
    const dbPath = path.join(tmpDir, 'devo-invitation-response-test.sqlite');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    console.log('Creating temp DB at', dbPath);
    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec('PRAGMA foreign_keys = ON');

    try {
        console.log('Running migrations...');
        await runDevoMigrations(db, { databasePath: dbPath, backup: false });

        const repos = createDevoRepositories(db);

        console.log('Creating fixtures...');
        const manager = await repos.manager.create({ user_id: 'mgr_user_1', codename: 'mgr1', number: 1, permission_level: 1, active: 1 });
        const recordA = await repos.record.create({ user_id: 'user_a', name: 'Record A', status: 'ativo' });
        const recordB = await repos.record.create({ user_id: 'user_b', name: 'Record B', status: 'ativo' });
        const recordC = await repos.record.create({ user_id: 'user_c', name: 'Record C', status: 'ativo' });
        const recordD = await repos.record.create({ user_id: 'user_d', name: 'Record D', status: 'ativo' });

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

        async function createVote({ title, code, status = 'convocando', maxSlots = 2, reservedSlots = 0 }) {
            return repos.deadlyVote.create({
                title,
                code,
                status,
                max_slots: maxSlots,
                reserved_slots: reservedSlots,
                created_by_manager_id: manager.id,
            });
        }

        async function invite(vote, record) {
            return repos.invitation.create({
                deadly_vote_id: vote.id,
                record_id: record.id,
                status: 'pendente',
                invited_by_manager_id: manager.id,
                expires_at: null,
            });
        }

        async function getInvitation(vote, record) {
            return repos.invitation.getByVoteAndRecord(vote.id, record.id);
        }

        async function getParticipant(vote, record) {
            return repos.participant.getByVoteAndRecord(vote.id, record.id);
        }

        async function countParticipants(vote, record) {
            const row = await db.get(
                `SELECT COUNT(*) AS count
                 FROM deadly_vote_participants
                 WHERE deadly_vote_id = ? AND record_id = ?`,
                [vote.id, record.id]
            );
            return Number(row?.count || 0);
        }

        console.log('\n== Test 1: aceitar por codigo ==');
        const acceptCodeVote = await createVote({ title: 'Accept Code', code: 'ACCEPT1' });
        await invite(acceptCodeVote, recordA);
        let reply = await send('user_a', '#devo entrar ACCEPT1');
        console.log('Accept by code reply:', reply);
        assertReplyIncludes(reply, 'Entrada confirmada.', 'player should accept by code');
        let invitation = await getInvitation(acceptCodeVote, recordA);
        let vote = await repos.deadlyVote.getById(acceptCodeVote.id);
        let participant = await getParticipant(acceptCodeVote, recordA);
        assert.equal(invitation.status, 'aceito');
        assert.ok(invitation.accepted_at);
        assert.equal(vote.reserved_slots, 1);
        assert.equal(vote.status, 'convocando');
        assert.ok(participant);
        assert.equal(participant.status, 'confirmado');
        assert.ok(participant.joined_at);

        console.log('\n== Test 2: aceitar por convite id ==');
        const acceptIdVote = await createVote({ title: 'Accept Id', code: 'ACCEPT2' });
        const acceptIdInvitation = await invite(acceptIdVote, recordB);
        reply = await send('user_b', `#devo entrar ${acceptIdInvitation.id}`);
        console.log('Accept by id reply:', reply);
        assertReplyIncludes(reply, 'Entrada confirmada.', 'player should accept by invitation id');
        invitation = await getInvitation(acceptIdVote, recordB);
        participant = await getParticipant(acceptIdVote, recordB);
        assert.equal(invitation.status, 'aceito');
        assert.ok(participant);

        console.log('\n== Test 3: recusar por codigo ==');
        const refuseCodeVote = await createVote({ title: 'Refuse Code', code: 'REFUSE1' });
        await invite(refuseCodeVote, recordA);
        reply = await send('user_a', '#devo recusar REFUSE1');
        console.log('Refuse by code reply:', reply);
        assertReplyIncludes(reply, 'Convocacao recusada.', 'player should refuse by code');
        invitation = await getInvitation(refuseCodeVote, recordA);
        vote = await repos.deadlyVote.getById(refuseCodeVote.id);
        assert.equal(invitation.status, 'recusado');
        assert.ok(invitation.refused_at);
        assert.equal(vote.reserved_slots, 0);
        assert.equal(vote.status, 'convocando');
        assert.equal(await countParticipants(refuseCodeVote, recordA), 0);

        console.log('\n== Test 4: recusar por convite id ==');
        const refuseIdVote = await createVote({ title: 'Refuse Id', code: 'REFUSE2' });
        const refuseIdInvitation = await invite(refuseIdVote, recordB);
        reply = await send('user_b', `#devo recusar ${refuseIdInvitation.id}`);
        console.log('Refuse by id reply:', reply);
        assertReplyIncludes(reply, 'Convocacao recusada.', 'player should refuse by invitation id');
        invitation = await getInvitation(refuseIdVote, recordB);
        assert.equal(invitation.status, 'recusado');
        assert.equal(await countParticipants(refuseIdVote, recordB), 0);

        console.log('\n== Test 5: nao aceitar convite de outro Record ==');
        const otherAcceptVote = await createVote({ title: 'Other Accept', code: 'OTHERACCEPT1' });
        const otherAcceptInvitation = await invite(otherAcceptVote, recordB);
        reply = await send('user_a', `#devo entrar ${otherAcceptInvitation.id}`);
        console.log('Other accept reply:', reply);
        assertReplyIncludes(reply, 'Convite nao pertence ao seu Record.', 'player should not accept another record invitation');
        invitation = await getInvitation(otherAcceptVote, recordB);
        vote = await repos.deadlyVote.getById(otherAcceptVote.id);
        assert.equal(invitation.status, 'pendente');
        assert.equal(vote.reserved_slots, 0);
        assert.equal(await countParticipants(otherAcceptVote, recordB), 0);

        console.log('\n== Test 6: nao recusar convite de outro Record ==');
        const otherRefuseVote = await createVote({ title: 'Other Refuse', code: 'OTHERREFUSE1' });
        const otherRefuseInvitation = await invite(otherRefuseVote, recordB);
        reply = await send('user_a', `#devo recusar ${otherRefuseInvitation.id}`);
        console.log('Other refuse reply:', reply);
        assertReplyIncludes(reply, 'Convite nao pertence ao seu Record.', 'player should not refuse another record invitation');
        invitation = await getInvitation(otherRefuseVote, recordB);
        assert.equal(invitation.status, 'pendente');
        assert.equal(await countParticipants(otherRefuseVote, recordB), 0);

        console.log('\n== Test 7: DV precisa estar convocando para aceitar ==');
        const draftVote = await createVote({ title: 'Draft Deny', code: 'DRAFTDENY1', status: 'rascunho' });
        await invite(draftVote, recordC);
        reply = await send('user_c', '#devo entrar DRAFTDENY1');
        console.log('Draft accept reply:', reply);
        assertReplyIncludes(reply, 'Deadly Vote nao esta convocando.', 'draft DV should deny accept');
        invitation = await getInvitation(draftVote, recordC);
        vote = await repos.deadlyVote.getById(draftVote.id);
        assert.equal(invitation.status, 'pendente');
        assert.equal(vote.reserved_slots, 0);
        assert.equal(await countParticipants(draftVote, recordC), 0);

        console.log('\n== Test 8: ultima vaga nao duplica ==');
        const lastSlotVote = await createVote({ title: 'Last Slot', code: 'LAST1', maxSlots: 1 });
        await invite(lastSlotVote, recordA);
        await invite(lastSlotVote, recordB);
        reply = await send('user_a', '#devo entrar LAST1');
        console.log('Last slot first reply:', reply);
        assertReplyIncludes(reply, 'Entrada confirmada.', 'first player should take last slot');
        vote = await repos.deadlyVote.getById(lastSlotVote.id);
        assert.equal(vote.reserved_slots, 1);
        assert.equal(vote.status, 'lotado');
        assert.ok(await getParticipant(lastSlotVote, recordA));

        reply = await send('user_b', '#devo entrar LAST1');
        console.log('Last slot second reply:', reply);
        assertReplyIncludes(reply, 'Sem vaga disponivel.', 'second player should get no slots');
        invitation = await getInvitation(lastSlotVote, recordB);
        vote = await repos.deadlyVote.getById(lastSlotVote.id);
        assert.equal(invitation.status, 'sem_vaga');
        assert.equal(vote.reserved_slots, 1);
        assert.equal(vote.status, 'lotado');
        assert.equal(await countParticipants(lastSlotVote, recordB), 0);

        console.log('\n== Test 9: rollback preserva invitation e DV se participant falhar ==');
        const rollbackVote = await createVote({ title: 'Rollback', code: 'ROLLBACK1', maxSlots: 1 });
        await invite(rollbackVote, recordD);
        await repos.participant.create({
            deadly_vote_id: rollbackVote.id,
            record_id: recordD.id,
            status: 'confirmado',
        });
        reply = await send('user_d', '#devo entrar ROLLBACK1');
        console.log('Rollback reply:', reply);
        assertReplyIncludes(reply, 'Erro ao entrar:', 'duplicate participant should fail command');
        invitation = await getInvitation(rollbackVote, recordD);
        vote = await repos.deadlyVote.getById(rollbackVote.id);
        assert.equal(invitation.status, 'pendente');
        assert.equal(invitation.accepted_at, null);
        assert.equal(vote.reserved_slots, 0);
        assert.equal(vote.status, 'convocando');
        assert.equal(await countParticipants(rollbackVote, recordD), 1);

        console.log('\n== Test 10: life_ledger nao e alterado ==');
        const lifeLedgerCount = await db.get('SELECT COUNT(*) AS count FROM life_ledger');
        assert.equal(Number(lifeLedgerCount?.count || 0), 0);
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
