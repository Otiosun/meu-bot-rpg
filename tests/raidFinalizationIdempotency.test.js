'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { RaidServiceError } = require('../helpers/clover/raidService');
const {
    recoverParticipantFinalization,
} = require('../helpers/clover/raidFinalizationIdempotencyService');
const {
    handleRaidFinalizationIdempotentHttp,
    statusForError,
} = require('../helpers/clover/raidFinalizationIdempotentHttp');

function makeReq(method, url, body = null, headers = {}) {
    const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = url;
    req.headers = headers;
    return req;
}

function makeRes() {
    return {
        statusCode: 0,
        headers: {},
        body: '',
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = value;
        },
        end(value = '') {
            this.body += value || '';
        },
    };
}

test('finalization recovery requires matching committed event and current participant state', async () => {
    const db = {
        async all() {
            return [{
                raid_id: 7,
                action: 'participant_finalization_reviewed',
                actor_id: 'host@test',
                subject_player_id: 'target@test',
                after_json: JSON.stringify({ status: 'eligible', note: 'Presença confirmada' }),
                created_at: '2026-08-07 12:00:01',
            }];
        },
        async get() {
            return {
                raid_id: 7,
                player_id: 'target@test',
                status: 'active',
                finalization_status: 'eligible',
                finalization_note: 'Presença confirmada',
            };
        },
    };

    const result = await recoverParticipantFinalization(db, {
        raidId: 7,
        actorId: 'host@test',
        targetPlayerId: 'target@test',
        status: 'eligible',
        note: 'Presença confirmada',
        claim: { created_at: '2026-08-07 12:00:00' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.participant.finalizationStatus, 'eligible');
    assert.equal(result.participant.finalizationNote, 'Presença confirmada');
});

test('finalization recovery refuses stale or different final state', async () => {
    const db = {
        async all() {
            return [{
                subject_player_id: 'target@test',
                after_json: JSON.stringify({ status: 'eligible', note: 'Presença confirmada' }),
            }];
        },
        async get() {
            return {
                status: 'active',
                finalization_status: 'absent',
                finalization_note: 'Mudou depois',
            };
        },
    };

    const result = await recoverParticipantFinalization(db, {
        raidId: 7,
        actorId: 'host@test',
        targetPlayerId: 'target@test',
        status: 'eligible',
        note: 'Presença confirmada',
        claim: { created_at: '2026-08-07 12:00:00' },
    });

    assert.equal(result, null);
});

test('finalization HTTP forwards stable idempotency key to protected service', async () => {
    let captured = null;
    const req = makeReq(
        'POST',
        '/raids/RAID-X/finalization/participants/target%40test',
        { status: 'eligible', note: 'Presença confirmada', idempotencyKey: 'body-key' },
        { authorization: 'Bearer token', 'idempotency-key': 'header-key' }
    );
    const res = makeRes();

    const handled = await handleRaidFinalizationIdempotentHttp(req, res, {
        getDb: () => ({ fake: true }),
        authenticateSession: async () => ({ ok: true, player: { id: 'host@test' } }),
        mutationRunner: async (operation) => operation(),
        setRaidParticipantFinalization: async (...args) => {
            captured = args;
            return { ok: true };
        },
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(captured[1], 'RAID-X');
    assert.equal(captured[2], 'host@test');
    assert.equal(captured[3], 'target@test');
    assert.equal(captured[4].status, 'eligible');
    assert.equal(captured[4].idempotencyKey, 'header-key');
});

test('finalization idempotency conflicts map to HTTP 409', () => {
    for (const code of [
        'idempotency_conflict',
        'idempotency_in_progress',
        'idempotency_claim_lost',
        'raid_not_in_finalization',
    ]) {
        assert.equal(statusForError(new RaidServiceError(code, code)), 409);
    }
});
