'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const {
    PROFILE_PRESENTATION_KEY,
    PROFILE_PRESENTATION_MIGRATION,
    PROFILE_PRESENTATION_OBJECTS,
    PROFILE_PRESENTATION_VERSION,
    inspectProfilePresentationSchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');

async function openFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0031-profile-'));
    const db = await openCloverDatabase({ filename: path.join(dir, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

test('0031 formaliza uma tabela própria para preferências de apresentação', () => {
    assert.equal(PROFILE_PRESENTATION_VERSION, 31);
    assert.equal(PROFILE_PRESENTATION_KEY, '0031_profile_presentation_preferences');
    assert.equal(PROFILE_PRESENTATION_OBJECTS.length, 1);
    assert.equal(PROFILE_PRESENTATION_OBJECTS[0].name, 'clover_profile_presentations');
});

test('0031 cria schema exato sem depender de colunas mecânicas de jogadores', async (t) => {
    const db = await openFixture(t);
    assert.equal((await inspectProfilePresentationSchemaState(db)).kind, 'absent');

    await PROFILE_PRESENTATION_MIGRATION.up(db);

    assert.equal((await inspectProfilePresentationSchemaState(db)).kind, 'exact');
    const columns = await db.all('PRAGMA table_info(clover_profile_presentations)');
    assert.deepEqual(
        columns.map((row) => row.name),
        ['player_id', 'schema_version', 'preferences_json', 'created_at', 'updated_at'],
    );
});

test('0031 é no-op quando o schema já é exato e preserva preferências existentes', async (t) => {
    const db = await openFixture(t);
    await PROFILE_PRESENTATION_MIGRATION.up(db);
    await db.run(
        `INSERT INTO clover_profile_presentations
         (player_id, schema_version, preferences_json)
         VALUES (?, ?, ?)`,
        ['player-1', 'profile-presentation.v1', '{"accent":"violet"}'],
    );
    const before = await db.get('SELECT * FROM clover_profile_presentations WHERE player_id = ?', ['player-1']);

    await PROFILE_PRESENTATION_MIGRATION.up(db);

    assert.deepEqual(
        await db.get('SELECT * FROM clover_profile_presentations WHERE player_id = ?', ['player-1']),
        before,
    );
});

test('0031 falha fechado para tabela parcial ou divergente', async (t) => {
    const db = await openFixture(t);
    await db.exec('CREATE TABLE clover_profile_presentations (player_id TEXT PRIMARY KEY, preferences_json TEXT)');

    await assert.rejects(
        PROFILE_PRESENTATION_MIGRATION.up(db),
        (error) => error?.code === 'profile_presentation_schema_mapping_required',
    );
    assert.equal((await inspectProfilePresentationSchemaState(db)).kind, 'partial_or_divergent');
});
