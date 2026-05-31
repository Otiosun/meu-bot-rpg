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
    const dbPath = path.join(tmpDir, 'devo-resolution-test.sqlite');
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
        const recordF = await repos.record.create({ user_id: 'user_f', name: 'Record F', status: 'morto' });
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

        async function createVote({ title, code, status = 'resolucao_pendente', maxSlots = 3, reservedSlots = 1, endedAt = '2026-01-01 00:00:00' }) {
            return repos.deadlyVote.create({
                title,
                code,
                status,
                max_slots: maxSlots,
                reserved_slots: reservedSlots,
                created_by_manager_id: manager.id,
                started_at: '2026-01-01 00:00:00',
                ended_at: endedAt,
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

        async function createParticipant(vote, record, { status = 'pendente_resolucao', joinedAt = '2026-01-01 00:00:00', resolvedAt = null } = {}) {
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

        async function auditCount(type) {
            const row = await db.get('SELECT COUNT(*) AS count FROM audit_logs WHERE action = ?', [type]);
            return Number(row?.count || 0);
        }

        const initialLifeLedgerCount = await lifeLedgerCount();

        console.log('\n== Test 1: manager resolve sobrevivente e mantem DV pendente com outro participante ==');
        const survivorVote = await createVote({ title: 'Survivor Vote', code: 'SURVIVE1', reservedSlots: 2 });
        const survivorFixture = await createParticipant(survivorVote, recordA);
        await createParticipant(survivorVote, recordB);
        let reply = await send('mgr_user_1', '#devo dv resolver SURVIVE1 sobrevivente user_a');
        console.log('Survivor reply:', reply);
        assertReplyIncludes(reply, 'Participante resolvido.', 'manager should resolve survivor');
        assertReplyIncludes(reply, 'Status: pendente_resolucao -> sobrevivente', 'participant should become survivor');
        let vote = await repos.deadlyVote.getById(survivorVote.id);
        let participant = await getParticipant(survivorVote, recordA);
        let record = await repos.record.getById(recordA.id);
        let invitation = await repos.invitation.getById(survivorFixture.invitation.id);
        assert.equal(participant.status, 'sobrevivente');
        assert.ok(participant.resolved_at);
        assert.equal(record.status, 'ativo');
        assert.equal(vote.status, 'resolucao_pendente');
        assert.equal(invitation.status, 'aceito');
        assert.ok(await repos.participant.getById(participant.id), 'participant should not be deleted');
        assert.ok(await repos.record.getById(recordA.id), 'record should not be deleted');

        console.log('\n== Test 2: manager resolve morto e auto-encerra ultimo pendente ==');
        const deadVote = await createVote({ title: 'Dead Vote', code: 'DEAD1', reservedSlots: 1, endedAt: '2026-02-01 00:00:00' });
        const deadFixture = await createParticipant(deadVote, recordC);
        reply = await send('mgr_user_1', `#devo dv resolver DEAD1 morto ${recordC.id}`);
        console.log('Dead reply:', reply);
        assertReplyIncludes(reply, 'Participante resolvido.', 'manager should resolve dead participant');
        assertReplyIncludes(reply, 'Deadly Vote encerrado automaticamente.', 'last pending should close DV');
        vote = await repos.deadlyVote.getById(deadVote.id);
        participant = await getParticipant(deadVote, recordC);
        record = await repos.record.getById(recordC.id);
        invitation = await repos.invitation.getById(deadFixture.invitation.id);
        assert.equal(participant.status, 'morto');
        assert.ok(participant.resolved_at);
        assert.equal(record.status, 'morto');
        assert.equal(vote.status, 'encerrado');
        assert.equal(vote.ended_at, '2026-02-01 00:00:00');
        assert.equal(invitation.status, 'aceito');

        console.log('\n== Test 3: manager resolve desistente por numero e auto-encerra ==');
        const quitterVote = await createVote({ title: 'Quitter Vote', code: 'QUIT1', reservedSlots: 1, endedAt: null });
        const quitterFixture = await createParticipant(quitterVote, recordD);
        reply = await send('mgr_user_1', '#devo dv resolver QUIT1 desistente 44');
        console.log('Quitter reply:', reply);
        assertReplyIncludes(reply, 'Participante resolvido.', 'manager should resolve quitter');
        vote = await repos.deadlyVote.getById(quitterVote.id);
        participant = await getParticipant(quitterVote, recordD);
        record = await repos.record.getById(recordD.id);
        invitation = await repos.invitation.getById(quitterFixture.invitation.id);
        assert.equal(participant.status, 'desistente');
        assert.ok(participant.resolved_at);
        assert.equal(record.status, 'ativo');
        assert.equal(vote.status, 'encerrado');
        assert.ok(vote.ended_at);
        assert.equal(invitation.status, 'aceito');

        console.log('\n== Test 4: player comum nao resolve ==');
        const playerDeniedVote = await createVote({ title: 'Player Denied', code: 'PLAYERDENY1', reservedSlots: 1 });
        await createParticipant(playerDeniedVote, recordE);
        reply = await send('user_e', '#devo dv resolver PLAYERDENY1 sobrevivente user_e');
        console.log('Player denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'common player should not resolve');
        vote = await repos.deadlyVote.getById(playerDeniedVote.id);
        participant = await getParticipant(playerDeniedVote, recordE);
        assert.equal(vote.status, 'resolucao_pendente');
        assert.equal(participant.status, 'pendente_resolucao');
        assert.equal(participant.resolved_at, null);

        console.log('\n== Test 5: DV precisa estar resolucao_pendente ==');
        const blockedVoteStatuses = ['rascunho', 'preparado', 'convocando', 'lotado', 'iniciado', 'em_andamento', 'encerrado', 'cancelado', 'arquivado'];
        for (const status of blockedVoteStatuses) {
            const code = `RES-DV-${status}`.toUpperCase().replace(/[^A-Z0-9_-]/g, '-');
            const blockedVote = await createVote({ title: `Blocked ${status}`, code, status, reservedSlots: 1 });
            const blockedRecord = await repos.record.create({ user_id: `blocked_${status}`, name: `Blocked ${status}`, status: 'ativo' });
            await createParticipant(blockedVote, blockedRecord);
            reply = await send('mgr_user_1', `#devo dv resolver ${code} sobrevivente ${blockedRecord.id}`);
            console.log(`Blocked DV ${status} reply:`, reply);
            assertReplyIncludes(reply, 'precisa estar em resolucao_pendente', `${status} should deny resolution`);
            vote = await repos.deadlyVote.getById(blockedVote.id);
            participant = await getParticipant(blockedVote, blockedRecord);
            assert.equal(vote.status, status);
            assert.equal(participant.status, 'pendente_resolucao');
        }

        console.log('\n== Test 6: participant precisa estar pendente_resolucao ==');
        const blockedParticipantStatuses = ['confirmado', 'ativo', 'sobrevivente', 'morto', 'removido', 'desistente'];
        for (const status of blockedParticipantStatuses) {
            const code = `RES-PART-${status}`.toUpperCase().replace(/[^A-Z0-9_-]/g, '-');
            const blockedVote = await createVote({ title: `Blocked participant ${status}`, code, reservedSlots: 1 });
            const blockedRecord = await repos.record.create({ user_id: `blocked_participant_${status}`, name: `Blocked Participant ${status}`, status: 'ativo' });
            await createParticipant(blockedVote, blockedRecord, {
                status,
                resolvedAt: ['sobrevivente', 'morto', 'removido', 'desistente'].includes(status) ? '2026-01-02 00:00:00' : null,
            });
            reply = await send('mgr_user_1', `#devo dv resolver ${code} sobrevivente ${blockedRecord.id}`);
            console.log(`Blocked participant ${status} reply:`, reply);
            assertReplyIncludes(reply, 'Apenas participantes pendente_resolucao', `${status} should deny resolution`);
            vote = await repos.deadlyVote.getById(blockedVote.id);
            participant = await getParticipant(blockedVote, blockedRecord);
            assert.equal(vote.status, 'resolucao_pendente');
            assert.equal(participant.status, status);
        }

        console.log('\n== Test 7: resolver participant ja resolvido falha sem fechar DV ==');
        const alreadyResolvedVote = await createVote({ title: 'Already Resolved', code: 'ALREADYRES1', reservedSlots: 2 });
        const alreadyResolvedRecord = await repos.record.create({ user_id: 'already_resolved_user', name: 'Already Resolved', status: 'ativo' });
        const stillPendingRecord = await repos.record.create({ user_id: 'still_pending_user', name: 'Still Pending', status: 'ativo' });
        await createParticipant(alreadyResolvedVote, alreadyResolvedRecord, { status: 'sobrevivente', resolvedAt: '2026-01-02 00:00:00' });
        await createParticipant(alreadyResolvedVote, stillPendingRecord);
        reply = await send('mgr_user_1', `#devo dv resolver ALREADYRES1 sobrevivente ${alreadyResolvedRecord.id}`);
        console.log('Already resolved reply:', reply);
        assertReplyIncludes(reply, 'Apenas participantes pendente_resolucao', 'already resolved participant should fail');
        vote = await repos.deadlyVote.getById(alreadyResolvedVote.id);
        participant = await getParticipant(alreadyResolvedVote, alreadyResolvedRecord);
        assert.equal(vote.status, 'resolucao_pendente');
        assert.equal(participant.status, 'sobrevivente');

        console.log('\n== Test 8: tentar matar Record ja morto falha e rollback preserva participant ==');
        const alreadyDeadVote = await createVote({ title: 'Already Dead', code: 'ALREADYDEAD1', reservedSlots: 1 });
        await createParticipant(alreadyDeadVote, recordF);
        reply = await send('mgr_user_1', `#devo dv resolver ALREADYDEAD1 morto ${recordF.id}`);
        console.log('Already dead reply:', reply);
        assertReplyIncludes(reply, 'Record ja esta morto', 'dead record should fail');
        vote = await repos.deadlyVote.getById(alreadyDeadVote.id);
        participant = await getParticipant(alreadyDeadVote, recordF);
        record = await repos.record.getById(recordF.id);
        assert.equal(vote.status, 'resolucao_pendente');
        assert.equal(participant.status, 'pendente_resolucao');
        assert.equal(participant.resolved_at, null);
        assert.equal(record.status, 'morto');

        console.log('\n== Test 9: audit, invitation e life_ledger preservados ==');
        assert.equal(await auditCount('devo.dv.participant.resolve'), 3);
        assert.equal(await lifeLedgerCount(), initialLifeLedgerCount);
        const ledgerTypes = await db.all('SELECT type FROM life_ledger WHERE type IN (?, ?)', ['recompensa', 'penalidade']);
        assert.equal(ledgerTypes.length, 0);
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
