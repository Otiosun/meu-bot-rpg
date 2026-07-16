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
    executableAvailable,
    healthUrl,
    startCloverSiteStack,
    waitForChildSpawn,
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

test('executavel explicito precisa existir e comando precisa ser encontrado no PATH', () => {
    assert.equal(executableAvailable('C:\\ngrok\\ngrok.exe', {
        existsSync: (value) => value === 'C:\\ngrok\\ngrok.exe',
        platform: 'win32',
    }), true);
    assert.equal(executableAvailable('C:\\ausente\\ngrok.exe', {
        existsSync: () => false,
        platform: 'win32',
    }), false);
    assert.equal(executableAvailable('ngrok', {
        platform: 'win32',
        spawnSyncProcess: (command, args) => ({
            status: command === 'where.exe' && args[0] === 'ngrok' ? 0 : 1,
        }),
    }), true);
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

function baseStackOptions(overrides = {}) {
    return {
        env: {},
        cwd: process.cwd(),
        registerSignals: false,
        setProcessExitCode: false,
        stdout: { write() {} },
        stderr: { write() {} },
        checkHealthFn: async () => false,
        executableAvailableFn: () => true,
        waitForNgrokStartFn: async () => true,
        ...overrides,
    };
}

test('waitForChildSpawn rejeita ENOENT antes de declarar o tunel online', async () => {
    const child = fakeChild();
    const waiting = waitForChildSpawn(child, { timeoutMs: 100 });
    const error = new Error('spawn ngrok ENOENT');
    error.code = 'ENOENT';
    queueMicrotask(() => child.emit('error', error));
    await assert.rejects(waiting, /ENOENT/);
});

test('stack recusa porta 8787 ocupada antes de abrir outro bot', async () => {
    let spawned = false;
    await assert.rejects(
        startCloverSiteStack(baseStackOptions({
            checkHealthFn: async () => true,
            spawnProcess: () => {
                spawned = true;
                return fakeChild();
            },
        })),
        /porta 8787 já está em uso/i,
    );
    assert.equal(spawned, false);
});

test('stack recusa ngrok ausente antes de abrir o bot', async () => {
    let spawned = false;
    await assert.rejects(
        startCloverSiteStack(baseStackOptions({
            executableAvailableFn: () => false,
            spawnProcess: () => {
                spawned = true;
                return fakeChild();
            },
        })),
        /não encontrei o executável do ngrok/i,
    );
    assert.equal(spawned, false);
});

test('stack inicia ngrok somente depois do health local e da confirmacao de spawn', async () => {
    const events = [];
    const botChild = fakeChild();
    const ngrokChild = fakeChild();

    const stack = await startCloverSiteStack(baseStackOptions({
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
        waitForNgrokStartFn: async () => {
            events.push('ngrok-spawn');
            return true;
        },
    }));

    assert.deepEqual(
        events.filter((item) => ['bot', 'health', 'ngrok', 'ngrok-spawn'].includes(item)),
        ['bot', 'health', 'ngrok', 'ngrok-spawn'],
    );
    const onlineIndex = events.findIndex((item) => item.includes('Stack online'));
    const spawnIndex = events.indexOf('ngrok-spawn');
    assert(onlineIndex > spawnIndex);
    stack.cleanup();
});

test('stack reinicia ngrok se o tunel cair enquanto o bot segue ativo', async () => {
    const botChild = fakeChild();
    const tunnels = [fakeChild(), fakeChild()];
    let starts = 0;

    const stack = await startCloverSiteStack(baseStackOptions({
        ngrokRestartDelayMs: 1,
        spawnProcess: () => botChild,
        waitForHealthFn: async () => true,
        startNgrokFn: () => ({ ok: true, child: tunnels[starts++] || fakeChild() }),
    }));

    tunnels[0].emit('exit', 1, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(starts, 2);
    assert.equal(stack.ngrokChild, tunnels[1]);
    stack.cleanup();
});

test('stack encerra ngrok quando o bot encerra', async () => {
    const botChild = fakeChild();
    const ngrokChild = fakeChild();

    await startCloverSiteStack(baseStackOptions({
        spawnProcess: () => botChild,
        waitForHealthFn: async () => true,
        startNgrokFn: () => ({ ok: true, child: ngrokChild }),
    }));

    botChild.emit('exit', 0, null);
    assert.equal(ngrokChild.killed, true);
    assert.deepEqual(ngrokChild.killCalls, ['SIGTERM']);
});
