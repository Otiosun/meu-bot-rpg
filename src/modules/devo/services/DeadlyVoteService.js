const { DeadlyVoteRepository } = require('../repositories');
const crypto = require('crypto');

const VALID_DEADLY_VOTE_STATUSES = new Set([
    'rascunho',
    'preparado',
    'convocando',
    'lotado',
    'iniciado',
    'em_andamento',
    'resolucao_pendente',
    'encerrado',
    'cancelado',
    'arquivado',
]);

function normalizeCode(code) {
    return String(code || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '-')
        .replace(/[^A-Z0-9_-]/g, '');
}

function normalizeLimit(limit) {
    const parsed = parseInt(limit, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return 20;
    return Math.min(parsed, 50);
}

class DeadlyVoteService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.deadlyVote || new DeadlyVoteRepository(this.db);
    }

    async createVote({ title, maxSlots, code = null, createdByManagerId = null } = {}) {
        const safeTitle = String(title || '').trim();
        if (!safeTitle) throw new Error('title is required');

        const safeMaxSlots = Number(maxSlots);
        if (!Number.isInteger(safeMaxSlots) || safeMaxSlots < 1) {
            throw new Error('maxSlots must be an integer >= 1');
        }

        if (!this.db) throw new Error('Database connection missing');
        if (typeof this.repository.tableExists === 'function' && !await this.repository.tableExists()) {
            throw new Error('Deadly Vote table unavailable');
        }

        const safeCode = code ? normalizeCode(code) : await this.generateUniqueCode();
        if (!safeCode) throw new Error('code is invalid');

        const existing = await this.repository.getByCode(safeCode);
        if (existing) throw new Error('deadly vote code already exists');

        return this.repository.create({
            title: safeTitle,
            code: safeCode,
            status: 'rascunho',
            max_slots: safeMaxSlots,
            reserved_slots: 0,
            created_by_manager_id: createdByManagerId || null,
        });
    }

    async generateUniqueCode() {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const code = `DV${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
            const existing = await this.repository.getByCode(code);
            if (!existing) return code;
        }

        throw new Error('could not generate unique deadly vote code');
    }

    async getByIdOrCode(value) {
        const raw = String(value || '').trim();
        if (!raw) return null;

        const byId = await this.repository.getById(raw);
        if (byId) return byId;

        const safeCode = normalizeCode(raw);
        if (!safeCode) return null;

        return this.repository.getByCode(safeCode);
    }

    async getByCode(code) {
        return this.repository.getByCode(normalizeCode(code));
    }

    async listVotes({ status = null, limit = 20 } = {}) {
        const safeLimit = normalizeLimit(limit);
        const safeStatus = status ? String(status).trim().toLowerCase() : null;

        if (safeStatus && !VALID_DEADLY_VOTE_STATUSES.has(safeStatus)) {
            throw new Error('invalid deadly vote status');
        }

        return this.repository.listVotes({ status: safeStatus, limit: safeLimit });
    }

    async updateStatus(id, status) {
        const safeStatus = String(status || '').trim().toLowerCase();
        if (!VALID_DEADLY_VOTE_STATUSES.has(safeStatus)) {
            throw new Error('invalid deadly vote status');
        }

        return this.repository.update(id, { status: safeStatus });
    }

    async markConvocandoIfNeeded(vote) {
        if (!vote) throw new Error('deadly vote not found');
        if (vote.status === 'rascunho' || vote.status === 'preparado') {
            return this.updateStatus(vote.id, 'convocando');
        }

        return vote;
    }

    getStatus() {
        return { name: 'DeadlyVoteService', ready: Boolean(this.db), implemented: true, repository: 'DeadlyVoteRepository' };
    }
}

module.exports = { DeadlyVoteService, VALID_DEADLY_VOTE_STATUSES };
