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
    if (filename === 'helpers/clover/accessControlService.js') return 'definition';
    if (filename.startsWith('tests/') || filename.startsWith('scripts/')) return 'contract_or_audit';
    return 'runtime_callsite';
}

function scanFile(filename) {
    const content = fs.readFileSync(filename, 'utf8');
    const matches = [];
    for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        for (let found = rule.pattern.exec(content); found; found = rule.pattern.exec(content)) {
            const line = lineNumberAt(content, found.index);
            matches.push({
                rule: rule.key,
                severity: rule.severity,
                file: relative(filename),
                line,
                text: lineTextAt(content, line),
            });
            if (found.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
        }
    }
    return matches;
}

function summarize(matches) {
    const byRule = {};
    const byClass = {};
    for (const match of matches) {
        match.classification = classify(match);
        byRule[match.rule] = Number(byRule[match.rule] || 0) + 1;
        byClass[match.classification] = Number(byClass[match.classification] || 0) + 1;
    }
    const runtime = matches.filter((match) => match.classification === 'runtime_callsite');
    return {
        total: matches.length,
        runtimeCallsiteCount: runtime.length,
        runtimeFileCount: new Set(runtime.map((match) => match.file)).size,
        byRule,
        byClassification: byClass,
        runtimeFiles: [...new Set(runtime.map((match) => match.file))].sort(),
    };
}

function main() {
    const files = listFiles(ROOT).sort();
    const matches = files.flatMap(scanFile)
        .sort((left, right) => left.file.localeCompare(right.file)
            || left.line - right.line
            || left.rule.localeCompare(right.rule));
    const report = {
        version: 'clover.generic-access-callsite-audit.v1',
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
        console.log(`${match.file}:${match.line} [${match.rule}] ${match.text}`);
    }
}

if (require.main === module) main();

module.exports = {
    EXCLUDED_DIRECTORIES,
    RULES,
    classify,
    lineNumberAt,
    listFiles,
    scanFile,
    summarize,
};
