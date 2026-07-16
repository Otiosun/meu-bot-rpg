'use strict';

const { spawn } = require('child_process');

const DEFAULT_PORT = 8787;

function envFlag(value = '', fallback = false) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return fallback;
    return ['1', 'true', 'yes', 'on', 'sim', 'ligado'].includes(text);
}

function normalizeUrl(value = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

function buildNgrokConfig(env = process.env) {
    const enabled = envFlag(env.CLOVER_NGROK_ENABLED, true);
    const binary = String(env.CLOVER_NGROK_BIN || env.NGROK_BIN || 'ngrok').trim();
    const port = Number(env.CLOVER_NGROK_TARGET_PORT || env.CLOVER_SITE_API_PORT || DEFAULT_PORT);
    const url = normalizeUrl(env.CLOVER_NGROK_URL || env.CLOVER_API_NGROK_URL || '');
    const args = ['http', String(port), '--log=stdout'];
    if (url) args.push(`--url=${url}`);

    return {
        enabled,
        binary,
        port,
        url,
        args,
        valid: Number.isFinite(port) && port > 0 && port <= 65535 && Boolean(binary),
    };
}

function startNgrok(config, options = {}) {
    const spawnProcess = options.spawnProcess || spawn;
    const cwd = options.cwd || process.cwd();
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;

    if (!config.enabled) {
        stdout.write('[clover-ngrok] Túnel desativado por CLOVER_NGROK_ENABLED.\n');
        return { ok: true, disabled: true, child: null };
    }
    if (!config.valid) {
        const error = new Error('Configuração inválida do ngrok.');
        error.code = 'invalid_config';
        return { ok: false, error, child: null };
    }

    stdout.write(
        `[clover-ngrok] Subindo túnel ${config.url || '(URL da conta ngrok)'} -> http://127.0.0.1:${config.port}\n`
    );
    const child = spawnProcess(config.binary, config.args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk) => stdout.write(`[clover-ngrok] ${chunk}`));
    child.stderr?.on('data', (chunk) => stderr.write(`[clover-ngrok] ${chunk}`));
    return { ok: true, disabled: false, child };
}

function runCli(env = process.env) {
    const config = buildNgrokConfig(env);
    const started = startNgrok(config);
    if (!started.ok) {
        console.error('[clover-ngrok] Porta ou binário inválido.');
        process.exitCode = 1;
        return null;
    }
    if (started.disabled) return null;

    const child = started.child;
    child.on('error', (error) => {
        if (error?.code === 'ENOENT') {
            console.error(`[clover-ngrok] Não achei o binário "${config.binary}". Configure CLOVER_NGROK_BIN.`);
        } else {
            console.error('[clover-ngrok] Falha ao iniciar:', error?.message || error);
        }
        process.exitCode = 1;
    });

    child.on('exit', (code, signal) => {
        if (code === 0) {
            console.log('[clover-ngrok] Túnel encerrado.');
            return;
        }
        console.error(`[clover-ngrok] Processo encerrou com code=${code ?? 'null'} signal=${signal || 'null'}.`);
        process.exitCode = code || 1;
    });

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            if (!child.killed) child.kill(signal);
            setTimeout(() => process.exit(0), 1500).unref();
        });
    }
    return child;
}

if (require.main === module) runCli();

module.exports = {
    DEFAULT_PORT,
    buildNgrokConfig,
    envFlag,
    normalizeUrl,
    runCli,
    startNgrok,
};
