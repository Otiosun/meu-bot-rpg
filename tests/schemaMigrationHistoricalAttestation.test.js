'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    resolveMigrationCompatibilityPlan,
} = require('../helpers/clover/schemaMigrationCompatibilityPlan');
const {
    computeSchemaFingerprint,
    ensureMigrationLedger,
    migrationChecksum,
    runCloverSchemaMigrations,
} = require('../helpers/clover/schemaMigrationService');
const {
    LIVE_SCHEMA_HISTORY_ATTESTATIONS,
} = require('../helpers/clover/liveSchemaHistoryAttestations');

async function makeDb() {
    return open({ filename: ':memory:', driver: sqlite3.Database });
}

function migration(version, key, sql) {
    return Object.freeze({
        version,
        key,
        description: key,
        async up(db) {
            if (sql) await db.exec(sql);
        },
    });
}

async function seedAttestedRow(db, attestation) {
    await ensureMigrationLedger(db);
    const fingerprint = await computeSchemaFingerprint(db);
    await db.run(
        `INSERT INTO clover_schema_migrations
         (version, migration_key, checksum, schema_fingerprint, metadata_json)
         VALUES (?, ?, ?, ?, '{}')`,
        [attestation.version, attestation.key, attestation.checksum, fingerprint]
    );
    await db.exec(`PRAGMA user_version = ${attestation.version}`);
}

test('histórico live 31-54 fica pinado exatamente ao ledger read-only de 2026-10-13', () => {
    const expected = [
        [31, '0031_clover_script_journal_foundation', '29418f25571671ac832e95c6416bc4342d99c0b289d50e4aeb3948ab2d360af9'],
        [32, '0032_global_reset_journal_freeze', '31531297fc47c5545f07cd0348db4e8426c90c39f46fd11baeb20f617f39c9d3'],
        [33, '0033_global_reset_child_event_guard', '9879e3452c7dc1693ab15d8e8d1ff055ef781646e4564389f41ceeb33402ed75'],
        [34, '0034_prereset_transition_decision', '8c437207c6a75d2e764c92d92042ce858dad99877c8345621ceee17cb02f45b6'],
        [35, '0035_prereset_campaign_control', '48218c749614533a55de5af68f2a5b1abbc380cab45594323646abb6975774e7'],
        [36, '0036_prereset_purge_hardening', 'cd1cf1c122867e662dd896448ca27ac3ab9bd58f4bf4500a33ee3ecac66446a3'],
        [37, '0037_prereset_admin_roster_launch', 'cfc1cc967d97ca94b50ffa87c2a3e0a335c5d09deae39db8e4c8ec80aaaae280'],
        [38, '0038_prereset_future_rolls', '7514b242e63ffa10b015855224972ae7312e23b4b85d5b7f8569035133867bc6'],
        [39, '0039_prereset_future_slot_reservations', '9c9bc895ae4eb038c200908a31c749ccbe59d3f36d5c7ba2531f3fe54cc1daec'],
        [40, '0040_return_point_shop_gate', 'ca6df6e11d7687fde72f13ac9567762b1e1024a489f34bc6e1174c9a4f3ea142'],
        [41, '0041_return_point_shop_purchases', '2d473de35941035aa3f8a7a0497379102648225ee36f78c4ed38951b388b25da'],
        [42, '0042_return_point_shop_eligibility_snapshot', '82ad1e4cf204c9590fca31571a18a6b1bdf7bdd6482d83e9276fcc9c16c2a333'],
        [43, '0043_return_point_shop_scoped_auth', 'eb472ea201df03af8c881c9a94d2bfb3c4da11a554f8d2fc1c6338d54a9eb814'],
        [44, '0044_return_shop_manual_obligations', '1d301c80c27ce0d6eb2653378de63482bd465ebc8ff084d5e33477c0fec9baf0'],
        [45, '0045_return_shop_custom_item_requests', 'b763d07db42698dca283b140a408ef4463da921fb975c9cdf660b85305788b3c'],
        [46, '0046_pr_pv_supplement_carry', '67f6b66c67ac8b2d3fb0ddfa70f33d391f00fed485e2164fa00bf56a2d906098'],
        [47, '0047_core_v2_attribute_rebaseline_foundation', 'cd135a61d0a9f86a71dc18a2dc57cc409052257231f2c483b2d21125ccc62ea8'],
        [48, '0048_core_v2_tree_migration_receipts', 'b3826548caeb4db473261c75b09f38a85217bae385d377b4adb27524e1f8ec2d'],
        [49, '0049_core_v2_spell_mechanics', '76e838d041370f14e51fa9c0d8caa9e101f0b91fa8cf955ef1afaac92f2b8858'],
        [50, '0050_core_v2_spell_approval_receipts', 'e8d4cd5b0e7f685b02f6ff3f50d41ef8a6af01f4ad066dea247efa9c558bd841'],
        [51, '0051_profile_presentation_preferences', 'cfc92e139a53037b0e584e34ccdfb3b3d59be1f9bafc7b27d77d0234e29cb566'],
        [52, '0052_profile_media', '403ac9570d370f7e7891172bd3ccaa2ca2e1c8df6286c3b246109d2bc5166537'],
        [53, '0053_mana_hexagon_v4_axes', 'f86a1c6d6a651f97de36bf37f49696844fa626f29fab891a62cdcd764f7837a7'],
        [54, '0054_admin_trait_profile_sync_v2', '9b29ea6ed99562432ffe6c801358e6f20433fc256282452b2a75dc5a8eaf1ace'],
    ];
    assert.deepEqual(
        LIVE_SCHEMA_HISTORY_ATTESTATIONS.map((item) => [item.version, item.key, item.checksum]),
        expected
    );
});

test('planner aceita histórico aplicado sobre a mesma versão executável sem reexecutá-la', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const currentV1 = migration(1, '0001_current', 'CREATE TABLE current_one (id INTEGER PRIMARY KEY)');
    const newV2 = migration(2, '0002_new', 'CREATE TABLE two (id INTEGER PRIMARY KEY)');
    const historicalV1 = Object.freeze({
        version: 1,
        key: '0001_live_legacy',
        checksum: 'd'.repeat(64),
    });
    await seedAttestedRow(db, historicalV1);

    const plan = await resolveMigrationCompatibilityPlan(db, {
        migrations: [currentV1, newV2],
        historicalAttestations: [historicalV1],
    });
    assert.deepEqual(plan.shadowedExecutableVersions, [1]);
    assert.deepEqual(plan.migrations.map((item) => item.version), [2]);
    assert.deepEqual(plan.historicalAttestations.map((item) => item.version), [1]);

    const result = await runCloverSchemaMigrations(db, plan);
    assert.equal(result.latestVersion, 2);
    assert.equal(result.appliedCount, 1);
    assert.equal(await db.get("SELECT name FROM sqlite_schema WHERE name='current_one'"), undefined);
    assert.equal((await db.get("SELECT name FROM sqlite_schema WHERE name='two'")).name, 'two');
});

test('planner deixa atestação sobreposta dormente em banco novo e executa migration canônica', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const currentV1 = migration(1, '0001_current', 'CREATE TABLE current_one (id INTEGER PRIMARY KEY)');
    const historicalV1 = Object.freeze({
        version: 1,
        key: '0001_live_legacy',
        checksum: 'e'.repeat(64),
    });
    const plan = await resolveMigrationCompatibilityPlan(db, {
        migrations: [currentV1],
        historicalAttestations: [historicalV1],
    });
    assert.deepEqual(plan.shadowedExecutableVersions, []);
    assert.deepEqual(plan.migrations.map((item) => item.version), [1]);
    assert.deepEqual(plan.historicalAttestations, []);

    await runCloverSchemaMigrations(db, plan);
    assert.equal((await db.get("SELECT name FROM sqlite_schema WHERE name='current_one'")).name, 'current_one');
});

test('planner bloqueia histórico sobreposto que não bate nem no live atestado nem no executável atual', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const currentV1 = migration(1, '0001_current', 'CREATE TABLE current_one (id INTEGER PRIMARY KEY)');
    await seedAttestedRow(db, {
        version: 1,
        key: '0001_unknown',
        checksum: 'f'.repeat(64),
    });

    await assert.rejects(
        resolveMigrationCompatibilityPlan(db, {
            migrations: [currentV1],
            historicalAttestations: [{
                version: 1,
                key: '0001_live_legacy',
                checksum: 'e'.repeat(64),
            }],
        }),
        (error) => error?.code === 'live_history_attestation_mismatch'
            && error?.version === 1
            && error?.currentExecutableKey === '0001_current'
    );
});

test('histórico aplicado atestado pode preencher gap sem virar migration executável', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const m1 = migration(1, '0001_test', 'CREATE TABLE one (id INTEGER PRIMARY KEY)');
    const m3 = migration(3, '0003_new', 'CREATE TABLE three (id INTEGER PRIMARY KEY)');
    await runCloverSchemaMigrations(db, { migrations: [m1] });

    const attestation = Object.freeze({
        version: 2,
        key: '0002_external_history',
        checksum: 'a'.repeat(64),
    });
    await seedAttestedRow(db, attestation);

    const result = await runCloverSchemaMigrations(db, {
        migrations: [m1, m3],
        historicalAttestations: [attestation],
    });
    assert.equal(result.latestVersion, 3);
    assert.equal(result.appliedCount, 1);
    const table = await db.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='three'");
    assert.equal(table.name, 'three');
    const uv = await db.get('PRAGMA user_version');
    assert.equal(Number(Object.values(uv)[0]), 3);
});

test('checksum histórico divergente bloqueia antes de qualquer migration nova', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const m1 = migration(1, '0001_test', 'CREATE TABLE one (id INTEGER PRIMARY KEY)');
    const m3 = migration(3, '0003_new', 'CREATE TABLE three (id INTEGER PRIMARY KEY)');
    await runCloverSchemaMigrations(db, { migrations: [m1] });
    await seedAttestedRow(db, {
        version: 2,
        key: '0002_external_history',
        checksum: 'b'.repeat(64),
    });

    await assert.rejects(
        runCloverSchemaMigrations(db, {
            migrations: [m1, m3],
            historicalAttestations: [{
                version: 2,
                key: '0002_external_history',
                checksum: 'a'.repeat(64),
            }],
        }),
        (error) => error?.code === 'migration_checksum_mismatch'
    );
    const table = await db.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='three'");
    assert.equal(table, undefined);
});

test('migration executável ausente abaixo de histórico aplicado é bloqueada', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const m1 = migration(1, '0001_test', 'CREATE TABLE one (id INTEGER PRIMARY KEY)');
    const m2 = migration(2, '0002_required', 'CREATE TABLE two (id INTEGER PRIMARY KEY)');
    const m4 = migration(4, '0004_new', 'CREATE TABLE four (id INTEGER PRIMARY KEY)');
    await runCloverSchemaMigrations(db, { migrations: [m1] });
    const historical = {
        version: 3,
        key: '0003_external_history',
        checksum: 'c'.repeat(64),
    };
    await seedAttestedRow(db, historical);

    await assert.rejects(
        runCloverSchemaMigrations(db, {
            migrations: [m1, m2, m4],
            historicalAttestations: [historical],
        }),
        (error) => error?.code === 'missing_migration_below_applied_history'
    );
    const table = await db.get("SELECT name FROM sqlite_schema WHERE type='table' AND name='two'");
    assert.equal(table, undefined);
});

test('release Clover Multicolor publica somente 55-58 acima do catálogo legado', () => {
    const { CANONICAL_SCHEMA_MIGRATIONS } = require('../database');
    const release = CANONICAL_SCHEMA_MIGRATIONS.slice(-4);
    assert.deepEqual(release.map((item) => item.version), [55, 56, 57, 58]);
    assert.deepEqual(release.map((item) => item.key), [
        '0055_scene_evaluation_integrity',
        '0056_scene_evaluation_void_accounting',
        '0057_universal_evaluation_queue',
        '0058_human_prototype_evaluation',
    ]);
    assert.equal(migrationChecksum(release[0]).length, 64);
});
