'use strict';

const { execFileSync } = require('node:child_process');

const SCOPED_PATHS = [
    'data/clover/squad-restructure',
    'scripts/planSquadRestructure20260804.cjs',
    'scripts/applySquadRestructure20260804.cjs',
    'tests/squadRestructurePlanner20260804.test.js',
    '.github/workflows/squad-restructure-pr202.yml',
];

const SENSITIVE_PATTERNS = [
    /\b\d{8,}@(lid|s\.whatsapp\.net)\b/gi,
    /"(?:phone|telefone)"\s*:\s*"\+?\d{8,}"/gi,
];

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isScopedPath(filePath) {
    return SCOPED_PATHS.some((prefix) => filePath.startsWith(prefix));
}

function containsSensitiveValue(text) {
    return SENSITIVE_PATTERNS.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(String(text || ''));
    });
}

function parseBase(argv) {
    const argument = argv.find((item) => item.startsWith('--base='));
    return argument ? argument.slice('--base='.length).replace(/^"|"$/g, '') : '';
}

function inspectHistory(base) {
    if (!base) throw new Error('Informe --base=REF para verificar o histórico da PR.');
    git(['rev-parse', '--verify', base]);
    const commits = git(['rev-list', `${base}..HEAD`]).split(/\r?\n/).filter(Boolean);
    const findings = [];

    for (const commit of commits) {
        const paths = git(['ls-tree', '-r', '--name-only', commit]).split(/\r?\n/).filter(isScopedPath);
        for (const filePath of paths) {
            let content = '';
            try {
                content = git(['show', `${commit}:${filePath}`]);
            } catch {
                continue;
            }
            if (containsSensitiveValue(content)) {
                findings.push({ commit: commit.slice(0, 12), path: filePath });
            }
        }
    }

    return { base, commits: commits.length, findings };
}

function main(argv = process.argv.slice(2)) {
    const result = inspectHistory(parseBase(argv));
    if (result.findings.length) {
        for (const finding of result.findings) {
            console.error(`PII detectada em ${finding.commit}:${finding.path}`);
        }
        process.exitCode = 1;
        return;
    }
    console.log(`Histórico sanitizado: ${result.commits} commit(s) verificado(s).`);
}

if (require.main === module) main();

module.exports = {
    containsSensitiveValue,
    inspectHistory,
    isScopedPath,
};
