'use strict';

const DEFAULT_PR_DUST_TOLERANCE = 1e-9;

class PrLegacyDustCleanupError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PrLegacyDustCleanupError';
        this.code = code;
        this.details = details;
    }
}

function requiredText(value, label) {
    const text = String(value || '').trim();
    if (!text) throw new PrLegacyDustCleanupError('invalid_argument', `${label} obrigatorio.`);
    return text;
}

async function rawPrBalance(db, playerId) {
    const row = await db.get(
        `SELECT COALESCE(SUM(amount), 0) AS balance
         FROM clover_pr_ledger
         WHERE player_id = ?`,
        [playerId]
    );
    return Number(row?.balance || 0);
}

async function cleanupLegacyPrDust(db, playerId, options = {}) {
    const id = requiredText(playerId, 'playerId');
    const idempotencyKey = requiredText(options.idempotencyKey, 'idempotencyKey');
    const createdBy = requiredText(options.createdBy, 'createdBy');
    const tolerance = Number(options.tolerance ?? DEFAULT_PR_DUST_TOLERANCE);
    if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1e-6) {
        throw new PrLegacyDustCleanupError('invalid_tolerance', 'Tolerancia de poeira PR invalida.');
    }

    const prior = await db.get(
        'SELECT * FROM clover_pr_ledger WHERE idempotency_key = ?',
        [idempotencyKey]
    );
    if (prior) {
        if (String(prior.player_id) !== id) {
            throw new PrLegacyDustCleanupError('idempotency_conflict', 'Chave de limpeza pertence a outro player.');
        }
        return {
            ok: true,
            duplicate: true,
            cleaned: true,
            ledgerId: prior.id,
            balanceAfter: await rawPrBalance(db, id),
        };
    }

    const observed = await rawPrBalance(db, id);
    if (Object.is(observed, 0) || observed === 0) {
        return { ok:true, duplicate:false, cleaned:false, ledgerId:null, balanceAfter:0 };
    }
    if (Math.abs(observed) > tolerance) {
        throw new PrLegacyDustCleanupError(
            'material_pr_balance_not_dust',
            'Saldo PR material nao pode ser apagado como poeira numerica.',
            { playerId:id, balance:observed, tolerance }
        );
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const fresh = await rawPrBalance(db, id);
        if (Math.abs(fresh) > tolerance) {
            throw new PrLegacyDustCleanupError(
                'material_pr_balance_not_dust',
                'Saldo PR mudou e nao e mais apenas poeira numerica.',
                { playerId:id, balance:fresh, tolerance }
            );
        }
        if (fresh === 0) {
            await db.exec('COMMIT');
            return { ok:true, duplicate:false, cleaned:false, ledgerId:null, balanceAfter:0 };
        }

        const event = await db.get(
            "SELECT id FROM clover_recruitment_events WHERE event_key='divulgacao_v1'"
        );
        if (!event) {
            throw new PrLegacyDustCleanupError('recruitment_event_missing', 'Evento divulgacao_v1 ausente.');
        }

        const result = await db.run(
            `INSERT INTO clover_pr_ledger (
                player_id,event_id,amount,kind,source,week_key,reason,related_id,
                idempotency_key,created_by,created_at,metadata_json
             ) VALUES (?, ?, ?, 'ajuste_admin', 'ajuste_admin', NULL, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
            [
                id,
                event.id,
                -fresh,
                options.reason || 'Limpeza auditavel de poeira numerica de PR legado.',
                options.relatedId || 'prpv-floating-dust-cleanup',
                idempotencyKey,
                createdBy,
                JSON.stringify({
                    cleanup_kind:'legacy_pr_ieee754_dust',
                    observed_balance:fresh,
                    applied_delta:-fresh,
                    tolerance,
                    ...(options.metadata && typeof options.metadata === 'object' ? options.metadata : {}),
                }),
            ]
        );

        const after = await rawPrBalance(db, id);
        if (Math.abs(after) > Number.EPSILON) {
            throw new PrLegacyDustCleanupError(
                'dust_cleanup_not_exact',
                'Limpeza de poeira PR nao produziu zero numerico exato.',
                { playerId:id, before:fresh, after }
            );
        }
        await db.exec('COMMIT');
        return { ok:true, duplicate:false, cleaned:true, ledgerId:result.lastID, balanceAfter:after };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    DEFAULT_PR_DUST_TOLERANCE,
    PrLegacyDustCleanupError,
    cleanupLegacyPrDust,
    rawPrBalance,
};
