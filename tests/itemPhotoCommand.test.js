'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sharp = require('sharp');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const command = require('../comandos/fotoitem');
const {
    ItemPhotoError,
    optimizeItemImage,
    parseRequest,
    resolveOwnedItem,
    saveItemPhoto,
} = command._test;

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_inventory_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            item_name TEXT NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'disponivel',
            equipped_slot TEXT DEFAULT NULL,
            properties_json TEXT NOT NULL DEFAULT '{}',
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    await db.run(
        `INSERT INTO clover_inventory_items
         (id, player_id, item_name, properties_json)
         VALUES (?, ?, ?, ?)`,
        [40, 'killian@lid', 'Roupas Nobres', JSON.stringify({ luxo: true, origem: 'Clover' })]
    );
    return db;
}

test('interpreta inclusão e remoção sem confundir o nome do item', () => {
    assert.deepEqual(parseRequest('40'), { remove: false, target: '40' });
    assert.deepEqual(parseRequest('remover Roupas Nobres'), { remove: true, target: 'Roupas Nobres' });
});

test('resolve somente item pertencente ao jogador', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const byId = await resolveOwnedItem(db, 'killian@lid', '#40');
    assert.equal(byId.item_name, 'Roupas Nobres');

    const byName = await resolveOwnedItem(db, 'killian@lid', 'roupas nobres');
    assert.equal(Number(byName.id), 40);

    await assert.rejects(
        () => resolveOwnedItem(db, 'outro@lid', '40'),
        (error) => error instanceof ItemPhotoError && error.code === 'item_not_found'
    );
});

test('otimiza a imagem e preserva propriedades do exemplar', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const source = await sharp({
        create: {
            width: 120,
            height: 90,
            channels: 3,
            background: { r: 80, g: 30, b: 15 },
        },
    }).png().toBuffer();

    const image = await optimizeItemImage(source, 'image/png');
    assert.match(image, /^data:image\/webp;base64,/);
    assert.ok(Buffer.from(image.split(',')[1], 'base64').length <= 180 * 1024);

    const updated = await saveItemPhoto(db, 'killian@lid', 40, image);
    assert.equal(updated.id, 40);
    assert.equal(updated.properties.luxo, true);
    assert.equal(updated.properties.origem, 'Clover');
    assert.equal(updated.properties.image, image);
    assert.equal(updated.properties.player_image_source, 'whatsapp_upload');

    const row = await db.get('SELECT properties_json FROM clover_inventory_items WHERE id = 40');
    const properties = JSON.parse(row.properties_json);
    assert.equal(properties.luxo, true);
    assert.equal(properties.image, image);
});

test('remover a foto não apaga as outras propriedades do item', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.run(
        `UPDATE clover_inventory_items
         SET properties_json = ?
         WHERE id = 40`,
        [JSON.stringify({ luxo: true, image: 'data:image/webp;base64,UklGRg==', player_image_source: 'whatsapp_upload' })]
    );

    const updated = await saveItemPhoto(db, 'killian@lid', 40, null);
    assert.equal(updated.image, null);
    assert.equal(updated.properties.luxo, true);
    assert.equal(Object.hasOwn(updated.properties, 'image'), false);
    assert.equal(Object.hasOwn(updated.properties, 'player_image_source'), false);
});
