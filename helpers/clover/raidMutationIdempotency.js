'use strict';

const crypto = require('crypto');

const RECEIPT_ACTION_PREFIX = 'idempotency_receipt:';

function optionalText(value) {
    const text = String(value || '').trim();
    return text || null;
}

function mutationIdempotencyKey(input = {}) {
    return optionalText(input.idempotencyKey || input.idempotency_key);
}

function withoutIdempotencyFields(value) {
    if (Array.isArray(value)) return value.map(withoutIdempotencyFields);
    if (!value || typeof value !== 'object') return value;

    const output = {};
    for (const [key, item] of Object.entries(value)) {
        if (key === 'idempotencyKey' || key === 'idempotency_key') continue;
        if (item === undefined) continue;
        output[key] = withoutIdempotencyFields(item);
    }
    return output;
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;

    const output = {};
    for (const key of Object.keys(value).sort()) {
        const item = value[key];
        if (item === undefined) continue;
        output[key] = canonicalize(item);
    }
    return output;
}

function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

function mutationFingerprint(operation, payload) {
    return crypto
        .createHash('sha256')
        .update(canonicalJson({
            operation: String(operation || '').trim(),
            payload: withoutIdempotencyFields(payload || {}),
        }))
        .digest('hex');
}

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function receiptAction(operation) {
    return `${RECEIPT_ACTION_PREFIX}${String(operation || '').trim()}`;
}

async function findRaidMutationReceipt(db, idempotencyKey) {
    const key = optionalText(idempotencyKey);
    if (!key) return null;
    return db.get(
        'SELECT * FROM clover_raid_events WHERE idempotency_key = ?',
        [key]
    );
}

function inspectRaidMutationReceipt(event, operation, payload) {
    if (!event) return { status: 'missing' };

    const expectedAction = receiptAction(operation);
    const metadata = safeJsonParse(event.metadata_json, {}) || {};
    const expectedFingerprint = mutationFingerprint(operation, payload);
    const storedFingerprint = optionalText(metadata.mutation_fingerprint);

    if (
        event.action !== expectedAction
        || storedFingerprint !== expectedFingerprint
        || metadata.mutation_operation !== operation
    ) {
        return {
            status: 'conflict',
            event,
            expectedAction,
            expectedFingerprint,
            storedFingerprint,
        };
    }

    const result = safeJsonParse(event.after_json, null);
    if (!result || typeof result !== 'object') {
        return {
            status: 'corrupt',
            event,
            expectedFingerprint,
        };
    }

    return {
        status: 'replay',
        event,
        result,
        fingerprint: expectedFingerprint,
    };
}

async function writeRaidMutationReceipt(db, options = {}) {
    const operation = String(options.operation || '').trim();
    const key = optionalText(options.idempotencyKey);
    if (!operation || !key) {
        throw new Error('Raid mutation receipt requires operation and idempotency key.');
    }

    const raidId = Number(options.raidId);
    if (!Number.isSafeInteger(raidId) || raidId <= 0) {
        throw new Error('Raid mutation receipt requires a valid raid id.');
    }

    const fingerprint = mutationFingerprint(operation, options.payload || {});
    const result = options.result && typeof options.result === 'object'
        ? options.result
        : { ok: true };

    const inserted = await db.run(
        `INSERT INTO clover_raid_events
         (raid_id, action, actor_id, subject_player_id, before_json, after_json,
          created_at, idempotency_key, metadata_json)
         VALUES (?, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP, ?, ?)`,
        [
            raidId,
            receiptAction(operation),
            String(options.actorId || '').trim(),
            optionalText(options.subjectPlayerId),
            JSON.stringify(result),
            key,
            JSON.stringify({
                mutation_operation: operation,
                mutation_fingerprint: fingerprint,
                receipt_version: 1,
            }),
        ]
    );

    return db.get('SELECT * FROM clover_raid_events WHERE id = ?', [inserted.lastID]);
}

module.exports = {
    RECEIPT_ACTION_PREFIX,
    canonicalJson,
    findRaidMutationReceipt,
    inspectRaidMutationReceipt,
    mutationFingerprint,
    mutationIdempotencyKey,
    receiptAction,
    withoutIdempotencyFields,
    writeRaidMutationReceipt,
};
