'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { EventEmitter } = require('events');

const {
    DEFAULT_CLOVER_SITE_URL,
    getPublicSiteUrl,
    migrateCustomMessageSiteUrls,
    normalizePublicSiteUrl,
    replaceLegacySiteUrls,
} = require('../helpers/clover/sitePublicUrl');
const {
    DEFAULT_NGROK_URL,
    buildStackEnv,
    healthUrl,
    startCloverSiteStack,
    waitForHealth,
} = require('../scripts/startCloverSiteStack');

test('URL publica padrao aponta para a producao final', () => {
    assert.equal(getPublicSiteUrl({}), DEFAULT_CLOVER_SITE_URL);
    assert.equal(normalizePublicSiteUrl('clover-multicolor.vercel.app'), DEFAULT_CLOVER_SITE_URL);
});

test('links antigos do Lovable e previews sao substituidos', () => {
    const text = [
        'https://black-clover-multicolor.lovable.app/',
        'https://clover-multicolor.lovable.app',
        'https://clover-multicolor-git-main-usuario.vercel.app/',
    ].join('\n');
    const migrated = replaceLegacySiteUrls(text);
    assert.equal((migrated.match(/https:\/\/clover-multicolor\.vercel\.app\//g) || []).length, 3);
    assert(!migrated.includes('lovable.app'));
    assert(!migrated.includes('git-main'));
});

test('mensagens personalizadas locais sao migradas sem perder estrutura', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-site-url-'));
    const filePath = path.join(dir, 'custom-messages.json');
    fs.writeFileSync(filePath, JSON.stringify({
        recepcao: { text: 'Entre em https://black-clover-multicolor.lovable.app/' },
        nested: ['https://clover-multicolor.lovable.app'],
    }), 'utf8');

    const result = migrateCustomMessageSiteUrls({ filePath, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    const saved = fs.readFileSync(filePath, 'utf8');
    assert(saved.includes(DEFAULT_CLOVER_SITE_URL));
    assert(!saved.includes('lovable.app'));
});

test('stack forca API e tunel no mesmo ambiente e dominio', () => {
    const env = buildStackEnv({});
    assert.equal(env.CLOVER_SITE_API_ENABLED, '1');
    assert.equal(env.CLOVER_SITE_API_PORT, '8787');
    assert.equal(env.CLOVER_NGROK_TARGET_PORT, '8787');
    assert.equal(env.CLOVER_NGROK_URL, DEFAULT_NGROK_URL);
    assert.equal(healthUrl(env), 'http://127.0.0.1:8787/health');
});

test('waitForHealth so libera depois da API responder', async () => {
    let attempts = 0;
    const ready = await waitForHealth('http://local/health', {
        timeoutMs: 500,
        intervalMs: 1,
        check: async () => {
            attempts += 1;
            return attempts === 3;
        },
    });
    assert.equal(ready, true);
    assert.equal(attempts, 3);
});

function fakeChild() {
    const child = new EventEmitter();
    child.killed = false;
    child.killCalls = [];
    child.kill = (signal) => {
        child.killed = true;
        child.killCalls.push(signal);
        child.emit('exit', 0, signal);
        return true;
    };
    return child;
}

test('stack inicia ngrok somente depois do health local', async () => {
    const events = [];
    const botChild = fakeChild();
    const ngrokChild = fakeChild();

    const stack = await startCloverSiteStack({
        env: {},
        cwd: process.cwd(),
        registerSignals: false,
        setProcessExitCode: false,
        stdout: { write(text) { events.push(`out:${text}`); } },
        stderr: { write(text) { events.push(`err:${text}`); } },
        spawnProcess: () => {
            events.push('bot');
            return botChild;
        },
        waitForHealthFn: async () => {
            events.push('health');
            return true;
        },
        startNgrokFn: () => {
            events.push('ngrok');
            return { ok: true, child: ngrokChild };
        },
    });

    assert.deepEqual(events.filter((item) => ['bot', 'health', 'ngrok'].includes(item)), ['bot', 'health', 'ngrok']);
    stack.cleanup();
});

test('stack reinicia ngrok se o tunel cair enquanto o bot segue ativo', async () => {
    const botChild = fakeChild();
    const tunnels = [fakeChild(), fakeChild()];
    let starts = 0;

    const stack = await startCloverSiteStack({
        env: {},
        cwd: process.cwd(),
        registerSignals: false,
        setProcessExitCode: false,
        ngrokRestartDelayMs: 1,
        stdout: { write() {} },
        stderr: { write() {} },
        spawnProcess: () => botChild,
        waitForHealthFn: async () => true,
        startNgrokFn: () => ({ ok: true, child: tunnels[starts++] || fakeChild() }),
    });

    tunnels[0].emit('exit', 1, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(starts, 2);
    assert.equal(stack.ngrokChild, tunnels[1]);
    stack.cleanup();
});

test('stack encerra ngrok quando o bot encerra', async () => {
    const botChild = fakeChild();
    const ngrokChild = fakeChild();

    await startCloverSiteStack({
        env: {},
        cwd: process.cwd(),
        registerSignals: false,
        setProcessExitCode: false,
        stdout: { write() {} },
        stderr: { write() {} },
        spawnProcess: () => botChild,
        waitForHealthFn: async () => true,
        startNgrokFn: () => ({ ok: true, child: ngrokChild }),
    });

    botChild.emit('exit', 0, null);
    assert.equal(ngrokChild.killed, true);
    assert.deepEqual(ngrokChild.killCalls, ['SIGTERM']);
});
