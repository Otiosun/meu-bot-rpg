const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { runDevoMigrations } = require('../src/modules/devo/migrations/migrationRunner');
const { createDevoRepositories } = require('../src/modules/devo/repositories');
const { RecordService } = require('../src/modules/devo/services/RecordService');
const { handleDevoMessage } = require('../src/modules/devo');
const {
    getWhatsAppIdentityVariants,
    normalizeWhatsAppUserId,
} = require('../src/modules/devo/rules/whatsappIdentity');

async function main() {
    const tmpDir = path.resolve('./temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const dbPath = path.join(tmpDir, 'devo-identity-test.sqlite');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    console.log('Creating temp DB at', dbPath);
    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec('PRAGMA foreign_keys = ON');

    try {
        console.log('Running migrations...');
        await runDevoMigrations(db, { databasePath: dbPath, backup: false });

        const repos = createDevoRepositories(db);
        const recordService = new RecordService({ db, repositories: { record: repos.record } });

        console.log('Creating fake manager...');
        const manager = await repos.manager.create({
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

        async function countByIdentity(value) {
            const variants = getWhatsAppIdentityVariants(value);
            const placeholders = variants.map(() => '?').join(', ');
            const row = await db.get(
                `SELECT COUNT(*) AS count
                 FROM records
                 WHERE user_id IN (${placeholders})`,
                variants
            );
            return Number(row?.count || 0);
        }

        console.log('\n== Test 1: criar Record com numero cru salva JID canonico ==');
        const phoneRaw = '5579998868223';
        const phoneRawJid = normalizeWhatsAppUserId(phoneRaw);
        let reply = await send('mgr_user_1', `#devo record criar ${phoneRaw} | Raw Phone Record`);
        console.log('Create raw phone reply:', reply);
        assertReplyIncludes(reply, 'Record criado:', 'raw phone should create record');
        let rows = await repos.record.listByUserId(phoneRawJid);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].user_id, `${phoneRaw}@s.whatsapp.net`);
        rows = await repos.record.listByUserId(phoneRaw);
        assert.equal(rows.length, 0);

        console.log('\n== Test 2: criar Record com JID salva JID canonico ==');
        const phoneJid = '5579998868224@s.whatsapp.net';
        reply = await send('mgr_user_1', `#devo record criar ${phoneJid} | Jid Record`);
        console.log('Create JID reply:', reply);
        assertReplyIncludes(reply, 'Record criado:', 'JID should create record');
        rows = await repos.record.listByUserId(phoneJid);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].user_id, phoneJid);

        console.log('\n== Test 3: duplicata bloqueada quando legado cru ja existe ==');
        const legacyPhone = '5579998868225';
        await repos.record.create({ user_id: legacyPhone, name: 'Legacy Raw', status: 'ativo' });
        reply = await send('mgr_user_1', `#devo record criar ${legacyPhone}@s.whatsapp.net | Duplicate Legacy`);
        console.log('Duplicate legacy reply:', reply);
        assertReplyIncludes(reply, 'record already exists for user', 'canonical duplicate should be blocked by raw legacy');
        assert.equal(await countByIdentity(legacyPhone), 1);

        console.log('\n== Test 4: duplicata bloqueada quando JID ja existe ==');
        const existingJidPhone = '5579998868226';
        await repos.record.create({
            user_id: `${existingJidPhone}@s.whatsapp.net`,
            name: 'Existing JID',
            status: 'ativo',
        });
        reply = await send('mgr_user_1', `#devo record criar ${existingJidPhone} | Duplicate JID`);
        console.log('Duplicate JID reply:', reply);
        assertReplyIncludes(reply, 'record already exists for user', 'raw duplicate should be blocked by canonical JID');
        assert.equal(await countByIdentity(existingJidPhone), 1);

        console.log('\n== Test 5: resolve Record legado cru usando JID ==');
        const resolveLegacyPhone = '5579998868227';
        const legacyRecord = await repos.record.create({
            user_id: resolveLegacyPhone,
            name: 'Resolve Legacy',
            status: 'ativo',
        });
        let resolved = await recordService.resolveRecordTarget(`${resolveLegacyPhone}@s.whatsapp.net`);
        assert.equal(resolved?.id, legacyRecord.id);

        console.log('\n== Test 6: resolve Record JID usando numero cru ==');
        const resolveJidPhone = '5579998868228';
        const jidRecord = await repos.record.create({
            user_id: `${resolveJidPhone}@s.whatsapp.net`,
            name: 'Resolve JID',
            status: 'ativo',
        });
        resolved = await recordService.resolveRecordTarget(resolveJidPhone);
        assert.equal(resolved?.id, jidRecord.id);

        console.log('\n== Test 7: #devo tempo sem alvo encontra Record do autor por JID ==');
        const tempoPhone = '5579998868229';
        await repos.record.create({
            user_id: tempoPhone,
            name: 'Legacy Tempo',
            status: 'ativo',
        });
        reply = await send(`${tempoPhone}@s.whatsapp.net`, '#devo tempo');
        console.log('Tempo reply:', reply);
        assertReplyIncludes(reply, 'Tempo de *Legacy Tempo*', 'tempo should resolve author JID to legacy raw record');

        console.log('\n== Test 8: #devo convocacoes sem alvo encontra Record do autor por JID ==');
        const invitePhone = '5579998868230';
        const inviteRecord = await repos.record.create({
            user_id: invitePhone,
            name: 'Legacy Invite',
            status: 'ativo',
        });
        const vote = await repos.deadlyVote.create({
            title: 'Identity Vote',
            code: 'IDENTITY1',
            status: 'convocando',
            max_slots: 1,
            reserved_slots: 0,
            created_by_manager_id: manager.id,
        });
        await repos.invitation.create({
            deadly_vote_id: vote.id,
            record_id: inviteRecord.id,
            status: 'pendente',
            invited_by_manager_id: manager.id,
            expires_at: null,
        });
        reply = await send(`${invitePhone}@s.whatsapp.net`, '#devo convocacoes');
        console.log('Convocacoes reply:', reply);
        assertReplyIncludes(reply, 'Identity Vote', 'convocations should resolve author JID to legacy raw record');

        console.log('\n== Test 9: #devo entrar funciona com Record legado equivalente ao JID ==');
        reply = await send(`${invitePhone}@s.whatsapp.net`, '#devo entrar IDENTITY1');
        console.log('Entrar reply:', reply);
        assertReplyIncludes(reply, 'Entrada confirmada.', 'enter should resolve author JID to legacy raw record');
        const participant = await repos.participant.getByVoteAndRecord(vote.id, inviteRecord.id);
        assert.ok(participant, 'participant should be created');
        assert.equal(participant.status, 'confirmado');

        console.log('\n== Test 10: #devo debug me apenas Owner/Gerente ==');
        reply = await send('mgr_user_1', '#devo debug me');
        console.log('Debug manager reply:', reply);
        assertReplyIncludes(reply, 'Debug Devo: identidade', 'manager should use debug me');
        assertReplyIncludes(reply, 'idJogador bruto: mgr_user_1', 'debug should show raw actor id');
        assertReplyIncludes(reply, 'Manager encontrado:', 'debug should show manager lookup');

        reply = await send(`${invitePhone}@s.whatsapp.net`, '#devo debug me');
        console.log('Debug common reply:', reply);
        assertReplyIncludes(reply, 'Permissao negada', 'common player should not use debug me');

        console.log('Identity test completed successfully.');
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
