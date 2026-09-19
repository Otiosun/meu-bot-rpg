'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildEligibilityStatusInventory,
    normalizeStatus,
} = require('../helpers/clover/squadMembershipEligibilityStatusAudit');

function snapshot() {
    return {
        write: false,
        queryOnlySafe: true,
        schema: { jogadores: true, clover_squad_memberships: true, missingPlayerColumns: [] },
        players: [
            { id: 'a', personagem_nome: 'Alpha', ficha_status: 'Aprovada', jogo_status: 'Liberado', esquadrao: 'Lobos' },
            { id: 'b', personagem_nome: 'Beta', ficha_status: 'aprovado', jogo_status: 'liberada', esquadrao: '-' },
            { id: 'c', personagem_nome: 'Gamma', ficha_status: 'Pendente', jogo_status: 'Bloqueado', esquadrao: '-' },
            { id: 'd', personagem_nome: '-', ficha_status: null, jogo_status: '', esquadrao: '-' },
        ],
        memberships: [
            { player_id: 'a', squad_key: 'lobos', status: 'active' },
        ],
    };
}

test('normalização preserva semântica e remove variações superficiais', () => {
    assert.equal(normalizeStatus('  APROVÁDA  '), 'aprovada');
    assert.equal(normalizeStatus('-'), null);
    assert.equal(normalizeStatus(null), null);
});

test('inventário conta vocabulário bruto, normalizado e pares', () => {
    const report = buildEligibilityStatusInventory(snapshot());
    assert.equal(report.write, false);
    assert.equal(report.queryOnlySafe, true);
    assert.equal(report.policy.evaluated, false);
    assert.equal(report.summary.playerCount, 4);
    assert.equal(report.summary.existingMemberCount, 1);
    assert.equal(report.summary.candidateCount, 2);
    assert.equal(report.vocabulary.sheet.raw.some((row) => row.value === 'Aprovada'), true);
    assert.equal(report.vocabulary.sheet.normalized.some((row) => row.value === 'aprovada'), true);
    assert.equal(report.vocabulary.pairs.length, 4);
});

test('colisões registram múltiplas formas brutas da mesma forma normalizada', () => {
    const source = snapshot();
    source.players.push({
        id: 'e', personagem_nome: 'Épsilon', ficha_status: 'APROVÁDA', jogo_status: 'Liberado', esquadrao: '-',
    });
    const report = buildEligibilityStatusInventory(source);
    const collision = report.vocabulary.sheet.collisions.find((row) => row.value === 'aprovada');
    assert.deepEqual(collision.rawValues, ['APROVÁDA', 'Aprovada']);
});

test('política explícita mede candidatos e não é aplicada ao banco', () => {
    const report = buildEligibilityStatusInventory(snapshot(), {
        approvedSheetStatuses: ['aprovada', 'aprovado'],
        releasedGameStatuses: ['liberado', 'liberada'],
    });
    assert.equal(report.policy.evaluated, true);
    assert.equal(report.policyApplied, false);
    assert.equal(report.summary.eligibleCandidateCount, 1);
    assert.equal(report.summary.blockedCandidateCount, 1);
    assert.equal(report.policyImpact.eligibleCandidates[0].playerId, 'b');
    assert.equal(report.policyImpact.blockedCandidates[0].policy.reason, 'sheet_not_approved');
});

test('política revela membro existente que seria bloqueado', () => {
    const source = snapshot();
    source.players[0].ficha_status = 'Pendente';
    const report = buildEligibilityStatusInventory(source, {
        approvedSheetStatuses: ['aprovada', 'aprovado'],
        releasedGameStatuses: ['liberado', 'liberada'],
    });
    assert.equal(report.policy.safeForExistingMembers, false);
    assert.equal(report.summary.existingMemberFailureCount, 1);
    assert.equal(report.policyImpact.existingMemberFailures[0].playerId, 'a');
});

test('personagem sem nome falha antes dos status', () => {
    const report = buildEligibilityStatusInventory(snapshot(), {
        approvedSheetStatuses: ['aprovada', 'aprovado'],
        releasedGameStatuses: ['liberado', 'liberada'],
    });
    const incomplete = report.records.find((row) => row.playerId === 'd');
    assert.equal(incomplete.policy.reason, 'character_incomplete');
});

test('status observados fora da allowlist permanecem visíveis', () => {
    const report = buildEligibilityStatusInventory(snapshot(), {
        approvedSheetStatuses: ['aprovada'],
        releasedGameStatuses: ['liberado'],
    });
    assert.deepEqual(report.policy.observedSheetStatusesOutsidePolicy, ['aprovado', 'pendente']);
    assert.deepEqual(report.policy.observedGameStatusesOutsidePolicy, ['bloqueado', 'liberada']);
});

test('schema incompleto nunca produz política segura', () => {
    const source = snapshot();
    source.schema.missingPlayerColumns = ['ficha_status'];
    const report = buildEligibilityStatusInventory(source, {
        approvedSheetStatuses: ['aprovada', 'aprovado'],
        releasedGameStatuses: ['liberado', 'liberada'],
    });
    assert.equal(report.policy.schemaReady, false);
    assert.equal(report.policy.safeForExistingMembers, false);
});
