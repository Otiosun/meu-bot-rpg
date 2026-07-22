'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { loadCloverConfigs } = require('../helpers/clover/configLoader');
const {
    filterAvailableMagicRarities,
    filterAvailableSlotOptions,
} = require('../helpers/clover/rollEngine');
const {
    clearPendingMagicConfirmation,
    getMagicAvailability,
    renderMagicChoicePrompt,
    savePendingMagicConfirmation,
} = require('../helpers/magicManager');
const { renderRacesText } = require('../helpers/clover/systemMessages');
const { parseTraitAttemptBody } = require('../comandos/tracos');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            ficha_status TEXT DEFAULT 'incompleta',
            magia TEXT DEFAULT '-',
            magia_key TEXT DEFAULT NULL,
            raca TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            familia TEXT DEFAULT '-',
            familia_key TEXT DEFAULT NULL,
            anomalia TEXT DEFAULT '-',
            anomalia_key TEXT DEFAULT NULL
        );

        CREATE TABLE slot_reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            category TEXT NOT NULL,
            option_key TEXT NOT NULL,
            status TEXT NOT NULL,
            source TEXT DEFAULT NULL,
            roll_number INTEGER DEFAULT NULL,
            expires_at TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            confirmed_at TEXT DEFAULT NULL
        );

        CREATE TABLE pending_magic_confirmations (
            player_id TEXT PRIMARY KEY,
            magic_label TEXT NOT NULL,
            roll_number INTEGER DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        INSERT INTO jogadores (id) VALUES ('p1');
        INSERT INTO jogadores (id) VALUES ('p2');
    `);
    return db;
}

async function fillOption(db, category, optionKey, capacity) {
    for (let index = 0; index < Number(capacity || 0); index += 1) {
        await db.run(
            `INSERT INTO slot_reservations
             (player_id, category, option_key, status, source, created_at)
             VALUES (?, ?, ?, 'confirmed', 'test', CURRENT_TIMESTAMP)`,
            [`ghost:${category}:${optionKey}:${index}`, category, optionKey]
        );
    }
}

test('raridade lendaria sai do roll quando todas as magias lendarias estao lotadas', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const config = loadCloverConfigs({ forceReload: true });

    for (const magic of config.lists.magics.filter((item) => item.rarity === 'Lendaria')) {
        await fillOption(db, 'magic', magic.key, magic.capacity);
    }

    const available = await filterAvailableMagicRarities(
        db,
        config,
        config.lists.magicRarities,
        { kingdomKey: 'clover' }
    );

    assert.equal(available.some((item) => item.key === 'lendaria'), false);
    assert.equal(available.some((item) => item.key === 'comum'), true);
});

test('racas limitadas lotadas nao voltam ao pool por fallback', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const config = loadCloverConfigs({ forceReload: true });
    const cloverRaces = config.lists.races.filter((race) => Number(race.weightsByKingdom?.clover || 0) > 0);

    for (const race of cloverRaces.filter((item) => item.capacity)) {
        await fillOption(db, 'race', race.key, race.capacity);
    }

    const available = await filterAvailableSlotOptions(db, 'race', cloverRaces);
    assert.deepEqual(available.map((item) => item.key), ['humano']);
});

test('escolha de magia limitada reserva a vaga durante uma hora', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const first = await savePendingMagicConfirmation(db, 'p1', 'Magia de Árvore Mundial', 1);
    assert.equal(first.ok, true);

    const blocked = await getMagicAvailability(db, 'Magia de Árvore Mundial', 'p2');
    assert.equal(blocked.capacity, 1);
    assert.equal(blocked.usedCount, 1);
    assert.equal(blocked.available, false);

    const prompt = await renderMagicChoicePrompt(db, { magic_rarity: 'Lendaria' });
    assert.match(prompt, /Magia de Árvore Mundial \*\(1\/1\)\* · esgotada/);

    await clearPendingMagicConfirmation(db, 'p1');
    const released = await getMagicAvailability(db, 'Magia de Árvore Mundial', 'p2');
    assert.equal(released.available, true);
    assert.equal(released.usedCount, 0);
});

test('mensagem de racas usa contagem real e marca vaga esgotada', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const config = loadCloverConfigs({ forceReload: true });
    const elf = config.maps.races.get('elfo');
    await fillOption(db, 'race', elf.key, elf.capacity);

    const text = await renderRacesText(db);
    assert.match(text, /\[5\/5 · esgotado\]/);
});

test('aliases do sorteio de tracos aceitam formas curtas e explicitas', () => {
    assert.equal(parseTraitAttemptBody('tentar aptidao'), 'aptidao');
    assert.equal(parseTraitAttemptBody('sortear traço marca rara'), 'marca rara');
    assert.equal(parseTraitAttemptBody('roll anomalia'), 'anomalia');
    assert.equal(parseTraitAttemptBody('apt rara'), 'apt rara');
    assert.equal(parseTraitAttemptBody('qualquer coisa'), null);
});
