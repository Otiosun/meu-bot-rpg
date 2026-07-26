'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { buildTunnelConfig, publicTunnelUrl, startTunnel } = require('./startCloverSiteTunnel');
const { migrateCustomMessageSiteUrls } = require('../helpers/clover/sitePublicUrl');

const DEFAULT_API_PORT = 8787;
const DEFAULT_NGROK_URL = 'https://underuse-clamshell-crazily.ngrok-free.dev';
const DEFAULT_HEALTH_TIMEOUT_MS = 45_000;
const DEFAULT_NGROK_SPAWN_TIMEOUT_MS = 5_000;
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
        CLOVER_TUNNEL_PROVIDER: env.CLOVER_TUNNEL_PROVIDER || env.CLOVER_SITE_TUNNEL_PROVIDER || 'ngrok',
        CLOVER_CLOUDFLARED_TARGET_PORT: env.CLOVER_CLOUDFLARED_TARGET_PORT || env.CLOVER_SITE_API_PORT || String(DEFAULT_API_PORT),
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

function stopChild(child, signal = 'SIGTERM') {
    if (!child || child.killed) return;
    try {
        child.kill(signal);
    } catch {}
}

function waitForChildSpawn(child, options = {}) {
    const timeoutMs = Number(options.timeoutMs || DEFAULT_NGROK_SPAWN_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
        if (!child || typeof child.once !== 'function') {
            reject(new Error('Ngrok nao retornou processo monitoravel.'));
            return;
        }

        let done = false;
        let timer = null;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            child.off?.('spawn', onSpawn);
            child.off?.('error', onError);
            child.off?.('exit', onExit);
        };
        const finish = (error = null) => {
            if (done) return;
            done = true;
            cleanup();
            if (error) reject(error);
            else resolve(true);
        };
        const onSpawn = () => finish();
        const onError = (error) => {
            if (error?.code === 'ENOENT') {
                finish(new Error('Nao achei o binario do ngrok. Configure CLOVER_NGROK_BIN com o caminho real do ngrok.exe.'));
                return;
            }
            finish(error instanceof Error ? error : new Error(String(error || 'Falha ao iniciar ngrok.')));
        };
        const onExit = (code, signal) => {
            finish(new Error(`Ngrok encerrou antes de iniciar (code=${code ?? 'null'}, signal=${signal || 'null'}).`));
        };

        child.once('spawn', onSpawn);
        child.once('error', onError);
        child.once('exit', onExit);
        timer = setTimeout(() => {
            finish(new Error(`Ngrok nao confirmou inicializacao em ${timeoutMs / 1000}s.`));
        }, timeoutMs);
        timer.unref?.();
    });
}

async function startCloverSiteStack(options = {}) {
    const env = buildStackEnv(options.env || process.env);
    const spawnProcess = options.spawnProcess || spawn;
    const preflightHealthFn = options.preflightHealthFn || requestHealth;
    const waitForHealthFn = options.waitForHealthFn || waitForHealth;
    const startTunnelFn = options.startTunnelFn || options.startNgrokFn || startTunnel;
    const executableAvailableFn = options.executableAvailableFn || executableAvailable;
    const waitForTunnelSpawnFn = options.waitForTunnelSpawnFn || options.waitForNgrokSpawnFn || waitForChildSpawn;
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;
    const cwd = options.cwd || path.join(__dirname, '..');
    const apiHealthUrl = healthUrl(env);
    const tunnelConfig = buildTunnelConfig(env);

    const migration = migrateCustomMessageSiteUrls({ env });
    if (migration.ok && migration.changed) stdout.write(`[clover-site] Links antigos migrados para ${migration.publicUrl}\n`);
    if (!migration.ok) stderr.write(`[clover-site] Nao consegui migrar mensagens: ${migration.error?.message || migration.error}\n`);

    if (await preflightHealthFn(apiHealthUrl)) {
        throw new Error(
            `A porta ${env.CLOVER_SITE_API_PORT} ja esta respondendo antes desta stack iniciar. ` +
            'Pare o clover-rpg/PM2 antigo ou libere a porta antes de usar npm run start:site.'
        );
    }

    if (tunnelConfig.enabled && !tunnelConfig.valid) {
        throw new Error(tunnelConfig.error || `Configuracao invalida do tunel ${tunnelConfig.provider}.`);
    }

    if (tunnelConfig.enabled && !executableAvailableFn(tunnelConfig.binary)) {
        throw new Error(
            `Nao encontrei o executavel do tunel ${tunnelConfig.provider} em "${tunnelConfig.binary}". ` +
            'Instale o binario, adicione-o ao PATH ou configure a variavel *_BIN correspondente.'
        );
    }

    let shuttingDown = false;
    let tunnelChild = null;
    let restartTimer = null;
    const restartDelayMs = Number(options.ngrokRestartDelayMs ?? NGROK_RESTART_DELAY_MS);
    const ngrokSpawnTimeoutMs = Number(options.ngrokSpawnTimeoutMs ?? DEFAULT_NGROK_SPAWN_TIMEOUT_MS);

    stdout.write(`[clover-site] Iniciando bot + API local em ${apiHealthUrl}\n`);
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
        stopChild(tunnelChild, signal);
        stopChild(botChild, signal);
    };

    const ready = await waitForHealthFn(apiHealthUrl);
    if (!ready) {
        cleanup();
        throw new Error(`A API local nao respondeu em ${apiHealthUrl} dentro do prazo.`);
    }

    const launchTunnel = async (initial = false) => {
        if (shuttingDown) return true;
        let started = null;
        try {
            started = startTunnelFn(tunnelConfig, { cwd, stdout, stderr });
        } catch (error) {
            cleanup();
            if (options.setProcessExitCode !== false) process.exitCode = 1;
            if (initial) throw error;
            stderr.write(`[clover-site] tunel falhou ao reiniciar: ${error?.message || error}\n`);
            return false;
        }
        if (!started.ok) {
            const error = started.error || new Error('Nao consegui iniciar o tunel.');
            cleanup();
            if (options.setProcessExitCode !== false) process.exitCode = 1;
            if (initial) throw error;
            stderr.write(`[clover-site] tunel falhou ao reiniciar: ${error?.message || error}\n`);
            return false;
        }
        if (started.disabled) {
            tunnelChild = null;
            return true;
        }
        if (!started.child) {
            const error = new Error('Tunel nao retornou processo ativo.');
            cleanup();
            if (options.setProcessExitCode !== false) process.exitCode = 1;
            if (initial) throw error;
            stderr.write(`[clover-site] tunel falhou ao reiniciar: ${error.message}\n`);
            return false;
        }

        try {
            await waitForTunnelSpawnFn(started.child, { timeoutMs: ngrokSpawnTimeoutMs, config: tunnelConfig });
        } catch (error) {
            stopChild(started.child);
            cleanup();
            if (options.setProcessExitCode !== false) process.exitCode = 1;
            if (initial) throw error;
            stderr.write(`[clover-site] tunel falhou ao reiniciar: ${error?.message || error}\n`);
            return false;
        }

        tunnelChild = started.child;
        tunnelChild.on('error', (error) => {
            stderr.write(`[clover-site] tunel falhou: ${error?.message || error}\n`);
        });
        tunnelChild.on('exit', (code, signal) => {
            if (shuttingDown) return;
            stderr.write(`[clover-site] tunel encerrou (code=${code ?? 'null'}, signal=${signal || 'null'}). Reiniciando em ${restartDelayMs / 1000}s.\n`);
            restartTimer = setTimeout(() => {
                void launchTunnel(false);
            }, restartDelayMs);
        });
        return true;
    };

    await launchTunnel(true);

    botChild.on('error', (error) => {
        stderr.write(`[clover-site] bot falhou ao iniciar: ${error?.message || error}\n`);
        cleanup();
    });
    botChild.on('exit', (code, signal) => {
        if (!shuttingDown) {
            stderr.write(`[clover-site] bot encerrou (code=${code ?? 'null'}, signal=${signal || 'null'}). Encerrando tunel.\n`);
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

    const publicUrl = publicTunnelUrl(tunnelConfig, env) || '(tunel sem URL publica fixa)';
    stdout.write(`[clover-site] Stack online: ${publicUrl} -> 127.0.0.1:${env.CLOVER_SITE_API_PORT}\n`);
    return { botChild, get ngrokChild() { return tunnelChild; }, get tunnelChild() { return tunnelChild; }, env, cleanup };
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
    DEFAULT_NGROK_SPAWN_TIMEOUT_MS,
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
