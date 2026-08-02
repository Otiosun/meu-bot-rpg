'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    applyCanonicalAdminRoleChange,
    cancelCanonicalAdminRoleChange,
    createCanonicalAdminRoleChange,
    getCanonicalAdminRoleChange,
    listCanonicalAdminTeam,
    readAdminRoleState,
    undoCanonicalAdminRoleChange,
} = require('../helpers/clover/canonicalAdminTeamService');

const OWNER_ID = '5500000000000@s.whatsapp.net';
const TARGET_ID = '5511111111111@s.whatsapp.net';
const SECOND_ID = '5522222222222@s.whatsapp.net';

function ownerCheck(value) {
    return String(value || '') === OWNER_ID;
}

async function createDb() {
    const db = await open({
        filename: ':memory:',
        driver: sqlite3.Database,
    });
    await db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            esquadrao TEXT,
            jogo_status TEXT
        );
    `);
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, nome, esquadrao, jogo_status)
         VALUES (?, 'Owner', 'Owner', NULL, 'liberado')`,
        [OWNER_ID]
    );
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, nome, esquadrao, jogo_status)
         VALUES (?, 'Emil', 'Emil', 'mephistopolis', 'liberado')`,
        [TARGET_ID]
    );
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, nome, esquadrao, jogo_status)
         VALUES (?, 'Kurai', 'Kurai', 'trevos_da_esperanca', 'liberado')`,
        [SECOND_ID]
    );
    return db;
}

function options(extra = {}) {
    return {
        ownerCheck,
        ...extra,
    };
}

async function createChange(db, input, extra = {}) {
    return createCanonicalAdminRoleChange(db, {
        actorId: OWNER_ID,
        targetId: TARGET_ID,
        reason: 'Ajuste administrativo controlado.',
        ...input,
    }, options(extra));
}

test('concessão cria grant canônico, admissão espelhada e eventos na mesma aplicação', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const preview = await createChange(db, { action: 'set', role: 'admin' });
    assert.equal(preview.change.status, 'draft');
    assert.equal(preview.change.plannedAfter.role, 'admin');

    const result = await applyCanonicalAdminRoleChange(
        db,
        preview.change.code,
        OWNER_ID,
        options()
    );
    assert.equal(result.change.status, 'applied');
    assert.equal(result.state.parity, 'matched');
    assert.deepEqual(result.state.effectiveRoles, ['admin']);

    const legacy = await db.get(
        'SELECT role, active FROM clover_admin_roles WHERE player_id = ?',
        [TARGET_ID]
    );
    assert.deepEqual(legacy, { role: 'admin', active: 1 });

    const grants = await db.all(
        `SELECT role_key, status, origin_type, origin_ref
         FROM clover_role_grants
         WHERE subject_id = ?
         ORDER BY id`,
        [TARGET_ID]
    );
    assert.equal(grants.length, 1);
    assert.equal(grants[0].role_key, 'admin');
    assert.equal(grants[0].status, 'active');
    assert.equal(grants[0].origin_type, 'admin_team');
    assert.equal(grants[0].origin_ref, preview.change.code);

    const events = await db.all(
        `SELECT action, role_key, origin_type, origin_ref
         FROM clover_role_grant_events
         WHERE subject_id = ?
         ORDER BY id`,
        [TARGET_ID]
    );
    assert.deepEqual(events, [{
        action: 'granted',
        role_key: 'admin',
        origin_type: 'admin_team',
        origin_ref: preview.change.code,
    }]);
});

test('troca revoga o grant anterior e mantém exatamente um cargo global canônico', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const first = await createChange(db, { action: 'set', role: 'admin' });
    await applyCanonicalAdminRoleChange(db, first.change.code, OWNER_ID, options());

    const swap = await createChange(db, { action: 'set', role: 'evaluator' });
    const applied = await applyCanonicalAdminRoleChange(
        db,
        swap.change.code,
        OWNER_ID,
        options()
    );
    assert.equal(applied.state.parity, 'matched');
    assert.deepEqual(applied.state.effectiveRoles, ['evaluator']);

    const grants = await db.all(
        `SELECT role_key, status
         FROM clover_role_grants
         WHERE subject_id = ?
         ORDER BY id`,
        [TARGET_ID]
    );
    assert.deepEqual(grants, [
        { role_key: 'admin', status: 'revoked' },
        { role_key: 'evaluator', status: 'active' },
    ]);

    const legacy = await db.get(
        'SELECT role, active FROM clover_admin_roles WHERE player_id = ?',
        [TARGET_ID]
    );
    assert.deepEqual(legacy, { role: 'evaluator', active: 1 });
});

test('revogação remove admissão e cargo canônico sem apagar histórico', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const first = await createChange(db, { action: 'set', role: 'narrator' });
    await applyCanonicalAdminRoleChange(db, first.change.code, OWNER_ID, options());

    const revoke = await createChange(db, { action: 'revoke' });
    const applied = await applyCanonicalAdminRoleChange(
        db,
        revoke.change.code,
        OWNER_ID,
        options()
    );
    assert.equal(applied.state.parity, 'none');
    assert.deepEqual(applied.state.effectiveRoles, []);

    const legacy = await db.get(
        'SELECT role, active FROM clover_admin_roles WHERE player_id = ?',
        [TARGET_ID]
    );
    assert.deepEqual(legacy, { role: 'narrator', active: 0 });

    const grants = await db.all(
        `SELECT role_key, status FROM clover_role_grants
         WHERE subject_id = ? ORDER BY id`,
        [TARGET_ID]
    );
    assert.deepEqual(grants, [{ role_key: 'narrator', status: 'revoked' }]);
});

test('prévia stale falha fechada sem alterar grants', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const preview = await createChange(db, { action: 'set', role: 'assistant' });
    await db.run(
        `INSERT INTO clover_admin_roles
         (player_id, role, active, granted_by)
         VALUES (?, 'admin', 1, ?)`,
        [TARGET_ID, OWNER_ID]
    );

    await assert.rejects(
        () => applyCanonicalAdminRoleChange(
            db,
            preview.change.code,
            OWNER_ID,
            options()
        ),
        (error) => error.code === 'admin_role_change_stale'
    );

    const grantCount = await db.get(
        'SELECT COUNT(*) AS total FROM clover_role_grants WHERE subject_id = ?',
        [TARGET_ID]
    );
    assert.equal(grantCount.total, 0);
});

test('prévia expirada é marcada e não pode ser aplicada', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const started = new Date('2026-08-02T08:00:00.000Z');

    const preview = await createChange(
        db,
        { action: 'set', role: 'assistant' },
        { now: started, expiryMinutes: 5 }
    );

    await assert.rejects(
        () => applyCanonicalAdminRoleChange(
            db,
            preview.change.code,
            OWNER_ID,
            options({ now: new Date('2026-08-02T08:06:00.000Z') })
        ),
        (error) => error.code === 'admin_role_change_expired'
    );

    const stored = await getCanonicalAdminRoleChange(db, preview.change.code);
    assert.equal(stored.status, 'expired');
});

test('cancelamento encerra somente uma prévia ainda pendente', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const preview = await createChange(db, { action: 'set', role: 'assistant' });
    const cancelled = await cancelCanonicalAdminRoleChange(
        db,
        preview.change.code,
        OWNER_ID,
        options()
    );
    assert.equal(cancelled.change.status, 'cancelled');

    await assert.rejects(
        () => applyCanonicalAdminRoleChange(
            db,
            preview.change.code,
            OWNER_ID,
            options()
        ),
        (error) => error.code === 'admin_role_change_not_draft'
    );
});

test('undo restaura o cargo anterior com novo histórico, sem reativar linha antiga', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const first = await createChange(db, { action: 'set', role: 'admin' });
    await applyCanonicalAdminRoleChange(db, first.change.code, OWNER_ID, options());

    const swap = await createChange(db, { action: 'set', role: 'evaluator' });
    await applyCanonicalAdminRoleChange(db, swap.change.code, OWNER_ID, options());

    const undone = await undoCanonicalAdminRoleChange(
        db,
        swap.change.code,
        OWNER_ID,
        'A decisão foi revertida após revisão.',
        options()
    );
    assert.equal(undone.change.status, 'undone');
    assert.equal(undone.state.parity, 'matched');
    assert.deepEqual(undone.state.effectiveRoles, ['admin']);

    const grants = await db.all(
        `SELECT role_key, status FROM clover_role_grants
         WHERE subject_id = ? ORDER BY id`,
        [TARGET_ID]
    );
    assert.deepEqual(grants, [
        { role_key: 'admin', status: 'revoked' },
        { role_key: 'evaluator', status: 'revoked' },
        { role_key: 'admin', status: 'active' },
    ]);
});

test('mudança posterior bloqueia undo antigo', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const first = await createChange(db, { action: 'set', role: 'admin' });
    await applyCanonicalAdminRoleChange(db, first.change.code, OWNER_ID, options());

    const later = await createChange(db, { action: 'set', role: 'narrator' });
    await applyCanonicalAdminRoleChange(db, later.change.code, OWNER_ID, options());

    await assert.rejects(
        () => undoCanonicalAdminRoleChange(
            db,
            first.change.code,
            OWNER_ID,
            'Tentativa de desfazer ação antiga.',
            options()
        ),
        (error) => error.code === 'admin_role_changed_after_apply'
    );
});

test('divergência canônico/legado bloqueia nova prévia', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await readAdminRoleState(db, TARGET_ID, options());
    await db.run(
        `INSERT INTO clover_role_grants
         (subject_id, role_key, scope_type, scope_key, status, granted_by)
         VALUES (?, 'admin', 'global', '*', 'active', ?)`,
        [TARGET_ID, OWNER_ID]
    );

    await assert.rejects(
        () => createChange(db, { action: 'set', role: 'assistant' }),
        (error) => error.code === 'admin_role_integrity_conflict'
            && error.details.parity === 'canonical_only'
    );
});

test('Owner não pode ser alvo e listagem expõe conflitos sem conceder acesso', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await assert.rejects(
        () => createCanonicalAdminRoleChange(db, {
            actorId: OWNER_ID,
            targetId: OWNER_ID,
            action: 'set',
            role: 'admin',
            reason: 'Tentativa inválida.',
        }, options()),
        (error) => error.code === 'target_is_owner'
    );

    await readAdminRoleState(db, SECOND_ID, options());
    await db.run(
        `INSERT INTO clover_admin_roles
         (player_id, role, active, granted_by)
         VALUES (?, 'assistant', 1, ?)`,
        [SECOND_ID, OWNER_ID]
    );

    const team = await listCanonicalAdminTeam(db, {
        actorId: OWNER_ID,
        ownerCheck,
    });
    const conflict = team.members.find((member) => member.playerId === SECOND_ID);
    assert.equal(conflict.parity, 'legacy_only');
    assert.equal(conflict.active, false);
    assert.equal(team.integrityConflictCount, 1);
    assert.equal(team.owner.immutable, true);
});
