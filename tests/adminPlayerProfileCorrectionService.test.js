'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    AdminPlayerProfileCorrectionError,
    createPlayerProfileCorrectionExecutors,
    normalizeProfileCorrectionPayload,
} = require('../helpers/clover/adminPlayerProfileCorrectionService');

async function makeDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            magia TEXT,
            magia_key TEXT,
            reino TEXT,
            classe TEXT,
            raca TEXT,
            grimorio TEXT,
            numero_roll_escolhido INTEGER,
            ficha_status TEXT
        );
        CREATE TABLE slot_reservations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            category TEXT NOT NULL,
            option_key TEXT NOT NULL,
            status TEXT NOT NULL,
            source TEXT,
            roll_number INTEGER,
            expires_at TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            confirmed_at TEXT
        );
    `);
    await db.run(
        `INSERT INTO jogadores
         (id, personagem_nome, magia, magia_key, reino, classe, raca, grimorio, numero_roll_escolhido, ficha_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            'player-1',
            'Noelle Silva',
            'Magia de Sombras',
            'magia_de_sombras',
            'Clover',
            'Nobreza',
            'Humano',
            'Grimório de 3 Folhas',
            1,
            'aprovada',
        ]
    );
    return db;
}

function opContext(db, action, extra = {}) {
    return {
        db,
        operation: { code: 'OP-TESTE', actor: { id: 'admin-1' } },
        action,
        target: { kind: 'player', playerId: 'player-1', characterName: 'Noelle Silva' },
        ...extra,
    };
}

test('player profile correction normalizes canonical character name and magic key', () => {
    const value = normalizeProfileCorrectionPayload({
        characterName: '  Noelle Silva  ',
        magicKey: 'magia_de_sombras',
    });
    assert.equal(value.characterName, 'Noelle Silva');
    assert.equal(value.magic.key, 'magia_de_sombras');
    assert.ok(value.magic.label);
});

test('player profile correction normalizes race grimoire and social class keys', () => {
    const value = normalizeProfileCorrectionPayload({
        raceKey: 'bruxa',
        grimoireKey: 'clover_4f',
    });
    assert.equal(value.race.key, 'bruxa');
    assert.equal(value.race.label, 'Bruxa');
    assert.equal(value.grimoire.key, 'clover_4f');
    assert.equal(value.grimoire.kingdomKey, 'clover');

    const social = normalizeProfileCorrectionPayload({ socialClassKey: 'realeza' });
    assert.equal(social.socialClass.label, 'Realeza');
});

test('player profile correction rejects unknown canonical options', () => {
    assert.throws(
        () => normalizeProfileCorrectionPayload({ magicKey: 'magia_inexistente_total' }),
        (error) => error instanceof AdminPlayerProfileCorrectionError && error.code === 'magic_not_found'
    );
    assert.throws(
        () => normalizeProfileCorrectionPayload({ raceKey: 'marciano' }),
        (error) => error?.code === 'race_not_found'
    );
    assert.throws(
        () => normalizeProfileCorrectionPayload({ grimoireKey: 'clover_99f' }),
        (error) => error?.code === 'grimoire_not_found'
    );
});

test('race and grimoire correction reserves canonical slots and undo restores previous profile', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const action = {
        type: 'player.profile.correct',
        payload: {
            raceKey: 'bruxa',
            grimoireKey: 'clover_4f',
        },
    };
    const executor = createPlayerProfileCorrectionExecutors()['player.profile.correct'];
    const preview = await executor.preview(opContext(db, action));

    assert.equal(preview.after.raceKey, 'bruxa');
    assert.equal(preview.after.classLabel, 'N/A');
    assert.equal(preview.after.grimoireKey, 'clover_4f');

    const applied = await executor.apply(opContext(db, action, {
        before: preview.before,
        after: preview.after,
    }));
    assert.equal(applied.after.raceLabel, 'Bruxa');
    assert.equal(applied.after.classLabel, 'N/A');
    assert.equal(applied.after.grimoireLabel, 'Grimório de 4 Folhas');

    const raceReservation = await db.get(
        `SELECT * FROM slot_reservations
         WHERE player_id = 'player-1' AND category = 'race' AND option_key = 'bruxa' AND status = 'confirmed'`
    );
    const grimoireReservation = await db.get(
        `SELECT * FROM slot_reservations
         WHERE player_id = 'player-1' AND category = 'grimoire' AND option_key = 'clover_4f' AND status = 'confirmed'`
    );
    assert.ok(raceReservation);
    assert.ok(grimoireReservation);

    await executor.undo(opContext(db, action, {
        before: preview.before,
        after: applied.after,
    }));
    const restored = await db.get(
        'SELECT raca, grimorio, classe FROM jogadores WHERE id = ?',
        ['player-1']
    );
    assert.equal(restored.raca, 'Humano');
    assert.equal(restored.grimorio, 'Grimório de 3 Folhas');
    assert.equal(restored.classe, 'Nobreza');
});

test('grimoire correction rejects another Kingdom', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const action = {
        type: 'player.profile.correct',
        payload: { grimoireKey: 'spade_3f' },
    };
    const executor = createPlayerProfileCorrectionExecutors()['player.profile.correct'];

    await assert.rejects(
        () => executor.preview(opContext(db, action)),
        (error) => error?.code === 'grimoire_kingdom_mismatch'
    );
});

test('human race requires a canonical social class when returning from non-human state', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    await db.run(
        `UPDATE jogadores SET raca = 'Bruxa', classe = 'N/A' WHERE id = 'player-1'`
    );

    const executor = createPlayerProfileCorrectionExecutors()['player.profile.correct'];
    await assert.rejects(
        () => executor.preview(opContext(db, {
            type: 'player.profile.correct',
            payload: { raceKey: 'humano' },
        })),
        (error) => error?.code === 'social_class_required_for_human'
    );

    const preview = await executor.preview(opContext(db, {
        type: 'player.profile.correct',
        payload: { raceKey: 'humano', socialClassKey: 'plebeu' },
    }));
    assert.equal(preview.after.raceKey, 'humano');
    assert.equal(preview.after.classKey, 'plebeu');
});

test('race correction fails closed when a limited race has no vacancy', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    for (let index = 0; index < 9; index += 1) {
        await db.run(
            `INSERT INTO slot_reservations
             (player_id, category, option_key, status, source)
             VALUES (?, 'race', 'bruxa', 'confirmed', 'fixture')`,
            [`occupied-${index}`]
        );
    }

    const executor = createPlayerProfileCorrectionExecutors()['player.profile.correct'];
    await assert.rejects(
        () => executor.preview(opContext(db, {
            type: 'player.profile.correct',
            payload: { raceKey: 'bruxa' },
        })),
        (error) => error?.code === 'race_capacity_full'
    );
});

test('player profile correction executor remains fully reversible', () => {
    const executor = createPlayerProfileCorrectionExecutors()['player.profile.correct'];
    assert.equal(typeof executor?.preview, 'function');
    assert.equal(typeof executor?.apply, 'function');
    assert.equal(typeof executor?.undo, 'function');
});
