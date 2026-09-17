const test = require('node:test');
const assert = require('node:assert/strict');

const { archiveAndResetPlayer } = require('../helpers/clover/playerReset');

async function assertManualStaffOnly(reason) {
    await assert.rejects(
        () => archiveAndResetPlayer({
            sock: null,
            db: null,
            playerId: 'player@lid',
            reason,
        }),
        (error) => {
            assert.equal(error.code, 'manual_staff_lifecycle_required');
            assert.equal(error.reason, reason.toLowerCase());
            assert.match(error.message, /ação administrativa explícita/i);
            return true;
        }
    );
}

test('saída confirmada pelo próprio player não pode arquivar/resetar automaticamente', async () => {
    await assertManualStaffOnly('community-exit-confirmed');
});

test('resposta privada anti-ghost do próprio player não pode remover personagem automaticamente', async () => {
    await assert.rejects(
        () => archiveAndResetPlayer({
            sock: null,
            db: null,
            playerId: 'player@lid',
            reason: 'anti-ghost: pedido do player por resposta anti-ghost',
        }),
        (error) => {
            assert.equal(error.code, 'prereset_antighost_mutation_disabled');
            assert.equal(error.manualOnly, true);
            assert.match(error.message, /ação administrativa explícita/i);
            return true;
        }
    );
});

test('timeout de saída continua terminal e não destrutivo', async () => {
    const result = await archiveAndResetPlayer({
        sock: null,
        db: null,
        playerId: 'player@lid',
        reason: 'community-exit-expired',
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.archived, false);
    assert.equal(result.mode, 'no_action');
    assert.equal(result.reason, 'community_exit_expired_no_action');
    assert.equal(result.backupPath, null);
});
