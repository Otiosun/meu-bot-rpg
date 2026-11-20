'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    assignAccessRole,
    hasAccessPermission,
} = require('../helpers/clover/accessControlService');
const {
    ensureCanonicalRoleGrantSchema,
} = require('../helpers/clover/canonicalRoleGrantSchema');

async function createDb() {
    return open({ filename: ':memory:', driver: sqlite3.Database });
}

async function insertCanonicalRole(db, subjectId, roleKey, scopeType = 'global', scopeKey = '*') {
    await ensureCanonicalRoleGrantSchema(db);
    await db.run(
        `INSERT INTO clover_role_grants
         (subject_id, role_key, scope_type, scope_key, status,
          valid_from, granted_by, origin_type, origin_ref)
         VALUES (?, ?, ?, ?, 'active',
                 '2000-01-01 00:00:00', 'owner@lid', 'fixture', ?)`,
        [subjectId, roleKey, scopeType, scopeKey, `${subjectId}:${roleKey}:${scopeKey}`]
    );
}

test('Avaliador canônico recebe somente permissões globais da matriz', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'evaluator@lid', 'evaluator');

    assert.equal(await hasAccessPermission(db, 'evaluator@lid', 'evaluation.apply'), true);
    assert.equal(await hasAccessPermission(db, 'evaluator@lid', 'raid.reward.review'), true);
    assert.equal(await hasAccessPermission(db, 'evaluator@lid', 'raid.create'), false);
});

test('Administrador e Narrador preservam expansões globais canônicas aprovadas', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'admin@lid', 'admin');
    await insertCanonicalRole(db, 'narrator@lid', 'narrator');

    assert.equal(await hasAccessPermission(db, 'admin@lid', 'raid.reward.review'), true);
    assert.equal(await hasAccessPermission(db, 'admin@lid', 'character.read.profile'), true);
    assert.equal(await hasAccessPermission(db, 'narrator@lid', 'raid.read.all'), true);
    assert.equal(await hasAccessPermission(db, 'narrator@lid', 'raid.reward.propose'), true);
    assert.equal(await hasAccessPermission(db, 'narrator@lid', 'raid.reward.review'), false);
});

test('Capitão canônico não tem seu escopo achatado pelo helper genérico', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'captain@lid', 'captain', 'squad', 'alpha');

    assert.equal(await hasAccessPermission(db, 'captain@lid', 'squad.manage.members'), false);
    assert.equal(await hasAccessPermission(db, 'captain@lid', 'raid.create'), false);
    assert.equal(await hasAccessPermission(db, 'captain@lid', 'raid.view'), false);
});

test('grant canônico bloqueia fallback legado conflitante', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await insertCanonicalRole(db, 'captain@lid', 'captain', 'squad', 'alpha');
    await assignAccessRole(db, {
        subjectId: 'captain@lid',
        role: 'captain',
        scopeKey: 'beta',
        assignedBy: 'owner@lid',
        reason: 'fixture divergente',
    });

    assert.equal(await hasAccessPermission(db, 'captain@lid', 'squad.manage.members'), false);
});

test('sujeito ainda sem grant canônico usa fallback legado temporário', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await assignAccessRole(db, {
        subjectId: 'legacy-evaluator@lid',
        role: 'evaluator',
        assignedBy: 'owner@lid',
        reason: 'fixture legado',
    });

    assert.equal(await hasAccessPermission(db, 'legacy-evaluator@lid', 'evaluation.apply'), true);
    assert.equal(await hasAccessPermission(db, 'legacy-evaluator@lid', 'raid.create'), false);
});


test('revisão idempotente de raid consulta permissão canônica antes de buscar proposta', async t => {
    const db = await createDb();
    t.after(() => db.close());
    const { prepareReviewIntent } = require('../helpers/clover/raidRewardProposalIdempotencyService');
    await insertCanonicalRole(db, 'fixture-narrator@lid', 'narrator');
    await insertCanonicalRole(db, 'fixture-reviewer@lid', 'evaluator');
    // Persist a conflicting legacy role so the test also covers fail-closed precedence.
    await assignAccessRole(db, { subjectId:'fixture-narrator@lid', role:'evaluator', assignedBy:'owner@lid', reason:'test' });
    // Minimal proposal dependency: no row is available, so an authorized actor reaches proposal_not_found.
    await db.exec("CREATE TABLE IF NOT EXISTS clover_raid_reward_proposals (id INTEGER PRIMARY KEY, raid_id INTEGER, status TEXT, proposed_by TEXT, reviewed_by TEXT, review_note TEXT, reviewed_at TEXT, delivery_key TEXT, delivery_result_json TEXT, snapshot_hash TEXT)");
    const input={proposalId:'999',decision:'approve',note:'fixture',idempotencyKey:'fixture:review'};
    await assert.rejects(()=>prepareReviewIntent(db,{...input,actorId:'fixture-narrator@lid'}), e=>e.code==='forbidden');
    await assert.rejects(()=>prepareReviewIntent(db,{...input,actorId:'fixture-reviewer@lid'}), e=>e.code==='proposal_not_found');
});
