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
    const dbPath = path.join(tmpDir, 'devo-participant-test.sqlite');
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

        console.log('Creating fixtures...');
        const manager = await repos.manager.create({ user_id: 'mgr_user_1', codename: 'mgr1', number: 1, permission_level: 1, active: 1 });
        const recordA = await repos.record.create({ user_id: 'user_a', name: 'Record A', status: 'ativo' });
        const recordB = await repos.record.create({ user_id: 'user_b', name: 'Record B', status: 'ativo' });
        const recordC = await repos.record.create({ user_id: 'user_c', name: 'Record C', status: 'ativo' });
        const recordD = await repos.record.create({ user_id: 'user_d', name: 'Record D', status: 'ativo' });
        const recordE = await repos.record.create({ user_id: 'user_e', name: 'Record E', status: 'ativo' });
        await db.run('INSERT INTO jogadores (id, numero_roll_escolhido) VALUES (?, ?)', ['user_d', 44]);

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

        async function createVote({ title, code, status = 'convocando', maxSlots = 3, reservedSlots = 1 }) {
            return repos.deadlyVote.create({
                title,
                code,
                status,
                max_slots: maxSlots,
                reserved_slots: reservedSlots,
                created_by_manager_id: manager.id,
            });
        }

        async function createAcceptedInvitation(vote, record) {
            return repos.invitation.create({
                deadly_vote_id: vote.id,
                record_id: record.id,
                status: 'aceito',
                invited_by_manager_id: manager.id,
                accepted_at: '2026-01-01 00:00:00',
                expires_at: null,
            });
        }

        async function createParticipant(vote, record, { status = 'confirmado', joinedAt = '2026-01-01 00:00:00', resolvedAt = null } = {}) {
            const invitation = await createAcceptedInvitation(vote, record);
            const participant = await repos.participant.create({
                deadly_vote_id: vote.id,
                record_id: record.id,
                invitation_id: invitation.id,
                status,
                joined_at: joinedAt,
                resolved_at: resolvedAt,
            });
            return { invitation, participant };
        }

        async function getParticipant(vote, record) {
            return repos.participant.getByVoteAndRecord(vote.id, record.id);
        }

        async function lifeLedgerCount() {
            const row = await db.get('SELECT COUNT(*) AS count FROM life_ledger');
            return Number(row?.count || 0);
        }

        console.log('\n== Test 1: manager lista participantes por id ==');
        const listVote = await createVote({ title: 'List Vote', code: 'LIST1', reservedSlots: 2 });
        const listA = await createParticipant(listVote, recordA);
        const listB = await createParticipant(listVote, recordB, { status: 'removido', resolvedAt: '2026-01-02 00:00:00' });
        let reply = await send('mgr_user_1', `#devo dv participantes ${listVote.id}`);
        console.log('List by id reply:', reply);
        assertReplyIncludes(reply, 'Participantes de *List Vote*', 'manager should list participants by id');
        assertReplyIncludes(reply, listA.participant.id, 'list should include participant id');
        assertReplyIncludes(reply, recordA.id, 'list should include record id');
        assertReplyIncludes(reply, 'Record A', 'list should include record name');

        console.log('\n== Test 2: manager lista participantes por codigo ==');
        reply = await send('mgr_user_1', '#devo dv participantes LIST1');
        console.log('List by code reply:', reply);
        assertReplyIncludes(reply, listB.participant.id, 'list should include second participant by code');
        assertReplyIncludes(reply, 'Record B', 'list should include second record name');

        console.log('\n== Test 3: player comum nao lista ==');
        reply = await send('user_a', '#devo dv participantes LIST1');
        console.log('Player list denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'common player should not list participants');

        console.log('\n== Test 4: listagem mostra campos esperados ==');
        reply = await send('mgr_user_1', '#devo dv participantes LIST1');
        assertReplyIncludes(reply, 'status: confirmado', 'list should show participant status');
        assertReplyIncludes(reply, 'joined_at: 2026-01-01 00:00:00', 'list should show joined_at');
        assertReplyIncludes(reply, 'resolved_at: 2026-01-02 00:00:00', 'list should show resolved_at when present');

        console.log('\n== Test 5: manager remove participante confirmado antes de iniciar ==');
        const removeVote = await createVote({ title: 'Remove Vote', code: 'REMOVE1', status: 'convocando', reservedSlots: 2 });
        const removeFixture = await createParticipant(removeVote, recordC);
        reply = await send('mgr_user_1', '#devo dv remover REMOVE1 user_c');
        console.log('Remove reply:', reply);
        assertReplyIncludes(reply, 'Participante removido.', 'manager should remove confirmed participant');
        let participant = await getParticipant(removeVote, recordC);
        let vote = await repos.deadlyVote.getById(removeVote.id);
        let invitation = await repos.invitation.getById(removeFixture.invitation.id);
        assert.equal(participant.status, 'removido');
        assert.ok(participant.resolved_at);
        assert.equal(vote.reserved_slots, 1);
        assert.equal(vote.status, 'convocando');
        assert.equal(invitation.status, 'aceito');

        console.log('\n== Test 6: reserved_slots nunca fica negativo ==');
        const zeroVote = await createVote({ title: 'Zero Vote', code: 'ZERO1', status: 'preparado', reservedSlots: 0 });
        await createParticipant(zeroVote, recordD);
        reply = await send('mgr_user_1', '#devo dv remover ZERO1 44');
        console.log('Zero slot remove reply:', reply);
        assertReplyIncludes(reply, 'Participante removido.', 'zero slot remove should still remove participant');
        vote = await repos.deadlyVote.getById(zeroVote.id);
        participant = await getParticipant(zeroVote, recordD);
        assert.equal(vote.reserved_slots, 0);
        assert.equal(participant.status, 'removido');

        console.log('\n== Test 7: DV lotado volta para convocando ao remover ==');
        const fullVote = await createVote({ title: 'Full Vote', code: 'FULL1', status: 'lotado', maxSlots: 1, reservedSlots: 1 });
        await createParticipant(fullVote, recordA);
        reply = await send('mgr_user_1', `#devo dv remover FULL1 ${recordA.id}`);
        console.log('Full remove reply:', reply);
        assertReplyIncludes(reply, 'Participante removido.', 'manager should remove from full vote');
        vote = await repos.deadlyVote.getById(fullVote.id);
        assert.equal(vote.reserved_slots, 0);
        assert.equal(vote.status, 'convocando');

        console.log('\n== Test 8: player comum nao remove ==');
        const playerDeniedVote = await createVote({ title: 'Player Denied', code: 'PLAYERDENY1', reservedSlots: 1 });
        await createParticipant(playerDeniedVote, recordA);
        reply = await send('user_a', `#devo dv remover PLAYERDENY1 ${recordA.id}`);
        console.log('Player remove denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'common player should not remove participant');
        vote = await repos.deadlyVote.getById(playerDeniedVote.id);
        participant = await getParticipant(playerDeniedVote, recordA);
        assert.equal(vote.reserved_slots, 1);
        assert.equal(participant.status, 'confirmado');

        console.log('\n== Test 9: remover inexistente falha ==');
        const missingVote = await createVote({ title: 'Missing Participant', code: 'MISSING1', reservedSlots: 1 });
        reply = await send('mgr_user_1', `#devo dv remover MISSING1 ${recordE.id}`);
        console.log('Missing participant reply:', reply);
        assertReplyIncludes(reply, 'Participante nao encontrado', 'missing participant should fail');
        vote = await repos.deadlyVote.getById(missingVote.id);
        assert.equal(vote.reserved_slots, 1);

        console.log('\n== Test 10: remover ja removido nao decrementa de novo ==');
        const alreadyRemovedVote = await createVote({ title: 'Already Removed', code: 'ALREADY1', reservedSlots: 1 });
        await createParticipant(alreadyRemovedVote, recordB, { status: 'removido', resolvedAt: '2026-01-02 00:00:00' });
        reply = await send('mgr_user_1', `#devo dv remover ALREADY1 ${recordB.id}`);
        console.log('Already removed reply:', reply);
        assertReplyIncludes(reply, 'Apenas participantes confirmados', 'already removed participant should not be removed again');
        vote = await repos.deadlyVote.getById(alreadyRemovedVote.id);
        participant = await getParticipant(alreadyRemovedVote, recordB);
        assert.equal(vote.reserved_slots, 1);
        assert.equal(participant.status, 'removido');

        console.log('\n== Test 11: DV iniciado/em andamento/resolucao/encerrado/cancelado/arquivado nega remocao ==');
        const blockedStatuses = ['iniciado', 'em_andamento', 'resolucao_pendente', 'encerrado', 'cancelado', 'arquivado'];
        for (const status of blockedStatuses) {
            const code = `BLOCK-${status}`.toUpperCase().replace(/[^A-Z0-9_-]/g, '-');
            const blockedVote = await createVote({ title: `Blocked ${status}`, code, status, reservedSlots: 1 });
            await createParticipant(blockedVote, recordE);
            reply = await send('mgr_user_1', `#devo dv remover ${code} ${recordE.id}`);
            console.log(`Blocked ${status} reply:`, reply);
            assertReplyIncludes(reply, 'Remocao negada', `${status} should deny removal`);
            vote = await repos.deadlyVote.getById(blockedVote.id);
            participant = await getParticipant(blockedVote, recordE);
            assert.equal(vote.reserved_slots, 1, `${status} should not release slot`);
            assert.equal(participant.status, 'confirmado', `${status} should keep participant confirmed`);
        }

        console.log('\n== Test 12: invitation status e life_ledger nao mudam ==');
        assert.equal(invitation.status, 'aceito');
        assert.equal(await lifeLedgerCount(), 0);
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
