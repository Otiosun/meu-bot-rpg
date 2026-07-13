const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    archiveAndResetPlayer,
    resetPlayerState,
} = require('../helpers/clover/playerReset');
const {
    removePlayerForAntiGhost,
} = require('../helpers/clover/antiGhostSafeService');
const { resolveCommand } = require('../helpers/commandRegistry');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            ficha_status TEXT DEFAULT 'aprovada',
            historia_status TEXT DEFAULT 'aprovada',
            personagem_aparencia_status TEXT DEFAULT 'approved',
            jogo_status TEXT DEFAULT 'liberado',
            esquadrao TEXT DEFAULT '-',
            is_shadow INTEGER DEFAULT 0,
            canonical_player_id TEXT DEFAULT NULL,
            merged_into TEXT DEFAULT NULL,
            identity_status TEXT DEFAULT 'active'
        );

        CREATE TABLE clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            kind TEXT NOT NULL,
            source TEXT,
            reason TEXT
        );
    `);
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, jogo_status, esquadrao)
         VALUES ('player@lid', 'Nilo', 'Nilo', 'Arthur Pendragon', 'liberado', 'Touros Negros')`
    );
    await db.run(
        `INSERT INTO clover_ph_ledger (player_id, amount, kind, source, reason)
         VALUES ('player@lid', 50, 'ganho', 'missao', 'Missão')`
    );
    return db;
}

test('helper legado não contém mais DELETE FROM jogadores', () => {
    const source = fs.readFileSync(require.resolve('../helpers/clover/playerReset'), 'utf8');
    assert.doesNotMatch(source, /DELETE\s+FROM\s+jogadores/i);
});

test('resetPlayerState legado é recusado explicitamente', async () => {
    await assert.rejects(
        resetPlayerState(null, 'player@lid'),
        (error) => error.code === 'legacy_destructive_reset_disabled'
    );
});

test('archiveAndResetPlayer legado converte a chamada em arquivamento preservando dados', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const result = await archiveAndResetPlayer({
        sock: null,
        db,
        playerId: 'player@lid',
        reason: 'remoção antiga',
        actorId: 'owner@lid',
    });

    assert.equal(result.ok, true);
    assert.equal(result.preserved, true);
    assert.equal(result.legacyRouteConverted, true);
    assert.match(result.lifecycleCode, /^LC-/);

    const player = await db.get(
        'SELECT personagem_nome, jogo_status, lifecycle_status FROM jogadores WHERE id = ?',
        ['player@lid']
    );
    assert.equal(player.personagem_nome, 'Arthur Pendragon');
    assert.equal(player.jogo_status, 'arquivado');
    assert.equal(player.lifecycle_status, 'archived');
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_ph_ledger')).total, 1);
});

test('anti-ghost seguro arquiva, remove da comunidade e retorna ok', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await db.run(
        `INSERT INTO clover_settings (key, value)
         VALUES ('clover_community_group_jid', 'community@g.us')`
    );

    const calls = [];
    const sock = {
        groupParticipantsUpdate: async (groupId, participants, action) => {
            calls.push({ groupId, participants, action });
            return [{ status: '200' }];
        },
    };
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', ['player@lid']);
    const result = await removePlayerForAntiGhost({
        sock,
        db,
        player,
        moderatorId: 'owner@lid',
        reason: 'inatividade confirmada',
    });

    assert.equal(result.ok, true);
    assert.equal(result.preserved, true);
    assert.match(result.lifecycleCode, /^LC-/);
    assert.deepEqual(calls, [{
        groupId: 'community@g.us',
        participants: ['player@lid'],
        action: 'remove',
    }]);

    const stored = await db.get(
        'SELECT personagem_nome, jogo_status, lifecycle_status FROM jogadores WHERE id = ?',
        ['player@lid']
    );
    assert.equal(stored.personagem_nome, 'Arthur Pendragon');
    assert.equal(stored.jogo_status, 'arquivado');
    assert.equal(stored.lifecycle_status, 'archived');
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_ph_ledger')).total, 1);

    const activity = await db.get(
        'SELECT community_status FROM clover_antighost_activity WHERE player_id = ?',
        ['player@lid']
    );
    assert.equal(activity.community_status, 'out');
});

test('comando específico de remoção vence o antighost base', () => {
    const base = require('../comandos/antighost');
    const safe = require('../comandos/antiGhostSafeRemoval');
    const commands = new Map([
        [base.nome, base],
        [safe.nome, safe],
    ]);

    const remove = resolveCommand('.#antighost remover @player motivo', commands);
    assert.equal(remove.command, safe);
    assert.equal(remove.body, '@player motivo');

    const eraseAlias = resolveCommand('.#antighost apagar @player motivo', commands);
    assert.equal(eraseAlias.command, safe);
});
