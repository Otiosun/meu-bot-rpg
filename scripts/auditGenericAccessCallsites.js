'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.resolve(process.argv[2] || path.join(ROOT, 'artifacts', 'generic-access-callsites.json'));
const SCAN_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx']);
const EXCLUDED_DIRECTORIES = new Set([
    '.git',
    'node_modules',
    'artifacts',
    'coverage',
    'dist',
    'build',
]);

const DEFINITION_OR_SHADOW_FILES = new Set([
    'helpers/clover/accessControlService.js',
    'helpers/clover/accessControlLegacyService.js',
    'helpers/clover/canonicalGlobalAccessService.js',
    'helpers/clover/canonicalRoleShadowReadOnly.js',
    'helpers/clover/canonicalRoleShadowService.js',
    'helpers/clover/canonicalScopedAccessService.js',
    'helpers/clover/integratedAccessContextService.js',
]);

const MIGRATION_FAMILIES = Object.freeze({
    'helpers/clover/legacyraidService.js': 'global_authorization',
    'helpers/clover/quickEvaluationService.js': 'global_authorization',
    'helpers/clover/raidFinalizationService.js': 'global_authorization',
    'helpers/clover/raidRewardProposalService.js': 'global_authorization',
    'helpers/clover/raidRewardProposalCoreService.js': 'global_authorization',
    'helpers/clover/raidRewardProposalIdempotencyService.js': 'global_authorization',
    'helpers/clover/siteAccessPayloadService.js': 'integrated_ui_context',
    'helpers/clover/siteSquadOperationsService.js': 'integrated_ui_context',
});

const PROTECTED_MIGRATION_FAMILIES = new Set([
    'global_authorization',
]);

const RULES = Object.freeze([
    {
        key: 'has_access_permission',
        severity: 'generic_helper',
        pattern: /\bhasAccessPermission\s*\(/g,
    },
    {
        key: 'context_has_permission',
        severity: 'generic_helper',
        pattern: /\bcontextHasPermission\s*\(/g,
    },
    {
        key: 'flattened_permissions_includes',
        severity: 'flattened_read',
        pattern: /(?:\bcontext\s*\.\s*permissions|\bpermissions)\s*\??\.\s*includes\s*\(/g,
    },
    {
        key: 'flattened_permissions_set',
        severity: 'flattened_read',
        pattern: /new\s+Set\s*\(\s*(?:\w+\s*\.\s*)?permissions\s*\)/g,
    },
]);

function relative(filename) {
    return path.relative(ROOT, filename).replace(/\\/g, '/');
}

function listFiles(directory, files = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
                listFiles(path.join(directory, entry.name), files);
            }
            continue;
        }
        if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) {
            files.push(path.join(directory, entry.name));
        }
    }
    return files;
}

function lineNumberAt(content, index) {
    let line = 1;
    for (let cursor = 0; cursor < index; cursor += 1) {
        if (content.charCodeAt(cursor) === 10) line += 1;
    }
    return line;
}

function lineTextAt(content, lineNumber) {
    return String(content.split(/\r?\n/)[lineNumber - 1] || '').trim();
}

function classify(match) {
    const filename = match.file;
    if (DEFINITION_OR_SHADOW_FILES.has(filename)) return 'definition_or_shadow';
    if (filename.startsWith('tests/') || filename.startsWith('scripts/')) return 'contract_or_audit';
    return 'runtime_callsite';
}

function migrationFamily(match) {
    if (classify(match) !== 'runtime_callsite') return null;
    return MIGRATION_FAMILIES[match.file] || 'unclassified_runtime';
}

function migrationStatus(match) {
    if (classify(match) !== 'runtime_callsite') return null;
    const family = migrationFamily(match);
    return PROTECTED_MIGRATION_FAMILIES.has(family)
        ? 'protected_by_canonical_global_facade'
        : 'requires_migration';
}

function extractPermission(text) {
    const match = String(text || '').match(/['"]([a-z]+(?:\.[a-z]+)+)['"]/i);
    return match ? match[1] : null;
}

function scanFile(filename) {
    const content = fs.readFileSync(filename, 'utf8');
    const matches = [];
    for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        for (let found = rule.pattern.exec(content); found; found = rule.pattern.exec(content)) {
            const line = lineNumberAt(content, found.index);
            const text = lineTextAt(content, line);
            const match = {
                rule: rule.key,
                severity: rule.severity,
                file: relative(filename),
                line,
                text,
                permission: extractPermission(text),
            };
            match.classification = classify(match);
            match.migrationFamily = migrationFamily(match);
            match.migrationStatus = migrationStatus(match);
            matches.push(match);
            if (found.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
        }
    }
    return matches;
}

function countBy(values, keySelector) {
    const result = {};
    for (const value of values) {
        const key = keySelector(value) || 'none';
        result[key] = Number(result[key] || 0) + 1;
    }
    return result;
}

function summarize(matches) {
    const runtime = matches.filter((match) => match.classification === 'runtime_callsite');
    const protectedRuntime = runtime.filter((match) => (
        match.migrationStatus === 'protected_by_canonical_global_facade'
    ));
    const unresolvedRuntime = runtime.filter((match) => (
        match.migrationStatus === 'requires_migration'
    ));
    return {
        total: matches.length,
        runtimeCallsiteCount: runtime.length,
        runtimeFileCount: new Set(runtime.map((match) => match.file)).size,
        protectedRuntimeCallsiteCount: protectedRuntime.length,
        unresolvedRuntimeCallsiteCount: unresolvedRuntime.length,
        unresolvedRuntimeFileCount: new Set(unresolvedRuntime.map((match) => match.file)).size,
        byRule: countBy(matches, (match) => match.rule),
        byClassification: countBy(matches, (match) => match.classification),
        byMigrationFamily: countBy(runtime, (match) => match.migrationFamily),
        byMigrationStatus: countBy(runtime, (match) => match.migrationStatus),
        byPermission: countBy(runtime.filter((match) => match.permission), (match) => match.permission),
        runtimeFiles: [...new Set(runtime.map((match) => match.file))].sort(),
        unresolvedRuntimeFiles: [...new Set(unresolvedRuntime.map((match) => match.file))].sort(),
    };
}

function main() {
    const files = listFiles(ROOT).sort();
    const matches = files.flatMap(scanFile)
        .sort((left, right) => left.file.localeCompare(right.file)
            || left.line - right.line
            || left.rule.localeCompare(right.rule));
    const report = {
        version: 'clover.generic-access-callsite-audit.v3',
        generatedAt: new Date().toISOString(),
        write: false,
        enforcementChanged: false,
        scannedFileCount: files.length,
        summary: summarize(matches),
        matches,
    };

    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log(JSON.stringify(report.summary, null, 2));
    for (const match of matches.filter((entry) => entry.classification === 'runtime_callsite')) {
        const permission = match.permission ? ` permission=${match.permission}` : '';
        console.log(`${match.file}:${match.line} [${match.migrationStatus}/${match.migrationFamily}/${match.rule}]${permission} ${match.text}`);
    }
}

if (require.main === module) main();

module.exports = {
    DEFINITION_OR_SHADOW_FILES,
    EXCLUDED_DIRECTORIES,
    MIGRATION_FAMILIES,
    PROTECTED_MIGRATION_FAMILIES,
    RULES,
    classify,
    extractPermission,
    lineNumberAt,
    listFiles,
    migrationFamily,
    migrationStatus,
    scanFile,
    summarize,
};
