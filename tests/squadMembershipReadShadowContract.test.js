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
const shadow = require('../helpers/clover/squadMembershipReadShadowService');
Module._load = originalLoad;

function healthySnapshot() {
    return {
        tables: { jogadores: true, clover_squads: true, clover_squad_memberships: true },
        squads: [
            { squad_key: 'lobos', name: 'Lobos' },
            { squad_key: 'trevos', name: 'Trevos' },
        ],
        players: [
            { id: 'a@lid', personagem_nome: 'A', esquadrao: 'Lobos' },
            { id: 'b@lid', personagem_nome: 'B', esquadrao: 'Trevos' },
        ],
        memberships: [
            { id: 1, player_id: 'a@lid', squad_key: 'lobos', status: 'active' },
            { id: 2, player_id: 'b@lid', squad_key: 'trevos', status: 'active' },
        ],
    };
}

test('fontes coerentes produzem shadow limpo sem trocar enforcement', () => {
    const report = shadow.buildSquadMembershipReadShadow(healthySnapshot());
    assert.equal(report.summary.divergentPlayerCount, 0);
    assert.equal(report.summary.safeToSwitchConsumers, true);
    assert.equal(report.enforcementChanged, false);
    assert.equal(report.write, false);
});

test('legado sem vínculo mostra quem desapareceria na troca', () => {
    const snapshot = healthySnapshot();
    snapshot.memberships = snapshot.memberships.filter((row) => row.player_id !== 'a@lid');
    const report = shadow.buildSquadMembershipReadShadow(snapshot);
    const player = report.players.find((item) => item.playerId === 'a@lid');
    assert.equal(player.state, 'legacy_only');
    assert.equal(player.severity, 'warning');
    assert.deepEqual(shadow.squadMemberIdsShadow(report, 'lobos').onlyLegacy, ['a@lid']);
    assert.equal(report.summary.safeToSwitchConsumers, false);
});

test('vínculo canônico sem projeção mostra membro omitido pelo painel atual', () => {
    const snapshot = healthySnapshot();
    snapshot.players[0].esquadrao = '-';
    const report = shadow.buildSquadMembershipReadShadow(snapshot);
    const player = report.players.find((item) => item.playerId === 'a@lid');
    assert.equal(player.state, 'canonical_only');
    assert.equal(player.severity, 'critical');
    assert.deepEqual(shadow.squadMemberIdsShadow(report, 'lobos').onlyCanonical, ['a@lid']);
});

test('mismatch expõe diferença em listagem, resolveSquad e participação', () => {
    const snapshot = healthySnapshot();
    snapshot.players[0].esquadrao = 'Trevos';
    const report = shadow.buildSquadMembershipReadShadow(snapshot);
    const player = report.players.find((item) => item.playerId === 'a@lid');
    assert.equal(player.state, 'mismatch');
    assert.equal(player.consumerImpact.listSquadMembersChanges, true);
    assert.equal(player.consumerImpact.resolveSquadByPlayerChanges, true);
    assert.equal(player.consumerImpact.participationMemberSetChanges, true);
    assert.deepEqual(shadow.resolvePlayerSquadShadow(report, 'A@LID'), {
        playerId: 'a@lid', legacySquadKey: 'trevos', canonicalSquadKey: 'lobos', changes: true, state: 'mismatch',
    });
});

test('mais de um vínculo ativo permanece crítico e sem escolha implícita', () => {
    const snapshot = healthySnapshot();
    snapshot.memberships.push({ id: 9, player_id: 'a@lid', squad_key: 'trevos', status: 'active' });
    const report = shadow.buildSquadMembershipReadShadow(snapshot);
    const player = report.players.find((item) => item.playerId === 'a@lid');
    assert.equal(player.state, 'multiple_active');
    assert.equal(player.canonicalSquadKey, null);
    assert.equal(report.summary.criticalCount, 1);
});

test('esquadrão desconhecido é crítico mesmo quando fontes concordam', () => {
    const snapshot = healthySnapshot();
    snapshot.squads = snapshot.squads.filter((row) => row.squad_key !== 'lobos');
    const report = shadow.buildSquadMembershipReadShadow(snapshot);
    const player = report.players.find((item) => item.playerId === 'a@lid');
    assert.deepEqual(player.unknownSquadKeys, ['lobos']);
    assert.equal(player.severity, 'critical');
});

test('leitura tolera tabelas ausentes e não tenta escrever', async () => {
    const db = {
        async get(sql, params) {
            if (/sqlite_master/.test(sql) && params[0] === 'jogadores') return { found: 1 };
            return null;
        },
        async all(sql) {
            assert.match(sql, /^SELECT id, nome, display_name/);
            return [{ id: 'a@lid', personagem_nome: 'A', esquadrao: 'Lobos' }];
        },
        async run() { throw new Error('write attempted'); },
        async exec() { throw new Error('write attempted'); },
    };
    const snapshot = await shadow.readSquadMembershipSourceSnapshot(db);
    assert.equal(snapshot.players.length, 1);
    assert.equal(snapshot.memberships.length, 0);
    assert.equal(snapshot.queryOnlySafe, true);
});
