'use strict';

const { getConfigOption } = require('./configLoader');
const { getFutureCharacter } = require('./preResetCharacterService');
const {
    FINAL_FUTURE_SACRIFICE_ROLL_NUMBER,
    assertBuildPlayer,
    getFutureRollByNumber,
    hasFinalFutureRoll,
    listFutureRolls,
} = require('./preResetFutureRollService');
const {
    holdFutureSlot,
    releaseFutureSlotCategory,
} = require('./preResetFutureSlotService');
const {
    appendReturnPointsInTransaction,
    getReturnPointsBalance,
    requiredText,
} = require('./returnPointsService');
const {
    RETURN_POINT_SHOP_CATALOG,
    RETURN_POINT_SHOP_CATALOG_VERSION,
    getReturnPointShopItem,
} = require('./returnPointShopCatalog');
const { assertReturnPointShopOpen } = require('./returnPointShopGateService');

class ReturnPointShopError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ReturnPointShopError';
        this.code = code;
        this.details = details;
    }
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function purchaseQuantity(row) {
    return Math.max(1, Number(parseJson(row?.metadata_json).quantity || 1));
}

function publicRoll(row) {
    return {
        rollNumber: Number(row.roll_number),
        kingdom: row.kingdom,
        kingdomKey: row.kingdom_key || null,
        socialClass: row.social_class,
        socialClassKey: row.social_class_key || null,
        family: row.family || null,
        race: row.race,
        raceKey: row.race_key || null,
        grimoire: row.grimoire,
        grimoireKey: row.grimoire_key || null,
        grimoireRank: row.grimoire_rank || null,
        grimoireSymbol: row.grimoire_symbol || null,
        magicRarity: row.magic_rarity,
        magicRarityKey: row.magic_rarity_key || null,
        magicScope: row.magic_scope || null,
        summary: row.summary || '',
        rollVersion: row.roll_version || null,
    };
}

function publicProduct(item, state = {}) {
    return {
        itemKey: item.itemKey,
        name: item.name,
        section: item.section,
        description: item.description,
        priceReturnPoints: item.priceReturnPoints,
        purchasable: item.purchasable,
        targetMode: item.targetMode,
        effectKind: item.effectKind,
        perPlayerLimit: item.perPlayerLimit,
        globalLimit: item.globalLimit,
        quantityMode: item.quantityMode,
        maxQuantityPerPurchase: item.maxQuantityPerPurchase,
        weeklyQuantityLimit: item.weeklyQuantityLimit,
        ownedQuantity: Number(state.ownedQuantity || 0),
        globalSoldQuantity: Number(state.globalSoldQuantity || 0),
        weeklyOwnedQuantity: Number(state.weeklyOwnedQuantity || 0),
        remainingForPlayer: item.perPlayerLimit == null
            ? null
            : Math.max(0, item.perPlayerLimit - Number(state.ownedQuantity || 0)),
        remainingGlobal: item.globalLimit == null
            ? null
            : Math.max(0, item.globalLimit - Number(state.globalSoldQuantity || 0)),
        remainingThisWeek: item.weeklyQuantityLimit == null
            ? null
            : Math.max(0, item.weeklyQuantityLimit - Number(state.weeklyOwnedQuantity || 0)),
    };
}

async function completedPurchases(db, where = '', params = []) {
    return db.all(
        `SELECT * FROM clover_prereset_purchases WHERE status='completed'${where} ORDER BY id ASC`,
        params
    );
}

async function getPurchaseState(db, playerId) {
    const [playerRows, globalRows, weeklyRows] = await Promise.all([
        completedPurchases(db, ' AND player_id=?', [String(playerId)]),
        completedPurchases(db),
        completedPurchases(
            db,
            " AND player_id=? AND strftime('%Y-%W', created_at)=strftime('%Y-%W','now')",
            [String(playerId)]
        ),
    ]);
    const sumBy = (rows) => {
        const map = new Map();
        for (const row of rows) {
            map.set(row.catalog_item_key, (map.get(row.catalog_item_key) || 0) + purchaseQuantity(row));
        }
        return map;
    };
    return { player: sumBy(playerRows), global: sumBy(globalRows), weekly: sumBy(weeklyRows), playerRows };
}

async function getReturnPointShopDashboard(db, playerId) {
    await assertBuildPlayer(db, playerId);
    const [balance, rolls, character, state] = await Promise.all([
        getReturnPointsBalance(db, playerId),
        listFutureRolls(db, playerId),
        getFutureCharacter(db, playerId),
        getPurchaseState(db, playerId),
    ]);
    const finalOnly = hasFinalFutureRoll(rolls);
    const targetRolls = finalOnly
        ? rolls.filter((roll) => Number(roll.roll_number) === FINAL_FUTURE_SACRIFICE_ROLL_NUMBER)
        : rolls;
    return {
        ok: true,
        catalogVersion: RETURN_POINT_SHOP_CATALOG_VERSION,
        balance: Number(balance || 0),
        sacrificeUsed: finalOnly,
        targetRolls: targetRolls.map(publicRoll),
        futureCharacterStatus: character?.status || null,
        items: RETURN_POINT_SHOP_CATALOG.map((item) => publicProduct(item, {
            ownedQuantity: state.player.get(item.itemKey),
            globalSoldQuantity: state.global.get(item.itemKey),
            weeklyOwnedQuantity: state.weekly.get(item.itemKey),
        })),
    };
}

function normalizeQuantity(item, rawQuantity) {
    if (item.quantityMode !== 'amount') return 1;
    const quantity = Number(rawQuantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > item.maxQuantityPerPurchase) {
        throw new ReturnPointShopError('invalid_quantity', 'Quantidade inválida para esta compra.', {
            max: item.maxQuantityPerPurchase,
        });
    }
    return quantity;
}

async function resolveTargetRoll(db, playerId, item, targetRollNumber) {
    if (item.targetMode !== 'roll') return null;
    const rolls = await listFutureRolls(db, playerId);
    if (!rolls.length) throw new ReturnPointShopError('no_future_rolls', 'Você precisa gerar pelo menos um roll antes desta compra.');
    const finalOnly = hasFinalFutureRoll(rolls);
    const requested = targetRollNumber == null && finalOnly
        ? FINAL_FUTURE_SACRIFICE_ROLL_NUMBER
        : Number(targetRollNumber);
    if (!Number.isInteger(requested) || requested <= 0) {
        throw new ReturnPointShopError('target_roll_required', 'Escolha qual roll futuro receberá esta compra.');
    }
    if (finalOnly && requested !== FINAL_FUTURE_SACRIFICE_ROLL_NUMBER) {
        throw new ReturnPointShopError('target_roll_replaced_by_sacrifice', 'Depois do sacrifício, somente o roll final #6 pode receber compras.');
    }
    const roll = rolls.find((row) => Number(row.roll_number) === requested);
    if (!roll) throw new ReturnPointShopError('target_roll_not_found', 'Esse roll futuro não existe mais.');
    return roll;
}

function assertEditableCharacter(character) {
    if (character && character.status !== 'draft') {
        throw new ReturnPointShopError(
            'future_character_locked',
            'A Ficha Nova já foi enviada/fechada. Compras que alteram roll não podem mais ser aplicadas.'
        );
    }
}

function buildSummary(roll) {
    return [roll.kingdom, roll.social_class, roll.race, roll.grimoire, roll.magic_rarity].join(' | ');
}

function nextPayload(roll, changes) {
    const payload = parseJson(roll.roll_payload, {});
    return JSON.stringify({
        ...payload,
        kingdomKey: changes.kingdom_key ?? roll.kingdom_key ?? payload.kingdomKey ?? null,
        socialClassKey: changes.social_class_key ?? roll.social_class_key ?? payload.socialClassKey ?? null,
        raceKey: changes.race_key ?? roll.race_key ?? payload.raceKey ?? null,
        grimoireKey: changes.grimoire_key ?? roll.grimoire_key ?? payload.grimoireKey ?? null,
        returnPointShopModified: true,
    });
}

async function updateRoll(db, playerId, roll, changes) {
    const merged = { ...roll, ...changes };
    await db.run(
        `UPDATE clover_prereset_future_rolls
         SET kingdom=?, kingdom_key=?, social_class=?, social_class_key=?, race=?, race_key=?,
             grimoire=?, grimoire_key=?, grimoire_rank=?, grimoire_symbol=?, summary=?, roll_payload=?
         WHERE campaign_key=? AND player_id=? AND roll_number=?`,
        [
            merged.kingdom, merged.kingdom_key, merged.social_class, merged.social_class_key,
            merged.race, merged.race_key, merged.grimoire, merged.grimoire_key,
            merged.grimoire_rank, merged.grimoire_symbol, buildSummary(merged), nextPayload(roll, changes),
            roll.campaign_key, String(playerId), Number(roll.roll_number),
        ]
    );
    return getFutureRollByNumber(db, playerId, roll.roll_number, roll.campaign_key);
}

async function applyRollEffect(db, playerId, item, roll) {
    if (!roll) return null;
    const number = Number(roll.roll_number);
    if (item.effectKind === 'social_class') {
        const option = getConfigOption('socialClasses', item.effectValue);
        if (!option) throw new ReturnPointShopError('invalid_catalog_effect', 'Classe social da loja não existe no balanceamento atual.');
        return updateRoll(db, playerId, roll, { social_class: option.name, social_class_key: option.key });
    }
    if (item.effectKind === 'kingdom') {
        const option = getConfigOption('kingdoms', item.effectValue);
        const race = getConfigOption('races', roll.race_key);
        const grimoire = getConfigOption('grimoires', roll.grimoire_key);
        if (!option) throw new ReturnPointShopError('invalid_catalog_effect', 'Reino da loja não existe no balanceamento atual.');
        if (race && Number(race.weightsByKingdom?.[option.key] || 0) <= 0) {
            throw new ReturnPointShopError('roll_incompatible', `A raça ${roll.race} não é compatível com ${option.name}.`);
        }
        if (grimoire && grimoire.kingdomKey !== option.key) {
            throw new ReturnPointShopError('roll_incompatible', `O grimório ${roll.grimoire} pertence a outro reino. Troque o grimório primeiro.`);
        }
        return updateRoll(db, playerId, roll, { kingdom: option.name, kingdom_key: option.key });
    }
    if (item.effectKind === 'race') {
        const option = getConfigOption('races', item.effectValue);
        if (!option) throw new ReturnPointShopError('invalid_catalog_effect', 'Raça da loja não existe no balanceamento atual.');
        if (Number(option.weightsByKingdom?.[roll.kingdom_key] || 0) <= 0) {
            throw new ReturnPointShopError('roll_incompatible', `${option.name} não é compatível com ${roll.kingdom}.`);
        }
        await releaseFutureSlotCategory(db, playerId, number, 'race', roll.campaign_key);
        const held = await holdFutureSlot(db, {
            playerId,
            rollNumber: number,
            category: 'race',
            optionKey: option.key,
            campaignKey: roll.campaign_key,
            source: 'return_point_shop',
        });
        if (!held.ok) throw new ReturnPointShopError('future_slot_full', 'As vagas futuras dessa raça acabaram.', held.availability || {});
        const socialChange = option.key === 'humano'
            ? {}
            : { social_class: 'N/A', social_class_key: 'nao_se_aplica' };
        return updateRoll(db, playerId, roll, { race: option.name, race_key: option.key, ...socialChange });
    }
    if (item.effectKind === 'grimoire') {
        const option = getConfigOption('grimoires', item.effectValue);
        if (!option) throw new ReturnPointShopError('invalid_catalog_effect', 'Grimório da loja não existe no balanceamento atual.');
        if (option.kingdomKey !== roll.kingdom_key) {
            throw new ReturnPointShopError('roll_incompatible', `${option.name} não pertence a ${roll.kingdom}.`);
        }
        await releaseFutureSlotCategory(db, playerId, number, 'grimoire', roll.campaign_key);
        const held = await holdFutureSlot(db, {
            playerId,
            rollNumber: number,
            category: 'grimoire',
            optionKey: option.key,
            campaignKey: roll.campaign_key,
            source: 'return_point_shop',
        });
        if (!held.ok) throw new ReturnPointShopError('future_slot_full', 'As vagas futuras desse grimório acabaram.', held.availability || {});
        return updateRoll(db, playerId, roll, {
            grimoire: option.name,
            grimoire_key: option.key,
            grimoire_rank: option.rank || null,
            grimoire_symbol: option.symbol || null,
        });
    }
    return roll;
}

function validateLimits(item, quantity, state) {
    const owned = Number(state.player.get(item.itemKey) || 0);
    const globalSold = Number(state.global.get(item.itemKey) || 0);
    const weekly = Number(state.weekly.get(item.itemKey) || 0);
    if (item.perPlayerLimit != null && owned + quantity > item.perPlayerLimit) {
        throw new ReturnPointShopError('player_limit_reached', 'Você atingiu o limite desta opção.', { limit: item.perPlayerLimit, owned });
    }
    if (item.globalLimit != null && globalSold + quantity > item.globalLimit) {
        throw new ReturnPointShopError('global_stock_exhausted', 'O estoque global desta opção acabou.', { limit: item.globalLimit, sold: globalSold });
    }
    if (item.weeklyQuantityLimit != null && weekly + quantity > item.weeklyQuantityLimit) {
        throw new ReturnPointShopError('weekly_limit_reached', 'Você atingiu o limite semanal desta opção.', { limit: item.weeklyQuantityLimit, used: weekly });
    }
    return { owned, globalSold, weekly };
}

async function purchaseReturnPointShopItem(db, playerId, request = {}) {
    const id = requiredText(playerId, 'playerId', 255);
    const itemKey = requiredText(request.itemKey, 'itemKey', 120);
    const idempotencyKey = requiredText(request.idempotencyKey, 'idempotencyKey', 160);
    const item = getReturnPointShopItem(itemKey);
    if (!item) throw new ReturnPointShopError('catalog_item_not_found', 'Esta opção não existe na Loja de Retorno.');
    if (!item.purchasable) throw new ReturnPointShopError('free_option', 'Esta opção é gratuita e não precisa ser comprada.');
    await assertBuildPlayer(db, id);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const prior = await db.get('SELECT * FROM clover_prereset_purchases WHERE idempotency_key=?', [idempotencyKey]);
        if (prior) {
            if (prior.player_id !== id || prior.catalog_item_key !== itemKey) {
                throw new ReturnPointShopError('idempotency_conflict', 'Esta chave de compra já pertence a outro pedido.');
            }
            const metadata = parseJson(prior.metadata_json, {});
            await db.exec('COMMIT');
            return {
                ok: true,
                duplicate: true,
                purchase: prior,
                balanceAfter: await getReturnPointsBalance(db, id),
                targetRoll: metadata.targetRollNumber ? publicRoll(await getFutureRollByNumber(db, id, metadata.targetRollNumber)) : null,
            };
        }

        // Gate lido dentro da mesma transacao que debita PR. Fechar a loja e
        // comprar nao podem atravessar um ao outro; replay idempotente continua seguro.
        await assertReturnPointShopOpen(db);

        const quantity = normalizeQuantity(item, request.quantity);
        const state = await getPurchaseState(db, id);
        const limitState = validateLimits(item, quantity, state);
        const targetRoll = await resolveTargetRoll(db, id, item, request.targetRollNumber);
        const character = await getFutureCharacter(db, id);
        if (targetRoll) assertEditableCharacter(character);

        const price = item.priceReturnPoints * quantity;
        const sequence = limitState.owned + 1;
        const entitlementKey = `${item.entitlementKey}:r${targetRoll ? targetRoll.roll_number : 0}:n${sequence}`;
        const metadata = {
            catalogVersion: RETURN_POINT_SHOP_CATALOG_VERSION,
            itemKey,
            name: item.name,
            effectKind: item.effectKind,
            effectValue: item.effectValue,
            quantity,
            targetRollNumber: targetRoll ? Number(targetRoll.roll_number) : null,
        };

        const debit = await appendReturnPointsInTransaction(db, id, {
            amount: price,
            entryKind: 'debit',
            operationKey: `return-shop:${idempotencyKey}`,
            source: 'return_point_shop',
            reason: `Compra na Loja de Retorno: ${item.name}`,
            relatedId: itemKey,
            correlationId: idempotencyKey,
            createdBy: id,
            metadata,
        });

        const mutatedRoll = targetRoll ? await applyRollEffect(db, id, item, targetRoll) : null;
        const inserted = await db.run(
            `INSERT INTO clover_prereset_purchases
             (player_id,idempotency_key,catalog_item_key,entitlement_key,price_return_points,return_points_ledger_id,metadata_json)
             VALUES (?,?,?,?,?,?,?)`,
            [id, idempotencyKey, itemKey, entitlementKey, price, debit.ledgerId, JSON.stringify(metadata)]
        );
        const purchaseId = Number(inserted.lastID);
        await db.run(
            `INSERT INTO clover_prereset_entitlements
             (player_id,entitlement_key,purchase_id,metadata_json)
             VALUES (?,?,?,?)`,
            [id, entitlementKey, purchaseId, JSON.stringify(metadata)]
        );
        const purchase = await db.get('SELECT * FROM clover_prereset_purchases WHERE id=?', [purchaseId]);
        await db.exec('COMMIT');
        return {
            ok: true,
            duplicate: false,
            purchase,
            balanceAfter: Number(debit.balanceAfter),
            targetRoll: mutatedRoll ? publicRoll(mutatedRoll) : null,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function hasRollBoundReturnPointPurchases(db, playerId) {
    const rows = await completedPurchases(db, ' AND player_id=?', [String(playerId)]);
    return rows.some((row) => Number(parseJson(row.metadata_json).targetRollNumber || 0) > 0);
}

module.exports = {
    ReturnPointShopError,
    getReturnPointShopDashboard,
    hasRollBoundReturnPointPurchases,
    publicProduct,
    publicRoll,
    purchaseReturnPointShopItem,
};
