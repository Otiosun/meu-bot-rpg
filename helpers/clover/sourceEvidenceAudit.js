'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PRODUCTION_ROOT = path.join(ROOT, 'helpers', 'clover');
const SQL_ACCESS = /\bdb\.(?:run|get|all|exec)\s*\(/g;
const WRITE_SQL = /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
const BOUNDED_ACCESS_CLASSIFICATIONS = Object.freeze({
    'adminSpellReviewInboxRead.js': 'READONLY_AUDIT',
    'characterStats.js': 'CANONICAL_SERVICE_INTERNAL',
    'cloverAdminViewFacade.js': 'READONLY_AUDIT',
    'privateDeliveryWorker.js': 'BOUNDED_EXCEPTION',
});

function productionFiles(root = PRODUCTION_ROOT) {
    const result = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) result.push(...productionFiles(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) result.push(full);
    }
    return result;
}

function classifyAccess(file, source) {
    if (!file.startsWith(PRODUCTION_ROOT)) return 'UNCLASSIFIED_PRODUCTION_ACCESS';
    const name = path.basename(file);
    if (BOUNDED_ACCESS_CLASSIFICATIONS[name]) return BOUNDED_ACCESS_CLASSIFICATIONS[name];
    if (/Migration|Schema|Prebootstrap/.test(name)) return 'MIGRATION_OWNER';
    if (/Audit/.test(name)) return 'READONLY_AUDIT';
    if (/Legacy/.test(name)) return 'COMPATIBILITY_ADAPTER';
    if (/databaseConnection/.test(name)) return 'CANONICAL_REPOSITORY';
    if (/Service|Repository|Persistence|Ledger|Operation|Manager|Executor|Idempotency|Renderer|Trigger|Catalog|Resolver|Phase/.test(name)) return 'CANONICAL_SERVICE_INTERNAL';
    if (/ReadOnly|ReadApi|Http/.test(name) && !WRITE_SQL.test(source)) return 'READONLY_AUDIT';
    return 'UNCLASSIFIED_PRODUCTION_ACCESS';
}

function auditSourceEvidence(files = productionFiles()) {
    const accesses = [];
    for (const file of files) {
        const source = fs.readFileSync(file, 'utf8');
        const count = [...source.matchAll(SQL_ACCESS)].length;
        if (count) accesses.push({ file: path.relative(ROOT, file).replaceAll('\\', '/'), count, classification: classifyAccess(file, source) });
    }
    return Object.freeze({ sourceFilesScanned: files.length, sqlAccessSites: accesses.reduce((sum, item) => sum + item.count, 0), accesses, unclassified: accesses.filter((item) => item.classification === 'UNCLASSIFIED_PRODUCTION_ACCESS') });
}

module.exports = { BOUNDED_ACCESS_CLASSIFICATIONS, PRODUCTION_ROOT, auditSourceEvidence, classifyAccess, productionFiles };
