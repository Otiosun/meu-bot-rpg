'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const database = require('../database');
const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const { CURRENT_SCHEMA_MIGRATIONS } = require('../helpers/clover/schemaMigrationCatalog');
const { MIGRATED_BASE_TABLES } = require('../helpers/clover/schemaBaseCatalog');
const {
    MIGRATION_TABLE,
    columnExists,
    tableExists,
} = require('../helpers/clover/schemaMigrationService');
const {
    collectMigratedColumnTargets,
    findCreateTableBody,
} = require('../helpers/clover/schemaBaseConsolidationAudit');
const {
    DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS,
    prebootstrapCloverSchemaBeforeLegacy,
} = require('../helpers/clover/schemaBasePrebootstrapService');

function tempDatabasePath(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-prebootstrap-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'database.sqlite');
}

function normalizeSql(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

test('catálogo base reproduz os 13 CREATE TABLE canônicos do legacy atual', () => {
    const legacySource = fs.readFileSync(path.join(__dirname, '..', 'database', 'legacy.js'), 'utf8');
    assert.equal(MIGRATED_BASE_TABLES.length, 13);
    for (const entry of MIGRATED_BASE_TABLES) {
        const legacyBody = findCreateTableBody(legacySource, entry.table);
        const openParen = entry.sql.indexOf('(');
        const closeParen = entry.sql.lastIndexOf(')');
        const catalogBody = openParen >= 0 && closeParen > openParen
            ? entry.sql.slice(openParen + 1, closeParen)
            : null;
        assert.ok(legacyBody, `CREATE ausente no legacy: ${entry.table}`);
        assert.ok(catalogBody, `CREATE ausente no catálogo: ${entry.table}`);
        assert.equal(normalizeSql(catalogBody), normalizeSql(legacyBody), entry.table);
    }
});

test('pre-bootstrap vazio cria 13 bases + 53 colunas sem ledger nem user_version', async (t) => {
    const filename = tempDatabasePath(t);
    const db = await openCloverDatabase({ filename });
    t.after(() => db.close());

    const result = await prebootstrapCloverSchemaBeforeLegacy(db, {
        migrations: CURRENT_SCHEMA_MIGRATIONS,
    });

    assert.equal(result.prebootstrappedBeforeLegacy, true);
    assert.equal(result.baseTablesCreatedOrPresent, 13);
    assert.equal(result.transientMigrationCount, 7);
    assert.deepEqual(result.transientMigrations.map((item) => item.key), DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);

    for (const entry of MIGRATED_BASE_TABLES) {
        assert.equal(await tableExists(db, entry.table), true, entry.table);
    }
    for (const target of collectMigratedColumnTargets()) {
        assert.equal(await columnExists(db, target.table, target.column), true, `${target.table}.${target.column}`);
    }

    const second = await prebootstrapCloverSchemaBeforeLegacy(db, {
        migrations: CURRENT_SCHEMA_MIGRATIONS,
    });
    assert.equal(second.afterFingerprint, result.afterFingerprint);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('pre-bootstrap rollback remove inclusive tabelas-base criadas na mesma transação', async (t) => {
    const filename = tempDatabasePath(t);
    const db = await openCloverDatabase({ filename });
    t.after(() => db.close());

    const failing = {
        version: 9,
        key: '0099_test_prebootstrap_failure',
        description: 'fixture de rollback',
        async up(connection) {
            await connection.exec('CREATE TABLE prebootstrap_should_rollback (id INTEGER PRIMARY KEY)');
            throw new Error('forced rollback');
        },
    };

    await assert.rejects(
        prebootstrapCloverSchemaBeforeLegacy(db, {
            migrations: [...CURRENT_SCHEMA_MIGRATIONS, failing],
            migrationKeys: [...DEFAULT_PREBOOTSTRAP_MIGRATION_KEYS, failing.key],
        }),
        /forced rollback/
    );

    assert.equal(await tableExists(db, 'clover_inventory_items'), false);
    assert.equal(await tableExists(db, 'prebootstrap_should_rollback'), false);
    assert.equal(await tableExists(db, MIGRATION_TABLE), false);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 0);
});

test('pre-bootstrap rejeita estado não adotado com user_version diferente de zero', async (t) => {
    const filename = tempDatabasePath(t);
    const db = await openCloverDatabase({ filename });
    t.after(() => db.close());
    await db.exec('PRAGMA user_version = 3');

    await assert.rejects(
        prebootstrapCloverSchemaBeforeLegacy(db, { migrations: CURRENT_SCHEMA_MIGRATIONS }),
        (error) => error?.code === 'canonical_prebootstrap_state_incompatible'
            && error?.userVersion === 3
    );
});

test('database.js executa pre-bootstrap antes do legacy e só formaliza ledger depois', async (t) => {
    const filename = tempDatabasePath(t);
    let observedBeforeLegacy = false;

    const openAtFixture = (options = {}) => openCloverDatabase({ ...options, filename });
    const createLegacyDatabase = async () => {
        const connection = await openAtFixture();
        observedBeforeLegacy = await columnExists(connection, 'clover_inventory_items', 'template_key')
            && await columnExists(connection, 'clover_item_templates', 'requestable')
            && await columnExists(connection, 'player_onboarding', 'step_payload');
        assert.equal(await tableExists(connection, MIGRATION_TABLE), false);
        assert.equal(Number(await readPragmaScalar(connection, 'user_version')), 0);
        return connection;
    };

    const db = await database.criarBanco({
        createLegacyDatabase,
        openMigrationDatabase: openAtFixture,
        migrations: CURRENT_SCHEMA_MIGRATIONS,
        canonicalPrebootstrap: true,
    });
    t.after(() => db.close());

    assert.equal(observedBeforeLegacy, true);
    assert.equal(Number(await readPragmaScalar(db, 'user_version')), 8);
    const rows = await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`);
    assert.deepEqual(rows.map((row) => Number(row.version)), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('bootstrap real completo em diretório vazio formaliza 0001→0008 depois do pre-bootstrap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-real-empty-'));
    try {
        const databaseModule = path.join(__dirname, '..', 'database.js');
        const script = `
            const { criarBanco } = require(${JSON.stringify(databaseModule)});
            (async () => {
                const db = await criarBanco();
                try {
                    const uv = await db.get('PRAGMA user_version');
                    const ledger = await db.all('SELECT version FROM clover_schema_migrations ORDER BY version');
                    const tables = await db.get("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'");
                    const quick = await db.get('PRAGMA quick_check');
                    const integrity = await db.get('PRAGMA integrity_check');
                    const fk = await db.all('PRAGMA foreign_key_check');
                    process.stdout.write(JSON.stringify({
                        userVersion: Number(Object.values(uv)[0]),
                        ledger: ledger.map((row) => Number(row.version)),
                        tables: Number(tables.n),
                        quick: quick.quick_check,
                        integrity: integrity.integrity_check,
                        fk: fk.length,
                    }));
                } finally { await db.close(); }
            })().catch((error) => { console.error(error); process.exit(1); });
        `;
        const output = execFileSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8' });
        const result = JSON.parse(output);
        assert.equal(result.userVersion, 8);
        assert.deepEqual(result.ledger, [1, 2, 3, 4, 5, 6, 7, 8]);
        assert.equal(result.tables >= 69, true);
        assert.equal(result.quick, 'ok');
        assert.equal(result.integrity, 'ok');
        assert.equal(result.fk, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('upgrade real preserva dados de schema antigo sem ledger', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-real-upgrade-'));
    const filename = path.join(dir, 'banco.sqlite');
    try {
        const seed = await openCloverDatabase({ filename });
        await require('../helpers/clover/schemaBaseCatalog').ensureCanonicalMigratedBaseTables(seed);
        await seed.run(
            'INSERT INTO player_onboarding (player_id, current_step) VALUES (?, ?)',
            ['legacy-player', 'recepcao']
        );
        await seed.run(
            'INSERT INTO clover_inventory_items (player_id, item_name, quantity, kind, created_at) VALUES (?, ?, ?, ?, ?)',
            ['legacy-player', 'Item Antigo', 2, 'material', '2026-01-01 00:00:00']
        );
        await seed.close();

        const databaseModule = path.join(__dirname, '..', 'database.js');
        const script = `
            const { criarBanco } = require(${JSON.stringify(databaseModule)});
            (async () => {
                const db = await criarBanco();
                try {
                    const uv = await db.get('PRAGMA user_version');
                    const onb = await db.get("SELECT player_id, current_step, step_payload FROM player_onboarding WHERE player_id='legacy-player'");
                    const item = await db.get("SELECT player_id, item_name, quantity, kind, category, status, quality, reference_price, created_at FROM clover_inventory_items WHERE player_id='legacy-player'");
                    const ledger = await db.all('SELECT version FROM clover_schema_migrations ORDER BY version');
                    const quick = await db.get('PRAGMA quick_check');
                    const integrity = await db.get('PRAGMA integrity_check');
                    const fk = await db.all('PRAGMA foreign_key_check');
                    process.stdout.write(JSON.stringify({
                        userVersion: Number(Object.values(uv)[0]),
                        onboarding: onb,
                        item,
                        ledger: ledger.map((row) => Number(row.version)),
                        quick: quick.quick_check,
                        integrity: integrity.integrity_check,
                        fk: fk.length,
                    }));
                } finally { await db.close(); }
            })().catch((error) => { console.error(error); process.exit(1); });
        `;
        const output = execFileSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8' });
        const result = JSON.parse(output);
        assert.equal(result.userVersion, 8);
        assert.deepEqual(result.ledger, [1, 2, 3, 4, 5, 6, 7, 8]);
        assert.deepEqual(result.onboarding, {
            player_id: 'legacy-player',
            current_step: 'recepcao',
            step_payload: '{}',
        });
        assert.equal(result.item.player_id, 'legacy-player');
        assert.equal(result.item.item_name, 'Item Antigo');
        assert.equal(result.item.quantity, 2);
        assert.equal(result.item.kind, 'material');
        assert.equal(result.item.created_at, '2026-01-01 00:00:00');
        assert.equal(result.quick, 'ok');
        assert.equal(result.integrity, 'ok');
        assert.equal(result.fk, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
