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
    const dbPath = path.join(tmpDir, 'devo-cycle-test.sqlite');
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

        async function createInvitation(vote, record, status = 'aceito') {
            return repos.invitation.create({
                deadly_vote_id: vote.id,
                record_id: record.id,
                status,
                invited_by_manager_id: manager.id,
                accepted_at: status === 'aceito' ? '2026-01-01 00:00:00' : null,
                refused_at: status === 'recusado' ? '2026-01-01 00:00:00' : null,
                expires_at: null,
            });
        }

        async function createParticipant(vote, record, { status = 'confirmado', joinedAt = '2026-01-01 00:00:00', resolvedAt = null } = {}) {
            const invitation = await repos.invitation.getByVoteAndRecord(vote.id, record.id)
                || await createInvitation(vote, record, 'aceito');
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

        async function auditCount(type) {
            const row = await db.get('SELECT COUNT(*) AS count FROM audit_logs WHERE action = ?', [type]);
            return Number(row?.count || 0);
        }

        const initialLifeLedgerCount = await lifeLedgerCount();

        console.log('\n== Test 1: manager inicia DV convocando ==');
        const startVote = await createVote({ title: 'Start Vote', code: 'START1', status: 'convocando', reservedSlots: 1 });
        await createParticipant(startVote, recordA);
        let reply = await send('mgr_user_1', '#devo dv iniciar START1');
        console.log('Start reply:', reply);
        assertReplyIncludes(reply, 'Deadly Vote iniciado.', 'manager should start convocando DV');
        let vote = await repos.deadlyVote.getById(startVote.id);
        let participant = await getParticipant(startVote, recordA);
        assert.equal(vote.status, 'em_andamento');
        assert.ok(vote.started_at);
        assert.equal(vote.ended_at, null);
        assert.equal(participant.status, 'ativo');
        assert.equal(await auditCount('devo.dv.start'), 1);

        console.log('\n== Test 2: manager inicia DV lotado ==');
        const fullStartVote = await createVote({ title: 'Full Start Vote', code: 'STARTFULL1', status: 'lotado', maxSlots: 1, reservedSlots: 1 });
        await createParticipant(fullStartVote, recordB);
        reply = await send('mgr_user_1', '#devo dv iniciar STARTFULL1');
        console.log('Full start reply:', reply);
        assertReplyIncludes(reply, 'Deadly Vote iniciado.', 'manager should start lotado DV');
        vote = await repos.deadlyVote.getById(fullStartVote.id);
        participant = await getParticipant(fullStartVote, recordB);
        assert.equal(vote.status, 'em_andamento');
        assert.ok(vote.started_at);
        assert.equal(participant.status, 'ativo');

        console.log('\n== Test 3: player comum nao inicia ==');
        const playerDeniedStartVote = await createVote({ title: 'Player Denied Start', code: 'STARTDENY1', status: 'convocando', reservedSlots: 1 });
        await createParticipant(playerDeniedStartVote, recordA);
        reply = await send('user_a', '#devo dv iniciar STARTDENY1');
        console.log('Player start denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'common player should not start DV');
        vote = await repos.deadlyVote.getById(playerDeniedStartVote.id);
        participant = await getParticipant(playerDeniedStartVote, recordA);
        assert.equal(vote.status, 'convocando');
        assert.equal(vote.started_at, null);
        assert.equal(participant.status, 'confirmado');

        console.log('\n== Test 4: iniciar exige participante confirmado ==');
        const noConfirmedVote = await createVote({ title: 'No Confirmed', code: 'NOCONF1', status: 'convocando', reservedSlots: 0 });
        reply = await send('mgr_user_1', '#devo dv iniciar NOCONF1');
        console.log('No confirmed start reply:', reply);
        assertReplyIncludes(reply, 'pelo menos 1 participante confirmado', 'start should require confirmed participants');
        vote = await repos.deadlyVote.getById(noConfirmedVote.id);
        assert.equal(vote.status, 'convocando');
        assert.equal(vote.started_at, null);

        console.log('\n== Test 5: manager encerra DV em_andamento ==');
        const endVote = await createVote({ title: 'End Vote', code: 'END1', status: 'em_andamento', reservedSlots: 1 });
        await createParticipant(endVote, recordA, { status: 'ativo' });
        reply = await send('mgr_user_1', '#devo dv encerrar END1');
        console.log('End reply:', reply);
        assertReplyIncludes(reply, 'Deadly Vote encerrado.', 'manager should end active DV');
        vote = await repos.deadlyVote.getById(endVote.id);
        participant = await getParticipant(endVote, recordA);
        assert.equal(vote.status, 'resolucao_pendente');
        assert.ok(vote.ended_at);
        assert.equal(participant.status, 'pendente_resolucao');
        assert.equal(await auditCount('devo.dv.end'), 1);

        console.log('\n== Test 6: manager encerra DV iniciado legado ==');
        const legacyEndVote = await createVote({ title: 'Legacy End Vote', code: 'ENDLEGACY1', status: 'iniciado', reservedSlots: 1 });
        await createParticipant(legacyEndVote, recordB, { status: 'ativo' });
        reply = await send('mgr_user_1', '#devo dv encerrar ENDLEGACY1');
        console.log('Legacy end reply:', reply);
        assertReplyIncludes(reply, 'Deadly Vote encerrado.', 'manager should end iniciado DV');
        vote = await repos.deadlyVote.getById(legacyEndVote.id);
        participant = await getParticipant(legacyEndVote, recordB);
        assert.equal(vote.status, 'resolucao_pendente');
        assert.ok(vote.ended_at);
        assert.equal(participant.status, 'pendente_resolucao');

        console.log('\n== Test 7: player comum nao encerra ==');
        const playerDeniedEndVote = await createVote({ title: 'Player Denied End', code: 'ENDDENY1', status: 'em_andamento', reservedSlots: 1 });
        await createParticipant(playerDeniedEndVote, recordA, { status: 'ativo' });
        reply = await send('user_a', '#devo dv encerrar ENDDENY1');
        console.log('Player end denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'common player should not end DV');
        vote = await repos.deadlyVote.getById(playerDeniedEndVote.id);
        participant = await getParticipant(playerDeniedEndVote, recordA);
        assert.equal(vote.status, 'em_andamento');
        assert.equal(vote.ended_at, null);
        assert.equal(participant.status, 'ativo');

        console.log('\n== Test 8: cancelar pre-inicio revoga pendentes e preserva historico ==');
        const cancelStatuses = ['rascunho', 'preparado', 'convocando', 'lotado'];
        for (const status of cancelStatuses) {
            const code = `CANCEL-${status}`.toUpperCase();
            const cancelVote = await createVote({
                title: `Cancel ${status}`,
                code,
                status,
                maxSlots: status === 'lotado' ? 1 : 3,
                reservedSlots: status === 'lotado' ? 1 : 0,
            });
            const pendingInvitation = await createInvitation(cancelVote, recordA, 'pendente');
            const acceptedInvitation = await createInvitation(cancelVote, recordB, 'aceito');
            const refusedInvitation = await createInvitation(cancelVote, recordC, 'recusado');
            await createParticipant(cancelVote, recordB, { status: 'confirmado' });

            reply = await send('mgr_user_1', `#devo dv cancelar ${code}`);
            console.log(`Cancel ${status} reply:`, reply);
            assertReplyIncludes(reply, 'Deadly Vote cancelado.', `${status} should be cancelable`);
            vote = await repos.deadlyVote.getById(cancelVote.id);
            const pending = await repos.invitation.getById(pendingInvitation.id);
            const accepted = await repos.invitation.getById(acceptedInvitation.id);
            const refused = await repos.invitation.getById(refusedInvitation.id);
            participant = await getParticipant(cancelVote, recordB);
            assert.equal(vote.status, 'cancelado');
            assert.ok(vote.ended_at);
            assert.equal(pending.status, 'revogado');
            assert.equal(accepted.status, 'aceito');
            assert.equal(refused.status, 'recusado');
            assert.equal(participant.status, 'confirmado');
        }
        assert.equal(await auditCount('devo.dv.cancel'), cancelStatuses.length);

        console.log('\n== Test 9: cancelar depois de iniciar nega ==');
        const cancelDeniedStatuses = ['iniciado', 'em_andamento', 'resolucao_pendente', 'encerrado', 'cancelado', 'arquivado'];
        for (const status of cancelDeniedStatuses) {
            const code = `CANCEL-DENY-${status}`.toUpperCase().replace(/[^A-Z0-9_-]/g, '-');
            const cancelDeniedVote = await createVote({ title: `Cancel Deny ${status}`, code, status, reservedSlots: 1 });
            const pendingInvitation = await createInvitation(cancelDeniedVote, recordA, 'pendente');
            await createParticipant(cancelDeniedVote, recordB, { status: status === 'em_andamento' ? 'ativo' : 'confirmado' });
            reply = await send('mgr_user_1', `#devo dv cancelar ${code}`);
            console.log(`Cancel denied ${status} reply:`, reply);
            assertReplyIncludes(reply, 'nao pode ser cancelado depois de iniciado', `${status} should deny cancel`);
            vote = await repos.deadlyVote.getById(cancelDeniedVote.id);
            const pending = await repos.invitation.getById(pendingInvitation.id);
            assert.equal(vote.status, status);
            assert.equal(vote.ended_at, null);
            assert.equal(pending.status, 'pendente');
        }

        console.log('\n== Test 10: player comum nao cancela ==');
        const playerDeniedCancelVote = await createVote({ title: 'Player Denied Cancel', code: 'CANCELDENY1', status: 'convocando' });
        const playerDeniedPending = await createInvitation(playerDeniedCancelVote, recordA, 'pendente');
        reply = await send('user_a', '#devo dv cancelar CANCELDENY1');
        console.log('Player cancel denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'common player should not cancel DV');
        vote = await repos.deadlyVote.getById(playerDeniedCancelVote.id);
        const playerPending = await repos.invitation.getById(playerDeniedPending.id);
        assert.equal(vote.status, 'convocando');
        assert.equal(playerPending.status, 'pendente');

        console.log('\n== Test 11: life_ledger nao e alterado ==');
        assert.equal(await lifeLedgerCount(), initialLifeLedgerCount);
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
