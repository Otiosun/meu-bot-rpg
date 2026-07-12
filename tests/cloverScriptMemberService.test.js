const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const { ensureTargetResolverTables } = require('../helpers/clover/targetResolverSchemaGuard');
const { ensureTargetResolverSchema } = require('../helpers/clover/targetResolver');
const {
    applyMemberSimulation,
    createMemberSimulation,
    looksLikeMemberScript,
    parseMemberScript,
    shouldHandleMemberApply,
} = require('../helpers/clover/cloverScriptMemberService');
const { resolveCommand } = require('../helpers/commandRegistry');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            ficha_status TEXT DEFAULT 'aprovada',
            historia_status TEXT DEFAULT 'aprovada',
            personagem_aparencia_status TEXT DEFAULT 'approved',
            jogo_status TEXT DEFAULT 'liberado',
            esquadrao TEXT DEFAULT '-',
            canonical_player_id TEXT DEFAULT NULL,
            merged_into TEXT DEFAULT NULL,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active'
        );

        CREATE TABLE clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE clover_spell_review_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL,
            requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
            called_at TEXT DEFAULT NULL,
            closed_at TEXT DEFAULT NULL,
            closed_by TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL
        );
    `);
    await ensureTargetResolverTables(db);
    await ensureTargetResolverSchema(db);
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome)
         VALUES ('player@lid', 'Nilo', 'Nilo', 'Arthur Pendragon')`
    );
    await db.run(
        `INSERT INTO clover_settings (key, value)
         VALUES ('clover_community_group_jid', 'community@g.us')`
    );
    return db;
}

function script(group = 'comunidade', sync = 'auto') {
    return [
        'LOTE id="member-test" nome="Member test" modo=rigido',
        '',
        'ALVO id="player@lid" confirmar=true',
        `MEMBRO remover grupo=${group} sincronizar=${sync} motivo="Saída administrativa" confirmar=true`,
        'FIM',
    ].join('\n');
}

function presentSock() {
    const calls = [];
    return {
        calls,
        groupMetadata: async (groupId) => ({
            id: groupId,
            subject: 'Comunidade Clover',
            participants: [{ id: 'player@lid' }],
        }),
        groupParticipantsUpdate: async (groupId, participants, action) => {
            calls.push({ groupId, participants, action });
            return [{ status: '200', jid: participants[0] }];
        },
    };
}

test('reconhece e analisa MEMBRO remover protegido', () => {
    assert.equal(looksLikeMemberScript(script()), true);
    const parsed = parseMemberScript(script());
    assert.equal(parsed.kind, 'member_remove');
    assert.equal(parsed.action.groupKey, 'community');
    assert.equal(parsed.action.sync, 'auto');
});

test('recusa ausência de confirmação e grupo desconhecido', () => {
    const noConfirm = [
        'ALVO id="player@lid"',
        'MEMBRO remover grupo=comunidade motivo="Teste"',
        'FIM',
    ].join('\n');
    assert.throws(
        () => parseMemberScript(noConfirm),
        (error) => error.code === 'missing_confirm'
    );

    const badGroup = [
        'ALVO id="player@lid" confirmar=true',
        'MEMBRO remover grupo=aleatorio motivo="Teste" confirmar=true',
        'FIM',
    ].join('\n');
    assert.throws(
        () => parseMemberScript(badGroup),
        (error) => error.code === 'invalid_group'
    );
});

test('simula sem remover e aplica com auditoria e sincronização da comunidade', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const sock = presentSock();

    const simulation = await createMemberSimulation(db, script(), {
        actorId: OWNER,
        chatId: 'admin@g.us',
        sock,
    });

    assert.equal(simulation.ok, true);
    assert.match(simulation.code, /^CSM-/);
    assert.match(simulation.text, /nada foi aplicado/i);
    assert.equal(sock.calls.length, 0);

    assert.equal(await shouldHandleMemberApply(db, {
        code: simulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
    }), true);

    const applied = await applyMemberSimulation(db, {
        code: simulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
        sock,
    });

    assert.equal(applied.ok, true);
    assert.equal(sock.calls.length, 1);
    assert.deepEqual(sock.calls[0], {
        groupId: 'community@g.us',
        participants: ['player@lid'],
        action: 'remove',
    });
    assert.match(applied.operation.operation_code, /^MO-/);

    const activity = await db.get(
        'SELECT community_status FROM clover_antighost_activity WHERE player_id = ?',
        ['player@lid']
    );
    assert.equal(activity.community_status, 'out');

    const run = await db.get('SELECT status FROM clover_script_runs WHERE code = ?', [simulation.code]);
    assert.equal(run.status, 'applied');
    const action = await db.get('SELECT action_type, status FROM clover_script_actions WHERE run_id = ?', [simulation.runId]);
    assert.equal(action.action_type, 'member_remove');
    assert.equal(action.status, 'applied');
});

test('finaliza como já ausente sem repetir chamada externa', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const sock = {
        calls: [],
        groupMetadata: async () => ({ subject: 'Comunidade Clover', participants: [] }),
        groupParticipantsUpdate: async (...args) => {
            sock.calls.push(args);
            throw new Error('não deveria chamar');
        },
    };

    const simulation = await createMemberSimulation(db, script('comunidade', 'nenhum'), {
        actorId: OWNER,
        chatId: 'admin@g.us',
        sock,
    });
    const applied = await applyMemberSimulation(db, {
        code: simulation.code,
        actorId: OWNER,
        chatId: 'admin@g.us',
        sock,
    });

    assert.equal(applied.ok, true);
    assert.equal(sock.calls.length, 0);
    assert.equal(applied.external.alreadyAbsent, true);
});

test('bloqueia aplicação quando o grupo configurado mudou após a simulação', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const sock = presentSock();
    const simulation = await createMemberSimulation(db, script(), {
        actorId: OWNER,
        chatId: 'admin@g.us',
        sock,
    });

    await db.run(
        `UPDATE clover_settings
         SET value = 'other-community@g.us'
         WHERE key = 'clover_community_group_jid'`
    );

    await assert.rejects(
        applyMemberSimulation(db, {
            code: simulation.code,
            actorId: OWNER,
            chatId: 'admin@g.us',
            sock,
        }),
        (error) => error.code === 'group_changed'
    );
    assert.equal(sock.calls.length, 0);
});

test('comandos específicos de simular e aplicar vencem o comando base', () => {
    const base = require('../comandos/cloverScript');
    const simulation = require('../comandos/cloverSimulation');
    const apply = require('../comandos/cloverApply');
    const commands = new Map([
        [base.nome, base],
        [simulation.nome, simulation],
        [apply.nome, apply],
    ]);

    const resolvedSimulation = resolveCommand('.#clover simular\nALVO id="x"\nFIM', commands);
    assert.equal(resolvedSimulation.command, simulation);

    const resolvedApply = resolveCommand('.#clover aplicar codigo=CSM-ABC123', commands);
    assert.equal(resolvedApply.command, apply);
    assert.equal(resolvedApply.body, 'codigo=CSM-ABC123');
});
