'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
let createAsyncAdapter;
try {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    createAsyncAdapter = () => open({ filename: ':memory:', driver: sqlite3.Database });
} catch {
    const { DatabaseSync } = require('node:sqlite');
    Module._load = function loadSqliteFallback(request, parent, isMain) {
        if (request === 'sqlite3') return { verbose: () => ({ Database: class TestDriver {} }) };
        if (request === 'sqlite') return { open: async () => { throw new Error('open() não deve ser usado'); } };
        return originalLoad.call(this, request, parent, isMain);
    };
    createAsyncAdapter = async () => {
        const raw = new DatabaseSync(':memory:');
        return {
            exec: async (sql) => raw.exec(sql),
            run: async (sql, params = []) => {
                const result = raw.prepare(sql).run(...params);
                return { changes: Number(result.changes || 0), lastID: Number(result.lastInsertRowid || 0) };
            },
            get: async (sql, params = []) => raw.prepare(sql).get(...params),
            all: async (sql, params = []) => raw.prepare(sql).all(...params),
            close: async () => raw.close(),
        };
    };
}

const { ensureCloverEconomySchema } = require('../database');
Module._load = originalLoad;

const {
    applyAdminOperation,
    approveAdminOperation,
    createAdminOperation,
    simulateAdminOperation,
    undoAdminOperation,
} = require('../helpers/clover/adminOperationService');
const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const {
    createRewardPackage,
    getRewardPackage,
    listRewardGrants,
    listRewardPackages,
    normalizeRewardEntries,
} = require('../helpers/clover/adminRewardService');
const { getStructuredInventory } = require('../helpers/clover/inventoryService');
const { addYulls, getYullsSummary } = require('../helpers/clover/yullsService');
const { getPhSummary } = require('../helpers/clover/phService');

const OWNER = 'owner@lid';
const PLAYER = 'player@lid';
const actor = { id: OWNER, role: 'owner' };
const executors = getAdminOperationExecutors();

async function createDb() {
    const db = await createAsyncAdapter();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            personagem_idade INTEGER DEFAULT NULL,
            personagem_genero TEXT DEFAULT '-',
            personagem_aparencia TEXT DEFAULT '-',
            personagem_aparencia_status TEXT DEFAULT 'approved',
            personagem_aparencia_image_path TEXT DEFAULT NULL,
            site_profile_image_data TEXT DEFAULT NULL,
            reino TEXT DEFAULT 'Clover',
            classe TEXT DEFAULT '-',
            familia TEXT DEFAULT '-',
            raca TEXT DEFAULT 'Humano',
            grimorio TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            formas TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT 'Coringas Magenta',
            estrelas INTEGER DEFAULT 0,
            patente TEXT DEFAULT 'Júnior 2ª Classe',
            aptidao_comum TEXT DEFAULT '-',
            aptidao_rara TEXT DEFAULT '-',
            marca_comum TEXT DEFAULT '-',
            marca_rara TEXT DEFAULT '-',
            anomalia TEXT DEFAULT '-',
            gancho_narrativo TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'liberado',
            dinheiro INTEGER DEFAULT 0,
            canonical_player_id TEXT,
            merged_into TEXT,
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active'
        );

        CREATE TABLE clover_player_target_aliases (
            alias_key TEXT PRIMARY KEY,
            alias_label TEXT NOT NULL,
            player_id TEXT NOT NULL,
            alias_kind TEXT NOT NULL DEFAULT 'manual',
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        );

        CREATE TABLE clover_player_aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id_destino TEXT NOT NULL,
            alias_type TEXT NOT NULL,
            alias_value TEXT NOT NULL,
            source TEXT DEFAULT 'manual',
            confidence INTEGER DEFAULT 100,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(alias_type, alias_value)
        );
    `);
    await db.run(
        `INSERT INTO jogadores (id, nome, display_name, personagem_nome, dinheiro, canonical_player_id)
         VALUES (?, 'Owner', 'Owner', 'Administrador', 0, ?)`,
        [OWNER, OWNER]
    );
    await db.run(
        `INSERT INTO jogadores (id, nome, display_name, personagem_nome, dinheiro, canonical_player_id)
         VALUES (?, 'Jogador', 'Jogador', 'Edmund', 1000, ?)`,
        [PLAYER, PLAYER]
    );
    await ensureCloverEconomySchema(db);
    return db;
}

async function runToApplied(db, input) {
    const created = await createAdminOperation(db, input, actor);
    await simulateAdminOperation(db, created.operation.code, actor, { executors });
    await approveAdminOperation(db, created.operation.code, actor);
    return applyAdminOperation(db, created.operation.code, actor, { executors });
}

function operationInput(action, suffix, target = PLAYER) {
    return {
        title: `Operação de recompensa ${suffix}`,
        reason: 'Teste do módulo administrativo de Recompensas.',
        targets: [{ kind: 'player', playerId: target }],
        actions: [action],
        idempotencyKey: `reward:test:${suffix}`,
    };
}

test('normaliza somente tipos sustentados por ledgers e impede duplicações ambíguas', () => {
    assert.deepEqual(normalizeRewardEntries([
        { type: 'dinheiro', amount: 1000 },
        { type: 'pontos_habilidade', amount: 20 },
        { type: 'caixa', templateKey: 'box_simple_v1', quantity: 1 },
    ]), [
        { type: 'yulls', amount: 1000, label: 'Yulls' },
        { type: 'ph', amount: 20, label: 'PH fora do teto' },
        { type: 'item', templateKey: 'box_simple_v1', quantity: 1, label: null },
    ]);
    assert.throws(
        () => normalizeRewardEntries([{ type: 'pa', amount: 10 }]),
        { code: 'unsupported_reward_entry' },
    );
    assert.throws(
        () => normalizeRewardEntries([{ type: 'yulls', amount: 10 }, { type: 'yulls', amount: 20 }]),
        { code: 'duplicate_reward_resource' },
    );
});

test('cria e consulta pacote versionado', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const rewardPackage = await createRewardPackage(db, {
        id: 'RW-A1B2C3D4',
        canonicalKey: 'missao_de_teste',
        name: 'Missão de Teste',
        description: 'Pacote reutilizável para validar o fluxo.',
        entries: [
            { type: 'yulls', amount: 1000 },
            { type: 'ph', amount: 20 },
            { type: 'item', templateKey: 'kit_campo', quantity: 2 },
        ],
    }, { actorId: OWNER, operationCode: 'OP-A1B2C3' });

    assert.equal(rewardPackage.id, 'RW-A1B2C3D4');
    assert.equal(rewardPackage.entries.length, 3);
    assert.equal((await getRewardPackage(db, rewardPackage.id)).name, 'Missão de Teste');
    assert.equal((await listRewardPackages(db, { query: 'missão' })).packages.length, 1);
});

test('concede Yulls, PH e item atomicamente e desfaz pelo snapshot', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await createRewardPackage(db, {
        id: 'RW-11112222',
        name: 'Pacote Completo',
        entries: [
            { type: 'yulls', amount: 1000 },
            { type: 'ph', amount: 20 },
            { type: 'item', templateKey: 'kit_campo', quantity: 2 },
        ],
    }, { actorId: OWNER });

    const applied = await runToApplied(db, operationInput({
        type: 'reward.grant',
        payload: { packageId: 'RW-11112222' },
    }, 'grant-complete'));

    assert.equal(applied.operation.status, 'applied');
    assert.equal((await getYullsSummary(db, PLAYER)).balance, 2000);
    assert.equal((await getPhSummary(db, PLAYER)).phAvailable, 35);
    const inventory = await getStructuredInventory(db, PLAYER, { limit: 100 });
    const kit = inventory.find((item) => item.template_key === 'kit_campo');
    assert.equal(kit.quantity, 2);
    const grants = await listRewardGrants(db, { playerId: PLAYER, status: 'applied' });
    assert.equal(grants.grants.length, 1);
    assert.equal(grants.grants[0].effects.length, 3);

    const undone = await undoAdminOperation(db, applied.operation.code, actor, { executors });
    assert.equal(undone.operation.status, 'undone');
    assert.equal((await getYullsSummary(db, PLAYER)).balance, 1000);
    assert.equal((await getPhSummary(db, PLAYER)).phAvailable, 15);
    assert.equal((await getStructuredInventory(db, PLAYER, { limit: 100 })).some((item) => item.template_key === 'kit_campo'), false);
    assert.equal((await listRewardGrants(db, { playerId: PLAYER })).grants[0].status, 'undone');
});

test('rejeita pacote alterado depois da simulação', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await createRewardPackage(db, {
        id: 'RW-33334444',
        name: 'Pacote Mutável',
        entries: [{ type: 'yulls', amount: 100 }],
    }, { actorId: OWNER });

    const created = await createAdminOperation(db, operationInput({
        type: 'reward.grant',
        payload: { packageId: 'RW-33334444' },
    }, 'changed-after-preview'), actor);
    await simulateAdminOperation(db, created.operation.code, actor, { executors });
    await db.run(
        `UPDATE clover_reward_packages
         SET version = version + 1, entries_json = ?, updated_at = ?
         WHERE id = ?`,
        [JSON.stringify([{ type: 'yulls', amount: 999, label: 'Yulls' }]), new Date().toISOString(), 'RW-33334444']
    );
    await approveAdminOperation(db, created.operation.code, actor);
    const applied = await applyAdminOperation(db, created.operation.code, actor, { executors });
    assert.equal(applied.operation.status, 'failed');
    assert.equal(applied.operation.result.failedCount, 1);
    assert.equal((await getYullsSummary(db, PLAYER)).balance, 1000);
});

test('undo falha fechado após lançamento posterior e preserva todos os efeitos', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await createRewardPackage(db, {
        id: 'RW-55556666',
        name: 'Pacote Protegido',
        entries: [
            { type: 'yulls', amount: 500 },
            { type: 'ph', amount: 5 },
            { type: 'item', templateKey: 'kit_campo', quantity: 1 },
        ],
    }, { actorId: OWNER });
    const applied = await runToApplied(db, operationInput({
        type: 'reward.grant',
        payload: { packageId: 'RW-55556666' },
    }, 'safe-undo'));

    await addYulls(db, PLAYER, 50, 'teste_posterior', 'Outro lançamento legítimo', OWNER, {
        idempotencyKey: 'reward:test:later-yulls',
    });

    await assert.rejects(
        () => undoAdminOperation(db, applied.operation.code, actor, { executors }),
        { code: 'reward_yulls_changed_since_apply' },
    );
    assert.equal((await getYullsSummary(db, PLAYER)).balance, 1550);
    assert.equal((await getPhSummary(db, PLAYER)).phAvailable, 20);
    const inventory = await getStructuredInventory(db, PLAYER, { limit: 100 });
    assert.equal(inventory.find((item) => item.template_key === 'kit_campo').quantity, 1);
    assert.equal((await listRewardGrants(db, { playerId: PLAYER })).grants[0].status, 'applied');
});

test('pacote criado por OP pode ser desfeito antes de qualquer concessão', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const applied = await runToApplied(db, operationInput({
        type: 'catalog.reward.create',
        payload: {
            id: 'RW-77778888',
            name: 'Pacote Criado por OP',
            entries: [{ type: 'yulls', amount: 100 }],
        },
    }, 'catalog-create', OWNER));

    assert.equal((await getRewardPackage(db, 'RW-77778888')).name, 'Pacote Criado por OP');
    await undoAdminOperation(db, applied.operation.code, actor, { executors });
    await assert.rejects(() => getRewardPackage(db, 'RW-77778888'), { code: 'reward_package_not_found' });
});
