'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const { runCloverSchemaMigrations } = require('../helpers/clover/schemaMigrationService');
const {
    PRERESET_CHARACTER_LAUNCH_MIGRATION,
    PRERESET_CHARACTER_LAUNCH_OBJECTS,
    inspectPreResetCharacterLaunchSchemaState,
} = require('../helpers/clover/schemaMigrationCatalog');
const {
    PreResetCharacterError,
    applyFutureCharacterMutation,
    getFutureCharacter,
    reviewFutureCharacter,
} = require('../helpers/clover/preResetCharacterService');
const {
    ReturnPointsServiceError,
    creditReturnPoints,
    debitReturnPoints,
    getReturnPointsBalance,
} = require('../helpers/clover/returnPointsService');
const {
    claimReturnPointConversion,
    previewReturnPointConversion,
    reconcileReturnPointConversions,
} = require('../helpers/clover/returnPointConversionService');
const { addPh, getPhHistory } = require('../helpers/clover/phService');
const {
    PreResetShopError,
    getPreResetEntitlements,
    purchasePreResetEntitlement,
} = require('../helpers/clover/preResetShopService');
const {
    PreResetAccessError,
    assertPreResetAdminCapability,
    assertPreResetMutationAllowed,
    isPreResetLaunchEnabled,
} = require('../helpers/clover/preResetAccessService');
const { createPreResetPolicyRegistry } = require('../helpers/clover/preResetPolicyRegistryService');

function testPolicyRegistry() {
    return createPreResetPolicyRegistry({ testOnly: true, policies: {
        PRE_RESET_MODE: { status: 'ENABLED', policyVersion: 'fixture-mode-v1' },
        SESSION_ELIGIBILITY: { status: 'ENABLED', policyVersion: 'fixture-eligibility-v1', eligibleReleasedSessions: true },
    } });
}

function enabledEnv() {
    return { PRE_RESET_LAUNCH_ENABLED: 'true', PRE_RESET_RETURN_ENABLED: 'true' };
}

function temporaryFilename() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-prereset-foundation-'));
    return path.join(dir, 'database.sqlite');
}

async function openFixture(t) {
    const filename = temporaryFilename();
    const db = await database.criarBanco({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });
    await db.run(
        `INSERT INTO jogadores (id, nome, raca, dinheiro, jogo_status)
         VALUES ('future-player', 'Future', 'Humano ativo', 77, 'bloqueado')`
    );
    return db;
}

function validDraft(overrides = {}) {
    return {
        name: 'Personagem Futuro',
        age: 18,
        gender: 'Feminino',
        appearance: 'Cabelo escuro e olhos verdes.',
        rollNumber: 1,
        familyKey: null,
        magicKey: null,
        entitlementKeys: [],
        ...overrides,
    };
}

test('0029 e formal, repetivel e falha fechado para shape parcial', async (t) => {
    const filename = temporaryFilename();
    const db = await openCloverDatabase({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });
    const first = await runCloverSchemaMigrations(db, { migrations: [PRERESET_CHARACTER_LAUNCH_MIGRATION] });
    assert.equal(first.latestVersion, 29);
    assert.equal((await inspectPreResetCharacterLaunchSchemaState(db)).kind, 'exact');
    const second = await runCloverSchemaMigrations(db, { migrations: [PRERESET_CHARACTER_LAUNCH_MIGRATION] });
    assert.equal(second.appliedCount, 0);

    const partialFilename = path.join(path.dirname(filename), 'partial.sqlite');
    const partial = await openCloverDatabase({ filename: partialFilename });
    await partial.exec(PRERESET_CHARACTER_LAUNCH_OBJECTS[0].sql);
    await assert.rejects(
        runCloverSchemaMigrations(partial, { migrations: [PRERESET_CHARACTER_LAUNCH_MIGRATION] }),
        (error) => error?.code === 'prereset_character_launch_schema_mapping_required'
    );
    await partial.close();
});

test('personagem futuro usa revisao, idempotencia e nunca altera ficha ativa', async (t) => {
    const db = await openFixture(t);
    const activeBefore = await db.get('SELECT raca, dinheiro, jogo_status FROM jogadores WHERE id = ?', ['future-player']);
    const created = await applyFutureCharacterMutation(db, 'future-player', 'future-player', {
        operationType: 'create', expectedRevision: 0, operationKey: 'future-create-0001', draft: validDraft(),
    });
    assert.equal(created.character.status, 'draft');
    assert.equal(created.character.revision, 1);
    const duplicate = await applyFutureCharacterMutation(db, 'future-player', 'future-player', {
        operationType: 'create', expectedRevision: 0, operationKey: 'future-create-0001', draft: validDraft(),
    });
    assert.equal(duplicate.duplicate, true);
    const updated = await applyFutureCharacterMutation(db, 'future-player', 'future-player', {
        operationType: 'update', expectedRevision: 1, operationKey: 'future-update-0001', draft: validDraft({ name: 'Outro Futuro' }),
    });
    assert.equal(updated.character.revision, 2);
    await assert.rejects(
        applyFutureCharacterMutation(db, 'future-player', 'future-player', {
            operationType: 'update', expectedRevision: 1, operationKey: 'future-stale-0001', draft: validDraft(),
        }),
        (error) => error instanceof PreResetCharacterError && error.code === 'revision_conflict'
    );
    const submitted = await applyFutureCharacterMutation(db, 'future-player', 'future-player', {
        submit: true, expectedRevision: 2, operationKey: 'future-submit-0001', draft: validDraft({ name: 'Outro Futuro' }),
    });
    assert.equal(submitted.character.status, 'submitted');
    await assert.rejects(
        applyFutureCharacterMutation(db, 'future-player', 'future-player', {
            operationType: 'update', expectedRevision: 3, operationKey: 'future-after-submit-0001', draft: validDraft(),
        }),
        (error) => error?.code === 'character_not_editable'
    );
    await assert.rejects(
        reviewFutureCharacter(db, { env: {}, capabilities: ['prereset.review'], actorId: 'admin-fixture' }, {
            playerId: 'future-player', expectedRevision: 3, action: 'approve', reason: 'Revisao fixture', operationKey: 'future-approve-0001',
        }),
        (error) => error?.code === 'prereset_mode_disabled'
    );
    const approved = await reviewFutureCharacter(db, {
        env: enabledEnv(), policyRegistry: testPolicyRegistry(), capabilities: ['prereset.review'], actorId: 'admin-fixture',
    }, {
        playerId: 'future-player', expectedRevision: 3, action: 'approve', reason: 'Revisao fixture', operationKey: 'future-approve-0001',
    });
    assert.equal(approved.character.status, 'approved');
    const locked = await reviewFutureCharacter(db, {
        env: enabledEnv(), policyRegistry: testPolicyRegistry(), capabilities: ['prereset.review'], actorId: 'admin-fixture',
    }, {
        playerId: 'future-player', expectedRevision: 4, action: 'lock', reason: 'Lock fixture', operationKey: 'future-lock-0001',
    });
    assert.equal(locked.character.status, 'locked');
    await assert.rejects(
        applyFutureCharacterMutation(db, 'future-player', 'future-player', {
            operationType: 'create', expectedRevision: 0, operationKey: 'future-invalid-0001', draft: validDraft({ age: 10 }),
        }),
        (error) => error?.code === 'invalid_draft'
    );
    assert.deepEqual(await db.get('SELECT raca, dinheiro, jogo_status FROM jogadores WHERE id = ?', ['future-player']), activeBefore);
    assert.equal((await getFutureCharacter(db, 'future-player')).status, 'locked');
});

test('Return Points sao ledger independente, idempotente e nao toca Recruitment PR', async (t) => {
    const db = await openFixture(t);
    const credit = await creditReturnPoints(db, 'future-player', 12, {
        operationKey: 'return-credit-0001', source: 'fixture', reason: 'Credito fixture', createdBy: 'system',
    });
    assert.equal(credit.balanceAfter, 12);
    const replay = await creditReturnPoints(db, 'future-player', 12, {
        operationKey: 'return-credit-0001', source: 'fixture', reason: 'Credito fixture', createdBy: 'system',
    });
    assert.equal(replay.duplicate, true);
    const debit = await debitReturnPoints(db, 'future-player', 5, {
        operationKey: 'return-debit-0001', source: 'fixture', reason: 'Debito fixture', createdBy: 'system',
    });
    assert.equal(debit.balanceAfter, 7);
    await assert.rejects(
        debitReturnPoints(db, 'future-player', 8, {
            operationKey: 'return-debit-0002', source: 'fixture', reason: 'Excede saldo', createdBy: 'system',
        }),
        (error) => error instanceof ReturnPointsServiceError && error.code === 'insufficient_return_points'
    );
    assert.equal(await getReturnPointsBalance(db, 'future-player'), 7);
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_pr_ledger WHERE player_id = ?', ['future-player'])).total, 0);
});

test('conversao usa snapshot do ledger PH e politica desativada nao emite nem consome', async (t) => {
    const db = await openFixture(t);
    await addPh(db, 'future-player', 5, 'fixture', 'PH fixture', 'system');
    const before = await getPhHistory(db, 'future-player', 100);
    const first = await previewReturnPointConversion(db, 'future-player', { policyVersion: 'future-v1', resetCycleKey: 'cycle-v1' });
    const second = await previewReturnPointConversion(db, 'future-player', { policyVersion: 'future-v1', resetCycleKey: 'cycle-v1' });
    const claim = await claimReturnPointConversion(db, 'future-player', { policyVersion: 'future-v1', resetCycleKey: 'cycle-v1' });
    assert.equal(first.claimKey, second.claimKey);
    assert.equal(claim.mutation, 'none');
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_return_points_ledger')).total, 0);
    assert.deepEqual(await getPhHistory(db, 'future-player', 100), before);
    assert.deepEqual(await reconcileReturnPointConversions(db, 'future-player'), {
        ok: true, claimCount: 0, mismatchCount: 0, currentLedgerDigest: first.sourcePh.ledgerDigest,
    });
});

test('shop sintetica faz debit e entitlement atomicamente sem raca ou inventario ativo', async (t) => {
    const db = await openFixture(t);
    const catalog = [
        { itemKey: 'future-race-fixture', entitlementKey: 'future_race:fixture', priceReturnPoints: 6, testOnly: true },
        { itemKey: 'future-grimoire-fixture', entitlementKey: 'future_grimoire:fixture', priceReturnPoints: 3, testOnly: true },
    ];
    await creditReturnPoints(db, 'future-player', 10, {
        operationKey: 'shop-credit-0001', source: 'fixture', reason: 'Credito fixture', createdBy: 'system',
    });
    const activeBefore = await db.get('SELECT raca FROM jogadores WHERE id = ?', ['future-player']);
    const inventoryBefore = await db.get('SELECT COUNT(*) AS total FROM clover_inventory_items WHERE player_id = ?', ['future-player']);
    const purchase = await purchasePreResetEntitlement(db, 'future-player', {
        itemKey: 'future-race-fixture', idempotencyKey: 'shop-purchase-0001', actorId: 'future-player',
    }, { catalog });
    assert.equal(purchase.duplicate, false);
    assert.equal(await getReturnPointsBalance(db, 'future-player'), 4);
    assert.equal((await getPreResetEntitlements(db, 'future-player')).length, 1);
    const replay = await purchasePreResetEntitlement(db, 'future-player', {
        itemKey: 'future-race-fixture', idempotencyKey: 'shop-purchase-0001', actorId: 'future-player',
    }, { catalog });
    assert.equal(replay.duplicate, true);
    assert.deepEqual(await db.get('SELECT raca FROM jogadores WHERE id = ?', ['future-player']), activeBefore);
    assert.deepEqual(await db.get('SELECT COUNT(*) AS total FROM clover_inventory_items WHERE player_id = ?', ['future-player']), inventoryBefore);
    await assert.rejects(
        purchasePreResetEntitlement(db, 'future-player', {
            itemKey: 'future-grimoire-fixture', idempotencyKey: 'shop-purchase-fail-0001', actorId: 'future-player',
        }, { catalog, transactionHook: async () => { throw new Error('fixture failure'); } }),
        /fixture failure/
    );
    assert.equal(await getReturnPointsBalance(db, 'future-player'), 4);
    await assert.rejects(
        purchasePreResetEntitlement(db, 'future-player', {
            itemKey: 'missing', idempotencyKey: 'shop-purchase-0002', actorId: 'future-player',
        }, { catalog }),
        (error) => error instanceof PreResetShopError && error.code === 'catalog_item_not_found'
    );
});

test('mode, ownership e capability falham fechados', () => {
    assert.equal(isPreResetLaunchEnabled({}), false);
    assert.equal(isPreResetLaunchEnabled({ PRE_RESET_LAUNCH_ENABLED: 'TRUE' }), false);
    assert.equal(isPreResetLaunchEnabled(enabledEnv()), true);
    assert.throws(() => assertPreResetMutationAllowed({ env: {}, playerId: 'p', session: { playerId: 'p' } }), PreResetAccessError);
    assert.throws(() => assertPreResetMutationAllowed({ env: enabledEnv(), playerId: 'p', session: { playerId: 'other', released: true }, policyRegistry: testPolicyRegistry() }), /sessao/);
    assert.throws(() => assertPreResetMutationAllowed({ env: enabledEnv(), playerId: 'p', session: { playerId: 'p', released: true } }), /politica/);
    assert.throws(() => assertPreResetAdminCapability({ capabilities: [] }, 'prereset.review'), PreResetAccessError);
    assert.equal(assertPreResetAdminCapability({ capabilities: ['prereset.review'] }, 'prereset.review'), true);
});
