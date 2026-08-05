'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    CATEGORIES,
    applyGlobalMembershipBackfill,
    buildSanitizedSummary,
    openReadOnlyDatabase,
    planGlobalMembershipBackfill,
    projectRestructureAfterBackfill,
} = require('../scripts/planGlobalMembershipBackfill20260804.cjs');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'planGlobalMembershipBackfill20260804.cjs');
const FIXED_TIME = '2026-08-04T12:00:00.000Z';

function fileHash(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeIdentityMapping(authInfoDir, phone, lid) {
    fs.writeFileSync(
        path.join(authInfoDir, `lid-mapping-${phone}.json`),
        JSON.stringify({ lid: `${lid}@lid` })
    );
    fs.writeFileSync(
        path.join(authInfoDir, `lid-mapping-${lid}_reverse.json`),
        JSON.stringify({ phoneNumber: phone })
    );
}

async function addPlayer(db, {
    id,
    name,
    squad = 'Alpha Knights',
    ficha = 'aprovada',
    jogo = 'liberado',
    identity = 'active',
    lifecycle = 'active',
    shadow = 0,
    mergedInto = null,
}) {
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, display_name, nome, esquadrao, ficha_status, jogo_status,
          identity_status, lifecycle_status, is_shadow, merged_into)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, name, name, name, squad, ficha, jogo, identity, lifecycle, shadow, mergedInto]
    );
}

async function createFixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-global-membership-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    const authInfoDir = path.join(directory, 'auth_info');
    fs.mkdirSync(authInfoDir);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const db = await open({ filename: databasePath, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            display_name TEXT,
            nome TEXT,
            esquadrao TEXT,
            ficha_status TEXT,
            jogo_status TEXT,
            identity_status TEXT,
            lifecycle_status TEXT,
            is_shadow INTEGER DEFAULT 0,
            merged_into TEXT DEFAULT NULL
        );
        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE TABLE clover_squad_memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            squad_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL,
            joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
            ended_at TEXT DEFAULT NULL,
            changed_by TEXT,
            reason TEXT,
            metadata_json TEXT
        );
        CREATE TABLE clover_squad_membership_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            membership_id INTEGER,
            squad_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            action TEXT NOT NULL,
            performed_by TEXT,
            reason TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT
        );
        INSERT INTO clover_squads (squad_key, name, status) VALUES
            ('alpha_knights', 'Alpha Knights', 'active'),
            ('beta_guard', 'Beta Guard', 'active'),
            ('archived_order', 'Archived Order', 'archived');
    `);

    const players = [
        { id: '10000001@s.whatsapp.net', name: 'Ready Same' },
        { id: '10000015@s.whatsapp.net', name: 'Ready Transfer' },
        { id: '10000002@s.whatsapp.net', name: 'Already Canonical' },
        { id: '10000003@s.whatsapp.net', name: 'Membership Conflict' },
        { id: '10000004@s.whatsapp.net', name: 'Multiple Memberships' },
        { id: '10000005@s.whatsapp.net', name: 'Unknown Squad', squad: 'Missing Squad' },
        { id: '10000006@s.whatsapp.net', name: 'Inactive Squad', squad: 'Archived Order' },
        { id: '10000007@s.whatsapp.net', name: 'Archived Identity', identity: 'archived' },
        { id: '10000008@s.whatsapp.net', name: 'Shadow Identity', shadow: 1 },
        { id: '10000009@s.whatsapp.net', name: 'Merged Identity', mergedInto: '10000999@s.whatsapp.net' },
        { id: '10000010@s.whatsapp.net', name: 'Sheet Pending', ficha: 'pendente' },
        { id: '10000011@s.whatsapp.net', name: 'Game Blocked', jogo: 'bloqueado' },
        { id: '10000012@s.whatsapp.net', name: 'Without Projection', squad: '-' },
        { id: 'projection-only-record', name: 'Invalid Identity Projection' },
        { id: '10000013@s.whatsapp.net', name: 'Ambiguous Phone' },
        { id: '20000013@lid', name: 'Ambiguous Lid' },
        { id: '10000014@s.whatsapp.net', name: 'Duplicate Canonical' },
        { id: '20000014@lid', name: 'Duplicate Archived', identity: 'archived' },
        { id: '10000016@s.whatsapp.net', name: 'Phone Without Lid Row' },
        { id: '20000017@lid', name: 'Executable Lid Row' },
        { id: '10000018@s.whatsapp.net', name: 'Inactive Lifecycle', lifecycle: 'inactive' },
        { id: '10000019@s.whatsapp.net', name: 'Membership Under Alias' },
    ];
    for (const player of players) await addPlayer(db, player);

    await db.exec(`
        INSERT INTO clover_squad_memberships (squad_key, player_id, status, changed_by)
        VALUES
            ('alpha_knights', '10000002@s.whatsapp.net', 'active', 'fixture'),
            ('beta_guard', '10000003@s.whatsapp.net', 'active', 'fixture'),
            ('alpha_knights', '10000004@s.whatsapp.net', 'active', 'fixture'),
            ('beta_guard', '10000004@s.whatsapp.net', 'active', 'fixture'),
            ('alpha_knights', '20000019@lid', 'active', 'fixture'),
            ('beta_guard', '10000001@s.whatsapp.net', 'removed', 'fixture');
        INSERT INTO clover_squad_membership_events
            (membership_id, squad_key, player_id, action, performed_by)
        VALUES (5, 'beta_guard', '10000001@s.whatsapp.net', 'removed', 'fixture');
    `);
    writeIdentityMapping(authInfoDir, '10000013', '20000013');
    writeIdentityMapping(authInfoDir, '10000014', '20000014');
    writeIdentityMapping(authInfoDir, '10000016', '20000016');
    writeIdentityMapping(authInfoDir, '10000017', '20000017');
    writeIdentityMapping(authInfoDir, '10000019', '20000019');
    await db.close();
    return { directory, databasePath, authInfoDir };
}

async function loadPlan(fixture) {
    const db = await openReadOnlyDatabase(fixture.databasePath);
    try {
        return await planGlobalMembershipBackfill(db, {
            authInfoDir: fixture.authInfoDir,
            generatedAt: FIXED_TIME,
        });
    } finally {
        await db.close();
    }
}

function itemFor(plan, playerId) {
    return plan.items.find((item) => item.playerId === playerId);
}

test('classifica globalmente todas as categorias e preserva proposta deterministica', async (t) => {
    const fixture = await createFixture(t);
    const plan = await loadPlan(fixture);

    assert.deepEqual(plan.categories, CATEGORIES);
    assert.equal(plan.readOnly, true);
    assert.equal(plan.queryOnly, true);
    assert.equal(plan.SafeToApply, false);
    assert.equal(plan.SafeToDeploy, false);
    assert.equal(plan.totals.playersRead, 22);
    assert.equal(plan.totals.identityComponentsRead, 20);
    assert.equal(plan.totals.withLegacyProjection, 21);
    assert.equal(plan.totals.withoutLegacyProjection, 1);
    assert.equal(plan.totals.activeMemberships, 5);
    assert.equal(plan.totals.multipleActiveMembershipIdentities, 1);
    assert.equal(plan.totals.duplicateIdentityComponents, 1);
    assert.equal(plan.totals.duplicateIdentityRecords, 2);
    assert.equal(plan.totals.ambiguousIdentityComponents, 1);
    assert.equal(plan.totals.ambiguousIdentityRecords, 2);

    assert.equal(itemFor(plan, '10000001@s.whatsapp.net').category, 'ready_for_membership_backfill');
    assert.equal(itemFor(plan, '10000015@s.whatsapp.net').category, 'ready_for_membership_backfill');
    assert.equal(itemFor(plan, '10000002@s.whatsapp.net').category, 'already_canonical');
    assert.equal(itemFor(plan, '10000003@s.whatsapp.net').category, 'active_membership_conflict');
    assert.equal(itemFor(plan, '10000004@s.whatsapp.net').category, 'multiple_active_memberships');
    assert.equal(itemFor(plan, '10000005@s.whatsapp.net').category, 'unknown_squad');
    assert.equal(itemFor(plan, '10000006@s.whatsapp.net').category, 'projection_without_valid_squad');
    assert.equal(itemFor(plan, '10000007@s.whatsapp.net').category, 'ineligible');
    assert.equal(itemFor(plan, '10000008@s.whatsapp.net').category, 'ineligible');
    assert.equal(itemFor(plan, '10000009@s.whatsapp.net').category, 'ineligible');
    assert.equal(itemFor(plan, '10000010@s.whatsapp.net').category, 'ineligible');
    assert.equal(itemFor(plan, '10000011@s.whatsapp.net').category, 'ineligible');
    assert.equal(itemFor(plan, 'projection-only-record').category, 'ineligible');
    assert.equal(itemFor(plan, '10000012@s.whatsapp.net').category, 'no_legacy_projection');
    assert.equal(itemFor(plan, '10000013@s.whatsapp.net').category, 'identity_ambiguous');
    assert.equal(itemFor(plan, '20000013@lid').category, 'identity_ambiguous');
    assert.equal(itemFor(plan, '10000014@s.whatsapp.net').category, 'duplicate_identity');
    assert.equal(itemFor(plan, '20000014@lid').category, 'duplicate_identity');
    assert.equal(itemFor(plan, '10000016@s.whatsapp.net').category, 'canonical_player_row_missing');
    assert.equal(itemFor(plan, '20000017@lid').category, 'ready_for_membership_backfill');
    assert.equal(itemFor(plan, '10000018@s.whatsapp.net').category, 'ineligible');
    assert.equal(itemFor(plan, '10000019@s.whatsapp.net').category, 'already_canonical');

    const ready = plan.readyCandidates.find((candidate) => candidate.selected_player_row_id === '10000001@s.whatsapp.net');
    assert.equal(ready.canonical_identity, '10000001@s.whatsapp.net');
    assert.equal(ready.proposed_membership_player_id, '10000001@s.whatsapp.net');
    assert.equal(ready.proposed_squad_key, 'alpha_knights');
    assert.equal(ready.projection_source.field, 'esquadrao');
    assert.equal(ready.future_write_preconditions.length, 6);
    assert.match(ready.proposed_idempotency_key, /^membership-backfill:[a-f0-9]{32}$/);
    assert.equal(ready.history_preservation.strategy, 'append_only_membership_and_event');
    assert.equal(ready.history_preservation.prior_membership_rows, 1);
    assert.equal(ready.history_preservation.prior_event_rows, 1);

    const lidReady = plan.readyCandidates.find((candidate) => candidate.selected_player_row_id === '20000017@lid');
    assert.equal(lidReady.canonical_identity, '20000017@lid');
    assert.equal(lidReady.proposed_membership_player_id, '20000017@lid');
    const identities = plan.readyCandidates.map((candidate) => candidate.canonical_identity);
    const keys = plan.readyCandidates.map((candidate) => candidate.proposed_idempotency_key);
    assert.equal(new Set(identities).size, identities.length);
    assert.equal(new Set(keys).size, keys.length);
});

test('explica inelegibilidade com motivos estruturados', async (t) => {
    const fixture = await createFixture(t);
    const plan = await loadPlan(fixture);

    assert.ok(itemFor(plan, '10000007@s.whatsapp.net').reasons.includes('identity_not_active'));
    assert.ok(itemFor(plan, '10000008@s.whatsapp.net').reasons.includes('shadow_identity'));
    assert.ok(itemFor(plan, '10000009@s.whatsapp.net').reasons.includes('identity_merged'));
    assert.ok(itemFor(plan, '10000010@s.whatsapp.net').reasons.includes('sheet_not_approved'));
    assert.ok(itemFor(plan, '10000011@s.whatsapp.net').reasons.includes('game_not_released'));
    assert.ok(itemFor(plan, 'projection-only-record').reasons.includes('invalid_identity'));
    assert.ok(itemFor(plan, '10000018@s.whatsapp.net').reasons.includes('lifecycle_not_active'));
    assert.ok(itemFor(plan, '10000016@s.whatsapp.net').reasons.includes('membership_normalization_has_no_player_row'));
});

test('saida e resumo sanitizado sao deterministas e nao vazam identidades', async (t) => {
    const fixture = await createFixture(t);
    const first = await loadPlan(fixture);
    const second = await loadPlan(fixture);
    assert.deepEqual(first, second);

    const summary = buildSanitizedSummary(first);
    const serialized = JSON.stringify(summary);
    assert.doesNotMatch(serialized, /@(?:lid|s\.whatsapp\.net)/i);
    assert.doesNotMatch(serialized, /\b(?:100000|200000)\d+\b/);
    assert.equal(summary.SafeToApply, false);
    assert.equal(summary.SafeToDeploy, false);
});

test('abre SQLite read-only, ativa query_only e preserva hash do banco', async (t) => {
    const fixture = await createFixture(t);
    const before = fileHash(fixture.databasePath);
    const db = await openReadOnlyDatabase(fixture.databasePath);
    const plan = await planGlobalMembershipBackfill(db, {
        authInfoDir: fixture.authInfoDir,
        generatedAt: FIXED_TIME,
    });
    const pragma = await db.get('PRAGMA query_only');
    assert.equal(Number(pragma.query_only), 1);
    assert.equal(plan.queryOnly, true);
    await assert.rejects(
        db.run("UPDATE jogadores SET esquadrao = 'Beta Guard' WHERE id = '10000001@s.whatsapp.net'"),
        /readonly|read-only|attempt to write/i
    );
    await db.close();
    assert.equal(fileHash(fixture.databasePath), before);
});

test('CLI grava apenas relatorio privado, imprime resumo sanitizado e nao muda o banco', async (t) => {
    const fixture = await createFixture(t);
    const output = path.join(fixture.directory, 'private-report.json');
    const before = fileHash(fixture.databasePath);
    const child = spawnSync(process.execPath, [
        SCRIPT,
        `--db=${fixture.databasePath}`,
        `--auth-info-dir=${fixture.authInfoDir}`,
        `--output=${output}`,
    ], { encoding: 'utf8' });

    assert.equal(child.status, 0, child.stderr);
    assert.equal(fileHash(fixture.databasePath), before);
    assert.doesNotMatch(child.stdout, /@(?:lid|s\.whatsapp\.net)/i);
    const summary = JSON.parse(child.stdout);
    const privateReport = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(summary.SafeToApply, false);
    assert.equal(summary.SafeToDeploy, false);
    assert.equal(summary.databaseUnchanged, true);
    assert.equal(privateReport.database.unchanged, true);
    assert.equal(privateReport.database.openedReadOnly, true);
    assert.ok(privateReport.readyCandidates.some((candidate) => candidate.canonical_identity.includes('@')));
});

test('recusa relatorio dentro do repositorio e Apply permanece indisponivel', async (t) => {
    const fixture = await createFixture(t);
    const internalOutput = path.resolve(__dirname, '..', 'forbidden-private-report.json');
    const outputAttempt = spawnSync(process.execPath, [
        SCRIPT,
        `--db=${fixture.databasePath}`,
        `--auth-info-dir=${fixture.authInfoDir}`,
        `--output=${internalOutput}`,
    ], { encoding: 'utf8' });
    assert.equal(outputAttempt.status, 1);
    assert.match(outputAttempt.stderr, /fora do repositorio/i);
    assert.equal(fs.existsSync(internalOutput), false);

    assert.throws(
        () => applyGlobalMembershipBackfill(),
        (error) => error.code === 'apply_unavailable'
    );
    const child = spawnSync(process.execPath, [SCRIPT, '--apply'], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /apply_unavailable/);
});

test('projeta em memoria o efeito do backfill sobre a reestruturacao da PR 202', async (t) => {
    const fixture = await createFixture(t);
    const db = await openReadOnlyDatabase(fixture.databasePath);
    try {
        const globalPlan = await planGlobalMembershipBackfill(db, {
            authInfoDir: fixture.authInfoDir,
            generatedAt: FIXED_TIME,
        });
        const projection = await projectRestructureAfterBackfill(db, globalPlan, {
            authInfoDir: fixture.authInfoDir,
            restructureTargets: {
                source: 'unit-test',
                squads: {
                    alpha_knights: {
                        name: 'Alpha Knights',
                        entries: [
                            { personagem: 'Ready Same' },
                            { personagem: 'Without Projection' },
                        ],
                    },
                    beta_guard: {
                        name: 'Beta Guard',
                        entries: [{ personagem: 'Ready Transfer' }],
                    },
                },
            },
        });

        assert.equal(projection.readOnly, true);
        assert.equal(projection.SafeToApply, false);
        assert.equal(projection.SafeToDeploy, false);
        assert.equal(projection.beforeCounts.membership_conflict, 2);
        assert.equal(projection.beforeCounts.needs_admission, 1);
        assert.equal(projection.afterCounts.already_correct, 1);
        assert.equal(projection.afterCounts.needs_transfer, 1);
        assert.equal(projection.afterCounts.needs_admission, 1);
        assert.equal(projection.transitions['membership_conflict->already_correct'], 1);
        assert.equal(projection.transitions['membership_conflict->needs_transfer'], 1);
        assert.equal(projection.extrasBefore, projection.extrasAfter);
    } finally {
        await db.close();
    }
});
