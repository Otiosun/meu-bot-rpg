'use strict';

const crypto = require('crypto');
const {
    findRaidMutationReceipt,
    inspectRaidMutationReceipt,
    mutationFingerprint,
    mutationIdempotencyKey,
    writeRaidMutationReceipt,
} = require('./raidMutationIdempotency');

const CREATION_OPERATION = 'create_raid';
const CREATION_MARKER_KEY = 'raidCreationIdempotency';
const DEFAULT_LEASE_MS = 30_000;

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function createToken() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');
}

function creationPayload(actorId, input = {}) {
    return {
        actorId: String(actorId || '').trim(),
        input,
    };
}

function creationMarker(idempotencyKey, fingerprint) {
    return {
        key: idempotencyKey,
        fingerprint,
        version: 1,
    };
}

function withCreationMarker(input, idempotencyKey, fingerprint) {
    return {
        ...input,
        metadata: {
            ...(input?.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
            [CREATION_MARKER_KEY]: creationMarker(idempotencyKey, fingerprint),
        },
    };
}

async function ensureRaidCreationIdempotencySchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_raid_creation_requests (
            idempotency_key TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'completed')),
            processing_token TEXT DEFAULT NULL,
            lease_expires_at TEXT DEFAULT NULL,
            raid_id INTEGER DEFAULT NULL,
            result_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raid_creation_status
        ON clover_raid_creation_requests (status, lease_expires_at, updated_at)
    `);
}

async function findRaidByCreationMarker(db, idempotencyKey, fingerprint) {
    const rows = await db.all(
        `SELECT id, raid_key, metadata_json
         FROM clover_raids
         WHERE metadata_json IS NOT NULL
         ORDER BY id DESC`
    );
    for (const row of rows) {
        const metadata = safeJsonParse(row.metadata_json, {}) || {};
        const marker = metadata[CREATION_MARKER_KEY];
        if (
            marker
            && marker.key === idempotencyKey
            && marker.fingerprint === fingerprint
        ) {
            return row;
        }
    }
    return null;
}

function leaseIsActive(row, now = Date.now()) {
    if (!row?.lease_expires_at) return false;
    const expiresAt = new Date(row.lease_expires_at).getTime();
    return Number.isFinite(expiresAt) && expiresAt > now;
}

async function prepareRaidCreation(db, options = {}) {
    const input = options.input || {};
    const idempotencyKey = mutationIdempotencyKey(input);
    if (!idempotencyKey) return { mode: 'direct', input };

    const payload = creationPayload(options.actorId, input);
    const fingerprint = mutationFingerprint(CREATION_OPERATION, payload);
    const errorFactory = options.errorFactory;
    await ensureRaidCreationIdempotencySchema(db);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const receipt = await findRaidMutationReceipt(db, idempotencyKey);
        if (receipt) {
            const inspection = inspectRaidMutationReceipt(
                receipt,
                CREATION_OPERATION,
                payload
            );
            if (inspection.status === 'replay') {
                await db.exec('COMMIT');
                return {
                    mode: 'replay',
                    idempotencyKey,
                    fingerprint,
                    payload,
                    result: inspection.result,
                };
            }
            throw errorFactory(
                'idempotency_conflict',
                'Esta chave de idempotência já pertence a outra mutação de Raid.',
                { operation: CREATION_OPERATION, receiptStatus: inspection.status }
            );
        }

        const claim = await db.get(
            `SELECT * FROM clover_raid_creation_requests
             WHERE idempotency_key = ?`,
            [idempotencyKey]
        );
        if (claim && claim.fingerprint !== fingerprint) {
            throw errorFactory(
                'idempotency_conflict',
                'Esta chave de idempotência já foi usada com outra criação de Raid.',
                { operation: CREATION_OPERATION }
            );
        }

        const recoveredRaid = await findRaidByCreationMarker(
            db,
            idempotencyKey,
            fingerprint
        );
        if (recoveredRaid) {
            await db.exec('COMMIT');
            return {
                mode: 'recover',
                idempotencyKey,
                fingerprint,
                payload,
                raidId: Number(recoveredRaid.id),
                raidKey: recoveredRaid.raid_key,
            };
        }

        const storedResult = claim?.status === 'completed'
            ? safeJsonParse(claim.result_json, null)
            : null;
        if (storedResult && typeof storedResult === 'object') {
            await db.exec('COMMIT');
            return {
                mode: 'replay',
                idempotencyKey,
                fingerprint,
                payload,
                result: storedResult,
            };
        }

        const now = Date.now();
        if (claim?.status === 'processing' && leaseIsActive(claim, now)) {
            throw errorFactory(
                'idempotency_in_progress',
                'Esta criação de Raid ainda está sendo processada.',
                {
                    operation: CREATION_OPERATION,
                    retryable: true,
                    leaseExpiresAt: claim.lease_expires_at,
                }
            );
        }

        const processingToken = createToken();
        const leaseExpiresAt = new Date(
            now + Number(options.leaseMs || DEFAULT_LEASE_MS)
        ).toISOString();

        if (claim) {
            await db.run(
                `UPDATE clover_raid_creation_requests
                 SET status = 'processing', actor_id = ?, processing_token = ?,
                     lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE idempotency_key = ? AND fingerprint = ?`,
                [
                    String(options.actorId || '').trim(),
                    processingToken,
                    leaseExpiresAt,
                    idempotencyKey,
                    fingerprint,
                ]
            );
        } else {
            await db.run(
                `INSERT INTO clover_raid_creation_requests
                 (idempotency_key, fingerprint, actor_id, status, processing_token,
                  lease_expires_at, created_at, updated_at)
                 VALUES (?, ?, ?, 'processing', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [
                    idempotencyKey,
                    fingerprint,
                    String(options.actorId || '').trim(),
                    processingToken,
                    leaseExpiresAt,
                ]
            );
        }

        await db.exec('COMMIT');
        return {
            mode: 'execute',
            idempotencyKey,
            fingerprint,
            payload,
            processingToken,
            input: withCreationMarker(input, idempotencyKey, fingerprint),
        };
    } catch (error) {
        try {
            await db.exec('ROLLBACK');
        } catch {}
        throw error;
    }
}

async function completeRaidCreation(db, options = {}) {
    const raidId = Number(options.raidId);
    if (!Number.isSafeInteger(raidId) || raidId <= 0) {
        throw options.errorFactory(
            'idempotency_receipt_failed',
            'A criação não produziu um identificador de Raid persistível.'
        );
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const receipt = await findRaidMutationReceipt(db, options.idempotencyKey);
        if (receipt) {
            const inspection = inspectRaidMutationReceipt(
                receipt,
                CREATION_OPERATION,
                options.payload
            );
            if (inspection.status !== 'replay') {
                throw options.errorFactory(
                    'idempotency_conflict',
                    'A chave da criação colidiu com outro recibo de Raid.',
                    { receiptStatus: inspection.status }
                );
            }
        } else {
            await writeRaidMutationReceipt(db, {
                raidId,
                operation: CREATION_OPERATION,
                actorId: options.actorId,
                idempotencyKey: options.idempotencyKey,
                payload: options.payload,
                result: options.result,
            });
        }

        await db.run(
            `UPDATE clover_raid_creation_requests
             SET status = 'completed', raid_id = ?, result_json = ?,
                 processing_token = NULL, lease_expires_at = NULL,
                 completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
                 updated_at = CURRENT_TIMESTAMP
             WHERE idempotency_key = ? AND fingerprint = ?`,
            [
                raidId,
                JSON.stringify(options.result || { ok: true }),
                options.idempotencyKey,
                options.fingerprint,
            ]
        );
        await db.exec('COMMIT');
    } catch (error) {
        try {
            await db.exec('ROLLBACK');
        } catch {}
        throw error;
    }
}

async function releaseRaidCreationClaim(db, options = {}) {
    if (!options.idempotencyKey || !options.processingToken) return;
    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run(
            `UPDATE clover_raid_creation_requests
             SET status = 'pending', processing_token = NULL, lease_expires_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE idempotency_key = ? AND fingerprint = ?
               AND processing_token = ? AND status = 'processing'`,
            [
                options.idempotencyKey,
                options.fingerprint,
                options.processingToken,
            ]
        );
        await db.exec('COMMIT');
    } catch (error) {
        try {
            await db.exec('ROLLBACK');
        } catch {}
    }
}

async function createRaidWithPersistentIdempotency(db, actorId, input = {}, options = {}) {
    const errorFactory = options.errorFactory;
    if (typeof errorFactory !== 'function') {
        throw new Error('Raid creation idempotency requires an error factory.');
    }

    const prepared = await prepareRaidCreation(db, {
        actorId,
        input,
        leaseMs: options.leaseMs,
        errorFactory,
    });

    if (prepared.mode === 'direct') return options.execute(prepared.input);
    if (prepared.mode === 'replay') {
        return {
            ...prepared.result,
            duplicate: true,
            idempotentReplay: true,
        };
    }

    if (prepared.mode === 'recover') {
        const recovered = await options.recover(prepared.raidKey, prepared.raidId);
        await completeRaidCreation(db, {
            ...prepared,
            actorId,
            result: recovered,
            errorFactory,
        });
        return {
            ...recovered,
            duplicate: true,
            idempotentReplay: true,
            recoveredAfterAmbiguousCommit: true,
        };
    }

    try {
        const result = await options.execute(prepared.input);
        const raidId = Number(result?.raid?.id || result?.raid?.raidId || 0);
        await completeRaidCreation(db, {
            ...prepared,
            actorId,
            raidId,
            result,
            errorFactory,
        });
        return {
            ...result,
            duplicate: false,
            idempotentReplay: false,
        };
    } catch (error) {
        await releaseRaidCreationClaim(db, prepared);
        throw error;
    }
}

module.exports = {
    CREATION_MARKER_KEY,
    CREATION_OPERATION,
    DEFAULT_LEASE_MS,
    completeRaidCreation,
    createRaidWithPersistentIdempotency,
    ensureRaidCreationIdempotencySchema,
    findRaidByCreationMarker,
    leaseIsActive,
    prepareRaidCreation,
    releaseRaidCreationClaim,
    withCreationMarker,
};
