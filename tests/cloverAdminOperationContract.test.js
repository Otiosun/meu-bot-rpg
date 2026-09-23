'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ADMIN_CAPABILITIES,
    AdminOperationContractError,
    CONTRACT_VERSION,
    canRole,
    canTransitionOperation,
    generateOperationCode,
    normalizeAdminOperationInput,
} = require('../helpers/clover/adminOperationContract');

test('gera um único código universal OP', () => {
    const code = generateOperationCode(() => Buffer.from([0xA8, 0x31, 0x4D]));
    assert.equal(code, 'OP-A8314D');
});

test('reparo de identidade permanece owner-only', () => {
    assert.equal(canRole('owner', ADMIN_CAPABILITIES.PLAYER_IDENTITY_REPAIR), true);
    assert.equal(canRole('admin', ADMIN_CAPABILITIES.PLAYER_IDENTITY_REPAIR), false);
    assert.equal(canRole('evaluator', ADMIN_CAPABILITIES.PLAYER_IDENTITY_REPAIR), false);
});

test('normaliza uma operação de atribuição de traço', () => {
    const operation = normalizeAdminOperationInput({
        title: 'Atribuir Corpo de Rotina',
        reason: 'Aprovação administrativa',
        targets: [{ kind: 'player', playerId: '231426393948202@lid' }],
        actions: [{
            type: 'player.trait.assign',
            payload: { traitKey: 'corpo_de_rotina', slot: 'aptidao_comum' },
        }],
        idempotencyKey: 'test:trait:gohhan',
    }, {
        actorId: 'owner@lid',
        actorRole: 'owner',
        now: new Date('2026-07-22T18:30:00.000Z'),
        randomBytes: () => Buffer.from([0x01, 0x02, 0x03]),
    });

    assert.equal(operation.version, CONTRACT_VERSION);
    assert.equal(operation.code, 'OP-010203');
    assert.equal(operation.status, 'draft');
    assert.equal(operation.actor.role, 'owner');
    assert.deepEqual(operation.targets, [{ kind: 'player', playerId: '231426393948202@lid' }]);
    assert.equal(operation.actions[0].type, 'player.trait.assign');
    assert.deepEqual(operation.requiredCapabilities, [ADMIN_CAPABILITIES.PLAYER_MANAGE]);
});

test('deduplica seleção explícita de jogadores', () => {
    const operation = normalizeAdminOperationInput({
        title: 'Recompensa de raid',
        reason: 'Raid concluída',
        targets: [{ kind: 'players', values: ['A', 'B', 'A', '  B  '] }],
        actions: [{ type: 'reward.grant', payload: { packageKey: 'raid_3_estrelas' } }],
    }, {
        actorId: 'adm@lid',
        actorRole: 'admin',
        randomBytes: () => Buffer.from([0x0A, 0x0B, 0x0C]),
    });

    assert.deepEqual(operation.targets[0], { kind: 'players', values: ['A', 'B'] });
});

test('recusa ação financeira para avaliador', () => {
    assert.throws(() => normalizeAdminOperationInput({
        title: 'Adicionar PA',
        reason: 'Correção',
        targets: [{ kind: 'player', query: 'Gohhan' }],
        actions: [{ type: 'resource.adjust', payload: { resource: 'pa', amount: 20 } }],
    }, {
        actorId: 'avaliador@lid',
        actorRole: 'evaluator',
    }), (error) => {
        assert.equal(error instanceof AdminOperationContractError, true);
        assert.equal(error.code, 'forbidden_actions');
        assert.deepEqual(error.details.missing, [ADMIN_CAPABILITIES.RESOURCE_ADJUST]);
        return true;
    });
});

test('recusa lista de alvos vazia e ação desconhecida', () => {
    assert.throws(() => normalizeAdminOperationInput({
        title: 'Operação inválida',
        reason: 'Teste',
        targets: [{ kind: 'players', values: [] }],
        actions: [{ type: 'reward.grant', payload: {} }],
    }, {
        actorId: 'owner@lid',
        actorRole: 'owner',
    }), { code: 'empty_players_target' });

    assert.throws(() => normalizeAdminOperationInput({
        title: 'Operação inválida',
        reason: 'Teste',
        targets: [{ kind: 'player', query: 'Gohhan' }],
        actions: [{ type: 'qualquer.coisa', payload: {} }],
    }, {
        actorId: 'owner@lid',
        actorRole: 'owner',
    }), { code: 'unknown_action_type' });
});

test('permite apenas transições explícitas de estado', () => {
    assert.equal(canTransitionOperation('draft', 'simulated'), true);
    assert.equal(canTransitionOperation('simulated', 'approved'), true);
    assert.equal(canTransitionOperation('applied', 'undone'), true);
    assert.equal(canTransitionOperation('draft', 'applied'), false);
    assert.equal(canTransitionOperation('failed', 'applying'), false);
});
