const { RecordRepository } = require('../repositories');
const {
    getWhatsAppIdentityVariants,
    getWhatsAppPhoneNumber,
    normalizeWhatsAppUserId,
} = require('../rules/whatsappIdentity');

class RecordService {
    constructor(context = {}) {
        this.db = context.db || null;
        this.repository = context.repositories?.record || new RecordRepository(this.db);
    }

    async listByUserId(userId) {
        if (typeof this.repository.listByUserIds === 'function') {
            return this.repository.listByUserIds(getWhatsAppIdentityVariants(userId));
        }

        return this.repository.listByUserId(normalizeWhatsAppUserId(userId));
    }

    async createRecord(targetUserId, name) {
        if (!targetUserId) throw new Error('targetUserId is required');
        const safeName = String(name || '').trim();
        if (!safeName) throw new Error('name is required');

        if (!this.db) throw new Error('Database connection missing');
        if (typeof this.repository.tableExists === 'function' && !await this.repository.tableExists()) {
            throw new Error('Records table unavailable');
        }

        const canonicalUserId = normalizeWhatsAppUserId(targetUserId);
        const existing = await this.findLatestByUserIdentity(targetUserId);
        if (existing) throw new Error('record already exists for user');

        const created = await this.repository.create({
            user_id: canonicalUserId,
            name: safeName,
            status: 'ativo',
        });

        return created;
    }

    async getById(recordId) {
        return this.repository.getById(recordId);
    }

    async getLatestByUserId(userId) {
        return this.findLatestByUserIdentity(userId);
    }

    async resolveLegacyUserId(value) {
        const raw = String(value || '').trim();
        let targetUserId = raw;

        if (/^\d+$/.test(raw) && this.db) {
            try {
                const manager = await this.db.get(
                    'SELECT user_id FROM manager_profiles WHERE number = ?',
                    [Number(raw)]
                );
                if (manager?.user_id) {
                    targetUserId = manager.user_id;
                } else {
                    const player = await this.db.get(
                        'SELECT id FROM jogadores WHERE numero_roll_escolhido = ?',
                        [Number(raw)]
                    );
                    if (player?.id) targetUserId = player.id;
                }
            } catch (e) {
                // Some deployments do not have the legacy jogadores table.
            }
        }

        return targetUserId;
    }

    async findLatestByUserIdentity(value) {
        const variants = getWhatsAppIdentityVariants(value);
        if (!variants.length) return null;

        if (typeof this.repository.listByUserIds === 'function') {
            const rows = await this.repository.listByUserIds(variants);
            if (rows && rows.length) return rows[0];
        } else {
            for (const variant of variants) {
                const rows = await this.repository.listByUserId(variant);
                if (rows && rows.length) return rows[0];
            }
        }

        const phone = getWhatsAppPhoneNumber(value);
        if (phone && typeof this.repository.listByPhoneIdentity === 'function') {
            const rows = await this.repository.listByPhoneIdentity(phone);
            if (rows && rows.length) return rows[0];
        }

        return null;
    }

    async resolveRecordTarget(value) {
        const raw = String(value || '').trim();
        if (!raw) return null;

        if (raw.startsWith('rec_')) {
            return this.getById(raw);
        }

        const targetUserId = await this.resolveLegacyUserId(raw);
        return this.findLatestByUserIdentity(targetUserId);
    }

    async listRecords(limit = 50) {
        return this.repository.list({ limit });
    }

    getStatus() {
        return { name: 'RecordService', ready: Boolean(this.db), implemented: true };
    }
}

module.exports = { RecordService };
