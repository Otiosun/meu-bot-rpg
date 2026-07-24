'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    applyAdminOperation,
    approveAdminOperation,
    createAdminOperation,
    simulateAdminOperation,
    undoAdminOperation,
} = require('../helpers/clover/adminOperationService');
const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const { getAdminPlayerTraitOverview } = require('../helpers/clover/adminPlayerTraitOverviewService');
const {
    createTraitTemplate,
    ensureAdminTraitSchema,
    getTraitTemplate,
} = require('../helpers/clover/adminTraitService');
const {
    normalizeOverridePayload,
} = require('../helpers/clover/adminTraitOverrideService');

const actor = { id: 'owner@lid', role: 'owner' };
const executors = getAdminOperationExecutors();

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            esquadrao TEXT,
            jogo_status TEXT,
            aptidao_comum TEXT,
            marca_comum TEXT,
            aptidao_rara TEXT,
            marca_rara TEXT,
            anomalia TEXT,
            historias_extras TEXT DEFAULT '[]',
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
    for (const [id, characterName] of [
        ['owner@lid', 'Owner'],
        ['a@lid', 'Aster'],
        ['b@lid', 'Beren'],
        ['legacy@lid', 'Legado'],
    ]) {
        await db.run(
            `INSERT INTO jogadores
             (id, personagem_nome, nome, jogo_status, aptidao_comum, canonical_player_id)
             VALUES (?, ?, ?, 'Liberado', NULL, ?)`,
            [id, characterName, characterName, id],
        );
    }
    await ensureAdminTraitSchema(db);
    return db;
}

async function runToApplied(db, input) {
    const created = await createAdminOperation(db, input, actor);
    await simulateAdminOperation(db, created.operation.code, actor, { executors });
    await approveAdminOperation(db, created.operation.code, actor);
    return applyAdminOperation(db, created.operation.code, actor, { executors });
}

async function assignBaseTrait(db, playerId, suffix) {
    return runToApplied(db, {
        title: `Atribuir base ${suffix}`,
        reason: 'Fixture de personalização individual',
        targets: [{ kind: 'player', playerId }],
        actions: [{ type: 'player.trait.assign', payload: { traitId: 'TR-BASE0001' } }],
        idempotencyKey: `override:assign:${suffix}`,
    });
}

test('personaliza um jogador sem alterar o catálogo nem outro jogador e desfaz exatamente', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await createTraitTemplate(db, {
        id: 'TR-BASE0001',
        name: 'Olhar Analítico',
        slotKey: 'aptidao_comum',
        description: 'Descrição global do sistema.',
        effectText: '+10% ao analisar pistas.',
        restrictionsText: 'Não ativa sem observação concreta.',
    }, { actorId: actor.id });
    await assignBaseTrait(db, 'a@lid', 'a');
    await assignBaseTrait(db, 'b@lid', 'b');

    const applied = await runToApplied(db, {
        title: 'Personalizar Olhar Analítico de Aster',
        reason: 'Variação narrativa exclusiva do personagem',
        targets: [{ kind: 'player', playerId: 'a@lid' }],
        actions: [{
            type: 'player.trait.customize',
            payload: {
                slotKey: 'aptidao_comum',
                override: {
                    name: 'Memória de Tinta',
                    description: 'Aster lê padrões pela memória de tinta.',
                    effectText: '+10% apenas ao comparar documentos já vistos.',
                    restrictionsText: 'Não funciona com informação inteiramente nova.',
                },
            },
        }],
        idempotencyKey: 'override:customize:a:1',
    });

    const a = await getAdminPlayerTraitOverview(db, 'a@lid');
    const b = await getAdminPlayerTraitOverview(db, 'b@lid');
    assert.equal(a.slots[0].personalized, true);
    assert.equal(a.slots[0].source, 'personalized');
    assert.equal(a.slots[0].value, 'Memória de Tinta');
    assert.equal(a.slots[0].trait.name, 'Memória de Tinta');
    assert.equal(a.slots[0].trait.description, 'Aster lê padrões pela memória de tinta.');
    assert.equal(a.slots[0].baseTrait.name, 'Olhar Analítico');
    assert.equal(a.slots[0].baseTrait.description, 'Descrição global do sistema.');
    assert.equal(b.slots[0].personalized, false);
    assert.equal(b.slots[0].value, 'Olhar Analítico');
    assert.equal(b.slots[0].trait.name, 'Olhar Analítico');
    assert.equal(b.slots[0].trait.description, 'Descrição global do sistema.');
    assert.equal((await getTraitTemplate(db, 'TR-BASE0001')).name, 'Olhar Analítico');
    assert.equal((await getTraitTemplate(db, 'TR-BASE0001')).description, 'Descrição global do sistema.');

    await undoAdminOperation(db, applied.operation.code, actor, { executors });
    const restored = await getAdminPlayerTraitOverview(db, 'a@lid');
    assert.equal(restored.slots[0].personalized, false);
    assert.equal(restored.slots[0].value, 'Olhar Analítico');
    assert.equal(restored.slots[0].trait.description, 'Descrição global do sistema.');
});

test('resolve registro legado pelo catálogo e cria vínculo somente ao personalizar', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await createTraitTemplate(db, {
        id: 'TR-BASE0001',
        name: 'Olhar Analítico',
        slotKey: 'aptidao_comum',
        description: 'Descrição recuperada pelo catálogo.',
    }, { actorId: actor.id });
    await db.run('UPDATE jogadores SET aptidao_comum = ? WHERE id = ?', ['Olhar Analítico', 'legacy@lid']);

    const before = await getAdminPlayerTraitOverview(db, 'legacy@lid');
    assert.equal(before.slots[0].source, 'catalog_match');
    assert.equal(before.slots[0].assignment, null);
    assert.equal(before.slots[0].trait.description, 'Descrição recuperada pelo catálogo.');

    const applied = await runToApplied(db, {
        title: 'Personalizar registro legado',
        reason: 'Conectar legado sem alterar o valor original',
        targets: [{ kind: 'player', playerId: 'legacy@lid' }],
        actions: [{
            type: 'player.trait.customize',
            payload: {
                slotKey: 'aptidao_comum',
                override: { description: 'Descrição exclusiva do registro legado.' },
            },
        }],
        idempotencyKey: 'override:legacy:1',
    });

    const customized = await getAdminPlayerTraitOverview(db, 'legacy@lid');
    assert.equal(customized.slots[0].personalized, true);
    assert.ok(customized.slots[0].assignment?.id);
    assert.equal(customized.slots[0].trait.description, 'Descrição exclusiva do registro legado.');
    assert.equal((await db.get('SELECT aptidao_comum FROM jogadores WHERE id = ?', ['legacy@lid'])).aptidao_comum, 'Olhar Analítico');

    await undoAdminOperation(db, applied.operation.code, actor, { executors });
    const restored = await getAdminPlayerTraitOverview(db, 'legacy@lid');
    assert.equal(restored.slots[0].assignment, null);
    assert.equal(restored.slots[0].source, 'catalog_match');
});

test('restaura o modelo e permite desfazer a restauração', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await createTraitTemplate(db, {
        id: 'TR-BASE0001',
        name: 'Olhar Analítico',
        slotKey: 'aptidao_comum',
        description: 'Base.',
    }, { actorId: actor.id });
    await assignBaseTrait(db, 'a@lid', 'reset');
    await runToApplied(db, {
        title: 'Personalizar antes de restaurar',
        reason: 'Fixture',
        targets: [{ kind: 'player', playerId: 'a@lid' }],
        actions: [{ type: 'player.trait.customize', payload: { slotKey: 'aptidao_comum', override: { name: 'Nome pessoal', description: 'Pessoal.' } } }],
        idempotencyKey: 'override:before-reset:1',
    });

    const reset = await runToApplied(db, {
        title: 'Restaurar modelo',
        reason: 'Remover personalização individual',
        targets: [{ kind: 'player', playerId: 'a@lid' }],
        actions: [{ type: 'player.trait.reset_override', payload: { slotKey: 'aptidao_comum' } }],
        idempotencyKey: 'override:reset:1',
    });
    const model = await getAdminPlayerTraitOverview(db, 'a@lid');
    assert.equal(model.slots[0].value, 'Olhar Analítico');
    assert.equal(model.slots[0].trait.description, 'Base.');

    await undoAdminOperation(db, reset.operation.code, actor, { executors });
    const restoredPersonalization = await getAdminPlayerTraitOverview(db, 'a@lid');
    assert.equal(restoredPersonalization.slots[0].personalized, true);
    assert.equal(restoredPersonalization.slots[0].value, 'Nome pessoal');
    assert.equal(restoredPersonalization.slots[0].trait.description, 'Pessoal.');
});

test('recusa imagem insegura no override', () => {
    assert.throws(
        () => normalizeOverridePayload({ override: { imageUrl: 'javascript:alert(1)' } }),
        { code: 'invalid_trait_override_image' },
    );
});
