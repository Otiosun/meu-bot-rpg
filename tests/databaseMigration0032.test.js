'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const {
    PROFILE_MEDIA_KEY,
    PROFILE_MEDIA_MIGRATION,
    PROFILE_MEDIA_OBJECTS,
    PROFILE_MEDIA_VERSION,
    inspectProfileMediaSchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');

async function openFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-db-0032-media-'));
    const db = await openCloverDatabase({ filename: path.join(dir, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

test('0032 formaliza tabela própria para avatar e banner file-backed', () => {
    assert.equal(PROFILE_MEDIA_VERSION, 32);
    assert.equal(PROFILE_MEDIA_KEY, '0032_profile_media');
    assert.equal(PROFILE_MEDIA_OBJECTS.length, 1);
    assert.equal(PROFILE_MEDIA_OBJECTS[0].name, 'clover_profile_media');
});

test('0032 cria schema exato com metadados de arquivo e crop', async (t) => {
    const db = await openFixture(t);
    assert.equal((await inspectProfileMediaSchemaState(db)).kind, 'absent');

    await PROFILE_MEDIA_MIGRATION.up(db);

    assert.equal((await inspectProfileMediaSchemaState(db)).kind, 'exact');
    const columns = await db.all('PRAGMA table_info(clover_profile_media)');
    assert.deepEqual(
        columns.map((row) => row.name),
        [
            'player_id', 'kind', 'mime_type', 'storage_key', 'byte_size',
            'width', 'height', 'sha256', 'focal_x', 'focal_y', 'zoom',
            'created_at', 'updated_at',
        ],
    );
    const pk = columns.filter((row) => Number(row.pk) > 0).sort((a, b) => a.pk - b.pk);
    assert.deepEqual(pk.map((row) => row.name), ['player_id', 'kind']);
});

test('0032 é idempotente e preserva metadados existentes', async (t) => {
    const db = await openFixture(t);
    await PROFILE_MEDIA_MIGRATION.up(db);
    await db.run(
        `INSERT INTO clover_profile_media
         (player_id, kind, mime_type, storage_key, byte_size, width, height, sha256, focal_x, focal_y, zoom)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['p1', 'banner', 'image/webp', 'safe.webp', 123, 800, 400, 'a'.repeat(64), 0.2, 0.7, 1.4],
    );
    const before = await db.get('SELECT * FROM clover_profile_media WHERE player_id = ? AND kind = ?', ['p1', 'banner']);

    await PROFILE_MEDIA_MIGRATION.up(db);

    assert.deepEqual(
        await db.get('SELECT * FROM clover_profile_media WHERE player_id = ? AND kind = ?', ['p1', 'banner']),
        before,
    );
});

test('0032 falha fechado em schema parcial ou divergente', async (t) => {
    const db = await openFixture(t);
    await db.exec('CREATE TABLE clover_profile_media (player_id TEXT, kind TEXT)');

    await assert.rejects(
        PROFILE_MEDIA_MIGRATION.up(db),
        (error) => error?.code === 'profile_media_schema_mapping_required',
    );
    assert.equal((await inspectProfileMediaSchemaState(db)).kind, 'partial_or_divergent');
});
