'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { PHASES, canUseCommandInPhase, getPlayerPhase } = require('../helpers/clover/playerPhase');
const {
    createAndStoreFutureRoll,
    getFutureRollByNumber,
    listFutureRolls,
} = require('../helpers/clover/preResetFutureRollService');
const { getFutureSlotAvailability } = require('../helpers/clover/preResetFutureSlotService');
const { applyFutureCharacterMutation, getFutureCharacter } = require('../helpers/clover/preResetCharacterService');
const fichaNova = require('../comandos/fichanova');

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-prereset-rolls-'));
    const db = await database.criarBanco({ filename:path.join(dir, 'database.sqlite') });
    t.after(async () => { await db.close(); fs.rmSync(dir, { recursive:true, force:true }); });
    for (const [id, name] of [['reset-player','Reset Old'],['keep-player','Keep Old']]) {
        await db.run(
            `INSERT INTO jogadores
             (id,nome,ficha_status,jogo_status,personagem_nome,personagem_aparencia,personagem_aparencia_status)
             VALUES (?,?,'aprovada','liberado',?,?,'approved')`,
            [id, id, name, `Aparencia ${name}`]
        );
    }
    await db.run(
        `INSERT INTO clover_prereset_launch_rosters
         (campaign_key,authority_mode,revision,status,roster_hash,finalized_by,finalized_at)
         VALUES ('mythic_launch_v1','admin_roster',1,'finalized','fixture','admin',CURRENT_TIMESTAMP)`
    );
    await db.run(
        `INSERT INTO clover_prereset_launch_players
         (campaign_key,player_id,roster_revision,outcome,status)
         VALUES ('mythic_launch_v1','reset-player',1,'reset','pending'),
                ('mythic_launch_v1','keep-player',1,'keep','pending')`
    );
    return db;
}

test('PRE_RESET: RESET sorteia em storage futuro sem tocar player_rolls nem slot_reservations legado', async (t) => {
    const db = await fixture(t);
    const beforeLegacy = await db.get("SELECT COUNT(*) AS total FROM player_rolls WHERE player_id='reset-player'");
    const beforeSlots = await db.get("SELECT COUNT(*) AS total FROM slot_reservations WHERE player_id='reset-player'");
    const result = await createAndStoreFutureRoll(db, 'reset-player');
    assert.equal(result.ok, true);
    assert.equal(result.roll.roll_number, 1);
    assert.equal((await listFutureRolls(db, 'reset-player')).length, 1);
    assert.ok(await getFutureRollByNumber(db, 'reset-player', 1));
    assert.deepEqual(await db.get("SELECT COUNT(*) AS total FROM player_rolls WHERE player_id='reset-player'"), beforeLegacy);
    assert.deepEqual(await db.get("SELECT COUNT(*) AS total FROM slot_reservations WHERE player_id='reset-player'"), beforeSlots);
    assert.equal(beforeLegacy.total, 0);
    assert.equal(beforeSlots.total, 0);
    const phase = await getPlayerPhase(db, 'reset-player');
    assert.equal(phase.phase, PHASES.PRE_RESET_BUILD);
    assert.equal(phase.rollCount, 1);
});

test('PRE_RESET: KEEP nao pode gerar roll novo', async (t) => {
    const db = await fixture(t);
    await assert.rejects(createAndStoreFutureRoll(db, 'keep-player'), (error) => error?.code === 'keep_player_cannot_roll');
    assert.equal((await listFutureRolls(db, 'keep-player')).length, 0);
    assert.equal((await getPlayerPhase(db, 'keep-player')).phase, PHASES.PRE_RESET_WAIT);
});

test('PRE_RESET: capacidade futura ignora ocupacao do RESET e preserva ocupacao KEEP', async (t) => {
    const db = await fixture(t);
    await db.run("UPDATE jogadores SET magia='Magia de Chave', magia_key='magia_de_chave' WHERE id='reset-player'");
    let availability = await getFutureSlotAvailability(db, 'magic', 'magia_de_chave');
    assert.equal(availability.keepUsed, 0);
    assert.equal(availability.futureHeld, 0);
    assert.equal(availability.ok, true);

    await db.run("UPDATE jogadores SET magia='Magia de Chave', magia_key='magia_de_chave' WHERE id='keep-player'");
    availability = await getFutureSlotAvailability(db, 'magic', 'magia_de_chave');
    assert.equal(availability.keepUsed, 1);
    assert.equal(availability.ok, false);
});

test('PRE_RESET gate distingue BUILD de WAIT/DECISION', () => {
    for (const command of ['.#sortear','.#rolls','.#ficha','.#ficha nova']) {
        assert.equal(canUseCommandInPhase(command, PHASES.PRE_RESET_BUILD), true, command);
        assert.equal(canUseCommandInPhase(command, PHASES.PRE_RESET_WAIT), false, `WAIT ${command}`);
        assert.equal(canUseCommandInPhase(command, PHASES.PRE_RESET_DECISION), false, `DECISION ${command}`);
    }
    for (const command of ['.#retorno','.#pr','.#status','.#continuar']) {
        assert.equal(canUseCommandInPhase(command, PHASES.PRE_RESET_BUILD), true, command);
        assert.equal(canUseCommandInPhase(command, PHASES.PRE_RESET_WAIT), true, command);
    }
    assert.equal(canUseCommandInPhase('.#inventario', PHASES.PRE_RESET_BUILD), false);
    assert.equal(canUseCommandInPhase('.#rota', PHASES.PRE_RESET_BUILD), false);
});

test('PRE_RESET: Ficha Nova grava somente personagem futuro', async (t) => {
    const db = await fixture(t);
    const rollResult = await createAndStoreFutureRoll(db, 'reset-player');
    assert.equal(rollResult.ok, true);
    await applyFutureCharacterMutation(db, 'reset-player', 'reset-player', {
        operationType:'create',
        expectedRevision:0,
        operationKey:'test:ficha-select:0001',
        draft:{ rollNumber:1 },
    });

    const oldBefore = await db.get("SELECT personagem_nome,ficha_status FROM jogadores WHERE id='reset-player'");
    const sent = [];
    const sock = { sendMessage:async (_jid, message) => { sent.push(message); return { key:{ id:'out-1' } }; } };
    const body = [
        '     --  dados do personagem  --',
        '*Nome:* Personagem Futuro',
        '*Idade do personagem (mínimo 15):* 19',
        '*Aparência:* Asta — Black Clover',
        '*Gênero:* Masculino',
        '*Número do Roll:* 1',
        '*Família:* Nenhuma',
        '*Magia:* Magia de Algodão',
    ].join('\n');

    await fichaNova.executar({
        sock,
        m:{ key:{ id:'in-ficha-1', remoteJid:'grupo@g.us' }, message:{ conversation:`.#Ficha Nova\n${body}` } },
        idChat:'grupo@g.us',
        idJogador:'reset-player',
        db,
        body,
    });

    const oldAfter = await db.get("SELECT personagem_nome,ficha_status FROM jogadores WHERE id='reset-player'");
    assert.deepEqual(oldAfter, oldBefore);
    const future = await getFutureCharacter(db, 'reset-player');
    assert.equal(future.status, 'submitted');
    assert.equal(future.draft.name, 'Personagem Futuro');
    assert.equal(future.draft.rollNumber, 1);
    assert.equal(future.draft.magicKey, 'magia_de_algodao');
    assert.ok(sent.some((message) => String(message?.text || '').includes('FICHA NOVA ENVIADA')));
});