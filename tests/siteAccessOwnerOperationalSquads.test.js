'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    filterOperationalSquadsForOwner,
} = require('../helpers/clover/siteAccessPayloadService');
const {
    SquadMembershipReadError,
} = require('../helpers/clover/squadMembershipReadService');

const persistedSquads = [
    'trevos',
    'dourados',
    'bruxa',
    'veu',
    'magenta',
    'asas',
    'kings',
    'lobos',
].map((squadKey) => ({
    squad_key: squadKey,
    name: squadKey,
}));

function createCanonicalDb({ conflict = false } = {}) {
    const players = [
        { id: 'p1@lid', esquadrao: 'Magenta' },
        { id: 'p2@lid', esquadrao: 'Asas' },
        { id: 'p3@lid', esquadrao: 'Kings' },
        { id: 'p4@lid', esquadrao: 'Lobos' },
    ];
    const memberships = [
        { id: 1, player_id: 'p1@lid', squad_key: 'trevos', status: 'active', squad_name: 'Trevos' },
        { id: 2, player_id: 'p2@lid', squad_key: 'dourados', status: 'active', squad_name: 'Dourados' },
        { id: 3, player_id: 'p3@lid', squad_key: 'bruxa', status: 'active', squad_name: 'Bruxa' },
        { id: 4, player_id: 'p4@lid', squad_key: 'veu', status: 'active', squad_name: 'Veu' },
    ];
    if (conflict) {
        memberships.push({
            id: 5,
            player_id: 'p1@lid',
            squad_key: 'magenta',
            status: 'active',
            squad_name: 'Magenta',
        });
    }

    return {
        async get(sql) {
            if (String(sql).includes('sqlite_master')) return { found: 1 };
            throw new Error(`Unexpected get: ${sql}`);
        },
        async all(sql) {
            const source = String(sql);
            if (source.includes('SELECT * FROM jogadores')) return players;
            if (source.includes('FROM clover_squad_memberships membership')) return memberships;
            throw new Error(`Unexpected all: ${sql}`);
        },
    };
}

test('owner sees only four canonically operational squads when eight rows remain persisted', async () => {
    const db = createCanonicalDb();

    const visible = await filterOperationalSquadsForOwner(
        db,
        persistedSquads,
        { owner: true }
    );

    assert.equal(persistedSquads.length, 8);
    assert.deepEqual(
        visible.map((row) => row.squad_key),
        ['trevos', 'dourados', 'bruxa', 'veu']
    );
});

test('non-owner path keeps existing squad candidate semantics and does not query membership reader', async () => {
    const db = {
        async get() {
            throw new Error('membership reader must not run for non-owner');
        },
        async all() {
            throw new Error('membership reader must not run for non-owner');
        },
    };

    const visible = await filterOperationalSquadsForOwner(
        db,
        persistedSquads,
        { owner: false }
    );

    assert.equal(visible, persistedSquads);
    assert.equal(visible.length, 8);
});

test('owner filter fails closed when canonical membership has multiple active rows', async () => {
    const db = createCanonicalDb({ conflict: true });

    await assert.rejects(
        () => filterOperationalSquadsForOwner(db, persistedSquads, { owner: true }),
        (error) => (
            error instanceof SquadMembershipReadError
            && error.code === 'multiple_active_memberships'
        )
    );
});
