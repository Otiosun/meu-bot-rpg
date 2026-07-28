'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    createRewardPackage,
    ensureAdminRewardSchema,
} = require('../helpers/clover/adminRewardService');
const {
    handleAdminRewardsReadApi,
    isAdminRewardsPath,
    parseRewardDetailPath,
} = require('../helpers/clover/adminRewardsReadApi');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            jogo_status TEXT,
            dinheiro INTEGER DEFAULT 0,
            canonical_player_id TEXT,
            merged_into TEXT,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active'
        );
        INSERT INTO jogadores
        (id, personagem_nome, nome, jogo_status, dinheiro, canonical_player_id)
        VALUES ('owner@lid', 'Administrador', 'Owner', 'Liberado', 0, 'owner@lid');
        INSERT INTO jogadores
        (id, personagem_nome, nome, jogo_status, dinheiro, canonical_player_id)
        VALUES ('player@lid', 'Edmund', 'Jogador', 'Liberado', 0, 'player@lid');
    `);
    await ensureAdminRewardSchema(db);
    return db;
}

function fakeResponse() {
    return {
        statusCode: 0,
        headers: {},
        body: '',
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        end(value = '') { this.body = String(value); },
    };
}

async function request(db, url, options = {}) {
    const req = {
        method: options.method || 'GET',
        url,
        headers: { authorization: 'Bearer test-token', origin: 'https://example.test' },
    };
    const res = fakeResponse();
    const handled = await handleAdminRewardsReadApi(req, res, {
        getDb: () => db,
        authenticateSession: async () => ({ ok: true, player: { id: 'owner@lid' } }),
        accessResolver: async () => ({
            ok: true,
            actor: { id: 'owner@lid', capabilities: options.capabilities || ['catalog.view', 'catalog.manage.rewards'] },
        }),
    });
    return { handled, status: res.statusCode, body: JSON.parse(res.body || '{}'), headers: res.headers };
}

test('reconhece somente rotas administrativas de Recompensas', () => {
    assert.equal(isAdminRewardsPath('/admin/rewards'), true);
    assert.equal(isAdminRewardsPath('/admin/rewards/grants'), true);
    assert.equal(isAdminRewardsPath('/admin/rewards/RW-ABCDEF12'), true);
    assert.equal(isAdminRewardsPath('/admin/hooks'), false);
    assert.equal(parseRewardDetailPath('/admin/rewards/RW-ABCDEF12'), 'RW-ABCDEF12');
    assert.equal(parseRewardDetailPath('/admin/rewards/grants'), null);
});

test('lista catálogo, detalhe e concessões auditáveis', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const rewardPackage = await createRewardPackage(db, {
        id: 'RW-ABCDEF12',
        name: 'Pacote da Capital',
        description: 'Recompensa consolidada de missão.',
        entries: [{ type: 'yulls', amount: 1000 }],
    }, { actorId: 'owner@lid' });
    await db.run(
        `INSERT INTO clover_reward_grants
         (grant_key, package_id, package_version, player_id, operation_code, status,
          effects_json, metadata_json, granted_by, granted_at)
         VALUES (?, ?, 1, ?, 'OP-ABC123', 'applied', ?, '{}', 'owner@lid', ?)`,
        [
            'OP-ABC123:unit:1:reward-grant',
            rewardPackage.id,
            'player@lid',
            JSON.stringify([{ type: 'yulls', amount: 1000 }]),
            new Date().toISOString(),
        ]
    );

    const list = await request(db, '/admin/rewards?q=capital&limit=20');
    assert.equal(list.handled, true);
    assert.equal(list.status, 200);
    assert.equal(list.body.packages.length, 1);
    assert.equal(list.body.packages[0].id, rewardPackage.id);
    assert.deepEqual(list.body.supportedEntryTypes, ['yulls', 'ph', 'item']);
    assert.equal(list.headers['cache-control'], 'private, no-store, max-age=0');

    const detail = await request(db, `/admin/rewards/${rewardPackage.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.package.name, 'Pacote da Capital');

    const grants = await request(db, '/admin/rewards/grants?playerId=player%40lid&status=applied');
    assert.equal(grants.status, 200);
    assert.equal(grants.body.grants.length, 1);
    assert.equal(grants.body.grants[0].characterName, 'Edmund');
    assert.equal(grants.body.grants[0].packageName, 'Pacote da Capital');
});

test('nega leitura sem catalog.view e rejeita método de escrita', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const forbidden = await request(db, '/admin/rewards', { capabilities: ['reward.grant'] });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error, 'missing_capability');

    const method = await request(db, '/admin/rewards', { method: 'POST' });
    assert.equal(method.status, 405);
    assert.equal(method.body.error, 'method_not_allowed');
});
