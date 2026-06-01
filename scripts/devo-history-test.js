const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { runDevoMigrations } = require('../src/modules/devo/migrations/migrationRunner');
const { createDevoRepositories } = require('../src/modules/devo/repositories');
const { createDevoServices } = require('../src/modules/devo/services');
const { handleDevoMessage } = require('../src/modules/devo');

async function main() {
    const tmpDir = path.resolve('./temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const dbPath = path.join(tmpDir, 'devo-history-test.sqlite');
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
        const services = createDevoServices({ db });

        console.log('Creating fixtures...');
        const manager = await repos.manager.create({ user_id: 'mgr_user_1', codename: 'mgr1', number: 1, permission_level: 1, active: 1 });
        const recordA = await repos.record.create({ user_id: 'user_a', name: 'Record A', status: 'ativo' });
        const recordB = await repos.record.create({ user_id: 'user_b', name: 'Record B', status: 'ativo' });
        const recordC = await repos.record.create({ user_id: 'user_c', name: 'Record C', status: 'ativo' });
        await db.run('INSERT INTO jogadores (id, numero_roll_escolhido) VALUES (?, ?)', ['user_a', 31]);

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

        async function countRows(table) {
            const row = await db.get(`SELECT COUNT(*) AS count FROM ${table}`);
            return Number(row?.count || 0);
        }

        function pick(row, keys) {
            const result = {};
            for (const key of keys) result[key] = row?.[key] ?? null;
            return result;
        }

        console.log('\n== Setup: criar DV, convites, entradas, resolucao e vida ==');
        let reply = await send('mgr_user_1', '#devo dv criar History Vote | vagas=2 | codigo=HIST1');
        assertReplyIncludes(reply, 'Deadly Vote criado', 'manager should create history vote');
        reply = await send('mgr_user_1', '#devo dv convocar HIST1 user_a user_b user_c');
        assertReplyIncludes(reply, 'Convocacao processada.', 'manager should invite records');
        reply = await send('user_a', '#devo entrar HIST1');
        assertReplyIncludes(reply, 'Entrada confirmada.', 'record A should accept invitation');
        reply = await send('user_b', '#devo entrar HIST1');
        assertReplyIncludes(reply, 'Entrada confirmada.', 'record B should accept invitation');
        reply = await send('user_c', '#devo recusar HIST1');
        assertReplyIncludes(reply, 'Convocacao recusada.', 'record C should refuse invitation');
        reply = await send('mgr_user_1', '#devo dv iniciar HIST1');
        assertReplyIncludes(reply, 'Deadly Vote iniciado.', 'manager should start vote');
        reply = await send('mgr_user_1', '#devo dv encerrar HIST1');
        assertReplyIncludes(reply, 'Deadly Vote encerrado.', 'manager should end vote');
        reply = await send('mgr_user_1', '#devo dv resolver HIST1 sobrevivente user_a');
        assertReplyIncludes(reply, 'Participante resolvido.', 'manager should resolve survivor');
        reply = await send('mgr_user_1', '#devo dv resolver HIST1 morto user_b');
        assertReplyIncludes(reply, 'Deadly Vote encerrado automaticamente.', 'last resolution should auto-close');
        reply = await send('mgr_user_1', '#devo dv recompensar HIST1 user_a 30m | premio historico');
        assertReplyIncludes(reply, 'Recompensa aplicada.', 'manager should reward survivor');
        reply = await send('mgr_user_1', '#devo dv penalizar HIST1 user_a 10m | custo historico');
        assertReplyIncludes(reply, 'Penalidade aplicada.', 'manager should penalize survivor');

        const historyVote = await repos.deadlyVote.getByCode('HIST1');
        const invitationA = await repos.invitation.getByVoteAndRecord(historyVote.id, recordA.id);
        const participantA = await repos.participant.getByVoteAndRecord(historyVote.id, recordA.id);

        console.log('\n== Setup: DV cancelado para historico de cancelamento ==');
        reply = await send('mgr_user_1', '#devo dv criar Cancel Vote | vagas=1 | codigo=CANCELH1');
        assertReplyIncludes(reply, 'Deadly Vote criado', 'manager should create cancel vote');
        reply = await send('mgr_user_1', '#devo dv convocar CANCELH1 user_c');
        assertReplyIncludes(reply, 'Convocacao processada.', 'manager should invite cancel target');
        reply = await send('mgr_user_1', '#devo dv cancelar CANCELH1');
        assertReplyIncludes(reply, 'Deadly Vote cancelado.', 'manager should cancel vote');

        console.log('\n== Test 1: player comum ve apenas proprio historico ==');
        const auditBeforeSelfHistory = await countRows('audit_logs');
        reply = await send('user_a', '#devo historico');
        console.log('Player history reply:', reply);
        assertReplyIncludes(reply, 'Historico de *Record A*', 'player should see own record history');
        assertReplyIncludes(reply, 'Tempo: recompensa', 'record history should include life ledger reward');
        assertReplyIncludes(reply, 'Tempo: penalidade', 'record history should include life ledger penalty');
        assertReplyIncludes(reply, 'Participacao em Deadly Vote', 'record history should include participation');
        assertReplyIncludes(reply, 'Resultado do Deadly Vote', 'record history should include resolution');
        assertReplyIncludes(reply, 'Entrada confirmada', 'record history should include accepted invitation');
        assertReplyExcludes(reply, 'Record B', 'player history should not show another record');
        assertNoRawPayload(reply, 'record history should not expose raw payload');
        assert.equal(await countRows('audit_logs'), auditBeforeSelfHistory, 'successful record history should not create audit');

        console.log('\n== Test 2: player comum com alvo explicito e negado ==');
        const auditBeforeDeniedTarget = await countRows('audit_logs');
        reply = await send('user_a', '#devo historico user_b');
        console.log('Player target denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'player should not see target history');
        assert.equal(await countRows('audit_logs'), auditBeforeDeniedTarget, 'denied history should not create audit');

        console.log('\n== Test 3: player comum nao ve historico de DV ==');
        const auditBeforeDeniedVote = await countRows('audit_logs');
        reply = await send('user_a', '#devo dv historico HIST1');
        console.log('Player DV history denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'player should not see DV history');
        assert.equal(await countRows('audit_logs'), auditBeforeDeniedVote, 'denied DV history should not create audit');

        console.log('\n== Test 4: manager ve historico de Record alvo ==');
        reply = await send('mgr_user_1', '#devo historico 31');
        console.log('Manager record history reply:', reply);
        assertReplyIncludes(reply, 'Historico de *Record A*', 'manager should see target record history');
        assertReplyIncludes(reply, 'Tempo: recompensa', 'manager record history should include life');
        assertReplyIncludes(reply, 'Resultado do Deadly Vote', 'manager record history should include result');
        assertNoRawPayload(reply, 'manager record history should not expose raw payload');

        console.log('\n== Test 5-11: manager ve historico completo de DV ==');
        const auditBeforeVoteHistory = await countRows('audit_logs');
        const ledgerBeforeVoteHistory = await countRows('life_ledger');
        const stateBefore = {
            vote: pick(await repos.deadlyVote.getById(historyVote.id), ['id', 'status', 'reserved_slots', 'ended_at', 'updated_at']),
            recordA: pick(await repos.record.getById(recordA.id), ['id', 'status', 'life_remaining_seconds', 'life_status', 'updated_at']),
            invitationA: pick(invitationA, ['id', 'status', 'accepted_at', 'refused_at', 'updated_at']),
            participantA: pick(participantA, ['id', 'status', 'joined_at', 'resolved_at', 'updated_at']),
        };

        reply = await send('mgr_user_1', '#devo dv historico HIST1');
        console.log('Manager DV history reply:', reply);
        assertReplyIncludes(reply, 'Historico do Deadly Vote *History Vote*', 'manager should see DV history');
        assertReplyIncludes(reply, 'Deadly Vote criado', 'DV history should include creation');
        assertReplyIncludes(reply, 'Convocacoes registradas', 'DV history should include invitation audit');
        assertReplyIncludes(reply, 'Convite criado', 'DV history should include invitations');
        assertReplyIncludes(reply, 'Entrada confirmada', 'DV history should include accepted entries');
        assertReplyIncludes(reply, 'Convite recusado', 'DV history should include refusals');
        assertReplyIncludes(reply, 'Participante registrado', 'DV history should include participants');
        assertReplyIncludes(reply, 'Deadly Vote iniciado', 'DV history should include start');
        assertReplyIncludes(reply, 'Deadly Vote encerrado para resolucao', 'DV history should include end');
        assertReplyIncludes(reply, 'Participante resolvido', 'DV history should include resolution');
        assertReplyIncludes(reply, 'Tempo: recompensa', 'DV history should include reward ledger');
        assertReplyIncludes(reply, 'Tempo: penalidade', 'DV history should include penalty ledger');
        assertNoRawPayload(reply, 'DV history should not expose raw payload');

        const stateAfter = {
            vote: pick(await repos.deadlyVote.getById(historyVote.id), ['id', 'status', 'reserved_slots', 'ended_at', 'updated_at']),
            recordA: pick(await repos.record.getById(recordA.id), ['id', 'status', 'life_remaining_seconds', 'life_status', 'updated_at']),
            invitationA: pick(await repos.invitation.getById(invitationA.id), ['id', 'status', 'accepted_at', 'refused_at', 'updated_at']),
            participantA: pick(await repos.participant.getById(participantA.id), ['id', 'status', 'joined_at', 'resolved_at', 'updated_at']),
        };
        assert.equal(await countRows('audit_logs'), auditBeforeVoteHistory, 'successful DV history should not create audit');
        assert.equal(await countRows('life_ledger'), ledgerBeforeVoteHistory, 'history query should not create life ledger');
        assert.deepEqual(stateAfter, stateBefore, 'history query should not alter vote, record, invitation or participant');

        console.log('\n== Test 10b: historico de DV cancelado inclui cancelamento ==');
        reply = await send('mgr_user_1', '#devo dv historico CANCELH1');
        console.log('Canceled DV history reply:', reply);
        assertReplyIncludes(reply, 'Deadly Vote cancelado', 'canceled DV history should include cancel event');
        assertReplyIncludes(reply, 'Convite revogado', 'canceled DV history should include revoked invitation');
        assertNoRawPayload(reply, 'canceled DV history should not expose raw payload');

        console.log('\n== Test 16: limite e cap funcionam ==');
        for (let i = 0; i < 60; i += 1) {
            await repos.audit.record({
                actorUserId: 'mgr_user_1',
                actorManagerId: manager.id,
                type: 'devo.dv.invite',
                entityType: 'deadly_vote',
                entityId: historyVote.id,
                payload: { created: [`inv_extra_${i}`], skipped: [], duplicates: [], notFound: [] },
            });
        }
        const capped = await services.audit.getDeadlyVoteHistory({ deadlyVoteId: historyVote.id, limit: 999 });
        assert.ok(capped.items.length <= 50, `history cap should be <= 50, got ${capped.items.length}`);
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
