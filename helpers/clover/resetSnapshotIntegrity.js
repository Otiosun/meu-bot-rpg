'use strict';

const crypto = require('crypto');

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value ?? null;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function snapshotHash(snapshot) {
    if (!snapshot) return sha256('null');
    const { capturedAt, ...rest } = snapshot;
    return sha256(JSON.stringify(stable(rest)));
}

module.exports = {
    sha256,
    snapshotHash,
};
