'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { COMMAND_PREFIX } = require('../config/bot');
const { getMessageText, normalizeCanonicalCommandAlias } = require('../helpers/messageContext');
const { isPreResetLaunchEnabled } = require('../helpers/clover/preResetAccessService');
const { archiveAndResetPlayer } = require('../helpers/clover/playerReset');
const { canUseCommandInPhase, PHASES } = require('../helpers/clover/playerPhase');

function withPreResetFlags(t) {
    const beforeLaunch = process.env.PRE_RESET_LAUNCH_ENABLED;
    const beforeReturn = process.env.PRE_RESET_RETURN_ENABLED;
    process.env.PRE_RESET_LAUNCH_ENABLED = 'true';
    process.env.PRE_RESET_RETURN_ENABLED = 'true';
    t.after(() => {
        if (beforeLaunch === undefined) delete process.env.PRE_RESET_LAUNCH_ENABLED;
        else process.env.PRE_RESET_LAUNCH_ENABLED = beforeLaunch;
        if (beforeReturn === undefined) delete process.env.PRE_RESET_RETURN_ENABLED;
        else process.env.PRE_RESET_RETURN_ENABLED = beforeReturn;
    });
}

function withoutPreResetFlags(t) {
    const beforeLaunch = process.env.PRE_RESET_LAUNCH_ENABLED;
    const beforeReturn = process.env.PRE_RESET_RETURN_ENABLED;
    delete process.env.PRE_RESET_LAUNCH_ENABLED;
    delete process.env.PRE_RESET_RETURN_ENABLED;
    t.after(() => {
        if (beforeLaunch === undefined) delete process.env.PRE_RESET_LAUNCH_ENABLED;
        else process.env.PRE_RESET_LAUNCH_ENABLED = beforeLaunch;
        if (beforeReturn === undefined) delete process.env.PRE_RESET_RETURN_ENABLED;
        else process.env.PRE_RESET_RETURN_ENABLED = beforeReturn;
    });
}

function poisonDbTracker() {
    let touched = false;
    const db = new Proxy({}, {
        get() {
            touched = true;
            throw new Error('DB nao deveria ser tocado');
        },
    });
    return { db, wasTouched:() => touched };
}

test('F11: site e bot compartilham gate duplo fail-closed', () => {
    assert.equal(isPreResetLaunchEnabled({}), false);
    assert.equal(isPreResetLaunchEnabled({ PRE_RESET_LAUNCH_ENABLED:'true' }), false);
    assert.equal(isPreResetLaunchEnabled({ PRE_RESET_RETURN_ENABLED:'true' }), false);
    assert.equal(isPreResetLaunchEnabled({ PRE_RESET_LAUNCH_ENABLED:'TRUE', PRE_RESET_RETURN_ENABLED:'true' }), false);
    assert.equal(isPreResetLaunchEnabled({ PRE_RESET_LAUNCH_ENABLED:'true', PRE_RESET_RETURN_ENABLED:'true' }), true);
});

test('F11: #retorno literal vira somente o comando interno canonico e passa pelo gate', () => {
    assert.equal(normalizeCanonicalCommandAlias('#retorno'), `${COMMAND_PREFIX}retorno`);
    assert.equal(normalizeCanonicalCommandAlias('#RETORNO confirmar manter'), `${COMMAND_PREFIX}retorno confirmar manter`);
    assert.equal(normalizeCanonicalCommandAlias('#status'), '#status');
    assert.equal(normalizeCanonicalCommandAlias('.#retorno'), '.#retorno');

    const incoming = getMessageText({ message:{ conversation:'#retorno resetar' } });
    assert.equal(incoming, `${COMMAND_PREFIX}retorno resetar`);
    assert.equal(canUseCommandInPhase('#retorno', PHASES.PRE_RESET_DECISION), true);
    assert.equal(canUseCommandInPhase(`${COMMAND_PREFIX}retorno`, PHASES.PRE_RESET_DECISION), true);
    assert.equal(canUseCommandInPhase(`${COMMAND_PREFIX}perfil`, PHASES.PRE_RESET_DECISION), false);
});

test('F11: qualquer caminho anti-ghost falha antes de tocar DB durante PRE_RESET', async (t) => {
    withPreResetFlags(t);
    const tracker = poisonDbTracker();

    await assert.rejects(
        archiveAndResetPlayer({
            db:tracker.db,
            playerId:'ambiguous-player@lid',
            reason:'anti-ghost: inatividade confirmada',
        }),
        (error) => error?.code === 'prereset_antighost_mutation_disabled'
    );
    assert.equal(tracker.wasTouched(), false);
});

test('F11: anti-ghost permanece manual-only mesmo fora do PRE_RESET', async (t) => {
    withoutPreResetFlags(t);
    const tracker = poisonDbTracker();

    await assert.rejects(
        archiveAndResetPlayer({
            db:tracker.db,
            playerId:'ambiguous-player@lid',
            reason:'anti-ghost: identidade potencialmente ambigua',
        }),
        (error) => error?.code === 'prereset_antighost_mutation_disabled' && error?.manualOnly === true
    );
    assert.equal(tracker.wasTouched(), false);
});

test('F11: pedido privado anti-ghost tambem e fail-closed antes de mutacao', async (t) => {
    withPreResetFlags(t);
    await assert.rejects(
        archiveAndResetPlayer({
            db:null,
            playerId:'player@lid',
            reason:'anti-ghost: pedido do player por resposta anti-ghost',
        }),
        (error) => error?.code === 'prereset_antighost_mutation_disabled'
    );
});
