'use strict';

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
const {
    ensureSquadSeasonStarSchema,
    grantSquadStarsInTransaction,
    purchaseSquadStarsInTransaction,
    readSquadNativeStars,
} = require('../helpers/clover/squadSeasonStarService');

async function openFixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            ficha_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado'
        );
    `);
    await ensureCloverSquadSchema(db);
    return db;
}

async function legacyLedgerFixture() {
    const db = await openFixture();
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, current_stars, historical_stars, black_stars)
         VALUES ('teste', 'Esquadrao Teste', 99, 99, 2)`
    );
    await db.exec(`
        INSERT INTO jogadores
            (id, personagem_nome, esquadrao, estrelas, ficha_status, jogo_status)
        VALUES
            ('active@lid', 'Membro Ativo', 'Teste', 4, 'aprovada', 'liberado'),
            ('archived@lid', 'Membro Arquivado', 'Teste', 40, 'arquivada', 'liberado'),
            ('shadow@lid', '-', 'Teste', 70, 'aprovada', 'liberado'),
            ('merged@lid', 'Membro Mesclado', 'Teste', 90, 'aprovada', 'mesclado');
    `);
    await db.run(
        `INSERT INTO clover_squad_star_ledger
         (squad_key, player_id, amount, kind, source, reason, created_by)
         VALUES ('teste', 'active@lid', 4, 'ganho', 'raid', 'Missao ativa', 'narrator@lid')`
    );
    await db.run(
        `INSERT INTO clover_squad_star_ledger
         (squad_key, player_id, amount, kind, source, reason, created_by)
         VALUES ('teste', 'archived@lid', 4, 'ganho', 'evento', 'Ganho historico legitimo', 'admin@lid')`
    );
    await db.run(
        `INSERT INTO clover_squad_star_ledger
         (squad_key, player_id, amount, kind, source, reason, created_by)
         VALUES ('teste', NULL, -5, 'gasto', 'qg_upgrade', 'Compra do QG', 'captain@lid')`
    );
    await db.run(
        `INSERT INTO clover_squad_star_ledger
         (squad_key, player_id, amount, kind, source, reason, created_by)
         VALUES ('teste', 'active@lid', 100, 'ganho', 'squad_reconcile', 'Importacao sintetica antiga', 'system')`
    );
    return db;
}

test('reconciliacao separa saldo, historico e estrelas individuais sem importar membros', async (t) => {
    const db = await legacyLedgerFixture();
    t.after(() => db.close());

    const result = await reconcileSquadStars(db, 'teste');
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.after.currentStars, 3);
    assert.equal(result.after.historicalStars, 8);
    assert.equal(result.ignoredSyntheticCount, 1);
    assert.deepEqual(result.insertedMissingMemberStars, []);

    const stored = await db.get(
        'SELECT current_stars, historical_stars FROM clover_squads WHERE squad_key = ?',
        ['teste']
    );
    assert.equal(stored.current_stars, 3);
    assert.equal(stored.historical_stars, 8);

    const view = await getSquadView(db, 'teste');
    assert.equal(view.members.length, 1);
    assert.equal(view.members[0].id, 'active@lid');
    assert.equal(view.memberStarsTotal, 4);
    assert.equal(view.historicalGap, 5);

    const description = renderSquadGroupDescription(view);
    assert.match(description, /\*Atuais:\* 3/);
    assert.match(description, /\*Histórico:\* 8/);
    assert.match(description, /\*Usado\/perdido:\* 5/);
    assert.match(description, /\*Membros visíveis:\* 4/);
});

test('reconciliacao e idempotente e nao cria novos lancamentos sinteticos', async (t) => {
    const db = await legacyLedgerFixture();
    t.after(() => db.close());

    const before = await db.get(
        'SELECT COUNT(*) AS total FROM clover_squad_star_ledger WHERE squad_key = ?',
        ['teste']
    );
    await reconcileSquadStars(db, 'teste');
    const second = await reconcileSquadStars(db, 'teste');
    const after = await db.get(
        'SELECT COUNT(*) AS total FROM clover_squad_star_ledger WHERE squad_key = ?',
        ['teste']
    );

    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
    assert.equal(second.reason, 'already_consistent');
    assert.equal(after.total, before.total);
});

test('reconciliacao preserva contrato nativo: compra reduz saldo, nao historico', async (t) => {
    const db = await openFixture();
    t.after(() => db.close());

    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, current_stars, historical_stars)
         VALUES ('nativo', 'Esquadrao Nativo', 0, 0)`
    );
    await ensureSquadSeasonStarSchema(db);

    await db.exec('BEGIN IMMEDIATE');
    try {
        await grantSquadStarsInTransaction(db, {
            squadKey: 'nativo',
            amount: 10,
            source: 'test',
            reason: 'Concessao',
            transactionKey: 'p0:nativo:grant',
            createdBy: 'evaluator@lid',
        });
        await purchaseSquadStarsInTransaction(db, {
            squadKey: 'nativo',
            amount: 4,
            source: 'test',
            reason: 'Compra',
            transactionKey: 'p0:nativo:purchase',
            createdBy: 'captain@lid',
        });
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }

    await db.run(
        `UPDATE clover_squads
         SET current_stars = 1, historical_stars = 1
         WHERE squad_key = 'nativo'`
    );

    const result = await reconcileSquadStars(db, 'nativo');
    assert.equal(result.after.currentStars, 6);
    assert.equal(result.after.historicalStars, 10);

    const stars = await readSquadNativeStars(db, 'nativo');
    assert.equal(stars.balance, 6);
    assert.equal(stars.lifetime, 10);
});
