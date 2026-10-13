'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TARGET_BRANCH = 'clover/evaluation-support-migration-2026-10-13';
const PM2_NAME = 'clover-rpg';
const APPLY_TOKEN = 'APPLY_UNIVERSAL_EVALUATION_LOCAL';

function runCapture(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd || process.cwd(),
        env: options.env || process.env,
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
    });
    return {
        ok: !result.error && result.status === 0,
        status: result.status,
        stdout: String(result.stdout || '').trim(),
        stderr: String(result.stderr || '').trim(),
        error: result.error ? result.error.message : null,
    };
}

function runInherit(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd || process.cwd(),
        env: options.env || process.env,
        stdio: 'inherit',
        windowsHide: true,
        shell: false,
    });
    if (result.error || result.status !== 0) {
        const error = new Error(`Falha: ${command} ${args.join(' ')} (exit=${result.status})`);
        error.cause = result.error || null;
        throw error;
    }
}

function pm2Capture(args, options = {}) {
    if (process.platform === 'win32') {
        return runCapture('cmd.exe', ['/d', '/s', '/c', ['pm2', ...args].join(' ')], options);
    }
    return runCapture('pm2', args, options);
}

function pm2Inherit(args, options = {}) {
    if (process.platform === 'win32') {
        return runInherit('cmd.exe', ['/d', '/s', '/c', ['pm2', ...args].join(' ')], options);
    }
    return runInherit('pm2', args, options);
}

function gitCapture(args, cwd) {
    return runCapture('git', args, { cwd });
}

function gitValue(args, cwd) {
    const result = gitCapture(args, cwd);
    if (!result.ok) {
        throw new Error(`git ${args.join(' ')} falhou: ${result.error || result.stderr || result.stdout}`);
    }
    return result.stdout;
}

function gitInherit(args, cwd) {
    runInherit('git', args, { cwd });
}

function migrationEnv(base = process.env) {
    return {
        ...base,
        CLOVER_UNIVERSAL_EVALUATION: '0',
        CLOVER_STRICT_COMMAND_OWNERSHIP: '0',
    };
}

function normalizePath(value) {
    const resolved = path.resolve(String(value || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function getPm2Process(name, cwd) {
    const result = pm2Capture(['jlist'], { cwd });
    if (!result.ok) {
        throw new Error(`pm2 jlist falhou: ${result.error || result.stderr || result.stdout}`);
    }
    let list;
    try {
        list = JSON.parse(result.stdout || '[]');
    } catch (error) {
        throw new Error(`pm2 jlist retornou JSON invalido: ${error.message}`);
    }
    return list.find((item) => item && item.name === name) || null;
}

function ensureLocalPreconditions(repo) {
    const dirty = gitValue(['status', '--porcelain'], repo);
    if (dirty) {
        throw new Error(`Arvore Git possui alteracoes locais. Commit/stash antes do bootstrap.\n${dirty}`);
    }

    const dbPath = path.join(repo, 'banco.sqlite');
    const authPath = path.join(repo, 'auth_info');
    if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
        throw new Error(`Banco nao encontrado: ${dbPath}`);
    }
    if (!fs.existsSync(authPath) || !fs.statSync(authPath).isDirectory()) {
        throw new Error(`auth_info nao encontrado: ${authPath}`);
    }

    const clover = getPm2Process(PM2_NAME, repo);
    if (!clover) throw new Error(`Processo PM2 ${PM2_NAME} nao encontrado.`);
    const status = String(clover.pm2_env && clover.pm2_env.status || '');
    if (status !== 'online') {
        throw new Error(`Processo PM2 ${PM2_NAME} precisa estar online antes do bootstrap; atual=${status || '-'}`);
    }
    const pmCwd = String(clover.pm2_env && clover.pm2_env.pm_cwd || '');
    if (!pmCwd || normalizePath(pmCwd) !== normalizePath(repo)) {
        throw new Error(`Processo PM2 ${PM2_NAME} aponta para outro repo: ${pmCwd || '(sem cwd)'}`);
    }

    return { dbPath, authPath, clover };
}

async function createVerifiedBackup(repo, dbPath) {
    const { backupSqliteDatabase } = require(path.join(repo, 'helpers', 'clover', 'sqliteBackupService'));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(
        repo,
        'backups',
        `universal-evaluation-bootstrap-${stamp}`,
        'banco.sqlite'
    );
    return backupSqliteDatabase(dbPath, backupPath);
}

function restoreDatabase(dbPath, backupPath) {
    for (const suffix of ['-wal', '-shm']) {
        try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
    }
    fs.copyFileSync(backupPath, dbPath);
}

function stopPm2(repo) {
    pm2Inherit(['stop', PM2_NAME], { cwd: repo });
}

function restartPm2Off(repo) {
    pm2Inherit(['restart', PM2_NAME, '--update-env'], {
        cwd: repo,
        env: migrationEnv(),
    });
}

function restoreCode(repo, oldBranch, oldHead) {
    if (oldBranch) {
        gitInherit(['switch', oldBranch], repo);
        const restoredHead = gitValue(['rev-parse', 'HEAD'], repo);
        if (restoredHead !== oldHead) {
            console.log(`Branch ${oldBranch} nao voltou ao SHA original; usando detached no SHA salvo.`);
            gitInherit(['checkout', '--detach', oldHead], repo);
        }
        return;
    }
    gitInherit(['checkout', '--detach', oldHead], repo);
}

async function main() {
    const repo = gitValue(['rev-parse', '--show-toplevel'], process.cwd());
    process.chdir(repo);

    const { dbPath } = ensureLocalPreconditions(repo);
    const oldBranch = gitValue(['branch', '--show-current'], repo);
    const oldHead = gitValue(['rev-parse', 'HEAD'], repo);
    const oldLabel = oldBranch || '(detached)';

    console.log('');
    console.log('CLOVER - BOOTSTRAP LOCAL DA FILA UNIVERSAL');
    console.log(`Repo: ${repo}`);
    console.log(`Estado anterior: ${oldLabel} @ ${oldHead}`);
    console.log('auth_info: sera preservado');
    console.log('');

    let backup = null;
    let switched = false;

    try {
        console.log('[1/6] Buscando branch remota...');
        gitInherit(['fetch', 'origin'], repo);
        const remote = gitCapture(['rev-parse', '--verify', `origin/${TARGET_BRANCH}`], repo);
        if (!remote.ok) throw new Error(`Branch remota ausente: origin/${TARGET_BRANCH}`);

        console.log('[2/6] Parando PM2 antes de qualquer checkout...');
        stopPm2(repo);

        console.log('[3/6] Criando backup SQLite verificado ANTES do checkout...');
        backup = await createVerifiedBackup(repo, dbPath);
        console.log(JSON.stringify(backup));

        console.log('[4/6] Trocando para a branch de migracao...');
        const localBranch = gitCapture(['show-ref', '--verify', '--quiet', `refs/heads/${TARGET_BRANCH}`], repo);
        if (localBranch.ok) {
            gitInherit(['switch', TARGET_BRANCH], repo);
        } else {
            gitInherit(['switch', '--track', '-c', TARGET_BRANCH, `origin/${TARGET_BRANCH}`], repo);
        }
        switched = true;
        gitInherit(['pull', '--ff-only', 'origin', TARGET_BRANCH], repo);

        const afterSwitchDirty = gitValue(['status', '--porcelain'], repo);
        if (afterSwitchDirty) {
            throw new Error(`Branch de migracao nao ficou limpa apos checkout.\n${afterSwitchDirty}`);
        }

        console.log('[5/6] Aplicando migrations 55-58 com feature OFF...');
        runInherit(process.execPath, [
            path.join(repo, 'scripts', 'applyUniversalEvaluationLocal.js'),
            `--confirm=${APPLY_TOKEN}`,
        ], {
            cwd: repo,
            env: migrationEnv(),
        });

        console.log('[6/6] Checkpoint aplicado com fila universal ainda OFF.');
        console.log('');
        console.log(`Backup pre-checkout: ${backup.destinationPath}`);
        console.log('PM2: online');
        console.log('CLOVER_UNIVERSAL_EVALUATION=0');
        console.log('auth_info: intocado');
        console.log('');
        console.log('Proximo passo, depois do smoke test legado:');
        console.log('node .\\scripts\\toggleUniversalEvaluationLocal.js --enable --confirm=ENABLE_UNIVERSAL_EVALUATION_LOCAL');
    } catch (error) {
        console.error('');
        console.error('BOOTSTRAP FALHOU - iniciando rollback automatico.');
        console.error(error && (error.stack || error.message) || error);

        try { pm2Capture(['stop', PM2_NAME], { cwd: repo }); } catch {}

        let rollbackError = null;
        try {
            if (backup && backup.destinationPath && fs.existsSync(backup.destinationPath)) {
                console.error('Restaurando SQLite anterior...');
                restoreDatabase(dbPath, backup.destinationPath);
            } else {
                console.error('ATENCAO: backup pre-checkout nao esta disponivel para restauracao.');
            }

            if (switched) {
                console.error('Restaurando codigo anterior...');
                restoreCode(repo, oldBranch, oldHead);
            }

            console.error('Reiniciando runtime anterior com features novas OFF...');
            restartPm2Off(repo);

            const diagnosisPath = path.join(repo, 'scripts', 'diagnoseCloverRuntime.js');
            if (fs.existsSync(diagnosisPath)) {
                runInherit(process.execPath, [diagnosisPath], { cwd: repo, env: migrationEnv() });
            }
        } catch (inner) {
            rollbackError = inner;
            console.error('ROLLBACK TAMBEM FALHOU:');
            console.error(inner && (inner.stack || inner.message) || inner);
        }

        process.exitCode = 1;
        if (rollbackError) process.exitCode = 2;
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error && (error.stack || error.message) || error);
        process.exitCode = 1;
    });
}

module.exports = {
    APPLY_TOKEN,
    PM2_NAME,
    TARGET_BRANCH,
    getPm2Process,
    migrationEnv,
    normalizePath,
};