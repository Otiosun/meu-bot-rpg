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
    const dbPath = path.join(tmpDir, 'devo-mvp-smoke-test.sqlite');
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

        console.log('Creating fake manager...');
        await repos.manager.create({
            user_id: 'mgr_user_1',
            codename: 'mgr1',
            number: 1,
            permission_level: 1,
            active: 1,
        });

        const messages = [];
        const mockSock = {
            sendMessage: async (idChat, message, opts) => {
                messages.push({ idChat, message, opts });
                return { ok: true };
            },
        };
        const baseContext = {
            sock: mockSock,
            idChat: 'test-chat',
            db,
            m: null,
            isGroup: false,
            groupEnabled: true,
            legacyBcEnabled: false,
        };

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

        function assertReplyExcludes(reply, unexpected, label) {
            assert.ok(
                !reply.includes(unexpected),
                `${label}\nExpected reply not to include: ${unexpected}\nActual reply: ${reply}`
            );
        }

        function assertNoRawPayload(reply, label) {
            assertReplyExcludes(reply, 'payload_json', label);
            assertReplyExcludes(reply, 'ledgerId', label);
            assertReplyExcludes(reply, 'previousRemaining', label);
            assertReplyExcludes(reply, '"deadlyVoteId"', label);
            assertReplyExcludes(reply, '{', label);
        }

        async function countRows(table, where = '', params = []) {
            const sql = `SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`;
            const row = await db.get(sql, params);
            return Number(row?.count || 0);
        }

        async function getRecord(userId) {
            const rows = await repos.record.listByUserId(userId);
            return rows[0] || null;
        }

        async function auditCount(action) {
            return countRows('audit_logs', 'action = ?', [action]);
        }

        console.log('\n== Step 1-3: criar Records pelo comando ==');
        let reply = await send('mgr_user_1', '#devo record criar user_a | Record A');
        console.log('Create Record A:', reply);
        assertReplyIncludes(reply, 'Record criado', 'manager should create record A');
        reply = await send('mgr_user_1', '#devo record criar user_b | Record B');
        assertReplyIncludes(reply, 'Record criado', 'manager should create record B');
        reply = await send('mgr_user_1', '#devo record criar user_c | Record C');
        assertReplyIncludes(reply, 'Record criado', 'manager should create record C');

        const recordA = await getRecord('user_a');
        const recordB = await getRecord('user_b');
        const recordC = await getRecord('user_c');
        assert.ok(recordA, 'record A should exist');
        assert.ok(recordB, 'record B should exist');
        assert.ok(recordC, 'record C should exist');

        console.log('\n== Step 4-6: criar DV, convocar e consultar convocacoes ==');
        reply = await send('mgr_user_1', '#devo dv criar Smoke Vote | vagas=2 | codigo=SMOKE1');
        console.log('Create DV:', reply);
        assertReplyIncludes(reply, 'Deadly Vote criado', 'manager should create DV');
        reply = await send('mgr_user_1', '#devo dv convocar SMOKE1 user_a user_b user_c');
        console.log('Invite records:', reply);
        assertReplyIncludes(reply, 'Convocacao processada.', 'manager should invite records');
        assertReplyIncludes(reply, 'Novos convites: 3', 'three invitations should be created');

        let vote = await repos.deadlyVote.getByCode('SMOKE1');
        assert.equal(vote.status, 'convocando');
        assert.equal(vote.max_slots, 2);
        assert.equal(vote.reserved_slots, 0);

        reply = await send('user_a', '#devo convocacoes');
        console.log('Player A convocacoes:', reply);
        assertReplyIncludes(reply, 'Convocacoes pendentes:', 'player should see pending invitation');
        assertReplyIncludes(reply, 'Smoke Vote', 'convocations should mention smoke vote');

        console.log('\n== Step 7-9: entrar, recusar e verificar estado ==');
        reply = await send('user_a', '#devo entrar SMOKE1');
        console.log('Player A enter:', reply);
        assertReplyIncludes(reply, 'Entrada confirmada.', 'record A should enter');
        reply = await send('user_b', '#devo recusar SMOKE1');
        console.log('Player B refuse:', reply);
        assertReplyIncludes(reply, 'Convocacao recusada.', 'record B should refuse');

        const invitationA = await repos.invitation.getByVoteAndRecord(vote.id, recordA.id);
        const invitationB = await repos.invitation.getByVoteAndRecord(vote.id, recordB.id);
        const participantA = await repos.participant.getByVoteAndRecord(vote.id, recordA.id);
        vote = await repos.deadlyVote.getById(vote.id);
        assert.equal(invitationA.status, 'aceito');
        assert.equal(invitationB.status, 'recusado');
        assert.ok(participantA, 'accepted record should become participant');
        assert.equal(participantA.status, 'confirmado');
        assert.equal(vote.reserved_slots, 1);

        console.log('\n== Protection: player comum nao executa comando de Gerente ==');
        reply = await send('user_a', '#devo dv iniciar SMOKE1');
        console.log('Player start denied:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'common player should not start DV');
        vote = await repos.deadlyVote.getById(vote.id);
        assert.equal(vote.status, 'convocando');

        console.log('\n== Step 10-14: listar, iniciar e encerrar DV ==');
        reply = await send('mgr_user_1', '#devo dv participantes SMOKE1');
        console.log('Participants list:', reply);
        assertReplyIncludes(reply, 'Participantes de *Smoke Vote*', 'manager should list participants');
        assertReplyIncludes(reply, 'status: confirmado', 'participant should be confirmed before start');

        reply = await send('mgr_user_1', '#devo dv iniciar SMOKE1');
        console.log('Start DV:', reply);
        assertReplyIncludes(reply, 'Deadly Vote iniciado.', 'manager should start DV');
        vote = await repos.deadlyVote.getById(vote.id);
        let participantAfterStart = await repos.participant.getByVoteAndRecord(vote.id, recordA.id);
        assert.equal(vote.status, 'em_andamento');
        assert.equal(participantAfterStart.status, 'ativo');

        reply = await send('mgr_user_1', '#devo dv encerrar SMOKE1');
        console.log('End DV:', reply);
        assertReplyIncludes(reply, 'Deadly Vote encerrado.', 'manager should end DV');
        vote = await repos.deadlyVote.getById(vote.id);
        let participantAfterEnd = await repos.participant.getByVoteAndRecord(vote.id, recordA.id);
        assert.equal(vote.status, 'resolucao_pendente');
        assert.equal(participantAfterEnd.status, 'pendente_resolucao');

        console.log('\n== Step 15-16: resolver participante e auto-encerrar DV ==');
        reply = await send('mgr_user_1', '#devo dv resolver SMOKE1 sobrevivente user_a');
        console.log('Resolve participant:', reply);
        assertReplyIncludes(reply, 'Participante resolvido.', 'manager should resolve participant');
        assertReplyIncludes(reply, 'Deadly Vote encerrado automaticamente.', 'last participant should close DV');
        vote = await repos.deadlyVote.getById(vote.id);
        const participantResolved = await repos.participant.getByVoteAndRecord(vote.id, recordA.id);
        assert.equal(participantResolved.status, 'sobrevivente');
        assert.ok(participantResolved.resolved_at);
        assert.equal(vote.status, 'encerrado');

        console.log('\n== Step 17-20: recompensa, tempo e historicos ==');
        const ledgerBeforeReward = await countRows('life_ledger');
        reply = await send('mgr_user_1', '#devo dv recompensar SMOKE1 user_a 30m | recompensa smoke');
        console.log('DV reward:', reply);
        assertReplyIncludes(reply, 'Recompensa aplicada.', 'manager should apply DV reward');
        const ledgerRows = await repos.lifeLedger.listByRecordId(recordA.id);
        const rewardLedger = ledgerRows.find((row) => row.reason === 'recompensa smoke');
        assert.ok(rewardLedger, 'reward ledger should exist');
        assert.equal(rewardLedger.deadly_vote_id, vote.id);
        assert.equal(rewardLedger.type, 'recompensa');
        assert.equal(rewardLedger.amount_seconds, 1800);
        assert.equal(await countRows('life_ledger'), ledgerBeforeReward + 1);

        const recordAfterReward = await repos.record.getById(recordA.id);
        assert.equal(recordAfterReward.status, 'ativo');
        assert.equal(recordAfterReward.life_remaining_seconds, 1800);
        assert.equal(recordAfterReward.life_status, 'ativo');

        reply = await send('user_a', '#devo tempo');
        console.log('Player time:', reply);
        assertReplyIncludes(reply, 'Tempo de *Record A*', 'player should consult own time');
        assertReplyIncludes(reply, 'Restante: 30m', 'time should reflect reward');

        reply = await send('user_a', '#devo historico');
        console.log('Player history:', reply);
        assertReplyIncludes(reply, 'Historico de *Record A*', 'player should see own history');
        assertReplyIncludes(reply, 'Tempo: recompensa', 'record history should include reward');
        assertReplyIncludes(reply, 'Participacao em Deadly Vote', 'record history should include participation');
        assertReplyIncludes(reply, 'Resultado do Deadly Vote', 'record history should include resolution');
        assertNoRawPayload(reply, 'record history should hide raw payload');

        reply = await send('mgr_user_1', '#devo dv historico SMOKE1');
        console.log('DV history:', reply);
        assertReplyIncludes(reply, 'Historico do Deadly Vote *Smoke Vote*', 'manager should see DV history');
        assertReplyIncludes(reply, 'Convite criado', 'DV history should include invitations');
        assertReplyIncludes(reply, 'Entrada confirmada', 'DV history should include accepted entry');
        assertReplyIncludes(reply, 'Convite recusado', 'DV history should include refusal');
        assertReplyIncludes(reply, 'Deadly Vote iniciado', 'DV history should include start');
        assertReplyIncludes(reply, 'Deadly Vote encerrado para resolucao', 'DV history should include end');
        assertReplyIncludes(reply, 'Participante resolvido', 'DV history should include resolution');
        assertReplyIncludes(reply, 'Tempo: recompensa', 'DV history should include reward');
        assertNoRawPayload(reply, 'DV history should hide raw payload');

        console.log('\n== Step 21: auditoria central e consistencia final ==');
        assert.ok(await auditCount('devo.record.create') >= 3, 'record create audit should exist');
        assert.equal(await auditCount('devo.dv.create'), 1, 'DV create audit should exist');
        assert.equal(await auditCount('devo.dv.invite'), 1, 'DV invite audit should exist');
        assert.equal(await auditCount('devo.invitation.accept'), 1, 'invitation accept audit should exist');
        assert.equal(await auditCount('devo.invitation.refuse'), 1, 'invitation refuse audit should exist');
        assert.equal(await auditCount('devo.dv.start'), 1, 'DV start audit should exist');
        assert.equal(await auditCount('devo.dv.end'), 1, 'DV end audit should exist');
        assert.equal(await auditCount('devo.dv.participant.resolve'), 1, 'participant resolve audit should exist');
        assert.equal(await auditCount('devo.life.add'), 1, 'life reward audit should exist');

        const invitationC = await repos.invitation.getByVoteAndRecord(vote.id, recordC.id);
        const finalParticipantB = await repos.participant.getByVoteAndRecord(vote.id, recordB.id);
        const finalParticipantC = await repos.participant.getByVoteAndRecord(vote.id, recordC.id);
        assert.equal(invitationC.status, 'pendente');
        assert.ok(!finalParticipantB, 'refused record should not become participant');
        assert.ok(!finalParticipantC, 'pending invitation should not become participant');
        assert.equal(await countRows('deadly_votes'), 1);
        assert.equal(await countRows('records'), 3);
        assert.equal(await countRows('deadly_vote_participants'), 1);
        assert.equal(await countRows('life_ledger'), 1);

        console.log('MVP smoke test completed successfully.');
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
