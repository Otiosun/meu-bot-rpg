'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SIZE_TARGETS = Object.freeze([
    'backups',
    'artifacts',
    'node_modules',
    'tools',
    'logs',
    'assets/appearance',
    'previews',
    'auth_info',
    'temp',
    'tmp',
]);

function parseArgs(argv) {
    const options = {
        output: null,
        limit: 25,
        plan: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--output') {
            options.output = argv[index + 1];
            index += 1;
        } else if (arg.startsWith('--output=')) {
            options.output = arg.slice('--output='.length);
        } else if (arg === '--limit') {
            options.limit = Number(argv[index + 1]);
            index += 1;
        } else if (arg.startsWith('--limit=')) {
            options.limit = Number(arg.slice('--limit='.length));
        } else if (arg === '--plan') {
            options.plan = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error('--limit must be a positive integer');
    }

    return options;
}

function git(args, cwd = ROOT) {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function runGitStatus(cwd) {
    try {
        return git(['status', '--short'], cwd)
            .split(/\r?\n/)
            .filter(Boolean);
    } catch (error) {
        return [`ERROR: ${error.message}`];
    }
}

function runGitIgnoredStatus(cwd) {
    try {
        return git(['status', '--short', '--ignored'], cwd)
            .split(/\r?\n/)
            .filter(Boolean);
    } catch {
        return [];
    }
}

function parseWorktrees() {
    const lines = git(['worktree', 'list', '--porcelain'])
        .split(/\r?\n/)
        .filter(Boolean);
    const worktrees = [];
    let current = null;

    for (const line of lines) {
        if (line.startsWith('worktree ')) {
            if (current) {
                worktrees.push(current);
            }
            current = {
                path: line.slice('worktree '.length),
                head: null,
                branch: 'detached',
                trackedChanges: 0,
                untracked: 0,
                ignored: 0,
                untrackedFiles: [],
            };
        } else if (current && line.startsWith('HEAD ')) {
            current.head = line.slice('HEAD '.length);
        } else if (current && line.startsWith('branch refs/heads/')) {
            current.branch = line.slice('branch refs/heads/'.length);
        }
    }

    if (current) {
        worktrees.push(current);
    }

    for (const worktree of worktrees) {
        if (!fs.existsSync(worktree.path)) {
            continue;
        }

        const status = runGitStatus(worktree.path);
        const ignoredStatus = runGitIgnoredStatus(worktree.path);
        worktree.trackedChanges = status.filter((entry) => !entry.startsWith('??')).length;
        worktree.untrackedFiles = status
            .filter((entry) => entry.startsWith('??'))
            .map((entry) => entry.slice(3));
        worktree.untracked = worktree.untrackedFiles.length;
        worktree.ignored = ignoredStatus.filter((entry) => entry.startsWith('!!')).length;
    }

    return worktrees;
}

function getBranches(flag) {
    return git(['branch', flag, 'main', '--format=%(refname:short)'])
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
}

function getBranchDetails() {
    return git([
        'for-each-ref',
        '--format=%(refname:short)|%(upstream:short)|%(committerdate:short)|%(objectname:short)|%(subject)',
        'refs/heads',
    ])
        .split(/\r?\n/)
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .map((line) => {
            const [name, upstream, date, head, ...subjectParts] = line.split('|');
            return {
                name,
                upstream,
                date,
                head,
                subject: subjectParts.join('|'),
            };
        });
}

function getDirectorySize(targetPath) {
    let total = 0;

    function walk(currentPath) {
        let entries;
        try {
            entries = fs.readdirSync(currentPath, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const entryPath = path.join(currentPath, entry.name);
            let stat;
            try {
                stat = fs.lstatSync(entryPath);
            } catch {
                continue;
            }

            if (stat.isSymbolicLink()) {
                continue;
            }
            if (stat.isDirectory()) {
                walk(entryPath);
            } else if (stat.isFile()) {
                total += stat.size;
            }
        }
    }

    if (fs.existsSync(targetPath)) {
        const stat = fs.lstatSync(targetPath);
        if (stat.isDirectory()) {
            walk(targetPath);
        } else if (stat.isFile()) {
            total += stat.size;
        }
    }

    return total;
}

function getTopEntries(basePath, limit) {
    if (!fs.existsSync(basePath)) {
        return [];
    }

    return fs.readdirSync(basePath, { withFileTypes: true })
        .map((entry) => {
            const entryPath = path.join(basePath, entry.name);
            const bytes = getDirectorySize(entryPath);
            return {
                name: entry.name,
                type: entry.isDirectory() ? 'dir' : 'file',
                bytes,
                mb: bytes / 1024 / 1024,
            };
        })
        .sort((left, right) => right.bytes - left.bytes)
        .slice(0, limit);
}

function formatMb(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function markdownTable(headers, rows) {
    const lines = [
        `| ${headers.join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`,
    ];

    for (const row of rows) {
        lines.push(`| ${row.join(' | ')} |`);
    }

    return lines.join('\n');
}

function commandEscape(value) {
    return value.replace(/'/g, "''");
}

function isProtectedBranch(branch) {
    return branch === 'main'
        || branch.startsWith('backup/')
        || branch.startsWith('release/')
        || branch.startsWith('rescue/');
}

function buildCleanupPlan({ worktrees, merged, unmerged }) {
    const branchToWorktree = new Map(
        worktrees
            .filter((worktree) => worktree.branch && worktree.branch !== 'detached')
            .map((worktree) => [worktree.branch, worktree]),
    );
    const removableWorktrees = worktrees.filter((worktree) => (
        worktree.branch !== 'main'
        && worktree.trackedChanges === 0
        && worktree.untracked === 0
    ));
    const carefulWorktrees = worktrees.filter((worktree) => (
        worktree.branch !== 'main'
        && worktree.trackedChanges === 0
        && worktree.untracked > 0
    ));
    const blockedWorktrees = worktrees.filter((worktree) => (
        worktree.branch !== 'main'
        && worktree.trackedChanges > 0
    ));
    const removableBranches = merged.filter((branch) => (
        !isProtectedBranch(branch)
        && !branchToWorktree.has(branch)
    ));
    const branchAfterWorktreeRows = merged
        .filter((branch) => (
            !isProtectedBranch(branch)
            && branchToWorktree.has(branch)
            && branchToWorktree.get(branch).trackedChanges === 0
            && branchToWorktree.get(branch).untracked === 0
        ))
        .map((branch) => {
            const worktree = branchToWorktree.get(branch);
            return [
                branch,
                worktree.path.replace(/\\/g, '/'),
            ];
        });
    const reviewBranches = unmerged.filter((branch) => !branch.startsWith('backup/'));

    const lines = [];
    lines.push('## Plano de limpeza dry-run');
    lines.push('');
    lines.push('Nada nesta secao foi executado. Os comandos abaixo sao modelos para uma janela futura autorizada.');
    lines.push('');

    lines.push('### Worktrees candidatos a arquivamento/remocao');
    lines.push('');
    if (removableWorktrees.length > 0) {
        lines.push(markdownTable(
            ['Caminho', 'Branch', 'HEAD', 'Ignorados'],
            removableWorktrees.map((worktree) => [
                worktree.path.replace(/\\/g, '/'),
                worktree.branch,
                worktree.head ? worktree.head.slice(0, 8) : '',
                String(worktree.ignored),
            ]),
        ));
    } else {
        lines.push('Nenhum.');
    }
    lines.push('');

    lines.push('### Worktrees que exigem arquivar nao rastreados primeiro');
    lines.push('');
    if (carefulWorktrees.length > 0) {
        lines.push(markdownTable(
            ['Caminho', 'Branch', 'Nao rastreados'],
            carefulWorktrees.map((worktree) => [
                worktree.path.replace(/\\/g, '/'),
                worktree.branch,
                worktree.untrackedFiles.join('<br>'),
            ]),
        ));
    } else {
        lines.push('Nenhum.');
    }
    lines.push('');

    lines.push('### Worktrees bloqueados por alteracao rastreada');
    lines.push('');
    if (blockedWorktrees.length > 0) {
        lines.push(markdownTable(
            ['Caminho', 'Branch', 'Alteracoes rastreadas'],
            blockedWorktrees.map((worktree) => [
                worktree.path.replace(/\\/g, '/'),
                worktree.branch,
                String(worktree.trackedChanges),
            ]),
        ));
    } else {
        lines.push('Nenhum.');
    }
    lines.push('');

    lines.push('### Branches locais mescladas removiveis depois de revisao');
    lines.push('');
    if (removableBranches.length > 0) {
        lines.push(removableBranches.map((branch) => `- ${branch}`).join('\n'));
    } else {
        lines.push('Nenhuma.');
    }
    lines.push('');

    lines.push('### Branches mescladas presas a worktree');
    lines.push('');
    if (branchAfterWorktreeRows.length > 0) {
        lines.push(markdownTable(['Branch', 'Worktree'], branchAfterWorktreeRows));
    } else {
        lines.push('Nenhuma.');
    }
    lines.push('');

    lines.push('### Branches nao mescladas para decisao humana');
    lines.push('');
    if (reviewBranches.length > 0) {
        lines.push(reviewBranches.map((branch) => `- ${branch}`).join('\n'));
    } else {
        lines.push('Nenhuma.');
    }
    lines.push('');

    lines.push('### Comandos-modelo para janela futura');
    lines.push('');
    lines.push('```powershell');
    lines.push('# Conferir antes de qualquer remocao');
    lines.push('git status --short --branch');
    lines.push('git worktree list');
    lines.push('');
    lines.push('# Remover um worktree apenas depois de arquivar o que importa');
    if (removableWorktrees[0]) {
        lines.push(`git worktree remove '${commandEscape(removableWorktrees[0].path)}'`);
    } else {
        lines.push("git worktree remove '<CAMINHO_DO_WORKTREE>'");
    }
    lines.push('');
    lines.push('# Remover branch local ja mesclada, sem apagar remoto');
    if (removableBranches[0]) {
        lines.push(`git branch -d '${commandEscape(removableBranches[0])}'`);
    } else {
        lines.push("git branch -d '<BRANCH_JA_MESCLADA>'");
    }
    lines.push('```');
    lines.push('');
    lines.push('Nao usar `git clean`, `reset --hard`, `prune`, force push ou remocao recursiva sem inventario e autorizacao explicita.');

    return lines.join('\n');
}

function buildReport(options) {
    const status = git(['status', '--short', '--branch']);
    const head = git(['rev-parse', 'HEAD']);
    const originMain = git(['rev-parse', 'origin/main']);
    const worktrees = parseWorktrees();
    const merged = getBranches('--merged');
    const unmerged = getBranches('--no-merged');
    const branchDetails = getBranchDetails();
    const branchByName = new Map(branchDetails.map((branch) => [branch.name, branch]));

    const sizeRows = SIZE_TARGETS
        .filter((target) => fs.existsSync(path.join(ROOT, target)))
        .map((target) => {
            const bytes = getDirectorySize(path.join(ROOT, target));
            return [target, formatMb(bytes)];
        });

    const worktreeRows = worktrees.map((worktree) => [
        worktree.path.replace(/\\/g, '/'),
        worktree.branch,
        worktree.head ? worktree.head.slice(0, 8) : '',
        String(worktree.trackedChanges),
        String(worktree.untracked),
        String(worktree.ignored),
    ]);

    const untrackedWorktreeRows = worktrees
        .filter((worktree) => worktree.untracked > 0)
        .map((worktree) => [
            worktree.path.replace(/\\/g, '/'),
            worktree.untrackedFiles.join('<br>'),
        ]);

    const unmergedRows = unmerged.map((branch) => {
        const detail = branchByName.get(branch) || {};
        return [
            branch,
            detail.upstream || '',
            detail.date || '',
            detail.head || '',
            detail.subject || '',
        ];
    });

    const lines = [];
    lines.push('# Auditoria local de limpeza Clover');
    lines.push('');
    lines.push(`Gerado em: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('## Estado');
    lines.push('');
    lines.push('```');
    lines.push(status);
    lines.push(`HEAD ${head}`);
    lines.push(`origin/main ${originMain}`);
    lines.push('```');
    lines.push('');
    lines.push('## Tamanhos principais');
    lines.push('');
    lines.push(markdownTable(['Caminho', 'Tamanho'], sizeRows));
    lines.push('');
    lines.push('## Worktrees');
    lines.push('');
    lines.push(markdownTable(
        ['Caminho', 'Branch', 'HEAD', 'Rastreados', 'Nao rastreados', 'Ignorados'],
        worktreeRows,
    ));
    lines.push('');
    lines.push('## Worktrees com nao rastreados');
    lines.push('');
    if (untrackedWorktreeRows.length > 0) {
        lines.push(markdownTable(['Caminho', 'Arquivos'], untrackedWorktreeRows));
    } else {
        lines.push('Nenhum.');
    }
    lines.push('');
    lines.push('## Branches ja mescladas em main');
    lines.push('');
    lines.push(merged.map((branch) => `- ${branch}`).join('\n'));
    lines.push('');
    lines.push('## Branches nao mescladas em main');
    lines.push('');
    lines.push(markdownTable(['Branch', 'Upstream', 'Data', 'HEAD', 'Assunto'], unmergedRows));
    lines.push('');
    lines.push('## Maiores entradas em backups');
    lines.push('');
    lines.push(markdownTable(
        ['Entrada', 'Tipo', 'Tamanho'],
        getTopEntries(path.join(ROOT, 'backups'), options.limit).map((entry) => [
            entry.name,
            entry.type,
            `${entry.mb.toFixed(2)} MB`,
        ]),
    ));
    lines.push('');
    lines.push('## Maiores entradas em artifacts');
    lines.push('');
    lines.push(markdownTable(
        ['Entrada', 'Tipo', 'Tamanho'],
        getTopEntries(path.join(ROOT, 'artifacts'), options.limit).map((entry) => [
            entry.name,
            entry.type,
            `${entry.mb.toFixed(2)} MB`,
        ]),
    ));
    lines.push('');

    if (options.plan) {
        lines.push(buildCleanupPlan({ worktrees, merged, unmerged }));
        lines.push('');
    }

    lines.push('## Garantia');
    lines.push('');
    lines.push('Este script e somente leitura. Ele nao remove branch, worktree, backup, artefato, banco, sessao ou runtime.');

    return lines.join('\n');
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const report = buildReport(options);

    if (options.output) {
        const outputPath = path.resolve(ROOT, options.output);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${report}\n`, 'utf8');
        console.log(`Local cleanup audit written to ${outputPath}`);
        return;
    }

    console.log(report);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`Local cleanup audit failed: ${error.message}`);
        process.exitCode = 1;
    }
}
