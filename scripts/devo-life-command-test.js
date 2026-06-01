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
    const dbPath = path.join(tmpDir, 'devo-life-command-test.sqlite');
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
        const deadRecord = await repos.record.create({ user_id: 'user_dead', name: 'Dead Record', status: 'morto' });
        await db.run('INSERT INTO jogadores (id, numero_roll_escolhido) VALUES (?, ?)', ['user_b', 44]);

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

        async function ledgerRows(recordId) {
            return repos.lifeLedger.listByRecordId(recordId);
        }

        async function auditCount(action) {
            const row = await db.get('SELECT COUNT(*) AS count FROM audit_logs WHERE action = ?', [action]);
            return Number(row?.count || 0);
        }

        async function createVote({ title, code, status = 'encerrado' }) {
            return repos.deadlyVote.create({
                title,
                code,
                status,
                max_slots: 3,
                reserved_slots: 1,
                created_by_manager_id: manager.id,
                started_at: '2026-01-01 00:00:00',
                ended_at: '2026-01-01 01:00:00',
            });
        }

        async function createParticipant(vote, record) {
            return repos.participant.create({
                deadly_vote_id: vote.id,
                record_id: record.id,
                status: 'sobrevivente',
                joined_at: '2026-01-01 00:00:00',
                resolved_at: '2026-01-01 01:00:00',
            });
        }

        console.log('\n== Test 1: player comum usa #devo tempo e ve proprio Record ==');
        let reply = await send('user_a', '#devo tempo');
        console.log('Self time reply:', reply);
        assertReplyIncludes(reply, 'Tempo de *Record A*', 'player should see own time');
        assertReplyIncludes(reply, 'Restante: 0m', 'summary should show remaining time');

        console.log('\n== Test 2: player comum usa #devo tempo <alvo> e e negado ==');
        reply = await send('user_a', '#devo tempo user_b');
        console.log('Target time denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'player should not see target time');

        console.log('\n== Test 3: manager usa #devo tempo <alvo> ==');
        reply = await send('mgr_user_1', '#devo tempo 44');
        console.log('Manager target time reply:', reply);
        assertReplyIncludes(reply, 'Tempo de *Record B*', 'manager should see target time');

        console.log('\n== Test 4/5: manager usa life dar com tempo valido e motivo ==');
        const addAuditBefore = await auditCount('devo.life.add');
        reply = await send('mgr_user_1', '#devo life dar user_a 30m | premio inicial');
        console.log('Life add reply:', reply);
        assertReplyIncludes(reply, 'Tempo concedido.', 'manager should add life');
        let record = await repos.record.getById(recordA.id);
        let rows = await ledgerRows(recordA.id);
        let row = rows.find((item) => item.reason === 'premio inicial');
        assert.equal(record.life_remaining_seconds, 1800);
        assert.equal(record.life_status, 'ativo');
        assert.equal(row.type, 'recompensa');
        assert.equal(row.amount_seconds, 1800);
        assert.equal(await auditCount('devo.life.add'), addAuditBefore + 1);

        console.log('\n== Test 6/7: manager usa life tirar com tempo valido e motivo ==');
        const subAuditBefore = await auditCount('devo.life.subtract');
        reply = await send('mgr_user_1', '#devo life tirar user_a 10m | custo narrativo');
        console.log('Life subtract reply:', reply);
        assertReplyIncludes(reply, 'Tempo removido.', 'manager should subtract life');
        record = await repos.record.getById(recordA.id);
        rows = await ledgerRows(recordA.id);
        row = rows.find((item) => item.reason === 'custo narrativo');
        assert.equal(record.life_remaining_seconds, 1200);
        assert.equal(record.life_status, 'ativo');
        assert.equal(row.type, 'penalidade');
        assert.equal(row.amount_seconds, 600);
        assert.equal(await auditCount('devo.life.subtract'), subAuditBefore + 1);

        console.log('\n== Test 8: motivo ausente falha ==');
        const ledgerBeforeMissingReason = (await ledgerRows(recordA.id)).length;
        reply = await send('mgr_user_1', '#devo life dar user_a 30m');
        console.log('Missing reason reply:', reply);
        assertReplyIncludes(reply, 'Motivo e obrigatorio', 'missing reason should show usage');
        assert.equal((await ledgerRows(recordA.id)).length, ledgerBeforeMissingReason);

        console.log('\n== Test 9: tempo invalido falha ==');
        const invalidDurations = ['0m', '-1h', '1.5h', '1h30m', 'abc'];
        const ledgerBeforeInvalid = (await ledgerRows(recordA.id)).length;
        for (const duration of invalidDurations) {
            reply = await send('mgr_user_1', `#devo life dar user_a ${duration} | tempo invalido`);
            console.log(`Invalid ${duration} reply:`, reply);
            assertReplyIncludes(reply, 'Tempo invalido', `${duration} should be rejected`);
        }
        assert.equal((await ledgerRows(recordA.id)).length, ledgerBeforeInvalid);

        console.log('\n== Test 10: life tirar ate zero deixa life_status esgotado ==');
        reply = await send('mgr_user_1', '#devo life dar user_b 20m | preparar teste zero');
        assertReplyIncludes(reply, 'Tempo concedido.', 'should add setup life');
        reply = await send('mgr_user_1', '#devo life tirar user_b 20m | zerar vida');
        console.log('Zero life reply:', reply);
        assertReplyIncludes(reply, 'Tempo removido.', 'should subtract to zero');
        record = await repos.record.getById(recordB.id);
        assert.equal(record.life_remaining_seconds, 0);
        assert.equal(record.life_status, 'esgotado');

        console.log('\n== Test 11/12: dv recompensar/penalizar exigem participant no DV ==');
        const noParticipantVote = await createVote({ title: 'No Participant', code: 'NOPART1' });
        const ledgerBeforeNoParticipant = (await ledgerRows(recordD.id)).length;
        reply = await send('mgr_user_1', '#devo dv recompensar NOPART1 user_d 1h | sem participacao');
        console.log('DV reward no participant reply:', reply);
        assertReplyIncludes(reply, 'Record nao participou', 'reward should require participant');
        reply = await send('mgr_user_1', '#devo dv penalizar NOPART1 user_d 1h | sem participacao');
        console.log('DV penalty no participant reply:', reply);
        assertReplyIncludes(reply, 'Record nao participou', 'penalty should require participant');
        assert.equal((await ledgerRows(recordD.id)).length, ledgerBeforeNoParticipant);

        console.log('\n== Test 13: dv recompensar cria ledger com deadly_vote_id ==');
        const rewardVote = await createVote({ title: 'Reward Vote', code: 'REWARD1' });
        await createParticipant(rewardVote, recordC);
        reply = await send('mgr_user_1', '#devo dv recompensar REWARD1 user_c 2h | recompensa do DV');
        console.log('DV reward reply:', reply);
        assertReplyIncludes(reply, 'Recompensa aplicada.', 'dv reward should add life');
        rows = await ledgerRows(recordC.id);
        row = rows.find((item) => item.reason === 'recompensa do DV');
        assert.equal(row.type, 'recompensa');
        assert.equal(row.deadly_vote_id, rewardVote.id);
        assert.equal(row.amount_seconds, 7200);

        console.log('\n== Test 14: dv penalizar cria ledger com deadly_vote_id ==');
        reply = await send('mgr_user_1', '#devo dv penalizar REWARD1 user_c 30m | penalidade do DV');
        console.log('DV penalty reply:', reply);
        assertReplyIncludes(reply, 'Penalidade aplicada.', 'dv penalty should subtract life');
        rows = await ledgerRows(recordC.id);
        row = rows.find((item) => item.reason === 'penalidade do DV');
        assert.equal(row.type, 'penalidade');
        assert.equal(row.deadly_vote_id, rewardVote.id);
        assert.equal(row.amount_seconds, 1800);

        console.log('\n== Test 15: player comum nao usa life dar/tirar ==');
        reply = await send('user_a', '#devo life dar user_a 1h | tentativa player');
        console.log('Player add denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'player should not add life');
        reply = await send('user_a', '#devo life tirar user_a 1h | tentativa player');
        console.log('Player subtract denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'player should not subtract life');

        console.log('\n== Test 16: player comum nao usa dv recompensar/penalizar ==');
        reply = await send('user_c', '#devo dv recompensar REWARD1 user_c 1h | tentativa player');
        console.log('Player dv reward denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'player should not dv reward');
        reply = await send('user_c', '#devo dv penalizar REWARD1 user_c 1h | tentativa player');
        console.log('Player dv penalty denied reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'player should not dv penalize');

        console.log('\n== Test 17: Record morto nao recebe alteracao ==');
        const deadRowsBefore = (await ledgerRows(deadRecord.id)).length;
        reply = await send('mgr_user_1', '#devo life dar user_dead 1h | nao deveria');
        console.log('Dead record add reply:', reply);
        assertReplyIncludes(reply, 'record is morto', 'dead record should be blocked by LifeService');
        record = await repos.record.getById(deadRecord.id);
        assert.equal(record.life_remaining_seconds, 0);
        assert.equal((await ledgerRows(deadRecord.id)).length, deadRowsBefore);
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
