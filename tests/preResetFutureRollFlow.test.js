'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { PHASES, canUseCommandInPhase } = require('../helpers/clover/playerPhase');
const {
    createAndStoreFutureRoll,
    getFutureRollByNumber,
    listFutureRolls,
} = require('../helpers/clover/preResetFutureRollService');

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-prereset-rolls-'));
    const db = await database.criarBanco({ filename:path.join(dir, 'database.sqlite') });
    t.after(async () => { await db.close(); fs.rmSync(dir, { recursive:true, force:true }); });
    for (const [id, name] of [['reset-player','Reset Old'],['keep-player','Keep Old']]) {
        await db.run(
            `INSERT INTO jogadores (id,nome,ficha_status,jogo_status,personagem_nome,personagem_aparencia,personagem_aparencia_status)
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

test('PRE_RESET: RESET sorteia em storage futuro sem tocar player_rolls legado', async (t) => {
    const db = await fixture(t);
    const beforeLegacy = await db.get("SELECT COUNT(*) AS total FROM player_rolls WHERE player_id='reset-player'");
    const result = await createAndStoreFutureRoll(db, 'reset-player');
    assert.equal(result.ok, true);
    assert.equal(result.roll.roll_number, 1);
    assert.equal((await listFutureRolls(db, 'reset-player')).length, 1);
    assert.ok(await getFutureRollByNumber(db, 'reset-player', 1));
    const afterLegacy = await db.get("SELECT COUNT(*) AS total FROM player_rolls WHERE player_id='reset-player'");
    assert.deepEqual(afterLegacy, beforeLegacy);
    assert.equal(afterLegacy.total, 0);
});

test('PRE_RESET: KEEP nao pode gerar roll novo', async (t) => {
    const db = await fixture(t);
    await assert.rejects(
        createAndStoreFutureRoll(db, 'keep-player'),
        (error) => error?.code === 'keep_player_cannot_roll'
    );
    assert.equal((await listFutureRolls(db, 'keep-player')).length, 0);
});

test('PRE_RESET gate libera build e continua bloqueando jogo normal', () => {
    for (const command of ['.#sortear','.#rolls','.#ficha','.#retorno','.#pr']) {
        assert.equal(canUseCommandInPhase(command, PHASES.PRE_RESET_DECISION), true, command);
    }
    assert.equal(canUseCommandInPhase('.#inventario', PHASES.PRE_RESET_DECISION), false);
    assert.equal(canUseCommandInPhase('.#rota', PHASES.PRE_RESET_DECISION), false);
});
