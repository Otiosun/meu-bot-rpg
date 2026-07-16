'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const { buildNgrokConfig, startNgrok } = require('./startCloverSiteNgrok');
const { migrateCustomMessageSiteUrls } = require('../helpers/clover/sitePublicUrl');

const DEFAULT_API_PORT = 8787;
const DEFAULT_NGROK_URL = 'https://underuse-clamshell-crazily.ngrok-free.dev';
const DEFAULT_HEALTH_TIMEOUT_MS = 45_000;
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

function stopChild(child, signal = 'SIGTERM') {
    if (!child || child.killed) return;
    try {
        child.kill(signal);
    } catch {}
}

async function startCloverSiteStack(options = {}) {
    const env = buildStackEnv(options.env || process.env);
    const spawnProcess = options.spawnProcess || spawn;
    const waitForHealthFn = options.waitForHealthFn || waitForHealth;
    const startNgrokFn = options.startNgrokFn || startNgrok;
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;
    const cwd = options.cwd || path.join(__dirname, '..');

    const migration = migrateCustomMessageSiteUrls({ env });
    if (migration.ok && migration.changed) stdout.write(`[clover-site] Links antigos migrados para ${migration.publicUrl}\n`);
    if (!migration.ok) stderr.write(`[clover-site] Não consegui migrar mensagens: ${migration.error?.message || migration.error}\n`);

    let shuttingDown = false;
    let ngrokChild = null;
    let restartTimer = null;
    const restartDelayMs = Number(options.ngrokRestartDelayMs ?? NGROK_RESTART_DELAY_MS);

    stdout.write(`[clover-site] Iniciando bot + API local em ${healthUrl(env)}\n`);
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

    const ready = await waitForHealthFn(healthUrl(env));
    if (!ready) {
        cleanup();
        throw new Error(`A API local não respondeu em ${healthUrl(env)} dentro do prazo.`);
    }

    const launchNgrok = (initial = false) => {
        if (shuttingDown) return true;
        let started = null;
        try {
            const config = buildNgrokConfig(env);
            started = startNgrokFn(config, { cwd, stdout, stderr });
        } catch (error) {
            cleanup();
            if (options.setProcessExitCode !== false) process.exitCode = 1;
            if (initial) throw error;
            stderr.write(`[clover-site] ngrok falhou ao reiniciar: ${error?.message || error}\n`);
            return false;
        }
        if (!started.ok) {
            const error = started.error || new Error('Não consegui iniciar o ngrok.');
            cleanup();
            if (options.setProcessExitCode !== false) process.exitCode = 1;
            if (initial) throw error;
            stderr.write(`[clover-site] ngrok falhou ao reiniciar: ${error?.message || error}\n`);
            return false;
        }
        if (started.disabled) {
            ngrokChild = null;
            return true;
        }
        if (!started.child) {
            const error = new Error('Ngrok não retornou processo ativo.');
            cleanup();
            if (options.setProcessExitCode !== false) process.exitCode = 1;
            if (initial) throw error;
            stderr.write(`[clover-site] ngrok falhou ao reiniciar: ${error.message}\n`);
            return false;
        }
        ngrokChild = started.child;
        ngrokChild.on('error', (error) => {
            stderr.write(`[clover-site] ngrok falhou: ${error?.message || error}\n`);
        });
        ngrokChild.on('exit', (code, signal) => {
            if (shuttingDown) return;
            stderr.write(`[clover-site] ngrok encerrou (code=${code ?? 'null'}, signal=${signal || 'null'}). Reiniciando em ${restartDelayMs / 1000}s.\n`);
            restartTimer = setTimeout(() => launchNgrok(false), restartDelayMs);
        });
        return true;
    };

    launchNgrok(true);

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
    DEFAULT_NGROK_URL,
    NGROK_RESTART_DELAY_MS,
    buildStackEnv,
    healthUrl,
    requestHealth,
    runCli,
    startCloverSiteStack,
    stopChild,
    waitForHealth,
};
