const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureCloverSquadSchema } = require('../database');
const {
    getSquadView,
    reconcileSquadStars,
    renderSquadGroupDescription,
} = require('../helpers/clover/squadService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            personagem_nome TEXT,
            display_name TEXT,
            esquadrao TEXT,
            estrelas INTEGER DEFAULT 0,
            ficha_status TEXT DEFAULT 'incompleta',
            jogo_status TEXT DEFAULT 'bloqueado',
            lifecycle_status TEXT DEFAULT 'active',
            is_shadow INTEGER DEFAULT 0,
            merged_into TEXT DEFAULT NULL
        );
    `);
    await ensureCloverSquadSchema(db);
    return db;
}

test('squad reconcile keeps squad balance independent from active members', async () => {
    const db = await createDb();

    await db.run(
        `INSERT INTO clover_squads (squad_key, name, current_stars, historical_stars)
         VALUES ('coringas_magenta', 'Coringas Magenta', 99, 99)`
    );

    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, display_name, esquadrao, estrelas, ficha_status, jogo_status)
         VALUES ('active@lid', 'Elizabeth', 'Elizabeth', 'Elizabeth', 'Coringas Magenta', 4, 'aprovada', 'liberado')`
    );
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, display_name, esquadrao, estrelas, ficha_status, jogo_status, lifecycle_status)
         VALUES ('archived@lid', 'Vesper', 'Vesper', 'Vesper', 'Coringas Magenta', 4, 'aprovada', 'liberado', 'archived')`
    );
    await db.run(
        `INSERT INTO jogadores
         (id, nome, personagem_nome, display_name, esquadrao, estrelas, ficha_status, jogo_status, is_shadow)
         VALUES ('shadow@lid', 'Espelho', 'Espelho', 'Espelho', 'Coringas Magenta', 3, 'aprovada', 'liberado', 1)`
    );

    await db.run(
        `INSERT INTO clover_squad_star_ledger
         (squad_key, player_id, amount, kind, source, reason)
         VALUES ('coringas_magenta', 'active@lid', 4, 'ganho', 'test', 'ativo')`
    );
    await db.run(
        `INSERT INTO clover_squad_star_ledger
         (squad_key, player_id, amount, kind, source, reason)
         VALUES ('coringas_magenta', 'archived@lid', 4, 'ganho', 'test', 'historico arquivado')`
    );
    await db.run(
        `INSERT INTO clover_squad_star_ledger
         (squad_key, player_id, amount, kind, source, reason)
         VALUES ('coringas_magenta', NULL, -5, 'ajuste_admin', 'test', 'ajuste manual')`
    );

    const result = await reconcileSquadStars(db, 'coringas_magenta');
    assert.equal(result.changed, true);
    assert.deepEqual(result.after, { currentStars: 3, historicalStars: 8 });

    const squad = await db.get('SELECT current_stars, historical_stars FROM clover_squads WHERE squad_key = ?', ['coringas_magenta']);
    assert.equal(squad.current_stars, 3);
    assert.equal(squad.historical_stars, 8);

    const view = await getSquadView(db, 'coringas_magenta');
    assert.equal(view.members.length, 1);
    assert.equal(view.memberStarsTotal, 4);
    assert.equal(view.historicalGap, 5);

    const description = renderSquadGroupDescription(view);
    assert.match(description, /\*Atuais:\* 3/);
    assert.match(description, /\*Hist.*rico:\* 8/);
    assert.match(description, /\*Usado\/perdido:\* 5/);

    await db.close();
});
