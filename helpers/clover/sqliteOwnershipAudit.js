'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CANONICAL_CONNECTION_OWNER = 'helpers/clover/databaseConnection.js';
const EXPLICIT_DEVTOOL_EXCEPTIONS = Object.freeze([
    'helpers/clover/sqliteBackupService.js',
]);
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'coverage']);

function normalizeRelative(root, file) {
    return path.relative(root, file).split(path.sep).join('/');
}

function collectJavaScriptFiles(root, directory = root, files = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!IGNORED_DIRECTORIES.has(entry.name)) collectJavaScriptFiles(root, path.join(directory, entry.name), files);
        } else if (/\.(?:c?js|mjs)$/.test(entry.name)) {
            files.push(normalizeRelative(root, path.join(directory, entry.name)));
        }
    }
    return files.sort();
}

function classifySqliteUse(file) {
    if (file === CANONICAL_CONNECTION_OWNER) return 'A';
    if (file === 'database.js' || file === 'database/legacy.js') return 'D';
    if (file.startsWith('helpers/clover/schema')) return 'B';
    if (EXPLICIT_DEVTOOL_EXCEPTIONS.includes(file) || file.startsWith('scripts/')) return 'E';
    if (file.startsWith('tests/')) return 'E';
    if (file.startsWith('docs/')) return 'F';
    return 'C';
}

function inspectSqliteUse(source) {
    const driverImport = /require\(\s*['"]sqlite(?:3)?['"]\s*\)/.test(source);
    const directDriver = /\bsqlite3\.Database\b/.test(source);
    const physicalOpen = /\bopen\s*\(\s*\{[\s\S]{0,500}?\bfilename\s*:/m.test(source);
    return { driverImport, directDriver, physicalOpen, relevant: driverImport || directDriver || physicalOpen };
}

function buildSqliteAccessInventory(root = path.resolve(__dirname, '../..')) {
    return collectJavaScriptFiles(root)
        .map((file) => {
            const usage = inspectSqliteUse(fs.readFileSync(path.join(root, file), 'utf8'));
            return usage.relevant ? { file, category: classifySqliteUse(file), ...usage } : null;
        })
        .filter(Boolean);
}

function auditSqliteOwnership(root = path.resolve(__dirname, '../..')) {
    const inventory = buildSqliteAccessInventory(root);
    const blockers = [];
    for (const entry of inventory) {
        const runtimeFile = !entry.file.startsWith('tests/') && !entry.file.startsWith('scripts/');
        if (!runtimeFile) continue;
        const approved = entry.file === CANONICAL_CONNECTION_OWNER || EXPLICIT_DEVTOOL_EXCEPTIONS.includes(entry.file);
        if ((entry.driverImport || entry.directDriver || entry.physicalOpen) && !approved) {
            blockers.push({ code: 'sqlite_runtime_owner_violation', file: entry.file });
        }
        if (entry.physicalOpen && entry.file !== CANONICAL_CONNECTION_OWNER && !EXPLICIT_DEVTOOL_EXCEPTIONS.includes(entry.file)) {
            blockers.push({ code: 'sqlite_physical_open_violation', file: entry.file });
        }
    }
    return Object.freeze({
        canonicalConnectionOwner: CANONICAL_CONNECTION_OWNER,
        explicitDevtoolExceptions: EXPLICIT_DEVTOOL_EXCEPTIONS,
        inventory,
        blockers,
        ok: blockers.length === 0,
    });
}

function assertSqliteOwnership(root) {
    const audit = auditSqliteOwnership(root);
    if (!audit.ok) {
        const error = new Error(`SQLite ownership audit falhou: ${audit.blockers.map((item) => item.file).join(', ')}`);
        error.code = 'sqlite_ownership_audit_failed';
        error.audit = audit;
        throw error;
    }
    return audit;
}

module.exports = {
    CANONICAL_CONNECTION_OWNER,
    EXPLICIT_DEVTOOL_EXCEPTIONS,
    assertSqliteOwnership,
    auditSqliteOwnership,
    buildSqliteAccessInventory,
    classifySqliteUse,
    collectJavaScriptFiles,
    inspectSqliteUse,
};
