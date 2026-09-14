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

for(const frozen of [false,true])test('anti-ghost manual-only preserva cadastro e ledger sem efeito externo; PRE_RESET='+frozen,async(t)=>{
 const db=await createDb();t.after(()=>db.close());
 const calls=[];const sock={groupParticipantsUpdate:async(...args)=>{calls.push(args);return [{status:'200'}];}};
 const player=await db.get('SELECT * FROM jogadores WHERE id=?',['player@lid']);
 const before=await db.all('SELECT * FROM clover_ph_ledger');
 await assert.rejects(require('../helpers/clover/lifecyclePolicy').runWithLifecycleContext({env:frozen?{PRE_RESET_RETURN_ENABLED:'true'}:{}},()=>removePlayerForAntiGhost({sock,db,player,moderatorId:'owner@lid',reason:'inatividade confirmada'})),e=>e.code===(frozen?'lifecycle_current_world_blocked':'prereset_antighost_mutation_disabled'));
 assert.deepEqual(calls,[]);
 assert.deepEqual(await db.get('SELECT * FROM jogadores WHERE id=?',['player@lid']),player);
 assert.deepEqual(await db.all('SELECT * FROM clover_ph_ledger'),before);
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
