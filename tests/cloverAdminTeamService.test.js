'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    AdminTeamError,
    applyAdminAccessChange,
    createAdminAccessChange,
    listAdminTeam,
    undoAdminAccessChange,
} = require('../helpers/clover/adminTeamService');
const {
    getAdminActorAccess,
    setAdminRole,
} = require('../helpers/clover/adminAccessService');

const OWNER = '111@lid';
const EVA = '222@lid';
const NAR = '333@lid';
const ownerCheck = (jid) => jid === OWNER;

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            numero TEXT,
            esquadrao_nome TEXT,
            jogo_status TEXT
        );
    `);
    await db.run(
        'INSERT INTO jogadores (id, personagem_nome, nome, esquadrao_nome, jogo_status) VALUES (?, ?, ?, ?, ?)',
        [OWNER, 'Proprietário', 'Nilo', 'Véu Negro', 'liberado']
    );
    await db.run(
        'INSERT INTO jogadores (id, personagem_nome, nome, esquadrao_nome, jogo_status) VALUES (?, ?, ?, ?, ?)',
        [EVA, 'Avaliadora', 'Eva', 'Coringas Magenta', 'liberado']
    );
    await db.run(
        'INSERT INTO jogadores (id, personagem_nome, nome, esquadrao_nome, jogo_status) VALUES (?, ?, ?, ?, ?)',
        [NAR, 'Narrador', 'Nar', 'Kings of Sun', 'liberado']
    );
    return db;
}

function fixedBytes() {
    return Buffer.from([0x01, 0x02, 0x03, 0x04]);
}

test('prévia não altera acesso; aplicação concede e undo remove vínculo criado', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const preview = await createAdminAccessChange(db, {
        actorId: OWNER,
        targetId: EVA,
        action: 'set',
        role: 'evaluator',
        reason: 'Responsável pela avaliação de traços',
    }, { ownerCheck, randomBytes: fixedBytes, now: new Date('2026-07-24T18:00:00.000Z') });

    assert.equal(preview.change.code, 'AC-01020304');
    assert.equal(preview.change.status, 'draft');
    assert.equal((await getAdminActorAccess(db, EVA, { ownerCheck })).ok, false);

    const applied = await applyAdminAccessChange(db, preview.change.code, OWNER, {
        ownerCheck,
        now: new Date('2026-07-24T18:01:00.000Z'),
    });
    assert.equal(applied.change.status, 'applied');
    assert.equal((await getAdminActorAccess(db, EVA, { ownerCheck })).actor.role, 'evaluator');

    const team = await listAdminTeam(db, {
        ownerActor: { id: OWNER, displayName: 'Proprietário' },
    });
    assert.equal(team.owner.role, 'owner');
    assert.equal(team.members.length, 1);
    assert.equal(team.members[0].characterName, 'Avaliadora');
    assert.equal(team.members[0].role, 'evaluator');

    const undone = await undoAdminAccessChange(
        db,
        preview.change.code,
        OWNER,
        'Concessão feita para a pessoa errada',
        { ownerCheck, now: new Date('2026-07-24T18:02:00.000Z') }
    );
    assert.equal(undone.change.status, 'undone');
    assert.equal((await getAdminActorAccess(db, EVA, { ownerCheck })).ok, false);
});

test('troca de cargo e revogação preservam estado anterior no undo', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await setAdminRole(db, {
        actorId: OWNER,
        targetId: NAR,
        role: 'narrator',
    }, { ownerCheck });

    const change = await createAdminAccessChange(db, {
        actorId: OWNER,
        targetId: NAR,
        action: 'set',
        role: 'admin',
        reason: 'Ampliação temporária de responsabilidade',
    }, { ownerCheck, randomBytes: () => Buffer.from([0x05, 0x06, 0x07, 0x08]) });
    await applyAdminAccessChange(db, change.change.code, OWNER, { ownerCheck });
    assert.equal((await getAdminActorAccess(db, NAR, { ownerCheck })).actor.role, 'admin');

    await undoAdminAccessChange(db, change.change.code, OWNER, 'Fim da ampliação', { ownerCheck });
    assert.equal((await getAdminActorAccess(db, NAR, { ownerCheck })).actor.role, 'narrator');

    const revoke = await createAdminAccessChange(db, {
        actorId: OWNER,
        targetId: NAR,
        action: 'revoke',
        reason: 'Saída da equipe administrativa',
    }, { ownerCheck, randomBytes: () => Buffer.from([0x09, 0x0A, 0x0B, 0x0C]) });
    await applyAdminAccessChange(db, revoke.change.code, OWNER, { ownerCheck });
    assert.equal((await getAdminActorAccess(db, NAR, { ownerCheck })).ok, false);

    await undoAdminAccessChange(db, revoke.change.code, OWNER, 'Revogação cancelada', { ownerCheck });
    assert.equal((await getAdminActorAccess(db, NAR, { ownerCheck })).actor.role, 'narrator');
});

test('prévia obsoleta não sobrescreve alteração posterior', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const preview = await createAdminAccessChange(db, {
        actorId: OWNER,
        targetId: EVA,
        action: 'set',
        role: 'assistant',
        reason: 'Apoio operacional',
    }, { ownerCheck, randomBytes: fixedBytes });

    await setAdminRole(db, {
        actorId: OWNER,
        targetId: EVA,
        role: 'evaluator',
    }, { ownerCheck });

    await assert.rejects(
        () => applyAdminAccessChange(db, preview.change.code, OWNER, { ownerCheck }),
        (error) => error instanceof AdminTeamError && error.code === 'access_change_stale'
    );
    assert.equal((await getAdminActorAccess(db, EVA, { ownerCheck })).actor.role, 'evaluator');
});

test('protege Proprietário, bloqueia não-owner e recusa cargo repetido', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await assert.rejects(
        () => createAdminAccessChange(db, {
            actorId: OWNER,
            targetId: OWNER,
            action: 'revoke',
            reason: 'Teste',
        }, { ownerCheck }),
        { code: 'target_is_owner' }
    );

    await setAdminRole(db, {
        actorId: OWNER,
        targetId: EVA,
        role: 'evaluator',
    }, { ownerCheck });

    await assert.rejects(
        () => createAdminAccessChange(db, {
            actorId: EVA,
            targetId: NAR,
            action: 'set',
            role: 'assistant',
            reason: 'Teste',
        }, { ownerCheck }),
        { code: 'owner_required' }
    );

    await assert.rejects(
        () => createAdminAccessChange(db, {
            actorId: OWNER,
            targetId: EVA,
            action: 'set',
            role: 'evaluator',
            reason: 'Sem alteração',
        }, { ownerCheck }),
        { code: 'admin_role_unchanged' }
    );
});

test('prévia expirada não pode ser aplicada', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const preview = await createAdminAccessChange(db, {
        actorId: OWNER,
        targetId: EVA,
        action: 'set',
        role: 'assistant',
        reason: 'Apoio temporário',
    }, {
        ownerCheck,
        randomBytes: fixedBytes,
        now: new Date('2026-07-24T18:00:00.000Z'),
        expiryMinutes: 5,
    });

    await assert.rejects(
        () => applyAdminAccessChange(db, preview.change.code, OWNER, {
            ownerCheck,
            now: new Date('2026-07-24T18:06:00.000Z'),
        }),
        { code: 'access_change_expired' }
    );
});
