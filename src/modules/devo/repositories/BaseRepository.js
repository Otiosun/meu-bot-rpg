const crypto = require('crypto');

function buildId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function filterObject(data, allowedColumns) {
    const filtered = {};

    for (const column of allowedColumns) {
        if (Object.prototype.hasOwnProperty.call(data, column) && data[column] !== undefined) {
            filtered[column] = data[column];
        }
    }

    return filtered;
}

class BaseRepository {
    constructor(db, { tableName, idPrefix, insertColumns = [], updateColumns = [] }) {
        this.db = db || null;
        this.tableName = tableName;
        this.idPrefix = idPrefix;
        this.insertColumns = insertColumns;
        this.updateColumns = updateColumns;
    }

    hasDatabase() {
        return Boolean(this.db);
    }

    async tableExists() {
        if (!this.db) return false;

        const row = await this.db.get(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'table' AND name = ?`,
            [this.tableName]
        );
        return Boolean(row);
    }

    async getById(id) {
        if (!this.db) return null;
        return this.db.get(`SELECT * FROM ${this.tableName} WHERE id = ?`, [id]);
    }

    async list({ limit = 50 } = {}) {
        if (!this.db) return [];
        return this.db.all(
            `SELECT *
             FROM ${this.tableName}
             ORDER BY created_at DESC
             LIMIT ?`,
            [limit]
        );
    }

    async create(data) {
        if (!this.db) return null;

        const payload = {
            id: data.id || buildId(this.idPrefix),
            ...filterObject(data, this.insertColumns),
        };
        const columns = Object.keys(payload);
        const placeholders = columns.map(() => '?').join(', ');

        await this.db.run(
            `INSERT INTO ${this.tableName} (${columns.join(', ')})
             VALUES (${placeholders})`,
            columns.map((column) => payload[column])
        );

        return this.getById(payload.id);
    }

    async update(id, data) {
        if (!this.db) return null;

        const touchUpdatedAt = this.updateColumns.includes('updated_at');
        const payload = filterObject(
            data,
            this.updateColumns.filter((column) => column !== 'updated_at')
        );
        const columns = Object.keys(payload);
        if (!columns.length) return this.getById(id);

        const setters = columns.map((column) => `${column} = ?`);
        if (touchUpdatedAt) {
            setters.push('updated_at = CURRENT_TIMESTAMP');
        }

        await this.db.run(
            `UPDATE ${this.tableName}
             SET ${setters.join(', ')}
             WHERE id = ?`,
            [...columns.map((column) => payload[column]), id]
        );

        return this.getById(id);
    }
}

module.exports = {
    BaseRepository,
    buildId,
};
