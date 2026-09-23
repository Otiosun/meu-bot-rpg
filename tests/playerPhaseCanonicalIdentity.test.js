'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { getPlayerPhase, PHASES } = require('../helpers/clover/playerPhase');

test('merged shadow identity uses the liberated canonical player phase', async (t) => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());

    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            ficha_status TEXT,
            jogo_status TEXT,
            historia_status TEXT,
            personagem_aparencia_status TEXT,
            magia TEXT,
            numero_roll_escolhido INTEGER,
            canonical_player_id TEXT,
            merged_into TEXT,
            is_shadow INTEGER DEFAULT 0
        );
        CREATE TABLE player_onboarding (player_id TEXT PRIMARY KEY);
        CREATE TABLE player_rolls (player_id TEXT);
        CREATE TABLE pending_profile_confirmations (player_id TEXT);
        CREATE TABLE pending_magic_confirmations (player_id TEXT);
    `);

    const canonicalId = '5511951469663@s.whatsapp.net';
    const shadowId = '73663118364899@lid';
    await db.run(
        `INSERT INTO jogadores
         (id,ficha_status,jogo_status,historia_status,personagem_aparencia_status,magia,canonical_player_id)
         VALUES (?,'aprovada','liberado','pendente','approved','Trevas',?)`,
        [canonicalId, canonicalId]
    );
    await db.run(
        `INSERT INTO jogadores
         (id,ficha_status,jogo_status,magia,canonical_player_id,merged_into,is_shadow)
         VALUES (?,'incompleta','bloqueado','-',?,?,1)`,
        [shadowId, canonicalId, canonicalId]
    );

    const phase = await getPlayerPhase(db, shadowId);
    assert.equal(phase.player.id, canonicalId);
    assert.equal(phase.phase, PHASES.JOGO_LIBERADO);
    assert.equal(phase.canPlay, true);
});
