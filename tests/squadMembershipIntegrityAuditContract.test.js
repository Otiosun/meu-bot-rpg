'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../groupAccess') {
        return { normalizeJid: (value) => String(value || '').trim().toLowerCase() || null };
    }
    if (request === './cavalierService') {
        return {
            normalizeSquadKey: (value) => String(value || '')
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || null,
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const audit = require('../helpers/clover/squadMembershipIntegrityAudit');
Module._load = originalLoad;

function healthySnapshot() {
    return {
        tables: {
            jogadores: true,
            clover_squads: true,
            clover_squad_memberships: true,
            clover_squad_membership_events: true,
        },
        activeUniqueIndex: {
            exists: true,
            valid: true,
            sql: "CREATE UNIQUE INDEX idx_clover_squad_memberships_active_player ON clover_squad_memberships(player_id) WHERE status = 'active'",
        },
        players: [{ id: 'a@lid', personagem_nome: 'A', esquadrao: 'Lobos' }],
        squads: [{ squad_key: 'lobos', name: 'Lobos' }],
        memberships: [{
            id: 1, player_id: 'a@lid', squad_key: 'lobos', status: 'active',
            joined_at: '2026-07-01 10:00:00', ended_at: null,
        }],
        events: [{ id: 1, membership_id: 1, player_id: 'a@lid', squad_key: 'lobos', action: 'added' }],
    };
}

test('estado coerente não gera achados', () => {
    const report = audit.classifySquadMembershipIntegrity(healthySnapshot());
    assert.equal(report.summary.findingCount, 0);
    assert.equal(report.summary.canAdvance, true);
    assert.equal(report.write, false);
    assert.equal(report.queryOnlySafe, true);
});

test('vínculos ativos duplicados são críticos e manuais', () => {
    const snapshot = healthySnapshot();
    snapshot.squads.push({ squad_key: 'trevos', name: 'Trevos' });
    snapshot.memberships.push({
        id: 2, player_id: 'a@lid', squad_key: 'trevos', status: 'active',
        joined_at: '2026-07-02 10:00:00', ended_at: null,
    });
    const report = audit.classifySquadMembershipIntegrity(snapshot);
    assert.ok(report.findings.some((item) => item.code === 'multiple_active_memberships'));
    assert.ok(report.repairPlan.manualRequired.some((item) => item.kind === 'resolve_multiple_active_memberships'));
    assert.equal(report.summary.canAdvance, false);
});

test('legado sem vínculo vira candidato, não correção executada', () => {
    const snapshot = healthySnapshot();
    snapshot.memberships = [];
    snapshot.events = [];
    const report = audit.classifySquadMembershipIntegrity(snapshot);
    assert.ok(report.findings.some((item) => item.code === 'legacy_membership_without_active_record'));
    assert.deepEqual(report.repairPlan.automaticCandidates, [{
        kind: 'create_active_membership_from_legacy',
        playerId: 'a@lid',
        squadKey: 'lobos',
    }]);
    assert.equal(report.repairPlan.executed, false);
});

test('vínculo ativo sem projeção legada é crítico', () => {
    const snapshot = healthySnapshot();
    snapshot.players[0].esquadrao = '-';
    const report = audit.classifySquadMembershipIntegrity(snapshot);
    assert.ok(report.findings.some((item) => item.code === 'active_membership_without_legacy_projection'));
    assert.ok(report.repairPlan.automaticCandidates.some((item) => item.kind === 'sync_legacy_projection_from_active'));
});

test('divergência entre ativo e legado exige decisão humana', () => {
    const snapshot = healthySnapshot();
    snapshot.squads.push({ squad_key: 'trevos', name: 'Trevos' });
    snapshot.players[0].esquadrao = 'Trevos';
    const report = audit.classifySquadMembershipIntegrity(snapshot);
    assert.ok(report.findings.some((item) => item.code === 'membership_legacy_mismatch'));
    assert.ok(report.repairPlan.manualRequired.some((item) => item.kind === 'resolve_membership_legacy_mismatch'));
});

test('período inválido e índice ausente são críticos', () => {
    const snapshot = healthySnapshot();
    snapshot.activeUniqueIndex = { exists: false, valid: false, sql: null };
    snapshot.memberships[0].status = 'removed';
    snapshot.memberships[0].joined_at = '2026-07-10 10:00:00';
    snapshot.memberships[0].ended_at = '2026-07-01 10:00:00';
    snapshot.players[0].esquado = '-';
    snapshot.players[0].esquadrao = '-';
    const report = audit.classifySquadMembershipIntegrity(snapshot);
    assert.ok(report.findings.some((item) => item.code === 'active_membership_unique_index_missing'));
    assert.ok(report.findings.some((item) => item.code === 'membership_invalid_period'));
});

test('leitura usa somente get/all e tolera tabelas ausentes', async () => {
    const db = {
        async get(sql, params = []) {
            if (/sqlite_master/.test(sql) && params[0] === 'jogadores') return { found: 1 };
            if (/sqlite_master/.test(sql)) return null;
            return null;
        },
        async all(sql) {
            assert.match(sql, /^SELECT id, personagem_nome, esquadrao FROM jogadores/);
            return [{ id: 'a@lid', personagem_nome: 'A', esquadrao: 'Lobos' }];
        },
        async run() { throw new Error('write attempted'); },
        async exec() { throw new Error('write attempted'); },
    };
    const snapshot = await audit.readSquadMembershipIntegritySnapshot(db);
    assert.equal(snapshot.players.length, 1);
    assert.equal(snapshot.memberships.length, 0);
    assert.equal(snapshot.write, false);
});
