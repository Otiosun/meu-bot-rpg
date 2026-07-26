'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const {
    buildNgrokConfig,
    envFlag,
    normalizeUrl,
    startNgrok,
} = require('../scripts/startCloverSiteNgrok');
const {
    buildCloudflaredConfig,
    buildTunnelConfig,
    startCloudflared,
} = require('../scripts/startCloverSiteTunnel');

test('envFlag reconhece valores ligados e desligados', () => {
    assert.equal(envFlag('sim'), true);
    assert.equal(envFlag('ON'), true);
    assert.equal(envFlag('false'), false);
    assert.equal(envFlag('', true), true);
});

test('normalizeUrl preserva protocolo e completa domínio simples', () => {
    assert.equal(normalizeUrl('example.ngrok.app'), 'https://example.ngrok.app');
    assert.equal(normalizeUrl('http://localhost:4040'), 'http://localhost:4040');
    assert.equal(normalizeUrl(''), '');
});

test('configuração usa porta, binário e URL explícitos', () => {
    const config = buildNgrokConfig({
        CLOVER_NGROK_ENABLED: '1',
        CLOVER_NGROK_BIN: 'C:\\ngrok\\ngrok.exe',
        CLOVER_NGROK_TARGET_PORT: '9999',
        CLOVER_NGROK_URL: 'clover.ngrok.app',
    });

    assert.equal(config.enabled, true);
    assert.equal(config.binary, 'C:\\ngrok\\ngrok.exe');
    assert.equal(config.port, 9999);
    assert.equal(config.url, 'https://clover.ngrok.app');
    assert.deepEqual(config.args, ['http', '9999', '--log=stdout', '--url=https://clover.ngrok.app']);
    assert.equal(config.valid, true);
});

test('porta inválida é recusada antes de abrir processo', () => {
    const config = buildNgrokConfig({ CLOVER_NGROK_TARGET_PORT: '70000' });
    let called = false;
    const result = startNgrok(config, {
        spawnProcess: () => {
            called = true;
        },
        stdout: { write() {} },
        stderr: { write() {} },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'invalid_config');
    assert.equal(called, false);
});

test('modo desativado não abre ngrok', () => {
    const config = buildNgrokConfig({ CLOVER_NGROK_ENABLED: '0' });
    let called = false;
    const result = startNgrok(config, {
        spawnProcess: () => {
            called = true;
        },
        stdout: { write() {} },
        stderr: { write() {} },
    });

    assert.equal(result.ok, true);
    assert.equal(result.disabled, true);
    assert.equal(called, false);
});

test('processo recebe somente argumentos públicos de configuração', () => {
    const config = buildNgrokConfig({
        CLOVER_SITE_API_PORT: '8787',
        CLOVER_NGROK_URL: 'https://clover.ngrok.app',
    });
    const calls = [];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    const result = startNgrok(config, {
        spawnProcess: (binary, args, options) => {
            calls.push({ binary, args, options });
            return child;
        },
        cwd: '/tmp/project',
        stdout: { write() {} },
        stderr: { write() {} },
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].binary, 'ngrok');
    assert.deepEqual(calls[0].args, ['http', '8787', '--log=stdout', '--url=https://clover.ngrok.app']);
    assert.equal(calls[0].options.cwd, '/tmp/project');
    assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('configuracao cloudflare aceita tunel nomeado sem gravar segredo', () => {
    const config = buildCloudflaredConfig({
        CLOVER_SITE_API_PORT: '8787',
        CLOVER_CLOUDFLARED_BIN: 'C:\\cloudflared\\cloudflared.exe',
        CLOVER_CLOUDFLARED_TUNNEL: 'clover-rpg-site',
        CLOVER_CLOUDFLARED_PUBLIC_URL: 'clover-api.example.com',
    });

    assert.equal(config.provider, 'cloudflare');
    assert.equal(config.binary, 'C:\\cloudflared\\cloudflared.exe');
    assert.equal(config.publicUrl, 'https://clover-api.example.com');
    assert.deepEqual(config.args, ['tunnel', '--no-autoupdate', 'run', 'clover-rpg-site']);
    assert.equal(config.usesQuickTunnel, false);
    assert.equal(config.valid, true);
});

test('seletor de tunel preserva ngrok por padrao e permite cloudflare', () => {
    assert.equal(buildTunnelConfig({ CLOVER_SITE_API_PORT: '8787' }).provider, 'ngrok');
    assert.equal(buildTunnelConfig({
        CLOVER_TUNNEL_PROVIDER: 'cloudflare',
        CLOVER_SITE_API_PORT: '8787',
    }).provider, 'cloudflare');
});

test('cloudflared quick tunnel aponta para a API local sem exigir login', () => {
    const config = buildCloudflaredConfig({
        CLOVER_SITE_API_PORT: '8787',
    });
    const calls = [];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    const result = startCloudflared(config, {
        spawnProcess: (binary, args, options) => {
            calls.push({ binary, args, options });
            return child;
        },
        cwd: '/tmp/project',
        stdout: { write() {} },
        stderr: { write() {} },
    });

    assert.equal(result.ok, true);
    assert.equal(calls[0].binary, 'cloudflared');
    assert.deepEqual(calls[0].args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:8787']);
    assert.equal(calls[0].options.cwd, '/tmp/project');
});
