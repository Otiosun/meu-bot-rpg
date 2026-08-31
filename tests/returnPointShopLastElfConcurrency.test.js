'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { purchaseReturnPointShopItem } = require('../helpers/clover/returnPointShopService');
const { creditReturnPoints, getReturnPointsBalance } = require('../helpers/clover/returnPointsService');

const CAMPAIGN = 'mythic_launch_v1';
const PLAYERS = [
    '5511999990101@s.whatsapp.net',
    '5511999990102@s.whatsapp.net',
];

function temporaryFilename() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-last-elf-'));
    return path.join(dir, 'database.sqlite');
}

async function openFixture(t) {
    const filename = temporaryFilename();
    const dbA = await database.criarBanco({ filename });
    const dbB = await openCloverDatabase({ filename, busyTimeoutMs:10_000 });
    t.after(async () => {
        await dbB.close().catch(() => {});
        await dbA.close().catch(() => {});
        fs.rmSync(path.dirname(filename), { recursive:true, force:true });
    });
    return { dbA, dbB };
}

async function seedPlayer(db, playerId, index) {
    await db.run(
        `INSERT INTO jogadores (
            id,nome,ficha_status,jogo_status,personagem_nome,personagem_idade,personagem_genero,
            personagem_aparencia,personagem_aparencia_status,reino,classe,raca,grimorio,familia,familia_key,
            magia,magia_key,numero_roll_escolhido
        ) VALUES (?,?, 'aprovada','liberado',?,20,'Masculino','Fixture','approved',
                  'Clover','Miseravel','Humano','Tres Folhas','Silva','silva','Vento','vento',1)`,
        [playerId, `Elf Buyer ${index}`, `Elf Buyer ${index}`]
    );
    await db.run(
        `INSERT INTO clover_prereset_launch_players
         (campaign_key,player_id,roster_revision,outcome,status)
         VALUES (?,?,1,'reset','pending')`,
        [CAMPAIGN, playerId]
    );
    await db.run(
        `INSERT INTO clover_return_point_shop_eligible
         (campaign_key,player_id,roster_revision,roster_hash,outcome,captured_by)
         VALUES (?,?,1,'last-elf-hash','reset','fixture')`,
        [CAMPAIGN, playerId]
    );
    await db.run(
        `INSERT INTO clover_prereset_future_rolls (
            campaign_key,player_id,roll_number,kingdom,social_class,race,grimoire,magic_rarity,summary,roll_version,
            kingdom_key,social_class_key,race_key,grimoire_key,magic_rarity_key,roll_payload
        ) VALUES (?, ?, 1, 'Clover', 'Miseravel', 'Humano', 'Tres Folhas', 'Comum',
                  'Clover | Miseravel | Humano | Tres Folhas | Comum', 'fixture-v1',
                  'clover','miseravel','humano','clover_3f','comum','{}')`,
        [CAMPAIGN, playerId]
    );
    await creditReturnPoints(db, playerId, 1000, {
        operationKey:`fixture:last-elf:fund:${index}`,
        source:'fixture',
        reason:'Saldo para teste concorrente da ultima vaga de Elfo.',
        createdBy:'fixture',
    });
}

async function seedWorld(db) {
    await db.run(
        `INSERT INTO clover_prereset_launch_rosters
         (campaign_key,revision,status,roster_hash,finalized_by,finalized_at)
         VALUES (?,1,'finalized','last-elf-hash','fixture',CURRENT_TIMESTAMP)`,
        [CAMPAIGN]
    );
    await db.run(
        `INSERT INTO clover_return_point_shop_gate
         (campaign_key,status,required_keep_count,roster_revision,roster_hash,keep_count_at_open,opened_by,opened_at)
         VALUES (?,'open',14,1,'last-elf-hash',14,'fixture',CURRENT_TIMESTAMP)`,
        [CAMPAIGN]
    );
    await seedPlayer(db, PLAYERS[0], 1);
    await seedPlayer(db, PLAYERS[1], 2);

    for (let index = 1; index <= 5; index += 1) {
        await db.run(
            `INSERT INTO clover_prereset_future_slot_reservations
             (campaign_key,player_id,roll_number,category,option_key,status,source)
             VALUES (?, ?, 1, 'race', 'elfo', 'held', 'fixture')`,
            [CAMPAIGN, `existing-elf-${index}`]
        );
    }
}

test('duas compras simultaneas disputando a ultima vaga de Elfo produzem exatamente um vencedor', async (t) => {
    const { dbA, dbB } = await openFixture(t);
    await seedWorld(dbA);

    const attempts = await Promise.allSettled([
        purchaseReturnPointShopItem(dbA, PLAYERS[0], {
            itemKey:'raca_elfo',
            targetRollNumber:1,
            idempotencyKey:'fixture:last-elf:purchase:a',
        }),
        purchaseReturnPointShopItem(dbB, PLAYERS[1], {
            itemKey:'raca_elfo',
            targetRollNumber:1,
            idempotencyKey:'fixture:last-elf:purchase:b',
        }),
    ]);

    const winners = attempts.filter((entry) => entry.status === 'fulfilled');
    const losers = attempts.filter((entry) => entry.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason?.code, 'future_slot_full');

    const held = await dbA.get(
        `SELECT COUNT(*) AS total
         FROM clover_prereset_future_slot_reservations
         WHERE campaign_key=? AND category='race' AND option_key='elfo' AND status='held'`,
        [CAMPAIGN]
    );
    assert.equal(Number(held.total), 6);

    const purchases = await dbA.get(
        `SELECT COUNT(*) AS total
         FROM clover_prereset_purchases
         WHERE catalog_item_key='raca_elfo' AND status='completed'`
    );
    assert.equal(Number(purchases.total), 1);

    const balances = await Promise.all(PLAYERS.map((playerId) => getReturnPointsBalance(dbA, playerId)));
    assert.deepEqual([...balances].sort((a, b) => a - b), [100, 1000]);

    const rolls = await dbA.all(
        `SELECT player_id,race_key FROM clover_prereset_future_rolls
         WHERE campaign_key=? AND player_id IN (?,?) ORDER BY player_id`,
        [CAMPAIGN, ...PLAYERS]
    );
    assert.equal(rolls.filter((row) => row.race_key === 'elfo').length, 1);
    assert.equal(rolls.filter((row) => row.race_key === 'humano').length, 1);
});
