'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { createPreResetPolicyRegistry } = require('../helpers/clover/preResetPolicyRegistryService');
const {
    applyLaunch,
    finalizeRoster,
    replaceKeepRoster,
} = require('../helpers/clover/preResetLaunchService');
const { addPh, getPhLedgerAuthoritySnapshot } = require('../helpers/clover/phService');
const { getReturnPointsBalance } = require('../helpers/clover/returnPointsService');
const {
    PH_RETURN_RESET_POLICY_VERSION,
    convertPhToReturnForReset,
} = require('../helpers/clover/phReturnResetConversionService');

function policyRegistry() {
    return createPreResetPolicyRegistry({
        testOnly: true,
        policies: {
            PRE_RESET_MODE: { status: 'ENABLED', policyVersion: 'ph-return-test-mode-v1' },
            SESSION_ELIGIBILITY: { status: 'ENABLED', policyVersion: 'ph-return-test-session-v1', eligibleReleasedSessions: true },
        },
    });
}

function adminContext(preReset = 'OFF') {
    return {
        actorId: 'admin-ph-return-test',
        env: {
            PRE_RESET_LAUNCH_ENABLED: 'true',
            PRE_RESET_RETURN_ENABLED: 'true',
            PRE_RESET: preReset,
        },
        policyRegistry: policyRegistry(),
        capabilities: ['prereset.review', 'player.manage', 'operation.apply'],
    };
}

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-ph-return-'));
    const db = await database.criarBanco({ filename: path.join(dir, 'database.sqlite') });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return db;
}

async function player(db, id, characterName) {
    await db.run(
        `INSERT INTO jogadores
         (id,nome,ficha_status,jogo_status,personagem_nome,personagem_aparencia,personagem_aparencia_status)
         VALUES (?,?,'aprovada','liberado',?,?,'approved')`,
        [id, `Player ${id}`, characterName, `Aparencia ${characterName}`]
    );
}

test('RESET automatico converte PH disponivel 1:1 em PR de Retorno antes de apagar PH', async (t) => {
    const db = await fixture(t);
    await player(db, 'keep-ph', 'Keep PH');
    await player(db, 'reset-ph', 'Reset PH');

    await addPh(db, 'reset-ph', 7, 'fixture', 'PH adicional fixture', 'admin-ph-return-test');
    const beforePh = await getPhLedgerAuthoritySnapshot(db, 'reset-ph');
    assert.equal(beforePh.available, 22, '15 PH inicial + 7 PH fixture');
    assert.equal(await getReturnPointsBalance(db, 'reset-ph'), 0);

    const ctxOff = adminContext('OFF');
    await replaceKeepRoster(db, ctxOff, {
        operationKey: 'ph-return:roster:replace:0001',
        expectedRevision: 0,
        keepPlayerIds: ['keep-ph'],
    });
    await finalizeRoster(db, ctxOff, {
        operationKey: 'ph-return:roster:finalize:0001',
        expectedRevision: 1,
    });

    const applied = await applyLaunch(db, adminContext('ON'), {
        operationKey: 'ph-return:apply:0001',
    });
    assert.equal(applied.completed, true);

    assert.equal(await getReturnPointsBalance(db, 'reset-ph'), 22);
    assert.equal(await getReturnPointsBalance(db, 'keep-ph'), 0);

    const resetPhRows = await db.get("SELECT COUNT(*) AS total FROM clover_ph_ledger WHERE player_id='reset-ph'");
    assert.equal(resetPhRows.total, 0, 'reset destrutivo remove PH legado depois da conversao');

    const claim = await db.get(
        `SELECT * FROM clover_return_point_conversion_claims
         WHERE player_id='reset-ph' AND policy_version=?`,
        [PH_RETURN_RESET_POLICY_VERSION]
    );
    assert.ok(claim);
    assert.equal(claim.source_ph_available, 22);
    assert.equal(claim.calculated_return_points, 22);

    const keepClaim = await db.get(
        `SELECT COUNT(*) AS total FROM clover_return_point_conversion_claims
         WHERE player_id='keep-ph' AND policy_version=?`,
        [PH_RETURN_RESET_POLICY_VERSION]
    );
    assert.equal(keepClaim.total, 0, 'KEEP nao converte PH para Return Points');

    const replay = await convertPhToReturnForReset(db, 'reset-ph', 'mythic_launch_v1', 'admin-ph-return-test');
    assert.equal(replay.duplicate, true);
    assert.equal(replay.calculatedReturnPoints, 22);
    assert.equal(await getReturnPointsBalance(db, 'reset-ph'), 22, 'retry nao duplica PR');
});
