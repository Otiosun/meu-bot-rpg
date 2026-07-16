'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { buildNgrokConfig, startNgrok } = require('./startCloverSiteNgrok');
const { migrateCustomMessageSiteUrls } = require('../helpers/clover/sitePublicUrl');

const DEFAULT_API_PORT = 8787;
const DEFAULT_NGROK_URL = 'https://underuse-clamshell-crazily.ngrok-free.dev';
const DEFAULT_HEALTH_TIMEOUT_MS = 45_000;
const DEFAULT_NGROK_START_TIMEOUT_MS = 5_000;
const NGROK_RESTART_DELAY_MS = 5_000;

function buildStackEnv(env = process.env) {
    return {
        ...env,
        CLOVER_SITE_API_ENABLED: env.CLOVER_SITE_API_ENABLED || '1',
        CLOVER_SITE_API_PORT: env.CLOVER_SITE_API_PORT || String(DEFAULT_API_PORT),
        CLOVER_SITE_API_HOST: env.CLOVER_SITE_API_HOST || '0.0.0.0',
        CLOVER_NGROK_ENABLED: env.CLOVER_NGROK_ENABLED || '1',
        CLOVER_NGROK_TARGET_PORT: env.CLOVER_NGROK_TARGET_PORT || env.CLOVER_SITE_API_PORT || String(DEFAULT_API_PORT),
        CLOVER_NGROK_URL: env.CLOVER_NGROK_URL || env.CLOVER_API_NGROK_URL || DEFAULT_NGROK_URL,
    };
}

function healthUrl(env) {
    return `http://127.0.0.1:${Number(env.CLOVER_SITE_API_PORT || DEFAULT_API_PORT)}/health`;
}

function requestHealth(url, options = {}) {
    const request = options.request || http.get;
    return new Promise((resolve) => {
        const req = request(url, { timeout: 2000 }, (res) => {
            res.resume?.();
            resolve(Number(res.statusCode) === 200);
        });
        req.on?.('timeout', () => {
            req.destroy?.();
            resolve(false);
        });
        req.on?.('error', () => resolve(false));
    });
}

async function waitForHealth(url, options = {}) {
    const timeoutMs = Number(options.timeoutMs || DEFAULT_HEALTH_TIMEOUT_MS);
    const intervalMs = Number(options.intervalMs || 500);
    const check = options.check || requestHealth;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await check(url)) return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}

function isPathLike(binary = '') {
    return /[\\/]/.test(binary) || /^[A-Za-z]:/.test(binary);
}

function executableAvailable(binary, options = {}) {
    const existsSync = options.existsSync || fs.existsSync;
    const spawnSyncProcess = options.spawnSyncProcess || spawnSync;
    const platform = options.platform || process.platform;
    const value = String(binary || '').trim();
    if (!value) return false;
    if (isPathLike(value)) return existsSync(value);

    const finder = platform === 'win32' ? 'where.exe' : 'which';
    const result = spawnSyncProcess(finder, [value], {
        stdio: 'ignore',
        windowsHide: true,
    });
    return !result?.error && result?.status === 0;
}

function waitForChildSpawn(child, options = {}) {
    const timeoutMs = Number(options.timeoutMs || DEFAULT_NGROK_START_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            child.removeListener?.('spawn', onSpawn);
            child.removeListener?.('error', onError);
        };
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback(value);
        };
        const onSpawn = () => finish(resolve, true);
        const onError = (error) => finish(reject, error);

        child.once?.('spawn', onSpawn);
        child.once?.('error', onError);
        timer = setTimeout(() => {
            const error = new Error(`O ngrok não confirmou inicialização em ${timeoutMs}ms.`);
            error.code = 'ngrok_start_timeout';
            finish(reject, error);
        }, timeoutMs);
    });
}

function stopChild(child, signal = 'SIGTERM') {
    if (!child || child.killed) return;
    try {
        child.kill(signal);
    } catch {}
}

async function startCloverSiteStack(options = {}) {
    const env = buildStackEnv(options.env || process.env);
    const spawnProcess = options.spawnProcess || spawn;
    const checkHealthFn = options.checkHealthFn || requestHealth;
    const waitForHealthFn = options.waitForHealthFn || waitForHealth;
    const startNgrokFn = options.startNgrokFn || startNgrok;
    const executableAvailableFn = options.executableAvailableFn || executableAvailable;
    const waitForNgrokStartFn = options.waitForNgrokStartFn || waitForChildSpawn;
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;
    const cwd = options.cwd || path.join(__dirname, '..');
    const localHealthUrl = healthUrl(env);
    const ngrokConfig = buildNgrokConfig(env);

    const migration = migrateCustomMessageSiteUrls({ env });
    if (migration.ok && migration.changed) stdout.write(`[clover-site] Links antigos migrados para ${migration.publicUrl}\n`);
    if (!migration.ok) stderr.write(`[clover-site] Não consegui migrar mensagens: ${migration.error?.message || migration.error}\n`);

    if (await checkHealthFn(localHealthUrl)) {
        throw new Error(
            `A porta ${env.CLOVER_SITE_API_PORT} já está em uso por outra API. ` +
            'Feche o processo antigo antes de iniciar npm run start:site.'
        );
    }

    if (ngrokConfig.enabled && !executableAvailableFn(ngrokConfig.binary)) {
        throw new Error(
            `Não encontrei o executável do ngrok em "${ngrokConfig.binary}". ` +
            'Instale o ngrok, adicione-o ao PATH ou configure CLOVER_NGROK_BIN com o caminho real do ngrok.exe.'
        );
    }

    let shuttingDown = false;
    let ngrokChild = null;
    let restartTimer = null;
    const restartDelayMs = Number(options.ngrokRestartDelayMs ?? NGROK_RESTART_DELAY_MS);

    stdout.write(`[clover-site] Iniciando bot + API local em ${localHealthUrl}\n`);
    const botChild = spawnProcess(process.execPath, ['index.js'], {
        cwd,
        env,
        windowsHide: true,
        stdio: 'inherit',
    });

    const cleanup = (signal = 'SIGTERM') => {
        if (shuttingDown) return;
        shuttingDown = true;
        if (restartTimer) clearTimeout(restartTimer);
        stopChild(ngrokChild, signal);
        stopChild(botChild, signal);
    };

    const ready = await waitForHealthFn(localHealthUrl);
    if (!ready) {
        cleanup();
        throw new Error(`A API local não respondeu em ${localHealthUrl} dentro do prazo.`);
    }

    const launchNgrok = async (initial = false) => {
        if (shuttingDown) return true;
        let started = null;
        try {
            started = startNgrokFn(ngrokConfig, { cwd, stdout, stderr });
            if (!started.ok) throw started.error || new Error('Não consegui iniciar o ngrok.');
            if (started.disabled) {
                ngrokChild = null;
                return true;
            }
            if (!started.child) throw new Error('Ngrok não retornou processo ativo.');
            await waitForNgrokStartFn(started.child);
        } catch (error) {
            cleanup();
            if (options.setProcessExitCode !== false) process.exitCode = 1;
            if (initial) throw error;
            stderr.write(`[clover-site] ngrok falhou ao reiniciar: ${error?.message || error}\n`);
            return false;
        }

        ngrokChild = started.child;
        ngrokChild.on('error', (error) => {
            stderr.write(`[clover-site] ngrok falhou: ${error?.message || error}\n`);
        });
        ngrokChild.on('exit', (code, signal) => {
            if (shuttingDown) return;
            stderr.write(`[clover-site] ngrok encerrou (code=${code ?? 'null'}, signal=${signal || 'null'}). Reiniciando em ${restartDelayMs / 1000}s.\n`);
            restartTimer = setTimeout(() => void launchNgrok(false), restartDelayMs);
        });
        return true;
    };

    await launchNgrok(true);

    botChild.on('error', (error) => {
        stderr.write(`[clover-site] bot falhou ao iniciar: ${error?.message || error}\n`);
        cleanup();
    });
    botChild.on('exit', (code, signal) => {
        if (!shuttingDown) {
            stderr.write(`[clover-site] bot encerrou (code=${code ?? 'null'}, signal=${signal || 'null'}). Encerrando túnel.\n`);
            cleanup();
        }
        if (options.setProcessExitCode !== false) process.exitCode = Number(code || 1);
    });

    if (options.registerSignals !== false) {
        for (const signal of ['SIGINT', 'SIGTERM']) {
            process.once(signal, () => {
                cleanup(signal);
                setTimeout(() => process.exit(0), 1500).unref();
            });
        }
    }

    stdout.write(`[clover-site] Stack online: ${env.CLOVER_NGROK_URL} -> 127.0.0.1:${env.CLOVER_SITE_API_PORT}\n`);
    return { botChild, get ngrokChild() { return ngrokChild; }, env, cleanup };
}

async function runCli() {
    try {
        await startCloverSiteStack();
    } catch (error) {
        console.error('[clover-site] Falha ao iniciar stack:', error?.message || error);
        process.exitCode = 1;
    }
}

if (require.main === module) void runCli();

module.exports = {
    DEFAULT_API_PORT,
    DEFAULT_HEALTH_TIMEOUT_MS,
    DEFAULT_NGROK_START_TIMEOUT_MS,
    DEFAULT_NGROK_URL,
    NGROK_RESTART_DELAY_MS,
    buildStackEnv,
    executableAvailable,
    healthUrl,
    isPathLike,
    requestHealth,
    runCli,
    startCloverSiteStack,
    stopChild,
    waitForChildSpawn,
    waitForHealth,
};
