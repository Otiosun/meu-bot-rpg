const { LifeLedgerRepository, AuditRepository, RecordRepository } = require('../repositories');

const ALLOWED_LEDGER_TYPES = new Set([
    'ganho',
    'perda',
    'compra',
    'aposta',
    'divida',
    'penalidade',
    'recompensa',
    'ajuste_admin',
]);

class LifeService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.ledgerRepository = context.repositories?.lifeLedger || new LifeLedgerRepository(this.db);
        this.auditRepository = context.repositories?.audit || new AuditRepository(this.db);
        this.recordRepository = context.repositories?.record || new RecordRepository(this.db);
    }

    async _withTransaction(fn, { immediate = false } = {}) {
        if (!this.db) throw new Error('Database connection missing');
        const beginStmt = immediate ? 'BEGIN IMMEDIATE' : 'BEGIN';
        try {
            await this.db.exec(beginStmt);
            const result = await fn();
            await this.db.exec('COMMIT');
            return result;
        } catch (err) {
            try {
                await this.db.exec('ROLLBACK');
            } catch (e) {
                // swallow rollback error
            }
            throw err;
        }
    }

    async addLife(recordId, amountSeconds, reason, context = {}) {
        if (!Number.isInteger(amountSeconds) || amountSeconds <= 0) {
            throw new Error('amountSeconds must be a positive integer');
        }
        if (!reason) throw new Error('reason is required');

        return this._withTransaction(async () => {
            // transaction is started by _withTransaction; select inside transaction
            const record = await this.recordRepository.getById(recordId);
            if (!record) throw new Error('record not found');
            if (record.status === 'morto' && !context.force) throw new Error('record is morto');

            const ledgerType = context.type || 'ganho';
            if (!ALLOWED_LEDGER_TYPES.has(ledgerType)) throw new Error('invalid ledger type');

            const ledger = await this.ledgerRepository.create({
                record_id: recordId,
                deadly_vote_id: context.deadlyVoteId || null,
                type: ledgerType,
                amount_seconds: amountSeconds,
                reason,
                created_by_manager_id: context.managerId || null,
            });

            const prev = Number(record.life_remaining_seconds || 0);
            const next = prev + amountSeconds;
            const nextStatus = next > 0 ? 'ativo' : 'esgotado';
            const nextExpires = next > 0 ? new Date(Date.now() + next * 1000).toISOString() : null;

            await this.db.run(
                `UPDATE records
                 SET life_remaining_seconds = ?, life_expires_at = ?, life_status = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [next, nextExpires, nextStatus, recordId]
            );

            await this.auditRepository.record({
                actorUserId: context.actorUserId || 'system',
                actorManagerId: context.managerId || null,
                type: 'devo.life.add',
                entityType: 'record',
                entityId: recordId,
                payload: {
                    change: amountSeconds,
                    reason,
                    ledgerId: ledger.id,
                    previousRemaining: prev,
                    newRemaining: next,
                    actionReason: context.actionReason || null,
                },
            });

            return {
                ledger,
                previousRemaining: prev,
                newRemaining: next,
                life_status: nextStatus,
                life_expires_at: nextExpires,
            };
        }, { immediate: true });
    }

    async subtractLife(recordId, amountSeconds, reason, context = {}) {
        if (!Number.isInteger(amountSeconds) || amountSeconds <= 0) {
            throw new Error('amountSeconds must be a positive integer');
        }
        if (!reason) throw new Error('reason is required');

        return this._withTransaction(async () => {
            // transaction is started by _withTransaction; select inside transaction
            const record = await this.recordRepository.getById(recordId);
            if (!record) throw new Error('record not found');
            if (record.status === 'morto' && !context.force) throw new Error('record is morto');

            const ledgerType = context.type || 'perda';
            if (!ALLOWED_LEDGER_TYPES.has(ledgerType)) throw new Error('invalid ledger type');

            const ledger = await this.ledgerRepository.create({
                record_id: recordId,
                deadly_vote_id: context.deadlyVoteId || null,
                type: ledgerType,
                amount_seconds: amountSeconds,
                reason,
                created_by_manager_id: context.managerId || null,
            });

            const prev = Number(record.life_remaining_seconds || 0);
            let next = prev - amountSeconds;
            if (next <= 0) {
                next = 0;
            }
            const nextStatus = next > 0 ? 'ativo' : 'esgotado';
            const nextExpires = next > 0 ? new Date(Date.now() + next * 1000).toISOString() : null;

            await this.db.run(
                `UPDATE records
                 SET life_remaining_seconds = ?, life_expires_at = ?, life_status = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [next, nextExpires, nextStatus, recordId]
            );

            await this.auditRepository.record({
                actorUserId: context.actorUserId || 'system',
                actorManagerId: context.managerId || null,
                type: 'devo.life.subtract',
                entityType: 'record',
                entityId: recordId,
                payload: {
                    change: -amountSeconds,
                    reason,
                    ledgerId: ledger.id,
                    previousRemaining: prev,
                    newRemaining: next,
                    actionReason: context.actionReason || null,
                },
            });

            return {
                ledger,
                previousRemaining: prev,
                newRemaining: next,
                life_status: nextStatus,
                life_expires_at: nextExpires,
            };
        }, { immediate: true });
    }

    async adjustLife(recordId, signedAmountSeconds, reason, context = {}) {
        if (!Number.isInteger(signedAmountSeconds) || signedAmountSeconds === 0) {
            throw new Error('signedAmountSeconds must be a non-zero integer');
        }
        if (!reason) throw new Error('reason is required');

        return this._withTransaction(async () => {
            // transaction is started by _withTransaction; select inside transaction
            const record = await this.recordRepository.getById(recordId);
            if (!record) throw new Error('record not found');

            const ledger = await this.ledgerRepository.create({
                record_id: recordId,
                deadly_vote_id: context.deadlyVoteId || null,
                type: 'ajuste_admin',
                amount_seconds: Math.abs(signedAmountSeconds),
                reason,
                created_by_manager_id: context.managerId || null,
            });

            const prev = Number(record.life_remaining_seconds || 0);
            let next = prev + signedAmountSeconds;
            if (next <= 0) {
                next = 0;
            }
            const nextStatus = next > 0 ? 'ativo' : 'esgotado';
            const nextExpires = next > 0 ? new Date(Date.now() + next * 1000).toISOString() : null;

            await this.db.run(
                `UPDATE records
                 SET life_remaining_seconds = ?, life_expires_at = ?, life_status = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [next, nextExpires, nextStatus, recordId]
            );

            await this.auditRepository.record({
                actorUserId: context.actorUserId || 'system',
                actorManagerId: context.managerId || null,
                type: 'devo.life.adjust',
                entityType: 'record',
                entityId: recordId,
                payload: {
                    change: signedAmountSeconds,
                    reason,
                    ledgerId: ledger.id,
                    previousRemaining: prev,
                    newRemaining: next,
                    actionReason: context.actionReason || null,
                },
            });

            return {
                ledger,
                previousRemaining: prev,
                newRemaining: next,
                life_status: nextStatus,
                life_expires_at: nextExpires,
            };
        }, { immediate: true });
    }

    async getLifeSummary(recordId, recentLimit = 10) {
        const record = await this.recordRepository.getById(recordId);
        if (!record) return null;
        const transactions = await this.ledgerRepository.listByRecordId(recordId);
        return {
            recordId,
            life_remaining_seconds: Number(record.life_remaining_seconds || 0),
            life_status: record.life_status,
            life_expires_at: record.life_expires_at || null,
            recent: (transactions || []).slice(0, recentLimit),
        };
    }

    async listLedger(recordId, limit = 100) {
        const rows = await this.ledgerRepository.listByRecordId(recordId);
        return (rows || []).slice(0, limit);
    }

    getStatus() {
        return { name: 'LifeService', ready: Boolean(this.db), implemented: true };
    }
}

module.exports = { LifeService };
