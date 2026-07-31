'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let scenario;

class SquadMembershipError extends Error {
    constructor(message, code, details = null) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../groupAccess') {
        return {
            normalizeJid: (value) => String(value || '').trim().toLowerCase() || null,
            isSameUser: (left, right) => String(left || '').toLowerCase() === String(right || '').toLowerCase(),
        };
    }
    if (request === './accessIntegrationService') {
        return {
            ACCESS_PERMISSIONS: { SQUAD_MEMBERS_MANAGE: 'squad.manage.members' },
            authorizeSquadAccess: async (db, input) => ({ ok: !scenario.deniedSquads?.includes(input.squad.squad_key) }),
        };
    }
    if (request === './cavalierService') {
        return {
            normalizeSquadKey: (value) => String(value || '')
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || null,
        };
    }
    if (request === './squadMembershipService') {
        return { SquadMembershipError, ensureSquadMembershipSchema: async () => {} };
    }
    if (request === './squadStateService') {
        return {
            resolveSquad: async (db, { squadName }) => scenario.squads[String(squadName).toLowerCase()] || null,
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const service = require('../helpers/clover/squadMembershipTransitionService');
Module._load = originalLoad;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createDb(options = {}) {
    const state = {
        players: [{ id: 'player@lid', personagem_nome: 'Player', esquadrao: 'Lobos' }],
        memberships: [{
            id: 1, squad_key: 'lobos', player_id: 'player@lid', status: 'active',
            joined_at: '2026-07-01 10:00:00', ended_at: null, changed_by: 'admin@lid',
            reason: null, metadata_json: '{}',
        }],
        events: [],
        transitions: [],
        nextMembershipId: 2,
        nextEventId: 1,
        nextTransitionId: 1,
    };
    let backup = null;
    const db = {
        state,
        async exec(sql) {
            if (/CREATE TABLE|CREATE INDEX/.test(sql)) return;
            if (sql === 'BEGIN IMMEDIATE') backup = clone(state);
            else if (sql === 'COMMIT') backup = null;
            else if (sql === 'ROLLBACK') {
                Object.assign(state, backup);
                backup = null;
            }
        },
        async get(sql, params) {
            if (/membership_transitions WHERE transition_key/.test(sql)) {
                return state.transitions.find((row) => row.transition_key === params[0]) || null;
            }
            if (/SELECT \* FROM jogadores WHERE id/.test(sql)) {
                return state.players.find((row) => row.id === params[0]) || null;
            }
            if (/SELECT \* FROM clover_squad_memberships WHERE id/.test(sql)) {
                return state.memberships.find((row) => row.id === Number(params[0])) || null;
            }
            throw new Error(`Unhandled get: ${sql}`);
        },
        async all(sql, params) {
            if (/WHERE player_id = \? AND status = 'active'/.test(sql)) {
                return state.memberships.filter((row) => row.player_id === params[0] && row.status === 'active');
            }
            throw new Error(`Unhandled all: ${sql}`);
        },
        async run(sql, params) {
            if (/UPDATE clover_squad_memberships/.test(sql) && /status = 'transferred'/.test(sql)) {
                const row = state.memberships.find((item) => item.id === Number(params[3]) && item.status === 'active');
                if (!row) return { changes: 0 };
                row.status = 'transferred';
                row.ended_at = '2026-07-31 12:00:00';
                row.changed_by = params[0];
                row.reason = params[1];
                row.metadata_json = params[2];
                return { changes: 1 };
            }
            if (/INSERT INTO clover_squad_memberships/.test(sql)) {
                const row = {
                    id: state.nextMembershipId++, squad_key: params[0], player_id: params[1], status: 'active',
                    joined_at: '2026-07-31 12:00:00', ended_at: null,
                    changed_by: params[2], reason: params[3], metadata_json: params[4],
                };
                state.memberships.push(row);
                return { lastID: row.id, changes: 1 };
            }
            if (/UPDATE jogadores SET esquadrao/.test(sql)) {
                const row = state.players.find((item) => item.id === params[1]);
                if (!row) return { changes: 0 };
                row.esquadrao = params[0];
                return { changes: 1 };
            }
            if (/INSERT INTO clover_squad_membership_events/.test(sql)) {
                if (options.failEvent && state.events.length === options.failEventAfter) {
                    throw new Error('event failure');
                }
                state.events.push({
                    id: state.nextEventId++, membership_id: params[0], squad_key: params[1],
                    player_id: params[2], action: params[3], performed_by: params[4],
                    reason: params[5], metadata_json: params[6],
                });
                return { lastID: state.nextEventId - 1, changes: 1 };
            }
            if (/INSERT INTO clover_squad_membership_transitions/.test(sql)) {
                const row = {
                    id: state.nextTransitionId++, transition_key: params[0], request_hash: params[1],
                    player_id: params[2], from_squad_key: params[3], to_squad_key: params[4],
                    from_membership_id: params[5], to_membership_id: params[6], status: 'completed',
                    performed_by: params[7], reason: params[8], result_json: params[9], metadata_json: params[10],
                };
                state.transitions.push(row);
                return { lastID: row.id, changes: 1 };
            }
            throw new Error(`Unhandled run: ${sql}`);
        },
    };
    return db;
}

function baseScenario() {
    return {
        deniedSquads: [],
        squads: {
            lobos: { squad_key: 'lobos', name: 'Lobos', captain_player_id: 'captain@lid', vice_captain_player_id: null },
            trevos: { squad_key: 'trevos', name: 'Trevos', captain_player_id: 'other@lid', vice_captain_player_id: null },
        },
    };
}

function input(overrides = {}) {
    return {
        actorId: 'admin@lid', characterId: 'player@lid', fromSquadInput: 'lobos',
        toSquadInput: 'trevos', reason: 'Reestruturação aprovada',
        transitionKey: 'membership:transfer:001', ...overrides,
    };
}

test('transferência fecha origem, cria destino e atualiza projeção no mesmo commit', async () => {
    scenario = baseScenario();
    const db = createDb();
    const result = await service.transferSquadMember(db, input());
    assert.equal(result.duplicate, false);
    assert.equal(db.state.memberships.filter((row) => row.status === 'active').length, 1);
    assert.equal(db.state.memberships.find((row) => row.id === 1).status, 'transferred');
    assert.equal(db.state.memberships.find((row) => row.status === 'active').squad_key, 'trevos');
    assert.equal(db.state.players[0].esquadrao, 'Trevos');
    assert.equal(db.state.events.length, 2);
    assert.equal(db.state.transitions.length, 1);
});

test('falha em evento desfaz toda a transferência', async () => {
    scenario = baseScenario();
    const db = createDb({ failEvent: true, failEventAfter: 1 });
    await assert.rejects(() => service.transferSquadMember(db, input()), /event failure/);
    assert.equal(db.state.memberships.length, 1);
    assert.equal(db.state.memberships[0].status, 'active');
    assert.equal(db.state.players[0].esquadrao, 'Lobos');
    assert.equal(db.state.events.length, 0);
    assert.equal(db.state.transitions.length, 0);
});

test('retry com a mesma chave retorna duplicata sem reaplicar', async () => {
    scenario = baseScenario();
    const db = createDb();
    const first = await service.transferSquadMember(db, input());
    const second = await service.transferSquadMember(db, input());
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(db.state.memberships.length, 2);
    assert.equal(db.state.events.length, 2);
});

test('reuso da chave com payload diferente é conflito', async () => {
    scenario = baseScenario();
    const db = createDb();
    await service.transferSquadMember(db, input());
    await assert.rejects(
        () => service.transferSquadMember(db, input({ reason: 'Outro motivo' })),
        (error) => error.code === 'membership_transition_idempotency_conflict'
    );
});

test('duplicidade ativa bloqueia antes de mutar', async () => {
    scenario = baseScenario();
    const db = createDb();
    db.state.memberships.push({ ...clone(db.state.memberships[0]), id: 9, squad_key: 'trevos' });
    await assert.rejects(
        () => service.transferSquadMember(db, input()),
        (error) => error.code === 'multiple_active_memberships'
    );
    assert.equal(db.state.events.length, 0);
});

test('divergência entre vínculo e projeção bloqueia fail-closed', async () => {
    scenario = baseScenario();
    const db = createDb();
    db.state.players[0].esquadrao = 'Trevos';
    await assert.rejects(
        () => service.transferSquadMember(db, input()),
        (error) => error.code === 'membership_transfer_source_conflict'
    );
    assert.equal(db.state.memberships[0].status, 'active');
});

test('ator precisa administrar origem e destino', async () => {
    scenario = baseScenario();
    scenario.deniedSquads = ['trevos'];
    const db = createDb();
    await assert.rejects(
        () => service.transferSquadMember(db, input()),
        (error) => error.code === 'forbidden' && error.details.squadKey === 'trevos'
    );
});

test('liderança não pode ser transferida pelo fluxo genérico', async () => {
    scenario = baseScenario();
    scenario.squads.lobos.captain_player_id = 'player@lid';
    const db = createDb();
    await assert.rejects(
        () => service.transferSquadMember(db, input()),
        (error) => error.code === 'leadership_transfer_blocked'
    );
});
