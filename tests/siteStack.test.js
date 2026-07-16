'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

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
    waitForHealth,
} = require('../scripts/startCloverSiteStack');

test('URL pública padrão aponta para a produção final', () => {
    assert.equal(getPublicSiteUrl({}), DEFAULT_CLOVER_SITE_URL);
    assert.equal(normalizePublicSiteUrl('clover-multicolor.vercel.app'), DEFAULT_CLOVER_SITE_URL);
});

test('links antigos do Lovable e previews são substituídos', () => {
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

test('mensagens personalizadas locais são migradas sem perder estrutura', () => {
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

test('stack força API e túnel no mesmo ambiente e domínio', () => {
    const env = buildStackEnv({});
    assert.equal(env.CLOVER_SITE_API_ENABLED, '1');
    assert.equal(env.CLOVER_SITE_API_PORT, '8787');
    assert.equal(env.CLOVER_NGROK_TARGET_PORT, '8787');
    assert.equal(env.CLOVER_NGROK_URL, DEFAULT_NGROK_URL);
    assert.equal(healthUrl(env), 'http://127.0.0.1:8787/health');
});

test('waitForHealth só libera depois da API responder', async () => {
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
