'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildUrgentOperationalPlan,
    canonicalGrantEffective,
    normalizeSquadKey,
    playerEligibleForMembership,
} = require('../helpers/clover/urgentOperationalRepairService');

function baseSnapshot() {
    return {
        missingRequired: [],
        activeMembershipIndex: {
            name: 'idx_clover_squad_memberships_active_player',
            sql: "CREATE UNIQUE INDEX idx_clover_squad_memberships_active_player ON clover_squad_memberships (player_id) WHERE status = 'active'",
        },
        players: [
            {
                id: 'member@lid',
                nome: 'Membro',
                personagem_nome: 'Membro',
                esquadrao: 'Véu Negro',
                ficha_status: 'aprovada',
                jogo_status: 'liberado',
                identity_status: 'active',
                lifecycle_status: 'active',
                is_shadow: 0,
                merged_into: null,
                canonical_player_id: 'member@lid',
            },
            {
                id: 'eval@lid',
                nome: 'Avaliador',
                personagem_nome: 'Avaliador',
                esquadrao: '-',
                ficha_status: 'aprovada',
                jogo_status: 'liberado',
                identity_status: 'active',
                lifecycle_status: 'active',
                is_shadow: 0,
                merged_into: null,
                canonical_player_id: 'eval@lid',
            },
        ],
        squads: [
            {
                squad_key: 'veu_negro',
                name: 'Véu Negro',
                captain_name: 'Capitão',
                captain_player_id: null,
            },
        ],
        memberships: [],
        adminRoles: [],
        canonicalRoleGrants: [
            {
                id: 1,
                subject_id: 'eval@lid',
                role_key: 'evaluator',
                scope_type: 'global',
                scope_key: '*',
                status: 'active',
                valid_from: '2026-08-01 00:00:00',
                valid_until: null,
                granted_by: 'owner@lid',
                created_at: '2026-08-01 00:00:00',
            },
        ],
        captainProfiles: [],
        adminOperations: [],
        rewardPackages: [],
        rewardGrants: [],
        raids: [],
        raidParticipantCounts: [],
        raidRewardCounts: [],
    };
}

const referenceDate = new Date('2026-08-06T22:00:00Z');

test('normaliza nomes de esquadrão com acento para a chave canônica', () => {
    assert.equal(normalizeSquadKey('Véu Negro'), 'veu_negro');
    assert.equal(normalizeSquadKey('Trevos da Esperança'), 'trevos_da_esperanca');
});

test('elegibilidade exige ficha aprovada, jogo liberado e identidade ativa', () => {
    const player = baseSnapshot().players[0];
    assert.equal(playerEligibleForMembership(player), true);
    assert.equal(playerEligibleForMembership({ ...player, jogo_status: 'bloqueado' }), false);
    assert.equal(playerEligibleForMembership({ ...player, lifecycle_status: 'archived' }), false);
    assert.equal(playerEligibleForMembership({ ...player, personagem_nome: '-' }), false);
});

test('cargo canônico respeita início e expiração', () => {
    const row = baseSnapshot().canonicalRoleGrants[0];
    assert.equal(canonicalGrantEffective(row, referenceDate), true);
    assert.equal(canonicalGrantEffective({ ...row, valid_from: '2026-08-07 00:00:00' }, referenceDate), false);
    assert.equal(canonicalGrantEffective({ ...row, valid_until: '2026-08-06 21:59:59' }, referenceDate), false);
});

test('plano seguro identifica projeção ADM e mantém vínculo legado aguardando mapa aprovado', () => {
    const plan = buildUrgentOperationalPlan(baseSnapshot(), { referenceDate });
    assert.equal(plan.safeToApply, true);
    assert.equal(plan.summary.adminProjectionCandidates, 1);
    assert.equal(plan.admin.candidates[0].subjectId, 'eval@lid');
    assert.equal(plan.admin.candidates[0].role, 'evaluator');
    assert.equal(plan.summary.squadMembershipCandidates, 0);
    assert.equal(plan.summary.squadMembershipReviewCount, 1);
    assert.equal(plan.squads.requiresApprovedMap[0].playerId, 'member@lid');
    assert.equal(plan.squads.requiresApprovedMap[0].squadKey, 'veu_negro');
});

test('mapa explícito permite backfill somente quando confirma o esquadrão legado', () => {
    const plan = buildUrgentOperationalPlan(baseSnapshot(), {
        referenceDate,
        approvedMembershipMap: [{ playerId: 'member@lid', squadKey: 'veu_negro' }],
    });
    assert.equal(plan.safeToApply, true);
    assert.equal(plan.summary.squadMembershipCandidates, 1);
    assert.equal(plan.squads.automaticCandidates[0].playerId, 'member@lid');
});

test('estado já sincronizado é idempotente e não cria candidatos', () => {
    const snapshot = baseSnapshot();
    snapshot.adminRoles.push({
        player_id: 'eval@lid',
        role: 'evaluator',
        active: 1,
    });
    snapshot.memberships.push({
        id: 10,
        player_id: 'member@lid',
        squad_key: 'veu_negro',
        status: 'active',
    });
    const plan = buildUrgentOperationalPlan(snapshot, { referenceDate });
    assert.equal(plan.safeToApply, true);
    assert.equal(plan.summary.adminProjectionCandidates, 0);
    assert.equal(plan.summary.squadMembershipCandidates, 0);
    assert.equal(plan.summary.squadMembershipReviewCount, 0);
    assert.equal(plan.admin.matched.length, 1);
    assert.equal(plan.squads.matched.length, 1);
});

test('cargo legado divergente bloqueia aplicação automática', () => {
    const snapshot = baseSnapshot();
    snapshot.adminRoles.push({
        player_id: 'eval@lid',
        role: 'admin',
        active: 1,
    });
    const plan = buildUrgentOperationalPlan(snapshot, { referenceDate });
    assert.equal(plan.safeToApply, false);
    assert.equal(plan.admin.mismatches.length, 1);
    assert.ok(plan.blockingReasons.some((item) => item.code === 'admin_projection_conflicts'));
});

test('mais de um cargo canônico efetivo bloqueia aplicação automática', () => {
    const snapshot = baseSnapshot();
    snapshot.canonicalRoleGrants.push({
        ...snapshot.canonicalRoleGrants[0],
        id: 2,
        role_key: 'admin',
    });
    const plan = buildUrgentOperationalPlan(snapshot, { referenceDate });
    assert.equal(plan.safeToApply, false);
    assert.equal(plan.admin.ambiguousCanonical.length, 1);
});

test('vínculo ativo em outro esquadrão bloqueia backfill', () => {
    const snapshot = baseSnapshot();
    snapshot.squads.push({ squad_key: 'kings_of_sun', name: 'Kings of Sun' });
    snapshot.memberships.push({
        id: 20,
        player_id: 'member@lid',
        squad_key: 'kings_of_sun',
        status: 'active',
    });
    const plan = buildUrgentOperationalPlan(snapshot, {
        referenceDate,
        approvedMembershipMap: [{ playerId: 'member@lid', squadKey: 'veu_negro' }],
    });
    assert.equal(plan.safeToApply, false);
    assert.equal(plan.squads.mismatches.length, 1);
    assert.equal(plan.summary.squadMembershipCandidates, 0);
});

test('personagem legado inelegível não é migrado silenciosamente', () => {
    const snapshot = baseSnapshot();
    snapshot.players[0].ficha_status = 'incompleta';
    const plan = buildUrgentOperationalPlan(snapshot, {
        referenceDate,
        approvedMembershipMap: [{ playerId: 'member@lid', squadKey: 'veu_negro' }],
    });
    assert.equal(plan.safeToApply, false);
    assert.equal(plan.squads.ineligibleLegacy.length, 1);
});

test('capitão sem identidade fica somente para decisão manual', () => {
    const plan = buildUrgentOperationalPlan(baseSnapshot(), { referenceDate });
    assert.equal(plan.captains.manualMissingCaptainIdentity.length, 1);
    assert.equal(plan.captains.automaticRepairCount, 0);
    assert.equal(plan.safeToApply, true);
});
