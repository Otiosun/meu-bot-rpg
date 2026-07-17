'use strict';

const crypto = require('crypto');
const { ensureCloverInventorySchema } = require('../../database');
const { addPhInTransaction, ensurePhState } = require('./phService');
const { getBoxCatalog, getTemplate, validateBoxCatalogs } = require('./economyItemCatalog');
const {
    addCatalogItemInTransaction,
    consumeInventoryItemInTransaction,
    ensureInventoryV1,
    findAvailableCatalogItemInTransaction,
} = require('./inventoryService');
const { addYullsInTransaction, ensureYullsState } = require('./yullsService');

class BoxServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'BoxServiceError';
        this.code = code;
        this.details = details;
    }
}

function randomInclusive(randomInt, min, max) {
    return randomInt(min, max + 1);
}

function drawStepped(randomInt, min, max, step = 1) {
    const total = Math.floor((max - min) / step) + 1;
    return min + randomInt(0, total) * step;
}

function selectReward(box, roll) {
    let ceiling = 0;
    for (const reward of box.rewards) {
        ceiling += Number(reward.chance || 0);
        if (roll <= ceiling) return reward;
    }
    throw new BoxServiceError('invalid_catalog', 'As probabilidades da caixa não fecham em 100%.');
}

function publicCatalog(box) {
    return {
        key: box.key,
        templateKey: box.templateKey,
        name: box.name,
        version: box.version,
        totalChance: box.rewards.reduce((sum, reward) => sum + reward.chance, 0),
        pity: false,
        transferable: false,
        rewards: box.rewards.map((reward) => ({
            key: reward.key,
            label: reward.label,
            chance: reward.chance,
        })),
    };
}

async function findOpeningByIdempotency(db, idempotencyKey) {
    if (!idempotencyKey) return null;
    return db.get(
        'SELECT * FROM clover_box_openings WHERE idempotency_key = ?',
        [idempotencyKey]
    );
}

function openingResult(row, duplicate = false) {
    return {
        ok: row.status === 'completed',
        duplicate,
        openingId: row.id,
        boxKey: row.box_key,
        catalogVersion: Number(row.catalog_version),
        roll: Number(row.roll),
        rewardKey: row.reward_key,
        reward: row.result_json ? JSON.parse(row.result_json) : null,
        openedAt: row.created_at,
    };
}

async function deliverReward(db, playerId, openingId, box, reward, options) {
    const randomInt = options.randomInt || crypto.randomInt;
    const relatedId = `box_opening:${openingId}`;
    if (reward.type === 'yulls') {
        const amount = drawStepped(randomInt, reward.min, reward.max, reward.step || 1);
        const result = await addYullsInTransaction(
            db,
            playerId,
            amount,
            'caixa_economia',
            `${box.name}: ${reward.label}`,
            playerId,
            {
                relatedId,
                idempotencyKey: `yulls:${relatedId}`,
                metadata: { box_key: box.key, reward_key: reward.key },
            }
        );
        return { type: 'yulls', amount, label: `${amount}¥`, ledgerId: result.ledgerId };
    }

    if (reward.type === 'ph') {
        const amount = randomInclusive(randomInt, reward.min, reward.max);
        const result = await addPhInTransaction(
            db,
            playerId,
            amount,
            'caixa_economia',
            `${box.name}: ${reward.label} — fora do teto semanal`,
            playerId,
            { outside_weekly_cap: true, box_key: box.key, reward_key: reward.key },
            relatedId
        );
        return { type: 'ph', amount, outsideWeeklyCap: true, ledgerId: result.ledgerId };
    }

    let templateKey = reward.templateKey;
    if (reward.type === 'item_pool') {
        if (!reward.pool?.length) throw new BoxServiceError('empty_reward_pool', 'Pool de itens vazio.');
        templateKey = reward.pool[randomInt(0, reward.pool.length)];
    }
    const template = getTemplate(templateKey);
    if (!template) throw new BoxServiceError('reward_template_not_found', 'Recompensa não existe no catálogo.');
    const added = await addCatalogItemInTransaction(db, playerId, templateKey, 1, {
        source: 'caixa_economia',
        relatedId,
        createdBy: playerId,
        expiresInDays: reward.expiresInDays || null,
        metadata: { box_key: box.key, reward_key: reward.key, opening_id: openingId },
    });
    const item = added.items[0];

    if (reward.type === 'title') {
        const titleInsert = await db.run(
            `INSERT OR IGNORE INTO clover_player_titles
             (player_id, title_key, title_name, source, related_id, active, unlocked_at, metadata_json)
             VALUES (?, ?, ?, 'caixa_economia', ?, 0, CURRENT_TIMESTAMP, ?)`,
            [
                playerId,
                template.key,
                template.itemName,
                relatedId,
                JSON.stringify({ box_key: box.key, opening_id: openingId }),
            ]
        );
        return {
            type: 'title',
            templateKey,
            itemId: item.id,
            itemName: item.item_name,
            newlyUnlocked: Number(titleInsert.changes || 0) > 0,
        };
    }

    return {
        type: 'item',
        templateKey,
        itemId: item.id,
        itemName: item.item_name,
        quantity: 1,
        expiresAt: item.expires_at,
    };
}

async function openBox(db, playerId, boxKey, options = {}) {
    const box = getBoxCatalog(boxKey);
    if (!box) throw new BoxServiceError('box_not_found', 'Tipo de caixa inválido.');
    const idempotencyKey = String(options.idempotencyKey || '').trim();
    if (!idempotencyKey) {
        throw new BoxServiceError('missing_idempotency_key', 'A abertura precisa de uma identificação única.');
    }
    const invalidCatalog = validateBoxCatalogs().find((item) => item.totalChance !== 100);
    if (invalidCatalog) {
        throw new BoxServiceError('invalid_catalog', `A caixa ${invalidCatalog.key} soma ${invalidCatalog.totalChance}%.`);
    }

    await ensureCloverInventorySchema(db);
    await ensureInventoryV1(db);
    await ensurePhState(db, playerId);
    await ensureYullsState(db, playerId);
    const existing = await findOpeningByIdempotency(db, idempotencyKey);
    if (existing) {
        if (existing.player_id !== playerId || existing.box_key !== box.key) {
            throw new BoxServiceError('idempotency_conflict', 'Essa identificação já pertence a outra abertura.');
        }
        return openingResult(existing, true);
    }

    const fixedRoll = options.roll === undefined || options.roll === null ? null : Number(options.roll);
    if (fixedRoll !== null && (!Number.isInteger(fixedRoll) || fixedRoll < 1 || fixedRoll > 100)) {
        throw new BoxServiceError('invalid_roll', 'Roll da caixa precisa ficar entre 1 e 100.');
    }
    const randomInt = options.randomInt || crypto.randomInt;

    await db.exec('BEGIN IMMEDIATE');
    try {
        const duplicate = await findOpeningByIdempotency(db, idempotencyKey);
        if (duplicate) {
            await db.exec('COMMIT');
            return openingResult(duplicate, true);
        }
        const inventoryItem = await findAvailableCatalogItemInTransaction(db, playerId, box.templateKey);
        if (!inventoryItem) {
            throw new BoxServiceError('box_not_owned', `Você não possui ${box.name}.`);
        }
        const roll = fixedRoll || randomInclusive(randomInt, 1, 100);
        const reward = selectReward(box, roll);
        const inserted = await db.run(
            `INSERT INTO clover_box_openings
             (player_id, inventory_item_id, box_key, catalog_version, roll, reward_key,
              result_json, status, idempotency_key, created_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?, CURRENT_TIMESTAMP, ?)`,
            [
                playerId,
                inventoryItem.id,
                box.key,
                box.version,
                roll,
                reward.key,
                idempotencyKey,
                JSON.stringify({ source: options.source || 'bot' }),
            ]
        );
        const openingId = inserted.lastID;
        await consumeInventoryItemInTransaction(db, inventoryItem, 1, {
            action: 'caixa_aberta',
            source: 'caixa_economia',
            relatedId: `box_opening:${openingId}`,
            createdBy: playerId,
            metadata: { box_key: box.key, roll, reward_key: reward.key },
        });
        const result = await deliverReward(db, playerId, openingId, box, reward, {
            ...options,
            randomInt,
        });
        await db.run(
            `UPDATE clover_box_openings
             SET result_json = ?, status = 'completed', completed_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [JSON.stringify(result), openingId]
        );
        const completed = await db.get('SELECT * FROM clover_box_openings WHERE id = ?', [openingId]);
        await db.exec('COMMIT');
        return openingResult(completed, false);
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function getBoxDashboard(db, playerId) {
    await ensureInventoryV1(db);
    const boxes = [];
    for (const key of ['simples', 'rara']) {
        const box = getBoxCatalog(key);
        const row = await db.get(
            `SELECT COALESCE(SUM(quantity), 0) AS total
             FROM clover_inventory_items
             WHERE player_id = ? AND template_key = ? AND status = 'disponivel'`,
            [playerId, box.templateKey]
        );
        boxes.push({ ...publicCatalog(box), owned: Number(row?.total || 0) });
    }
    return { pity: false, independentRolls: true, boxes };
}

async function getBoxHistory(db, playerId, limit = 20) {
    await ensureInventoryV1(db);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const rows = await db.all(
        `SELECT * FROM clover_box_openings
         WHERE player_id = ? AND status = 'completed'
         ORDER BY id DESC LIMIT ?`,
        [playerId, safeLimit]
    );
    return rows.map((row) => openingResult(row));
}

module.exports = {
    BoxServiceError,
    getBoxDashboard,
    getBoxHistory,
    openBox,
    publicCatalog,
    selectReward,
};
