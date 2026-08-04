'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    matchesProfileConfirmationResetSignature,
    readProfileAccessSnapshot,
    restoreReleasedAccessAfterProfileConfirmation,
} = require('../helpers/clover/profileAccessPreservationService');

async function createDb() {
    const db = await open({
        filename: ':memory:',
        driver: sqlite3.Database,
    });

    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            ficha_status TEXT,
            personagem_aparencia_status TEXT,
            jogo_status TEXT,
            jogo_liberado_at TEXT,
            jogo_liberado_by TEXT,
            jogo_bloqueio_motivo TEXT
        );

        CREATE TABLE player_onboarding (
            player_id TEXT PRIMARY KEY,
            current_step TEXT,
            step_payload TEXT,
            last_seen_at TEXT
        );
    `);

    return db;
}

test('restaura acesso quando a confirmação apaga um estado previamente liberado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.run(
        `INSERT INTO jogadores
         (id, ficha_status, personagem_aparencia_status, jogo_status,
          jogo_liberado_at, jogo_liberado_by, jogo_bloqueio_motivo)
         VALUES (?, 'aprovada', 'approved', 'liberado', ?, ?, NULL)`,
        ['player@lid', '2026-06-10 12:00:00', 'admin@lid']
    );

    const before = await readProfileAccessSnapshot(db, 'player@lid');

    await db.run(
        `UPDATE jogadores
         SET ficha_status = 'aprovada',
             personagem_aparencia_status = 'pending',
             jogo_status = 'bloqueado',
             jogo_liberado_at = NULL,
             jogo_liberado_by = NULL,
             jogo_bloqueio_motivo = NULL
         WHERE id = 'player@lid'`
    );

    const broken = await readProfileAccessSnapshot(db, 'player@lid');
    assert.equal(matchesProfileConfirmationResetSignature(broken), true);

    const result = await restoreReleasedAccessAfterProfileConfirmation(db, 'player@lid', before);
    assert.equal(result.restored, true);
    assert.equal(result.player.jogo_status, 'liberado');
    assert.equal(result.player.jogo_liberado_at, '2026-06-10 12:00:00');
    assert.equal(result.player.jogo_liberado_by, 'admin@lid');
    assert.equal(result.player.jogo_bloqueio_motivo, null);
    assert.equal(result.player.personagem_aparencia_status, 'pending');
});

test('não libera jogador que já estava bloqueado antes da confirmação', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.run(
        `INSERT INTO jogadores
         (id, ficha_status, personagem_aparencia_status, jogo_status,
          jogo_liberado_at, jogo_liberado_by, jogo_bloqueio_motivo)
         VALUES ('blocked@lid', 'aprovada', 'pending', 'bloqueado', NULL, NULL, NULL)`
    );

    const before = await readProfileAccessSnapshot(db, 'blocked@lid');
    const result = await restoreReleasedAccessAfterProfileConfirmation(db, 'blocked@lid', before);

    assert.equal(result.restored, false);
    assert.equal(result.reason, 'no_previous_release_evidence');
    assert.equal(result.player.jogo_status, 'bloqueado');
});

test('restaura acesso quando existe evidÃªncia de onboarding jogo liberado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.run(
        `INSERT INTO jogadores
         (id, ficha_status, personagem_aparencia_status, jogo_status,
          jogo_liberado_at, jogo_liberado_by, jogo_bloqueio_motivo)
         VALUES ('onboarding@lid', 'aprovada', 'pending', 'bloqueado', NULL, NULL, NULL)`
    );
    await db.run(
        `INSERT INTO player_onboarding
         (player_id, current_step, step_payload, last_seen_at)
         VALUES (?, ?, ?, ?)`,
        [
            'onboarding@lid',
            'jogo_liberado',
            JSON.stringify({ last_message: 'Jogo liberado pelo bot.' }),
            '2026-08-04 02:00:00',
        ]
    );

    const result = await restoreReleasedAccessAfterProfileConfirmation(db, 'onboarding@lid', null);

    assert.equal(result.restored, true);
    assert.equal(result.player.jogo_status, 'liberado');
    assert.equal(result.player.jogo_liberado_at, '2026-08-04 02:00:00');
    assert.equal(result.player.jogo_liberado_by, 'system:profile-confirmation-release-evidence');
});

test('bloqueia restauraÃ§Ã£o sem evidÃªncia de onboarding liberado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.run(
        `INSERT INTO jogadores
         (id, ficha_status, personagem_aparencia_status, jogo_status,
          jogo_liberado_at, jogo_liberado_by, jogo_bloqueio_motivo)
         VALUES ('no-evidence@lid', 'aprovada', 'pending', 'bloqueado', NULL, NULL, NULL)`
    );
    await db.run(
        `INSERT INTO player_onboarding
         (player_id, current_step, step_payload, last_seen_at)
         VALUES (?, ?, ?, ?)`,
        [
            'no-evidence@lid',
            'aparencia_aprovada',
            JSON.stringify({ last_message: 'Aparencia aprovada.' }),
            '2026-08-04 02:00:00',
        ]
    );

    const result = await restoreReleasedAccessAfterProfileConfirmation(db, 'no-evidence@lid', null);

    assert.equal(result.restored, false);
    assert.equal(result.reason, 'no_previous_release_evidence');
    assert.equal(result.player.jogo_status, 'bloqueado');
});

test('não sobrescreve bloqueio explícito criado depois da confirmação', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.run(
        `INSERT INTO jogadores
         (id, ficha_status, personagem_aparencia_status, jogo_status,
          jogo_liberado_at, jogo_liberado_by, jogo_bloqueio_motivo)
         VALUES (?, 'aprovada', 'approved', 'liberado', ?, ?, NULL)`,
        ['manual@lid', '2026-06-11 12:00:00', 'admin@lid']
    );

    const before = await readProfileAccessSnapshot(db, 'manual@lid');

    await db.run(
        `UPDATE jogadores
         SET personagem_aparencia_status = 'pending',
             jogo_status = 'bloqueado',
             jogo_liberado_at = NULL,
             jogo_liberado_by = NULL,
             jogo_bloqueio_motivo = 'bloqueio administrativo'
         WHERE id = 'manual@lid'`
    );

    const result = await restoreReleasedAccessAfterProfileConfirmation(db, 'manual@lid', before);
    assert.equal(result.restored, false);
    assert.equal(result.reason, 'current_state_does_not_match_profile_reset');
    assert.equal(result.player.jogo_status, 'bloqueado');
    assert.equal(result.player.jogo_bloqueio_motivo, 'bloqueio administrativo');
});
