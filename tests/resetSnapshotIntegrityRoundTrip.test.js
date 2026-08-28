'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    normalizePersistedSnapshot,
    snapshotHash,
} = require('../helpers/clover/resetSnapshotIntegrity');

test('snapshotHash preserva identidade apos o mesmo round-trip JSON usado pelo journal', () => {
    const snapshot = {
        capturedAt: '2026-08-28T00:00:00.000Z',
        player: {
            id: 'roundtrip@lid',
            optionalUndefined: undefined,
            binaryFixture: Buffer.from('clover-reset'),
        },
        tables: {
            fixture: [{ id: 1, nullable: null, optionalUndefined: undefined }],
        },
        queueEntries: [],
        reservations: [],
        leadership: [],
        antiGhost: null,
        archiveRecord: null,
    };
    const persisted = JSON.parse(JSON.stringify(snapshot));

    assert.deepEqual(normalizePersistedSnapshot(snapshot), normalizePersistedSnapshot(persisted));
    assert.equal(snapshotHash(snapshot), snapshotHash(persisted));

    persisted.player.id = 'forged@lid';
    assert.notEqual(snapshotHash(snapshot), snapshotHash(persisted));
});
