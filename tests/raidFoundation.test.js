'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensureCloverInventorySchema,
    ensureCloverRaidSchema,
    ensureCloverSquadSchema,
    ensureCloverYullsLedgerSchema,
} = require('../database');
const {
    assignAccessRole,
    ensureAccessControlSchema,
} = require('../helpers/clover/accessControlService');
const {
    addCatalogItem,
    getAvailableInventoryQuantity,
} = require('../helpers/clover/inventoryService');
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
    setRaidParticipantFinalization,
    startRaid,
} = require('../helpers/clover/raidService');

const IDS = Object.freeze({
    narrator: '5511111111111@s.whatsapp.net',
    coHost: '5522222222222@s.whatsapp.net',
    player1: '5533333333333@s.whatsapp.net',
    player2: '5544444444444@s.whatsapp.net',
    player3: '5555555555555@s.whatsapp.net',
});

async function createTestDb({ prepareRaidSchema = true } = {}) {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
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
            anomalia TEXT DEFAULT '-', gancho_narrativo TEXT DEFAULT '-', historias_extras TEXT DEFAULT '[]',
            jogo_status TEXT DEFAULT 'liberado', dinheiro INTEGER DEFAULT 0
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
    await db.run(
        `INSERT INTO clover_squads (squad_key, name)
         VALUES ('coringas_magenta', 'Coringas Magenta')`
    );
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

async function markEligible(db, raidKey, actorId, ...playerIds) {
    for (const playerId of playerIds) {
        await setRaidParticipantFinalization(db, raidKey, actorId, playerId, {
            status: 'eligible',
        });
    }
}

test('criação de raid prepara o schema ausente em banco legado', async (t) => {
    const db = await createTestDb({ prepareRaidSchema: false });
    t.after(() => db.close());

    const before = await db.get(
        "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'clover_raids'"
    );
    assert.equal(Number(before.total), 0);

    const created = await createRaid(db, IDS.narrator, {
        name: 'Ruínas do Banco Legado',
        category: 'evento_especial',
        maxPlayers: 4,
    });
    const after = await db.get(
        "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'clover_raids'"
    );

    assert.equal(Number(after.total), 1);
    assert.equal(created.raid.name, 'Ruínas do Banco Legado');
    assert.equal(created.raid.status, 'lobby');
});

test('preenche code quando o schema legado exige a coluna', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());

    await db.exec("ALTER TABLE clover_raids ADD COLUMN code TEXT NOT NULL DEFAULT ''");
    const created = await createRaid(db, IDS.narrator, {
        name: 'Ruínas do Schema Antigo',
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
        () => createRaid(db, IDS.player1, {
            name: 'Missão proibida',
            category: 'evento_especial',
        }),
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
    const created = await createRaid(db, IDS.narrator, {
        name: 'Escolta Real',
        category: 'evento_especial',
        maxPlayers: 3,
    });
    await addRaidHost(db, created.raid.key, IDS.narrator, IDS.coHost);
    await joinRaid(db, created.raid.key, IDS.player1);
    await joinRaid(db, created.raid.key, IDS.player2);
    const potion = await addCatalogItem(db, IDS.player1, 'pocao_cura_basica', 2, { source: 'teste' });
    const armor = await addCatalogItem(db, IDS.player1, 'armadura_couro', 1, { source: 'teste' });
    const staff = await addCatalogItem(db, IDS.player1, 'bastao', 1, { source: 'teste' });
    const shield = await addCatalogItem(db, IDS.player1, 'escudo_mao', 1, { source: 'teste' });

    await assert.rejects(
        () => setRaidLoadoutSlot(db, created.raid.key, IDS.player1, 'quick_1', {
            inventoryItemId: potion.items[0].id,
            quantity: 2,
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
    await setRaidLoadoutSlot(db, created.raid.key, IDS.player1, 'off_hand', {
        inventoryItemId: null,
    });

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

    const detail = await getRaidParticipantDetail(
        db,
        created.raid.key,
        IDS.coHost,
        IDS.player1
    );
    assert.equal(detail.profile.player.personagem_nome, 'Player Um');
    assert.equal(detail.loadout.length, 2);
});

test('saída após o início exclui o player e valores não têm teto arbitrário', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const created = await createRaid(db, IDS.narrator, {
        name: 'Retirada Controlada',
        category: 'evento_especial',
    });
    await joinRaid(db, created.raid.key, IDS.player1);
    await joinRaid(db, created.raid.key, IDS.player2);
    const potion = await addCatalogItem(db, IDS.player1, 'pocao_cura_basica', 1, { source: 'teste' });
    await setRaidLoadoutSlot(db, created.raid.key, IDS.player1, 'quick_1', {
        inventoryItemId: potion.items[0].id,
        quantity: 1,
    });
    await startRaid(db, created.raid.key, IDS.narrator);
    await leaveRaid(db, created.raid.key, IDS.player1);

    assert.equal((await db.get(
        'SELECT status FROM clover_raid_participants WHERE raid_id = ? AND player_id = ?',
        [created.raid.id, IDS.player1]
    )).status, 'withdrawn');
    assert.equal(Number((await db.get(
        "SELECT COUNT(*) AS total FROM clover_inventory_reservations WHERE source_type = 'raid' AND status = 'active'"
    )).total), 0);

    await addRaidReward(db, created.raid.key, IDS.narrator, {
        rewardType: 'yulls',
        amount: 250000,
        label: 'Valor definido pelo narrador',
    });
    await beginRaidFinalization(db, created.raid.key, IDS.narrator);
    await markEligible(db, created.raid.key, IDS.narrator, IDS.player2);
    const completed = await completeRaid(db, created.raid.key, IDS.narrator, {
        idempotencyKey: 'raid:withdrawal:complete',
    });

    assert.equal(completed.deliveries, 1);
    assert.equal((await getYullsSummary(db, IDS.player1)).balance, 0);
    assert.equal((await getYullsSummary(db, IDS.player2)).balance, 250000);
});

test('narrador registra consumo, desgaste e encerra premiação revisada uma única vez', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());
    const created = await createRaid(db, IDS.narrator, {
        name: 'Defesa da Muralha',
        category: 'evento_especial',
    });
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
        targetType: 'general',
        rewardType: 'yulls',
        amount: 2000,
        label: 'Pagamento da missão',
    });
    await addRaidReward(db, created.raid.key, IDS.coHost, {
        targetType: 'general',
        rewardType: 'stars',
        amount: 1,
        label: 'Mérito do esquadrão',
    });
    await addRaidReward(db, created.raid.key, IDS.coHost, {
        targetType: 'player',
        targetPlayerId: IDS.player1,
        rewardType: 'box',
        boxKey: 'simples',
        amount: 1,
        label: 'Caixa exclusiva',
    });
    const customLoot = await createItemTemplate(db, IDS.narrator, {
        itemName: 'Fragmento da Muralha',
        description: 'Saque personalizado obtido durante a defesa.',
        category: 'material',
        basePrice: 1200,
        stackable: true,
        transferable: true,
        marketable: true,
        duplicable: true,
        requestable: true,
    });
    await addRaidReward(db, created.raid.key, IDS.coHost, {
        targetType: 'player',
        targetPlayerId: IDS.player2,
        rewardType: 'catalog_item',
        amount: 2,
        templateKey: customLoot.template.key,
        label: 'Saque da muralha',
    });

    await beginRaidFinalization(db, created.raid.key, IDS.coHost);
    await markEligible(
        db,
        created.raid.key,
        IDS.coHost,
        IDS.player1,
        IDS.player2
    );
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
    assert.equal(Number((await db.get(
        'SELECT estrelas FROM jogadores WHERE id = ?',
        [IDS.player1]
    )).estrelas), 1);
    assert.equal(Number((await db.get(
        'SELECT estrelas FROM jogadores WHERE id = ?',
        [IDS.player2]
    )).estrelas), 1);
    assert.equal(Number((await db.get(
        "SELECT COALESCE(SUM(quantity), 0) AS total FROM clover_inventory_items WHERE player_id = ? AND template_key = 'box_simple_v1'",
        [IDS.player1]
    )).total), 1);
    assert.equal(Number((await db.get(
        'SELECT quantity FROM clover_inventory_items WHERE player_id = ? AND template_key = ?',
        [IDS.player2, customLoot.template.key]
    )).quantity), 2);
    assert.equal(Number((await db.get(
        "SELECT COUNT(*) AS total FROM clover_inventory_reservations WHERE source_type = 'raid' AND status = 'active'"
    )).total), 0);
    assert.equal(Number((await db.get(
        'SELECT COUNT(*) AS total FROM clover_raid_reward_deliveries'
    )).total), 6);
});

test('participante abre a própria ficha sem acessar a ficha detalhada de outro jogador', async (t) => {
    const db = await createTestDb();
    t.after(() => db.close());

    const created = await createRaid(db, IDS.narrator, {
        name: 'Registro individual da raid',
        category: 'evento_especial',
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
        (error) => error instanceof RaidServiceError
            && error.code === 'raid_participant_detail_forbidden'
    );
});
