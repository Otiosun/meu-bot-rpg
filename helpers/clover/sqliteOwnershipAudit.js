'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CANONICAL_CONNECTION_OWNER = 'helpers/clover/databaseConnection.js';
const EXPLICIT_DEVTOOL_EXCEPTIONS = Object.freeze([
    'helpers/clover/sqliteBackupService.js',
]);
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'coverage']);
const DATA_ACCESS_PATTERNS = Object.freeze([
    ['sqlite_import', /(?:require\(\s*['"](?:sqlite|sqlite3|node:sqlite)['"]\s*\)|from\s+['"](?:sqlite|sqlite3|node:sqlite)['"])/],
    ['physical_open', /\bopen\s*\(\s*\{[\s\S]{0,500}?\bfilename\s*:/m],
    ['run', /\b(?:db|connection|stmt)\s*\.\s*run\s*\(/],
    ['get', /\b(?:db|connection|stmt)\s*\.\s*get\s*\(/],
    ['all', /\b(?:db|connection|stmt)\s*\.\s*all\s*\(/],
    ['exec', /\b(?:db|connection)\s*\.\s*exec\s*\(/],
    ['each', /\b(?:db|connection)\s*\.\s*each\s*\(/],
    ['prepare', /\b(?:db|connection)\s*\.\s*prepare\s*\(/],
    ['transaction', /\btransaction\s*\(/],
    ['begin', /\bBEGIN(?:\s+IMMEDIATE)?\b/i],
    ['commit', /\bCOMMIT\b/i],
    ['rollback', /\bROLLBACK\b/i],
    ['pragma', /\bPRAGMA\b/i],
    ['create_table', /\bCREATE\s+TABLE\b/i],
    ['create_index', /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i],
    ['alter_table', /\bALTER\s+TABLE\b/i],
    ['drop', /\bDROP\s+(?:TABLE|INDEX)\b/i],
    ['close', /\b(?:db|connection)\s*\.\s*close\s*\(/],
    ['backup', /\bbackup\b/i],
]);

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

function isProductionFile(file) {
    return !file.startsWith('tests/') && !file.startsWith('scripts/') && !file.startsWith('docs/');
}

function dataAccessOwner(file, category) {
    if (file === CANONICAL_CONNECTION_OWNER) return 'connection-owner';
    if (file === 'helpers/clover/sqliteBackupService.js') return 'backup-verifier';
    if (file === 'database.js') return 'database-lifecycle-orchestrator';
    if (file === 'database/legacy.js') return 'legacy-schema-bootstrap';
    if (file.startsWith('helpers/clover/schema')) return 'schema-migration-infrastructure';
    if (file.startsWith('helpers/clover/')) return `clover-domain:${path.basename(file, path.extname(file))}`;
    if (file.startsWith('helpers/')) return `legacy-helper:${path.basename(file, path.extname(file))}`;
    if (file.startsWith('comandos/')) return `command-domain:${path.basename(file, path.extname(file))}`;
    if (file === 'index.js') return 'application-entrypoint';
    if (file.startsWith('tests/')) return `test-fixture:${path.basename(file, path.extname(file))}`;
    if (file.startsWith('scripts/')) return `devtool:${path.basename(file, path.extname(file))}`;
    if (category === 'F') return 'documentation';
    return null;
}

function decisionFor(file, category, physicalConnectionOwner, owner) {
    if (physicalConnectionOwner && file === CANONICAL_CONNECTION_OWNER) return 'canonical physical connection owner';
    if (physicalConnectionOwner) return 'exact read-only backup exception';
    if (category === 'B') return 'schema operations through injected connection';
    if (category === 'C' || category === 'D') return `injected data-access owner: ${owner}`;
    if (category === 'E') return 'recorded non-runtime test/devtool occurrence';
    return 'non-executable/documentation occurrence';
}

function inspectSqliteUse(source) {
    const driverImport = /require\(\s*['"]sqlite(?:3)?['"]\s*\)/.test(source);
    const directDriver = /\bsqlite3\.Database\b/.test(source);
    const physicalOpen = /\bopen\s*\(\s*\{[\s\S]{0,500}?\bfilename\s*:/m.test(source);
    return { driverImport, directDriver, physicalOpen, relevant: driverImport || directDriver || physicalOpen };
}

function inspectDataAccess(source) {
    return DATA_ACCESS_PATTERNS
        .filter(([, pattern]) => pattern.test(source))
        .map(([type]) => type);
}

function buildFullDataAccessInventory(root = path.resolve(__dirname, '../..')) {
    return collectJavaScriptFiles(root).map((file) => {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        const sqlite = inspectSqliteUse(source);
        const accessTypes = inspectDataAccess(source);
        const category = classifySqliteUse(file);
        const physicalConnectionOwner = file === CANONICAL_CONNECTION_OWNER || EXPLICIT_DEVTOOL_EXCEPTIONS.includes(file);
        const owner = dataAccessOwner(file, category);
        return Object.freeze({
            path: file,
            category,
            accessTypes,
            physicalConnectionOwner,
            dataAccessOwner: owner,
            decision: decisionFor(file, category, physicalConnectionOwner, owner),
            exception: EXPLICIT_DEVTOOL_EXCEPTIONS.includes(file) ? 'read-only backup verifier' : null,
            ...sqlite,
            relevant: sqlite.relevant || accessTypes.length > 0,
        });
    }).filter((entry) => entry.relevant);
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
    const inventory = buildFullDataAccessInventory(root);
    const blockers = [];
    for (const entry of inventory) {
        const file = entry.path;
        const runtimeFile = isProductionFile(file);
        if (!runtimeFile) continue;
        const approved = file === CANONICAL_CONNECTION_OWNER || EXPLICIT_DEVTOOL_EXCEPTIONS.includes(file);
        if ((entry.driverImport || entry.directDriver || entry.physicalOpen) && !approved) {
            blockers.push({ code: 'sqlite_runtime_owner_violation', file });
        }
        if (entry.physicalOpen && file !== CANONICAL_CONNECTION_OWNER && !EXPLICIT_DEVTOOL_EXCEPTIONS.includes(file)) {
            blockers.push({ code: 'sqlite_physical_open_violation', file });
        }
        if (entry.accessTypes.length > 0 && !entry.dataAccessOwner) {
            blockers.push({ code: 'sqlite_unclassified_production_data_access', file });
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
    buildFullDataAccessInventory,
    classifySqliteUse,
    collectJavaScriptFiles,
    inspectSqliteUse,
    inspectDataAccess,
    isProductionFile,
};
