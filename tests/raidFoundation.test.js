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

const {
    ensureCloverInventorySchema,
    ensureCloverRaidSchema,
    ensureCloverSquadSchema,
    ensureCloverYullsLedgerSchema,
} = require('../database');

Module._load = originalLoad;
Module._load = function loadRaidWithPhStub(request, parent, isMain) {
    if (request === './phService' && String(parent?.filename || '').endsWith('raidService.js')) {
        return {
            ensurePhState: async (db) => {
                await db.exec(`
                    CREATE TABLE IF NOT EXISTS test_raid_ph_awards (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        player_id TEXT NOT NULL,
                        amount INTEGER NOT NULL,
                        related_id TEXT DEFAULT NULL
                    )
                `);
            },
            addPhInTransaction: async (db, playerId, amount, source, reason, actor, metadata, relatedId) => {
                const inserted = await db.run(
                    'INSERT INTO test_raid_ph_awards (player_id, amount, related_id) VALUES (?, ?, ?)',
                    [playerId, amount, relatedId]
                );
                return { ledgerId: inserted.lastID, amount };
            },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const { assignAccessRole, ensureAccessControlSchema } = require('../helpers/clover/accessControlService');
const { addCatalogItem, getAvailableInventoryQuantity } = require('../helpers/clover/inventoryService');
const { createItemTemplate } = require('../helpers/clover/itemAdminService');
const { getYullsSummary } = require('../helpers/clover/yullsService');
const {
    RaidServiceError,
    addRaidCondition,
    addRaidHost,
    addRaidReward,
    applyRaidDurabilityLoss,
    beginRaidFinalization,
    cancelRaid,
    completeRaid,
    consumeRaidItem,
    createRaid,
    getRaidDashboard,
    getRaidParticipantDetail,
    joinRaid,
    leaveRaid,
    resolveRaidCondition,
    setRaidLoadoutSlot,
    startRaid,
} = require('../helpers/clover/raidService');

Module._load = originalLoad;

const IDS = Object.freeze({
    narrator: '5511111111111@s.whatsapp.net',
    coHost: '5522222222222@s.whatsapp.net',
    player1: '5533333333333@s.whatsapp.net',
    player2: '5544444444444@s.whatsapp.net',
    player3: '5555555555555@s.whatsapp.net',
});

async function createTestDb({ prepareRaidSchema = true } = {}) {
    const db = await createAsyncAdapter();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-', display_name TEXT DEFAULT '-', personagem_nome TEXT DEFAULT '-',
            personagem_idade INTEGER DEFAULT NULL, personagem_genero TEXT DEFAULT '-',
            personagem_aparencia TEXT DEFAULT '-', personagem_aparencia_status TEXT DEFAULT 'approved',
            personagem_aparencia_image_path TEXT DEFAULT NULL,
            site_profile_image_data TEXT DEFAULT NULL,
            reino TEXT DEFAULT 'Clover', classe TEXT DEFAULT '-', familia TEXT DEFAULT '-', raca TEXT DEFAULT 'Humano',
            grimorio TEXT DEFAULT '-', magia TEXT DEFAULT '-', formas TEXT DEFAULT '-', esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0, patente TEXT DEFAULT '-', aptidao_comum TEXT DEFAULT '-',
            aptidao_rara TEXT DEFAULT '-', marca_comum TEXT DEFAULT '-', marca_rara TEXT DEFAULT '-',
            anomalia TEXT DEFAULT '-', gancho_narrativo TEXT DEFAULT '-', historias_extras TEXT DEFAULT '[]', jogo_status TEXT DEFAULT 'liberado',
            dinheiro INTEGER DEFAULT 0
        );
        INSERT INTO jogadores (id, personagem_nome, esquadrao) VALUES
            ('${IDS.narrator}', 'Narrador', '-'),
            ('${IDS.coHost}', 'Co-Host', '-'),
            ('${IDS.player1}', 'Player Um', 'Coringas Magenta'),
            ('${IDS.player2}', 'Player Dois', 'Coringas Magenta'),
            ('${IDS.player3}', 'Player Três', '-');
    `);
    await ensureCloverInventorySchema(db);
    if (prepareRaidSchema) await ensureCloverRaidSchema(db);
    await ensureCloverYullsLedgerSchema(db);
    await ensureCloverSquadSchema(db);
    await ensureAccessControlSchema(db);
    await assignAccessRole(db, {
        subjectId: IDS.narrator,
        role: 'narrator',
        assignedBy: IDS.narrator,
        reason: 'teste',
    });
    await assignAccessRole(db, {
        subjectId: IDS.coHost,
        role: 'narrator',
        assignedBy: IDS.narrator,
        reason: 'teste',
    });
    return db;
}

test('criacao de raid prepara o schema ausente em banco legado', async (t) => {
    const db = await createTestDb({ prepareRaidSchema: false });
    t.after(() => db.close());

    const before = await db.get(
        "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'clover_raids'"
    );
    assert.equal(before.total, 0);

    const created = await createRaid(db, IDS.narrator, {
        name: 'Ruinas do Banco Legado',
        category: 'evento_especial',
        maxPlayers: 4,
    });
    const after = await db.get(
        "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'clover_raids'"
    );

    assert.equal(after.total, 1);
    assert.equal(created.raid.name, 'Ruinas do Banco Legado');
    assert.equal(created.raid.status, 'lobby');
});

test('preenche code quando o schema legado exige a coluna', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());

    await db.exec(
        "ALTER TABLE clover_raids " +
        "ADD COLUMN code TEXT NOT NULL DEFAULT ''"
    );

    const created = await createRaid(db, IDS.narrator, {
        name: 'Ru?nas do Schema Antigo',
        category: 'evento_especial',
        maxPlayers: 6,
    });

    const row = await db.get(
        'SELECT raid_key, code FROM clover_raids WHERE id = ?',
        [created.raid.id]
    );

    assert.equal(row.code, row.raid_key);
    assert.equal(row.code, created.raid.key);
});

test('somente narrador cria raid e o criador permanece owner principal', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());

    await assert.rejects(
        () => createRaid(db, IDS.player1, { name: 'Missão proibida' }),
        (error) => error instanceof RaidServiceError && error.code === 'narrator_required'
    );
    const created = await createRaid(db, IDS.narrator, {
        name: 'Ruínas da Capital',
        category: 'evento_especial',
        maxPlayers: 4,
    });
    await addRaidHost(db, created.raid.key, IDS.narrator, IDS.coHost);
    const dashboard = await getRaidDashboard(db, created.raid.key, IDS.narrator);

    assert.equal(created.raid.location, 'Capital de Clover');
    assert.equal(created.raid.category, 'evento_especial');
    assert.equal(dashboard.access.isPrincipalOwner, true);
    assert.deepEqual(dashboard.hosts.map((host) => host.role), ['owner', 'co_host']);
    await assert.rejects(
        () => cancelRaid(db, created.raid.key, IDS.coHost, 'Não posso'),
        (error) => error instanceof RaidServiceError && error.code === 'principal_owner_required'
    );
});

test('lobby reserva inventário atual e início congela novas entradas', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const created = await createRaid(db, IDS.narrator, { name: 'Escolta Real', category: 'evento_especial', maxPlayers: 3 });
    await addRaidHost(db, created.raid.key, IDS.narrator, IDS.coHost);
    await joinRaid(db, created.raid.key, IDS.player1);
    await joinRaid(db, created.raid.key, IDS.player2);
    const potion = await addCatalogItem(db, IDS.player1, 'pocao_cura_basica', 2, { source: 'teste' });
    const armor = await addCatalogItem(db, IDS.player1, 'armadura_couro', 1, { source: 'teste' });
    const staff = await addCatalogItem(db, IDS.player1, 'bastao', 1, { source: 'teste' });
    const shield = await addCatalogItem(db, IDS.player1, 'escudo_mao', 1, { source: 'teste' });

    await assert.rejects(
        () => setRaidLoadoutSlot(db, created.raid.key, IDS.player1, 'quick_1', {
            inventoryItemId: potion.items[0].id, quantity: 2,
        }),
        (error) => error instanceof RaidServiceError && error.code === 'quick_slot_quantity'
    );
    await setRaidLoadoutSlot(db, created.raid.key, IDS.player1, 'off_hand', {
        inventoryItemId: shield.items[0].id,
    });
    await assert.rejects(
        () => setRaidLoadoutSlot(db, created.raid.key, IDS.player1, 'main_hand', {
            inventoryItemId: staff.items[0].id,
        }),
        (error) => error instanceof RaidServiceError && error.code === 'two_handed_conflict'
    );
    await setRaidLoadoutSlot(db, created.raid.key, IDS.player1, 'off_hand', { inventoryItemId: null });

    const quick = await setRaidLoadoutSlot(db, created.raid.key, IDS.player1, 'quick_1', {
        inventoryItemId: potion.items[0].id,
        quantity: 1,
    });
    await setRaidLoadoutSlot(db, created.raid.key, IDS.player1, 'body', {
        inventoryItemId: armor.items[0].id,
        quantity: 1,
    });
    const availability = await getAvailableInventoryQuantity(db, IDS.player1, potion.items[0].id);
    assert.equal(availability.available, 1);
    assert.equal(quick.item.quantity, 1);

    const started = await startRaid(db, created.raid.key, IDS.coHost);
    assert.equal(started.raid.status, 'in_progress');
    await assert.rejects(
        () => joinRaid(db, created.raid.key, IDS.player3),
        (error) => error instanceof RaidServiceError && error.code === 'raid_already_started'
    );
    await assert.rejects(
        () => setRaidLoadoutSlot(db, created.raid.key, IDS.player1, 'quick_2', {
            inventoryItemId: potion.items[0].id,
        }),
        (error) => error instanceof RaidServiceError && error.code === 'loadout_locked'
    );

    const detail = await getRaidParticipantDetail(db, created.raid.key, IDS.coHost, IDS.player1);
    assert.equal(detail.profile.player.personagem_nome, 'Player Um');
    assert.equal(detail.loadout.length, 2);
});

test('saída após o início libera carga restante e exclui o player da recompensa', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const created = await createRaid(db, IDS.narrator, { name: 'Retirada Controlada', category: 'evento_especial' });
    await joinRaid(db, created.raid.key, IDS.player1);
    await joinRaid(db, created.raid.key, IDS.player2);
    const potion = await addCatalogItem(db, IDS.player1, 'pocao_cura_basica', 1, { source: 'teste' });
    await setRaidLoadoutSlot(db, created.raid.key, IDS.player1, 'quick_1', {
        inventoryItemId: potion.items[0].id, quantity: 1,
    });
    await startRaid(db, created.raid.key, IDS.narrator);
    await leaveRaid(db, created.raid.key, IDS.player1);
    assert.equal((await db.get('SELECT status FROM clover_raid_participants WHERE raid_id = ? AND player_id = ?', [created.raid.id, IDS.player1])).status, 'withdrawn');
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM clover_inventory_reservations WHERE source_type = 'raid' AND status = 'active'")).total, 0);

    await assert.rejects(
        () => addRaidReward(db, created.raid.key, IDS.narrator, { rewardType: 'yulls', amount: 20001 }),
        (error) => error instanceof RaidServiceError && error.code === 'invalid_reward_amount' && error.details.maximum === 20000
    );
    await addRaidReward(db, created.raid.key, IDS.narrator, { rewardType: 'yulls', amount: 2000 });
    await beginRaidFinalization(db, created.raid.key, IDS.narrator);
    const completed = await completeRaid(db, created.raid.key, IDS.narrator, { idempotencyKey: 'raid:withdrawal:complete' });
    assert.equal(completed.deliveries, 1);
    assert.equal((await getYullsSummary(db, IDS.player1)).balance, 0);
    assert.equal((await getYullsSummary(db, IDS.player2)).balance, 2000);
});

test('narrador registra consumo, desgaste e encerra recompensas uma única vez', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const created = await createRaid(db, IDS.narrator, { name: 'Defesa da Muralha', category: 'evento_especial' });
    await addRaidHost(db, created.raid.key, IDS.narrator, IDS.coHost);
    await joinRaid(db, created.raid.key, IDS.player1);
    await joinRaid(db, created.raid.key, IDS.player2);
    const potion = await addCatalogItem(db, IDS.player1, 'pocao_cura_basica', 2, { source: 'teste' });
    const armor = await addCatalogItem(db, IDS.player1, 'armadura_couro', 1, { source: 'teste' });
    const quick = await setRaidLoadoutSlot(db, created.raid.key, IDS.player1, 'quick_1', {
        inventoryItemId: potion.items[0].id,
        quantity: 1,
    });
    const body = await setRaidLoadoutSlot(db, created.raid.key, IDS.player1, 'body', {
        inventoryItemId: armor.items[0].id,
    });
    await startRaid(db, created.raid.key, IDS.coHost);

    const wear = await applyRaidDurabilityLoss(
        db,
        created.raid.key,
        IDS.coHost,
        body.item.id,
        2,
        'Impacto direto do inimigo',
        { idempotencyKey: 'raid:wear:one' }
    );
    const consumed = await consumeRaidItem(
        db,
        created.raid.key,
        IDS.coHost,
        quick.item.id,
        1,
        'Poção usada durante a defesa',
        { idempotencyKey: 'raid:consume:one' }
    );
    assert.equal(wear.item.durability_current, 3);
    assert.equal(consumed.item.quantityRemaining, 0);

    const condition = await addRaidCondition(db, created.raid.key, IDS.coHost, {
        targetType: 'player',
        targetPlayerId: IDS.player1,
        label: 'Atordoado',
        severity: 'seria',
        description: 'Condição imposta pelo impacto durante a missão.',
    });
    assert.equal(condition.condition.status, 'active');
    const resolved = await resolveRaidCondition(
        db,
        created.raid.key,
        IDS.coHost,
        condition.condition.id,
        'Recuperado após atendimento.'
    );
    assert.equal(resolved.condition.status, 'resolved');

    await addRaidReward(db, created.raid.key, IDS.coHost, {
        targetType: 'general', rewardType: 'yulls', amount: 2000, label: 'Pagamento da missão',
    });
    await addRaidReward(db, created.raid.key, IDS.coHost, {
        targetType: 'general', rewardType: 'stars', amount: 1, label: 'Mérito do esquadrão',
    });
    await addRaidReward(db, created.raid.key, IDS.coHost, {
        targetType: 'player', targetPlayerId: IDS.player1,
        rewardType: 'catalog_item', amount: 1, templateKey: 'box_simple_v1', label: 'Caixa exclusiva',
    });
    const customLoot = await createItemTemplate(db, IDS.narrator, {
        itemName: 'Fragmento da Muralha',
        description: 'Saque personalizado obtido durante a defesa.',
        category: 'material', basePrice: 1200, stackable: true,
        transferable: true, marketable: true, duplicable: true, requestable: true,
    });
    await addRaidReward(db, created.raid.key, IDS.coHost, {
        targetType: 'player', targetPlayerId: IDS.player2,
        rewardType: 'catalog_item', amount: 2, templateKey: customLoot.template.key, label: 'Saque da muralha',
    });
    await beginRaidFinalization(db, created.raid.key, IDS.coHost);
    const completed = await completeRaid(db, created.raid.key, IDS.coHost, {
        idempotencyKey: 'raid:complete:one',
    });
    const repeated = await completeRaid(db, created.raid.key, IDS.coHost, {
        idempotencyKey: 'raid:complete:one',
    });

    assert.equal(completed.deliveries, 6);
    assert.equal(repeated.duplicate, true);
    assert.equal((await getYullsSummary(db, IDS.player1)).balance, 2000);
    assert.equal((await getYullsSummary(db, IDS.player2)).balance, 2000);
    assert.equal((await db.get('SELECT estrelas FROM jogadores WHERE id = ?', [IDS.player1])).estrelas, 1);
    assert.equal((await db.get('SELECT estrelas FROM jogadores WHERE id = ?', [IDS.player2])).estrelas, 1);
    assert.equal((await db.get(
        "SELECT COUNT(*) AS total FROM clover_inventory_items WHERE player_id = ? AND template_key = 'box_simple_v1'",
        [IDS.player1]
    )).total, 1);
    assert.equal((await db.get(
        'SELECT quantity FROM clover_inventory_items WHERE player_id = ? AND template_key = ?',
        [IDS.player2, customLoot.template.key]
    )).quantity, 2);
    assert.equal((await db.get(
        "SELECT COUNT(*) AS total FROM clover_inventory_reservations WHERE source_type = 'raid' AND status = 'active'"
    )).total, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_raid_reward_deliveries')).total, 6);
});


test('participante abre a própria ficha sem acessar a ficha detalhada de outro jogador', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());

    const created = await createRaid(db, IDS.narrator, {
        name: 'Registro individual da raid', category: 'evento_especial',
        maxPlayers: 4,
    });
    await joinRaid(db, created.raid.key, IDS.player1);
    await joinRaid(db, created.raid.key, IDS.player2);

    const own = await getRaidParticipantDetail(
        db,
        created.raid.key,
        IDS.player1,
        IDS.player1
    );

    assert.equal(own.participant.playerId, IDS.player1);
    assert.equal(own.access.isSelf, true);
    assert.equal(own.access.isHost, false);
    assert.equal(own.hostRole, null);

    await assert.rejects(
        () => getRaidParticipantDetail(
            db,
            created.raid.key,
            IDS.player1,
            IDS.player2
        ),
        (error) => error instanceof RaidServiceError &&
            error.code === 'raid_participant_detail_forbidden'
    );
});
