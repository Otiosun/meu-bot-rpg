const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    approvePlayerStory,
    blockPlayerGame,
    denyPlayerStory,
    releasePlayerGame,
} = require('../helpers/clover/playerAccessService');
const { runWithLifecycleContext } = require('../helpers/clover/lifecyclePolicy');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`CREATE TABLE jogadores (
        id TEXT PRIMARY KEY,
        historia_status TEXT,
        historia_aprovada_at TEXT,
        historia_aprovada_by TEXT,
        historia_status_updated_at TEXT,
        historia_motivo TEXT,
        jogo_status TEXT,
        jogo_liberado_at TEXT,
        jogo_liberado_by TEXT,
        jogo_bloqueio_motivo TEXT
    )`);
    await db.run(
        `INSERT INTO jogadores
         (id, historia_status, jogo_status, jogo_bloqueio_motivo)
         VALUES ('player@lid', 'pendente', 'bloqueado', 'cadastro')`
    );
    return db;
}

test('autoridade de acesso preserva as transições existentes de história e jogo', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await approvePlayerStory(db, { playerId: 'player@lid', actorId: 'admin@lid', releaseGame: false });
    let player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(player.historia_status, 'aprovada');
    assert.equal(player.jogo_status, 'historia_aprovada');

    await releasePlayerGame(db, { playerId: 'player@lid', actorId: 'admin@lid' });
    player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(player.jogo_status, 'liberado');
    assert.equal(player.jogo_liberado_by, 'admin@lid');

    await blockPlayerGame(db, { playerId: 'player@lid', reason: 'pausa administrativa' });
    player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(player.jogo_status, 'bloqueado');
    assert.equal(player.jogo_bloqueio_motivo, 'pausa administrativa');
    assert.equal(player.jogo_liberado_at, null);

    await denyPlayerStory(db, { playerId: 'player@lid', reason: 'ajustar história' });
    player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);
    assert.equal(player.historia_status, 'negada');
    assert.equal(player.jogo_status, 'aguardando_historia');
});

test('autoridade de acesso falha antes do write em PRE_RESET', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    const before = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);

    await assert.rejects(
        () => runWithLifecycleContext(
            { env: { PRE_RESET_RETURN_ENABLED: 'true' } },
            () => releasePlayerGame(db, { playerId: 'player@lid', actorId: 'admin@lid' })
        ),
        (error) => error.code === 'lifecycle_current_world_blocked'
    );
    assert.deepEqual(await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']), before);
});

test('comandos não possuem SQL bruto de jogo_status ou lifecycle_status', () => {
    for (const relative of ['comandos/historiaJogo.js', 'comandos/playerControle.js', 'comandos/vincular.js']) {
        const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
        assert.doesNotMatch(source, /(?:INSERT|UPDATE)\s+(?:OR\s+IGNORE\s+)?(?:INTO\s+)?jogadores[\s\S]{0,700}(?:jogo_status|identity_status|lifecycle_status)/i, relative);
    }
});

test('CloverScript genérico não mantém autoridade de escrita de status', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'helpers/clover/cloverScriptService.js'),
        'utf8'
    );
    const body = source.match(/async function applyStatusAction[\s\S]*?\r?\n}\r?\n\r?\nasync function applyPersonAction/)?.[0] || '';
    assert.match(body, /canonical_status_operation_required/);
    assert.doesNotMatch(body, /db\.run/);
});
