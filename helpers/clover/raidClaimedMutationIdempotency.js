'use strict';

const crypto = require('crypto');
const {
    findRaidMutationReceipt,
    inspectRaidMutationReceipt,
    mutationFingerprint,
    mutationIdempotencyKey,
    writeRaidMutationReceipt,
} = require('./raidMutationIdempotency');

const DEFAULT_LEASE_MS = 90_000;

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

function leaseIsActive(row, now = Date.now()) {
    if (!row?.lease_expires_at) return false;
    const expiresAt = new Date(row.lease_expires_at).getTime();
    return Number.isFinite(expiresAt) && expiresAt > now;
}

async function ensureRaidClaimedMutationSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_raid_mutation_requests (
            idempotency_key TEXT PRIMARY KEY,
            operation TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            raid_id INTEGER NOT NULL,
            subject_player_id TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'completed')),
            processing_token TEXT DEFAULT NULL,
            lease_expires_at TEXT DEFAULT NULL,
            result_json TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_raid_mutation_requests_status
        ON clover_raid_mutation_requests (status, lease_expires_at, updated_at)
    `);
}

async function readClaim(db, idempotencyKey) {
    return db.get(
        `SELECT * FROM clover_raid_mutation_requests
         WHERE idempotency_key = ?`,
        [idempotencyKey]
    );
}

function claimedMutationError(errorFactory, code, message, details = {}) {
    return errorFactory(code, message, details);
}

async function persistCompletion(db, options = {}) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const claim = await readClaim(db, options.idempotencyKey);
        if (!claim || claim.operation !== options.operation || claim.fingerprint !== options.fingerprint) {
            throw claimedMutationError(
                options.errorFactory,
                'idempotency_claim_lost',
                'A reserva idempotente desta mutação de Raid não está mais disponível.',
                { operation: options.operation, retryable: true }
            );
        }
        if (
            options.processingToken
            && claim.status === 'processing'
            && claim.processing_token
            && claim.processing_token !== options.processingToken
        ) {
            throw claimedMutationError(
                options.errorFactory,
                'idempotency_claim_lost',
                'Outra tentativa assumiu esta mutação de Raid.',
                { operation: options.operation, retryable: true }
            );
        }

        const existing = await findRaidMutationReceipt(db, options.idempotencyKey);
        if (existing) {
            const inspection = inspectRaidMutationReceipt(
                existing,
                options.operation,
                options.payload
            );
            if (inspection.status !== 'replay') {
                throw claimedMutationError(
                    options.errorFactory,
                    'idempotency_conflict',
                    'Esta chave de idempotência já pertence a outra mutação de Raid.',
                    { operation: options.operation, receiptStatus: inspection.status }
                );
            }
        } else {
            await writeRaidMutationReceipt(db, {
                raidId: options.raidId,
                operation: options.operation,
                actorId: options.actorId,
                subjectPlayerId: options.subjectPlayerId,
                idempotencyKey: options.idempotencyKey,
                payload: options.payload,
                result: options.result,
            });
        }

        await db.run(
            `UPDATE clover_raid_mutation_requests
             SET status = 'completed', result_json = ?, processing_token = NULL,
                 lease_expires_at = NULL,
                 completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
                 updated_at = CURRENT_TIMESTAMP
             WHERE idempotency_key = ? AND operation = ? AND fingerprint = ?`,
            [
                JSON.stringify(options.result || { ok: true }),
                options.idempotencyKey,
                options.operation,
                options.fingerprint,
            ]
        );
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function releaseClaim(db, options = {}) {
    if (!options.idempotencyKey || !options.processingToken) return;
    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run(
            `UPDATE clover_raid_mutation_requests
             SET status = 'pending', processing_token = NULL, lease_expires_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE idempotency_key = ? AND operation = ? AND fingerprint = ?
               AND processing_token = ? AND status = 'processing'`,
            [
                options.idempotencyKey,
                options.operation,
                options.fingerprint,
                options.processingToken,
            ]
        );
        await db.exec('COMMIT');
    } catch {
        await db.exec('ROLLBACK').catch(() => null);
    }
}

async function prepareClaim(db, options = {}) {
    const idempotencyKey = mutationIdempotencyKey(options.input || {});
    if (!idempotencyKey) return { mode: 'direct' };

    const payload = options.payload || {};
    const fingerprint = mutationFingerprint(options.operation, payload);
    await ensureRaidClaimedMutationSchema(db);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const receipt = await findRaidMutationReceipt(db, idempotencyKey);
        if (receipt) {
            const inspection = inspectRaidMutationReceipt(
                receipt,
                options.operation,
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
            throw claimedMutationError(
                options.errorFactory,
                'idempotency_conflict',
                'Esta chave de idempotência já pertence a outra mutação de Raid.',
                { operation: options.operation, receiptStatus: inspection.status }
            );
        }

        const claim = await readClaim(db, idempotencyKey);
        if (
            claim
            && (
                claim.operation !== options.operation
                || claim.fingerprint !== fingerprint
                || String(claim.actor_id || '') !== String(options.actorId || '')
                || Number(claim.raid_id) !== Number(options.raidId)
            )
        ) {
            throw claimedMutationError(
                options.errorFactory,
                'idempotency_conflict',
                'Esta chave de idempotência já foi usada com outra mutação de Raid.',
                { operation: options.operation }
            );
        }

        if (claim?.status === 'processing' && typeof options.recover === 'function') {
            const recovered = await options.recover({
                claim,
                idempotencyKey,
                fingerprint,
                payload,
            });
            if (recovered && typeof recovered === 'object') {
                await db.exec('COMMIT');
                return {
                    mode: 'recover',
                    idempotencyKey,
                    fingerprint,
                    payload,
                    claim,
                    result: recovered,
                };
            }
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
            throw claimedMutationError(
                options.errorFactory,
                'idempotency_in_progress',
                'Esta mutação de Raid ainda está sendo processada.',
                {
                    operation: options.operation,
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
                `UPDATE clover_raid_mutation_requests
                 SET status = 'processing', processing_token = ?, lease_expires_at = ?,
                     subject_player_id = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE idempotency_key = ? AND operation = ? AND fingerprint = ?`,
                [
                    processingToken,
                    leaseExpiresAt,
                    options.subjectPlayerId || null,
                    idempotencyKey,
                    options.operation,
                    fingerprint,
                ]
            );
        } else {
            await db.run(
                `INSERT INTO clover_raid_mutation_requests
                 (idempotency_key, operation, fingerprint, actor_id, raid_id,
                  subject_player_id, status, processing_token, lease_expires_at,
                  created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [
                    idempotencyKey,
                    options.operation,
                    fingerprint,
                    String(options.actorId || ''),
                    Number(options.raidId),
                    options.subjectPlayerId || null,
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
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function runClaimedRaidMutation(db, options = {}) {
    if (typeof options.errorFactory !== 'function') {
        throw new Error('Claimed Raid mutation requires an error factory.');
    }
    if (typeof options.execute !== 'function') {
        throw new Error('Claimed Raid mutation requires an execute function.');
    }

    const prepared = await prepareClaim(db, options);
    if (prepared.mode === 'direct') return options.execute();
    if (prepared.mode === 'replay') {
        return {
            ...prepared.result,
            duplicate: true,
            idempotentReplay: true,
        };
    }
    if (prepared.mode === 'recover') {
        await persistCompletion(db, {
            ...options,
            ...prepared,
            result: prepared.result,
        });
        return {
            ...prepared.result,
            duplicate: true,
            idempotentReplay: true,
            recoveredAfterAmbiguousCommit: true,
        };
    }

    let result;
    try {
        result = await options.execute();
    } catch (error) {
        await releaseClaim(db, {
            ...options,
            ...prepared,
        });
        throw error;
    }

    // Se a mutação de domínio já commitou, nunca devolvemos o claim para pending
    // por uma falha posterior ao commit. O retry precisa recuperar o efeito
    // persistido, não executar a mutação novamente.
    await persistCompletion(db, {
        ...options,
        ...prepared,
        result,
    });
    return {
        ...result,
        duplicate: false,
        idempotentReplay: false,
    };
}

module.exports = {
    DEFAULT_LEASE_MS,
    ensureRaidClaimedMutationSchema,
    leaseIsActive,
    prepareClaim,
    readClaim,
    releaseClaim,
    runClaimedRaidMutation,
};
