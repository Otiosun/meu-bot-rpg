'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_DIRECT_LEGACY_IMPORTS = Object.freeze({
    'database.js': Object.freeze(['./database/legacy']),
    'tests/databaseMigrationCatalog.test.js': Object.freeze(['../database/legacy']),
});

const IGNORED_DIRECTORIES = new Set([
    '.git', 'node_modules', 'auth_info', '.vercel', 'coverage', 'dist', 'build',
    'out', 'tmp', 'temp', 'logs', 'backups',
]);

const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

function normalizeRelativePath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function walkSourceFiles(rootDir) {
    const root = path.resolve(rootDir);
    const files = [];
    const stack = [root];
    while (stack.length) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (IGNORED_DIRECTORIES.has(entry.name)) continue;
                stack.push(path.join(current, entry.name));
                continue;
            }
            if (!entry.isFile()) continue;
            if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
            files.push(path.join(current, entry.name));
        }
    }
    return files.sort();
}

function extractDirectLegacyImports(source) {
    const text = String(source || '');
    const matches = [];
    const patterns = [
        /\brequire\s*\(\s*(['"])([^'"]*database\/legacy(?:\.js)?)\1\s*\)/g,
        /\bimport\s*\(\s*(['"])([^'"]*database\/legacy(?:\.js)?)\1\s*\)/g,
        /\b(?:import|export)\b[\s\S]*?\bfrom\s*(['"])([^'"]*database\/legacy(?:\.js)?)\1/g,
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text))) {
            const specifier = match[2];
            matches.push(Object.freeze({
                specifier,
                index: match.index,
            }));
        }
    }
    return matches;
}

function countRegexMatches(source, pattern) {
    const text = String(source || '');
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let count = 0;
    while (regex.exec(text)) count += 1;
    return count;
}

function auditLegacyDatabaseBypasses(rootDir) {
    const root = path.resolve(rootDir);
    const sourceFiles = walkSourceFiles(root);
    const records = [];
    for (const absolutePath of sourceFiles) {
        const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
        const source = fs.readFileSync(absolutePath, 'utf8');
        const directImports = extractDirectLegacyImports(source);
        const bridgeUses = countRegexMatches(source, /\blegacyDatabase\s*\.\s*criarBanco\b/g);
        const customLegacyInjections = countRegexMatches(source, /\bcreateLegacyDatabase\s*:/g);
        if (!directImports.length && !bridgeUses && !customLegacyInjections) continue;
        records.push(Object.freeze({
            path: relativePath,
            directImports,
            bridgeUses,
            customLegacyInjections,
            testFile: relativePath.startsWith('tests/'),
        }));
    }

    const blockers = [];
    let directImportCount = 0;
    for (const record of records) {
        directImportCount += record.directImports.length;
        const allowedSpecifiers = new Set(ALLOWED_DIRECT_LEGACY_IMPORTS[record.path] || []);
        for (const item of record.directImports) {
            if (!allowedSpecifiers.has(item.specifier)) {
                blockers.push(Object.freeze({
                    code: 'legacy_direct_import_not_allowed',
                    path: record.path,
                    detail: item.specifier,
                }));
            }
        }

        if (record.bridgeUses > 0 && !record.testFile && record.path !== 'database.js') {
            blockers.push(Object.freeze({
                code: 'legacy_bridge_use_not_allowed',
                path: record.path,
                detail: String(record.bridgeUses),
            }));
        }

        if (record.customLegacyInjections > 0 && !record.testFile) {
            blockers.push(Object.freeze({
                code: 'custom_legacy_injection_in_production',
                path: record.path,
                detail: String(record.customLegacyInjections),
            }));
        }
    }

    for (const [allowedPath, specifiers] of Object.entries(ALLOWED_DIRECT_LEGACY_IMPORTS)) {
        const record = records.find((item) => item.path === allowedPath);
        for (const specifier of specifiers) {
            if (!record?.directImports.some((item) => item.specifier === specifier)) {
                blockers.push(Object.freeze({
                    code: 'expected_legacy_bridge_missing',
                    path: allowedPath,
                    detail: specifier,
                }));
            }
        }
    }

    const productionDirectImports = records
        .filter((record) => !record.testFile)
        .reduce((sum, record) => sum + record.directImports.length, 0);
    const testDirectImports = records
        .filter((record) => record.testFile)
        .reduce((sum, record) => sum + record.directImports.length, 0);

    return Object.freeze({
        ok: blockers.length === 0,
        root,
        sourceFilesScanned: sourceFiles.length,
        directImportCount,
        productionDirectImports,
        testDirectImports,
        records: Object.freeze(records),
        blockers: Object.freeze(blockers),
        removalGate: blockers.length === 0
            ? 'legacy_direct_bypass_clean'
            : 'blocked_by_legacy_direct_bypass',
    });
}

function assertLegacyDatabaseBypassGate(rootDir) {
    const result = auditLegacyDatabaseBypasses(rootDir);
    if (!result.ok) {
        const error = new Error(`Legacy database bypass gate falhou com ${result.blockers.length} blocker(s).`);
        error.code = 'legacy_database_bypass_detected';
        error.blockers = result.blockers;
        throw error;
    }
    return result;
}

module.exports = {
    ALLOWED_DIRECT_LEGACY_IMPORTS,
    IGNORED_DIRECTORIES,
    SOURCE_EXTENSIONS,
    assertLegacyDatabaseBypassGate,
    auditLegacyDatabaseBypasses,
    extractDirectLegacyImports,
    normalizeRelativePath,
    walkSourceFiles,
};
