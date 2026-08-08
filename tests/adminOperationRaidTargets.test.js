'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    AdminOperationServiceError,
    materializeRaidParticipantSelectors,
} = require('../helpers/clover/adminOperationService');

class RaidTargetDb {
    constructor() {
        this.raids = new Map([
            ['RAID-ABC', { id: 7, raid_key: 'RAID-ABC', name: 'Teste', status: 'active' }],
        ]);
        this.participants = [
            { raid_id: 7, player_id: 'a@test', status: 'active' },
            { raid_id: 7, player_id: 'b@test', status: 'completed' },
            { raid_id: 7, player_id: 'c@test', status: 'removed' },
            { raid_id: 7, player_id: 'd@test', status: 'withdrawn' },
            { raid_id: 7, player_id: 'a@test', status: 'active' },
        ];
    }

    async get(sql, params = []) {
        if (sql.includes('FROM clover_raids')) {
            const requested = String(params[0] || '').toUpperCase();
            return this.raids.get(requested) || null;
        }
        return null;
    }

    async all(sql, params = []) {
        if (!sql.includes('FROM clover_raid_participants')) return [];
        const raidId = Number(params[0]);
        const includeRemoved = Number(params[1]) === 1;
        const seen = new Set();
        return this.participants
            .filter((row) => row.raid_id === raidId)
            .filter((row) => includeRemoved || !['removed', 'withdrawn'].includes(row.status))
            .filter((row) => {
                if (seen.has(row.player_id)) return false;
                seen.add(row.player_id);
                return true;
            })
            .sort((a, b) => a.player_id.localeCompare(b.player_id));
    }
}

test('raid participants become a stable players selector and preserve audit snapshot', async () => {
    const db = new RaidTargetDb();
    const result = await materializeRaidParticipantSelectors(db, {
        title: 'Teste',
        targets: [{ kind: 'raid_participants', raidKey: 'raid-abc' }],
        metadata: { source: 'test' },
    });

    assert.deepEqual(result.targets, [{ kind: 'players', values: ['a@test', 'b@test'] }]);
    assert.equal(result.metadata.source, 'test');
    assert.equal(result.metadata.raidTargetSnapshots.length, 1);
    assert.equal(result.metadata.raidTargetSnapshots[0].raidKey, 'RAID-ABC');
    assert.equal(result.metadata.raidTargetSnapshots[0].participantCount, 2);
    assert.equal(result.metadata.raidTargetSnapshots[0].includeRemoved, false);
});

test('includeRemoved snapshots historical removed and withdrawn participants too', async () => {
    const db = new RaidTargetDb();
    const result = await materializeRaidParticipantSelectors(db, {
        targets: [{ kind: 'raid_participants', raidKey: 'RAID-ABC', includeRemoved: true }],
    });

    assert.deepEqual(result.targets[0].values, ['a@test', 'b@test', 'c@test', 'd@test']);
    assert.equal(result.metadata.raidTargetSnapshots[0].participantCount, 4);
    assert.equal(result.metadata.raidTargetSnapshots[0].includeRemoved, true);
});

test('raid selector composes with existing selectors without rewriting them', async () => {
    const db = new RaidTargetDb();
    const result = await materializeRaidParticipantSelectors(db, {
        targets: [
            { kind: 'player', playerId: 'owner@test' },
            { kind: 'raid_participants', raidKey: 'RAID-ABC' },
            { kind: 'squad', squadKey: 'magenta' },
        ],
    });

    assert.deepEqual(result.targets[0], { kind: 'player', playerId: 'owner@test' });
    assert.deepEqual(result.targets[1], { kind: 'players', values: ['a@test', 'b@test'] });
    assert.deepEqual(result.targets[2], { kind: 'squad', squadKey: 'magenta' });
});

test('missing raid fails closed before an OP is drafted', async () => {
    const db = new RaidTargetDb();
    await assert.rejects(
        () => materializeRaidParticipantSelectors(db, {
            targets: [{ kind: 'raid_participants', raidKey: 'RAID-NOPE' }],
        }),
        (error) => error instanceof AdminOperationServiceError && error.code === 'raid_target_not_found'
    );
});

test('empty raid target fails closed', async () => {
    const db = new RaidTargetDb();
    db.participants = [];
    await assert.rejects(
        () => materializeRaidParticipantSelectors(db, {
            targets: [{ kind: 'raid_participants', raidKey: 'RAID-ABC' }],
        }),
        (error) => error instanceof AdminOperationServiceError && error.code === 'empty_raid_target'
    );
});
