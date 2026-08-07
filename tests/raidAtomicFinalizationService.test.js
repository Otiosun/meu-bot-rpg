'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    beginRaidFinalizationAtomic,
} = require('../helpers/clover/raidAtomicFinalizationService');

class FakeDb {
    constructor() {
        this.raid = {
            id: 7,
            raid_key: 'RAID-X',
            name: 'Raid Teste',
            category: 'missao',
            description: null,
            location: 'Capital de Clover',
            status: 'in_progress',
            owner_player_id: 'owner@test',
            max_players: 12,
            salary_eligible: 1,
            rules_json: '{}',
            metadata_json: '{}',
            created_at: '2026-08-07 12:00:00',
            updated_at: '2026-08-07 12:00:00',
            started_at: '2026-08-07 12:01:00',
            finalization_at: null,
            completed_at: null,
            cancelled_at: null,
            cancellation_reason: null,
        };
        this.participants = [{
            raid_id: 7,
            player_id: 'player@test',
            status: 'active',
            finalization_status: 'eligible',
            finalization_note: 'estado antigo',
            finalized_by: 'owner@test',
            finalized_at: '2026-08-07 12:05:00',
        }];
        this.events = [];
        this.snapshot = null;
        this.failSecondEvent = false;
    }

    cloneState() {
        return {
            raid: structuredClone(this.raid),
            participants: structuredClone(this.participants),
            events: structuredClone(this.events),
        };
    }

    restoreState(snapshot) {
        this.raid = snapshot.raid;
        this.participants = snapshot.participants;
        this.events = snapshot.events;
    }

    async exec(sql) {
        if (sql === 'BEGIN IMMEDIATE') {
            this.snapshot = this.cloneState();
            return;
        }
        if (sql === 'COMMIT') {
            this.snapshot = null;
            return;
        }
        if (sql === 'ROLLBACK') {
            if (this.snapshot) this.restoreState(this.snapshot);
            this.snapshot = null;
        }
    }

    async get(sql) {
        if (sql.includes('FROM clover_raids')) return { ...this.raid };
        return null;
    }

    async all(sql) {
        if (sql.includes('FROM clover_raid_hosts')) return [];
        return [];
    }

    async run(sql, params = []) {
        if (sql.includes('UPDATE clover_raids')) {
            if (this.raid.status !== 'in_progress') return { changes: 0 };
            this.raid.status = 'finalization';
            this.raid.finalization_at = '2026-08-07 12:10:00';
            this.raid.updated_at = '2026-08-07 12:10:00';
            return { changes: 1 };
        }
        if (sql.includes('UPDATE clover_raid_participants')) {
            for (const participant of this.participants) {
                if (participant.raid_id === 7 && participant.status === 'active') {
                    participant.finalization_status = 'pending';
                    participant.finalization_note = null;
                    participant.finalized_by = null;
                    participant.finalized_at = null;
                }
            }
            return { changes: 1 };
        }
        if (sql.includes('INSERT INTO clover_raid_events')) {
            const action = params[1];
            if (this.failSecondEvent && action === 'finalization_eligibility_opened') {
                throw new Error('event write failed');
            }
            this.events.push({ action, actor_id: params[2] });
            return { changes: 1, lastID: this.events.length };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    }
}

const noSchema = async () => {};
const summary = async () => ({ counts: { pending: 1, eligible: 0 } });

test('opening finalization commits raid status, participant reset and both events together', async () => {
    const db = new FakeDb();
    const result = await beginRaidFinalizationAtomic(db, 'RAID-X', 'owner@test', {
        ensureSchema: noSchema,
        readSummary: summary,
    });

    assert.equal(result.ok, true);
    assert.equal(result.duplicate, false);
    assert.equal(db.raid.status, 'finalization');
    assert.equal(db.participants[0].finalization_status, 'pending');
    assert.equal(db.participants[0].finalization_note, null);
    assert.deepEqual(db.events.map((event) => event.action), [
        'finalization_started',
        'finalization_eligibility_opened',
    ]);
});

test('failure after raid status change rolls back status, participant state and events', async () => {
    const db = new FakeDb();
    db.failSecondEvent = true;

    await assert.rejects(
        () => beginRaidFinalizationAtomic(db, 'RAID-X', 'owner@test', {
            ensureSchema: noSchema,
            readSummary: summary,
        }),
        /event write failed/
    );

    assert.equal(db.raid.status, 'in_progress');
    assert.equal(db.raid.finalization_at, null);
    assert.equal(db.participants[0].finalization_status, 'eligible');
    assert.equal(db.participants[0].finalization_note, 'estado antigo');
    assert.deepEqual(db.events, []);
});

test('repeating finalization after a completed transition is a no-op duplicate', async () => {
    const db = new FakeDb();
    db.raid.status = 'finalization';
    db.participants[0].finalization_status = 'eligible';

    const result = await beginRaidFinalizationAtomic(db, 'RAID-X', 'owner@test', {
        ensureSchema: noSchema,
        readSummary: summary,
    });

    assert.equal(result.duplicate, true);
    assert.equal(db.participants[0].finalization_status, 'eligible');
    assert.deepEqual(db.events, []);
});
