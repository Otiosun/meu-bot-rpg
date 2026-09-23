'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    buildLiveIdentityRepairPlan,
    createIdentityRepairExecutors,
    simulateIdentityRepair,
} = require('../helpers/clover/adminIdentityRepairService');

async function makeDb(options = {}) {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            nome_real TEXT,
            personagem_nome TEXT,
            raca TEXT,
            classe TEXT,
            grimorio TEXT,
            magia TEXT,
            ficha_status TEXT,
            historia_status TEXT,
            personagem_aparencia_status TEXT,
            jogo_status TEXT,
            canonical_player_id TEXT,
            merged_into TEXT,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT
        );

        CREATE TABLE group_member_welcomes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            player_id TEXT NOT NULL,
            message_id TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (group_id, player_id)
        );

        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            kind TEXT NOT NULL,
            source TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        );
        CREATE UNIQUE INDEX idx_identity_test_ph
            ON clover_ph_ledger (player_id, source, related_id);
    `);

    const sourceId = '5511999999999@s.whatsapp.net';
    const canonicalId = '5511999999999@lid';

    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, canonical_player_id, is_shadow, identity_status)
         VALUES (?, 'Cacador', ?, 1, 'shadow')`,
        [sourceId, canonicalId]
    );
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, raca, classe, grimorio, magia, ficha_status, jogo_status,
          canonical_player_id, is_shadow, identity_status)
         VALUES (?, 'Jogador Real', 'Humano', 'Nobreza', 'Grimório de 3 Folhas',
                 'Fogo', 'aprovada', 'liberado', ?, 0, 'active')`,
        [canonicalId, canonicalId]
    );

    await db.run(
        `INSERT INTO group_member_welcomes (group_id, player_id, message_id, created_at)
         VALUES ('grupo-1', ?, NULL, '2026-01-01 10:00:00')`,
        [canonicalId]
    );
    await db.run(
        `INSERT INTO group_member_welcomes (group_id, player_id, message_id, created_at)
         VALUES ('grupo-1', ?, 'msg-source', '2026-01-02 10:00:00')`,
        [sourceId]
    );
    await db.run(
        `INSERT INTO group_member_welcomes (group_id, player_id, message_id, created_at)
         VALUES ('grupo-2', ?, 'msg-2', '2026-01-03 10:00:00')`,
        [sourceId]
    );

    await db.run(
        `INSERT INTO clover_ph_ledger
         (player_id, amount, kind, source, reason, related_id, created_by, metadata_json)
         VALUES (?, 5, 'ganho', 'scene', NULL, 'scene-1', NULL, NULL)`,
        [canonicalId]
    );
    await db.run(
        `INSERT INTO clover_ph_ledger
         (player_id, amount, kind, source, reason, related_id, created_by, metadata_json)
         VALUES (?, 5, 'ganho', 'scene', 'Cena semanal', 'scene-1', 'narrador', '{"scene":1}')`,
        [sourceId]
    );

    if (options.sourceSubstantive) {
        await db.run(
            `UPDATE jogadores
             SET personagem_nome = 'Personagem Fonte', raca = 'Humano', classe = 'Plebeu',
                 grimorio = 'Grimório de 3 Folhas', magia = 'Água', ficha_status = 'aprovada'
             WHERE id = ?`,
            [sourceId]
        );
    }

    return { db, sourceId, canonicalId };
}

async function snapshot(db) {
    return {
        jogadores: await db.all('SELECT * FROM jogadores ORDER BY id'),
        welcomes: await db.all(
            'SELECT group_id, player_id, message_id, created_at FROM group_member_welcomes ORDER BY group_id, player_id'
        ),
        ph: await db.all(
            `SELECT player_id, amount, kind, source, reason, related_id, created_by, metadata_json
             FROM clover_ph_ledger ORDER BY id`
        ),
    };
}

function context(db, sourceId, canonicalId, extra = {}) {
    return {
        db,
        operation: {
            code: 'OP-ID-TEST',
            actor: { id: 'owner-1' },
            reason: 'Consolidar identidade duplicada',
        },
        action: {
            type: 'player.identity.repair',
            payload: {
                sourcePlayerId: sourceId,
                canonicalPlayerId: canonicalId,
            },
        },
        target: {
            kind: 'player',
            playerId: canonicalId,
            characterName: 'Jogador Real',
        },
        ...extra,
    };
}

test('identity planner marks empty alias -> substantive canonical as executable', async (t) => {
    const { db, sourceId, canonicalId } = await makeDb();
    t.after(() => db.close());

    const plan = await buildLiveIdentityRepairPlan(db, sourceId, canonicalId);
    assert.equal(plan.readyForExecutor, true);
    assert.equal(plan.action, 'transactional_alias_consolidation_ready');
    assert.equal(plan.dataOwnerId, canonicalId);
    assert.ok(plan.sourceReferences.references.some(
        (entry) => entry.table === 'group_member_welcomes' && entry.strategy === 'repoint_history'
    ));
    assert.ok(plan.fingerprint);
});

test('identity dry-run executes full merge and rolls back all mutations', async (t) => {
    const { db, sourceId, canonicalId } = await makeDb();
    t.after(() => db.close());

    const before = await snapshot(db);
    const plan = await buildLiveIdentityRepairPlan(db, sourceId, canonicalId);
    const simulated = await simulateIdentityRepair(db, plan);

    assert.ok(simulated.journal.length >= 2);
    assert.deepEqual(await snapshot(db), before);
});

test('identity operation consolidates equivalent history and removes only source identity', async (t) => {
    const { db, sourceId, canonicalId } = await makeDb();
    t.after(() => db.close());

    const executor = createIdentityRepairExecutors()['player.identity.repair'];
    const preview = await executor.preview(context(db, sourceId, canonicalId));

    assert.equal(preview.metadata.undoSafe, false);
    assert.equal(preview.metadata.recovery, 'restore_database_backup_or_forward_identity_repair');
    assert.equal(preview.before.sourceId, sourceId);
    assert.equal(preview.before.canonicalId, canonicalId);

    const applied = await executor.apply(context(db, sourceId, canonicalId, {
        before: preview.before,
        after: preview.after,
    }));

    assert.equal(applied.after.canonicalId, canonicalId);
    assert.equal(applied.after.removedSourceId, sourceId);
    assert.equal(
        (await db.get('SELECT COUNT(*) AS total FROM jogadores WHERE id = ?', [sourceId])).total,
        0
    );
    assert.equal(
        (await db.get('SELECT COUNT(*) AS total FROM jogadores WHERE id = ?', [canonicalId])).total,
        1
    );

    const welcomes = await db.all(
        'SELECT group_id, player_id, message_id FROM group_member_welcomes ORDER BY group_id'
    );
    assert.deepEqual(welcomes, [
        { group_id: 'grupo-1', player_id: canonicalId, message_id: 'msg-source' },
        { group_id: 'grupo-2', player_id: canonicalId, message_id: 'msg-2' },
    ]);

    const ph = await db.all(
        `SELECT player_id, amount, kind, source, reason, related_id, created_by, metadata_json
         FROM clover_ph_ledger`
    );
    assert.deepEqual(ph, [{
        player_id: canonicalId,
        amount: 5,
        kind: 'ganho',
        source: 'scene',
        reason: 'Cena semanal',
        related_id: 'scene-1',
        created_by: 'narrador',
        metadata_json: '{"scene":1}',
    }]);

    assert.equal(typeof executor.undo, 'undefined');
});

test('identity repair blocks automatic merge when both profiles contain substantive data', async (t) => {
    const { db, sourceId, canonicalId } = await makeDb({ sourceSubstantive: true });
    t.after(() => db.close());

    const plan = await buildLiveIdentityRepairPlan(db, sourceId, canonicalId);
    assert.equal(plan.readyForExecutor, false);
    assert.equal(plan.action, 'blocked_manual_merge');

    const executor = createIdentityRepairExecutors()['player.identity.repair'];
    await assert.rejects(
        () => executor.preview(context(db, sourceId, canonicalId)),
        (error) => error?.code === 'identity_repair_blocked'
    );
});

test('identity repair blocks unknown references instead of guessing a migration strategy', async (t) => {
    const { db, sourceId, canonicalId } = await makeDb();
    t.after(() => db.close());

    await db.exec(`
        CREATE TABLE unknown_identity_reference (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_ref TEXT NOT NULL
        );
    `);
    await db.run(
        'INSERT INTO unknown_identity_reference (owner_ref) VALUES (?)',
        [sourceId]
    );

    const plan = await buildLiveIdentityRepairPlan(db, sourceId, canonicalId);
    assert.equal(plan.readyForExecutor, false);
    assert.equal(plan.action, 'review_unknown_references');
    assert.ok(plan.sourceReferences.unknownReferences.some(
        (entry) => entry.table === 'unknown_identity_reference' && entry.column === 'owner_ref'
    ));
});

test('identity apply fails stale when reference graph changes after preview', async (t) => {
    const { db, sourceId, canonicalId } = await makeDb();
    t.after(() => db.close());

    const executor = createIdentityRepairExecutors()['player.identity.repair'];
    const preview = await executor.preview(context(db, sourceId, canonicalId));

    await db.exec(`
        CREATE TABLE new_identity_reference (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_ref TEXT NOT NULL
        );
    `);
    await db.run(
        'INSERT INTO new_identity_reference (player_ref) VALUES (?)',
        [sourceId]
    );

    await assert.rejects(
        () => executor.apply(context(db, sourceId, canonicalId, {
            before: preview.before,
            after: preview.after,
        })),
        (error) => error?.code === 'identity_repair_changed_after_preview'
    );
});

test('identity repair rejects unrelated identities even when an owner supplies both ids', async (t) => {
    const { db, sourceId } = await makeDb();
    t.after(() => db.close());

    const otherId = '5521888888888@lid';
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, canonical_player_id, is_shadow, identity_status)
         VALUES (?, 'Outro', ?, 0, 'active')`,
        [otherId, otherId]
    );

    await assert.rejects(
        () => buildLiveIdentityRepairPlan(db, sourceId, otherId),
        (error) => error?.code === 'identity_not_equivalent'
    );
});

test('identity repair requires the OP target to be the canonical player', async (t) => {
    const { db, sourceId, canonicalId } = await makeDb();
    t.after(() => db.close());

    const executor = createIdentityRepairExecutors()['player.identity.repair'];
    await assert.rejects(
        () => executor.preview({
            ...context(db, sourceId, canonicalId),
            target: { kind: 'player', playerId: sourceId },
        }),
        (error) => error?.code === 'identity_target_mismatch'
    );
});
