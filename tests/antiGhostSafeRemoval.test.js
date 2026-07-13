const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

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
            numero_roll_escolhido INTEGER DEFAULT NULL,
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
            amount INTEGER NOT NULL
        );
    `);
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, jogo_status, esquadrao)
         VALUES ('player@lid', 'Nilo', 'Nilo', 'Arthur Pendragon', 'liberado', '-')`
    );
    await db.run(
        `INSERT INTO clover_ph_ledger (player_id, amount)
         VALUES ('player@lid', 50)`
    );
    await db.run(
        `INSERT INTO clover_settings (key, value)
         VALUES ('clover_community_group_jid', 'community@g.us')`
    );
    return db;
}

test('remoção direta do anti-ghost retorna sucesso e preserva o cadastro', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

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

test('comando específico vence os aliases destrutivos do comando base', () => {
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
