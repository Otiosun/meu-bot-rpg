'use strict';

const fs = require('fs');
const path = require('path');

const TOKENS = Object.freeze([
    'reconcileSquadStars',
    'syncMissingVisibleMemberStars',
    'syncAllSquadGroupDescriptions',
    'squad_reconcile',
]);

const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx']);
const IGNORED_DIRECTORIES = new Set([
    '.git',
    'node_modules',
    'backups',
    'artifacts',
    'auth_info',
    'logs',
    'temp',
    'tmp',
]);

function parseArgs(argv) {
    const options = {
        root: path.resolve(__dirname, '..'),
        output: null,
        failOnRuntimeCallsite: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--root') options.root = path.resolve(argv[++index]);
        else if (arg.startsWith('--root=')) options.root = path.resolve(arg.slice('--root='.length));
        else if (arg === '--output') options.output = path.resolve(argv[++index]);
        else if (arg.startsWith('--output=')) options.output = path.resolve(arg.slice('--output='.length));
        else if (arg === '--fail-on-runtime-callsite') options.failOnRuntimeCallsite = true;
        else throw new Error(`Argumento desconhecido: ${arg}`);
    }
    return options;
}

function walk(directory, files = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target, files);
        else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(target);
    }
    return files;
}

function isInsideBlock(lines, index, startPattern, endPattern, maximumDistance = 40) {
    const minimum = Math.max(0, index - maximumDistance);
    let startIndex = -1;

    for (let cursor = index; cursor >= minimum; cursor -= 1) {
        if (cursor < index && endPattern.test(lines[cursor])) break;
        if (startPattern.test(lines[cursor])) {
            startIndex = cursor;
            break;
        }
    }
    if (startIndex < 0) return false;

    const maximum = Math.min(lines.length - 1, index + maximumDistance);
    for (let cursor = index; cursor <= maximum; cursor += 1) {
        if (endPattern.test(lines[cursor])) return true;
    }
    return false;
}

function classify(relativePath, lines, index, token) {
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const line = lines[index];
    const trimmed = line.trim();

    if (/scripts\/auditLegacySquadReconcileCallsites\.js$/.test(normalizedPath)) return 'scanner';
    if (normalizedPath.startsWith('tests/')) return 'test';
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return 'comment';
    if (/^(async\s+)?function\s+/.test(trimmed) && trimmed.includes(token)) return 'definition';
    if (new RegExp(`^(const|let|var)\\s+${token}\\s*=`).test(trimmed)) return 'definition';
    if (/module\.exports|exports\./.test(trimmed)) return 'export';
    if (/require\(|from\s+['"]/.test(trimmed)) return 'import';

    if (isInsideBlock(
        lines,
        index,
        /^\s*(const|let|var)\s*\{/,
        /\}\s*=\s*require\s*\(/
    )) return 'import';
    if (isInsideBlock(
        lines,
        index,
        /^\s*import\s*\{/,
        /\}\s*from\s*['"]/
    )) return 'import';
    if (isInsideBlock(
        lines,
        index,
        /module\.exports\s*=\s*\{/,
        /^\s*\};?\s*$/
    )) return 'export';

    return 'runtime_reference';
}

function scanFile(root, filename) {
    const content = fs.readFileSync(filename, 'utf8');
    const lines = content.split(/\r?\n/);
    const relativePath = path.relative(root, filename).replace(/\\/g, '/');
    const matches = [];

    for (let index = 0; index < lines.length; index += 1) {
        for (const token of TOKENS) {
            if (!lines[index].includes(token)) continue;
            matches.push({
                path: relativePath,
                line: index + 1,
                token,
                classification: classify(relativePath, lines, index, token),
                snippet: lines[index].trim().slice(0, 260),
            });
        }
    }
    return matches;
}

function countBy(items, key) {
    return Object.fromEntries(
        [...new Set(items.map((item) => item[key]))]
            .sort()
            .map((value) => [value, items.filter((item) => item[key] === value).length])
    );
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(options.root)) throw new Error(`Diretório não encontrado: ${options.root}`);

    const files = walk(options.root);
    const matches = files
        .flatMap((filename) => scanFile(options.root, filename))
        .sort((left, right) => (
            left.path.localeCompare(right.path)
            || left.line - right.line
            || left.token.localeCompare(right.token)
        ));
    const runtimeReferences = matches.filter((item) => item.classification === 'runtime_reference');
    const report = {
        reportVersion: 'clover-legacy-squad-reconcile-callsites-v2',
        generatedAt: new Date().toISOString(),
        root: options.root,
        tokens: TOKENS,
        summary: {
            filesScanned: files.length,
            matches: matches.length,
            runtimeReferences: runtimeReferences.length,
            byClassification: countBy(matches, 'classification'),
            byToken: countBy(matches, 'token'),
        },
        runtimeReferences,
        matches,
    };

    if (options.output) {
        fs.mkdirSync(path.dirname(options.output), { recursive: true });
        fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }

    console.log('\n=== CLOVER · CHAMADAS DO RECONCILIADOR LEGADO ===');
    console.log(`Arquivos analisados: ${report.summary.filesScanned}`);
    console.log(`Referências totais: ${report.summary.matches}`);
    console.log(`Referências de runtime: ${report.summary.runtimeReferences}`);
    if (runtimeReferences.length) {
        console.log('\nReferências de runtime:');
        for (const item of runtimeReferences) {
            console.log(`- ${item.path}:${item.line} · ${item.token} · ${item.snippet}`);
        }
    }
    if (options.output) console.log(`\nRelatório: ${options.output}`);

    if (options.failOnRuntimeCallsite && runtimeReferences.length > 0) process.exitCode = 2;
}

try {
    main();
} catch (error) {
    console.error('\nFalha ao mapear o reconciliador legado:', error?.stack || error?.message || error);
    process.exitCode = 1;
}
