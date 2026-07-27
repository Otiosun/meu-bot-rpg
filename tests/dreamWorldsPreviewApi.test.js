'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureCloverSiteAuthSchema } = require('../database');
const {
    assertPreviewPath,
    selectPreviewPlayer,
    startPreviewApi,
} = require('../scripts/startDreamWorldsPreviewApi');

async function createPreviewDatabase(t) {
    const directory = await mkdtemp(path.join(tmpdir(), 'clover-preview-test-'));
    const filename = path.join(directory, 'preview-copy.sqlite');
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'bloqueado',
            dinheiro INTEGER DEFAULT 0,
            esquadrao TEXT DEFAULT '-'
        );
        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            captain_player_id TEXT DEFAULT NULL,
            vice_captain_player_id TEXT DEFAULT NULL
        );
    `);
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, jogo_status)
         VALUES ('blocked@lid', 'Mago Bloqueado', 'bloqueado')`
    );
    await db.run(
        `INSERT INTO jogadores (id, personagem_nome, jogo_status)
         VALUES ('preview@lid', 'Mago de Preview', 'liberado')`
    );
    await ensureCloverSiteAuthSchema(db);
    await db.close();

    t.after(async () => {
        await rm(directory, { recursive: true, force: true });
    });
    return filename;
}

test('preview recusa banco sem marcador seguro ou sem autorização explícita', () => {
    assert.throws(
        () => assertPreviewPath('C:/projeto/banco.sqlite', { allowWrite: true }),
        /Caminho recusado/
    );
    assert.throws(
        () => assertPreviewPath('C:/projeto/backups/copia.sqlite', { allowWrite: false }),
        /Preview bloqueado/
    );
});

test('seleção automática prioriza personagem liberado', async (t) => {
    const filename = await createPreviewDatabase(t);
    const db = await open({ filename, driver: sqlite3.Database });
    t.after(() => db.close());
    const player = await selectPreviewPlayer(db);
    assert.equal(player.id, 'preview@lid');
});

test('API isolada inicia na cópia e autentica sessão temporária', async (t) => {
    const filename = await createPreviewDatabase(t);
    const runtime = await startPreviewApi({
        databasePath: filename,
        allowWrite: true,
        host: '127.0.0.1',
        port: 18990,
        playerId: 'preview@lid',
    });
    t.after(() => runtime.close());

    assert.equal(runtime.player.id, 'preview@lid');
    assert.match(runtime.token, /^clv_/);

    const publicResponse = await fetch(`${runtime.baseUrl}/dream-worlds`);
    assert.equal(publicResponse.status, 200);
    const publicBody = await publicResponse.json();
    assert.equal(publicBody.ok, true);

    const journeyResponse = await fetch(`${runtime.baseUrl}/dream-worlds/me`, {
        headers: { Authorization: `Bearer ${runtime.token}` },
    });
    assert.equal(journeyResponse.status, 200);
    const journeyBody = await journeyResponse.json();
    assert.equal(journeyBody.ok, true);
});
