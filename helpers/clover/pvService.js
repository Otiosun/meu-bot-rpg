'use strict';

const PV_LEDGER = 'clover_pv_ledger';
const PV_ENTRY_KINDS = new Set(['credit','debit','adjustment','migration','refund','compensation']);

class PvServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PvServiceError';
        this.code = code;
        this.details = details;
    }
}

function requiredText(value, label, limit = 255) {
    const text = String(value || '').trim();
    if (!text || text.length > limit) throw new PvServiceError('invalid_argument', `${label} invalido.`);
    return text;
}

function positiveInteger(value, label = 'amount') {
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount <= 0) throw new PvServiceError('invalid_amount', `${label} precisa ser inteiro positivo.`);
    return amount;
}

async function assertPlayerExists(db, playerId) {
    const id = requiredText(playerId, 'playerId');
    const row = await db.get('SELECT id FROM jogadores WHERE id = ?', [id]);
    if (!row) throw new PvServiceError('player_not_found', 'Player nao encontrado.');
    return id;
}

async function getPvBalance(db, playerId) {
    const id = requiredText(playerId, 'playerId');
    const row = await db.get(`SELECT COALESCE(SUM(amount),0) AS balance FROM ${PV_LEDGER} WHERE player_id = ?`, [id]);
    return Number(row?.balance || 0);
}

async function getPvLedger(db, playerId, limit = 50) {
    const id = requiredText(playerId, 'playerId');
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    return db.all(`SELECT * FROM ${PV_LEDGER} WHERE player_id = ? ORDER BY id DESC LIMIT ?`, [id, safeLimit]);
}

function normalizeEntry(raw = {}) {
    const entryKind = requiredText(raw.entryKind, 'entryKind', 32);
    if (!PV_ENTRY_KINDS.has(entryKind)) throw new PvServiceError('invalid_entry_kind', 'Tipo de lancamento PV invalido.');
    const absolute = positiveInteger(raw.amount);
    return {
        amount: entryKind === 'debit' ? -absolute : absolute,
        entryKind,
        operationKey: requiredText(raw.operationKey, 'operationKey'),
        source: requiredText(raw.source, 'source', 120),
        reason: requiredText(raw.reason, 'reason', 500),
        policyVersion: raw.policyVersion ? requiredText(raw.policyVersion, 'policyVersion', 120) : null,
        resetCycleKey: raw.resetCycleKey ? requiredText(raw.resetCycleKey, 'resetCycleKey', 120) : null,
        relatedId: raw.relatedId ? requiredText(raw.relatedId, 'relatedId') : null,
        correlationId: raw.correlationId ? requiredText(raw.correlationId, 'correlationId') : null,
        createdBy: requiredText(raw.createdBy, 'createdBy'),
        metadataJson: JSON.stringify(raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}),
    };
}

function sameEntry(existing, playerId, entry) {
    return existing.player_id === playerId
        && Number(existing.amount) === entry.amount
        && existing.entry_kind === entry.entryKind
        && existing.source === entry.source;
}

async function appendPvInTransaction(db, playerId, rawEntry) {
    const id = await assertPlayerExists(db, playerId);
    const entry = normalizeEntry(rawEntry);
    const existing = await db.get(`SELECT * FROM ${PV_LEDGER} WHERE operation_key = ?`, [entry.operationKey]);
    if (existing) {
        if (!sameEntry(existing, id, entry)) throw new PvServiceError('idempotency_conflict', 'A chave PV pertence a outro lancamento.');
        const balance = await getPvBalance(db, id);
        return { ok:true, duplicate:true, ledgerId:existing.id, balanceBefore:balance, balanceAfter:balance, entry:existing };
    }
    const balanceBefore = await getPvBalance(db, id);
    if (entry.amount < 0 && balanceBefore < Math.abs(entry.amount)) {
        throw new PvServiceError('insufficient_pv', 'Saldo PV insuficiente.', { balance:balanceBefore, required:Math.abs(entry.amount) });
    }
    const result = await db.run(
        `INSERT INTO ${PV_LEDGER}
         (player_id,amount,entry_kind,operation_key,source,reason,policy_version,reset_cycle_key,
          related_id,correlation_id,created_by,metadata_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id,entry.amount,entry.entryKind,entry.operationKey,entry.source,entry.reason,entry.policyVersion,
         entry.resetCycleKey,entry.relatedId,entry.correlationId,entry.createdBy,entry.metadataJson]
    );
    return {
        ok:true, duplicate:false, ledgerId:Number(result.lastID), balanceBefore,
        balanceAfter:balanceBefore + entry.amount,
        entry:await db.get(`SELECT * FROM ${PV_LEDGER} WHERE id = ?`, [result.lastID]),
    };
}

async function mutatePv(db, playerId, entry) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await appendPvInTransaction(db, playerId, entry);
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function creditPv(db, playerId, amount, options = {}) {
    return mutatePv(db, playerId, { ...options, amount, entryKind:options.entryKind || 'credit' });
}
async function debitPv(db, playerId, amount, options = {}) {
    return mutatePv(db, playerId, { ...options, amount, entryKind:'debit' });
}

module.exports = {
    PV_ENTRY_KINDS,
    PV_LEDGER,
    PvServiceError,
    appendPvInTransaction,
    creditPv,
    debitPv,
    getPvBalance,
    getPvLedger,
};
