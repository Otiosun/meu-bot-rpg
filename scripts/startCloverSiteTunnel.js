'use strict';

const { spawn } = require('child_process');
const { buildNgrokConfig, envFlag, normalizeUrl, startNgrok } = require('./startCloverSiteNgrok');

const DEFAULT_PORT = 8787;

function normalizeProvider(value = '') {
    const text = String(value || '').trim().toLowerCase();
    if (!text || text === 'auto') return 'ngrok';
    if (['0', 'off', 'false', 'none', 'disabled'].includes(text)) return 'none';
    if (['cloudflare', 'cloudflared', 'cf'].includes(text)) return 'cloudflare';
    if (text === 'ngrok') return 'ngrok';
    return text;
}

function buildCloudflaredConfig(env = process.env) {
    const enabled = envFlag(env.CLOVER_CLOUDFLARED_ENABLED ?? env.CLOVER_TUNNEL_ENABLED, true);
    const binary = String(env.CLOVER_CLOUDFLARED_BIN || env.CLOUDFLARED_BIN || 'cloudflared').trim();
    const port = Number(env.CLOVER_CLOUDFLARED_TARGET_PORT || env.CLOVER_SITE_API_PORT || DEFAULT_PORT);
    const publicUrl = normalizeUrl(env.CLOVER_CLOUDFLARED_PUBLIC_URL || env.CLOVER_TUNNEL_PUBLIC_URL || '');
    const token = String(env.CLOVER_CLOUDFLARED_TOKEN || '').trim();
    const tunnel = String(env.CLOVER_CLOUDFLARED_TUNNEL || env.CLOVER_TUNNEL_NAME || '').trim();
    const config = String(env.CLOVER_CLOUDFLARED_CONFIG || '').trim();
    const targetUrl = String(env.CLOVER_CLOUDFLARED_URL || `http://127.0.0.1:${port}`).trim();
    const args = ['tunnel', '--no-autoupdate'];

    if (config) args.push('--config', config);
    if (token) args.push('run', '--token', token);
    else if (tunnel) args.push('run', tunnel);
    else args.push('--url', targetUrl);

    return {
        enabled,
        binary,
        port,
        publicUrl,
        provider: 'cloudflare',
        args,
        valid: Number.isFinite(port) && port > 0 && port <= 65535 && Boolean(binary),
        usesQuickTunnel: !token && !tunnel && !config,
    };
}

function buildTunnelConfig(env = process.env) {
    const provider = normalizeProvider(env.CLOVER_TUNNEL_PROVIDER || env.CLOVER_SITE_TUNNEL_PROVIDER || '');
    if (provider === 'none') return { provider, enabled: false, valid: true, binary: '', args: [] };
    if (provider === 'cloudflare') return buildCloudflaredConfig(env);
    if (provider === 'ngrok') return { ...buildNgrokConfig(env), provider: 'ngrok' };
    return { provider, enabled: true, valid: false, binary: '', args: [], error: `Provedor de tunel desconhecido: ${provider}` };
}

function publicTunnelUrl(config, env = process.env) {
    if (config.provider === 'cloudflare') {
        return config.publicUrl || normalizeUrl(env.CLOVER_SITE_API_PUBLIC_URL || env.CLOVER_API_PUBLIC_URL || '');
    }
    return config.url || '';
}

function startCloudflared(config, options = {}) {
    const spawnProcess = options.spawnProcess || spawn;
    const cwd = options.cwd || process.cwd();
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;

    if (!config.enabled) {
        stdout.write('[clover-cloudflare] Tunel desativado.\n');
        return { ok: true, disabled: true, child: null };
    }
    if (!config.valid) {
        const error = new Error('Configuracao invalida do cloudflared.');
        error.code = 'invalid_config';
        return { ok: false, error, child: null };
    }

    const mode = config.usesQuickTunnel ? 'quick tunnel temporario' : 'tunel nomeado/configurado';
    stdout.write(`[clover-cloudflare] Subindo ${mode} -> http://127.0.0.1:${config.port}\n`);
    const child = spawnProcess(config.binary, config.args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk) => stdout.write(`[clover-cloudflare] ${chunk}`));
    child.stderr?.on('data', (chunk) => stderr.write(`[clover-cloudflare] ${chunk}`));
    return { ok: true, disabled: false, child };
}

function startTunnel(config, options = {}) {
    if (config.provider === 'none' || !config.enabled) {
        options.stdout?.write?.('[clover-tunnel] Tunel desativado.\n');
        return { ok: true, disabled: true, child: null };
    }
    if (config.provider === 'cloudflare') return startCloudflared(config, options);
    if (config.provider === 'ngrok') return startNgrok(config, options);
    const error = new Error(config.error || `Provedor de tunel desconhecido: ${config.provider}`);
    error.code = 'invalid_provider';
    return { ok: false, error, child: null };
}

module.exports = {
    buildCloudflaredConfig,
    buildTunnelConfig,
    normalizeProvider,
    publicTunnelUrl,
    startCloudflared,
    startTunnel,
};
