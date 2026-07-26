'use strict';

const crypto = require('crypto');
const { ensureCloverInventorySchema } = require('../../database');
const { addPhInTransaction, ensurePhState } = require('./phService');
const {
    RELIC_POOL,
    getAnyTemplate,
    getBoxCatalog,
    seedSeasonalEventTemplates,
    validateBoxCatalogs,
} = require('./seasonalEventCatalog');
const {
    addCatalogItemInTransaction,
    consumeInventoryItemInTransaction,
    ensureInventoryV1,
    findAvailableCatalogItemInTransaction,
} = require('./inventoryService');
const {
    grantPlayerTitleInTransaction,
    recordTitleHistoryInTransaction,
} = require('./titleService');
const { serializeBoxOpeningReceipt } = require('./boxReceiptService');
const { addYullsInTransaction, ensureYullsState } = require('./yullsService');

const BOX_ROLL_SCALE = 10000;

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
        ceiling += Math.round(Number(reward.chance || 0) * 100);
        if (roll <= ceiling) return reward;
    }
    throw new BoxServiceError(
        'invalid_catalog',
        'As probabilidades da caixa não fecham em 100%.'
    );
}

function selectWeightedReward(rewards, randomInt) {
    const weighted = rewards
        .map((reward) => ({
            reward,
            weight: Math.round(Number(reward.chance || 0) * 100),
        }))
        .filter((item) => item.weight > 0);
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    if (!total) {
        throw new BoxServiceError(
            'empty_fallback_pool',
            'Não existe recompensa disponível para o novo sorteio.'
        );
    }
    const roll = randomInclusive(randomInt, 1, total);
    let ceiling = 0;
    for (const item of weighted) {
        ceiling += item.weight;
        if (roll <= ceiling) return item.reward;
    }
    return weighted[weighted.length - 1].reward;
}

function publicCatalog(box) {
    return {
        key: box.key,
        templateKey: box.templateKey,
        name: box.name,
        version: box.version,
        totalChance: Math.round(
            box.rewards.reduce((sum, reward) => sum + reward.chance, 0) * 10
        ) / 10,
        pity: false,
        transferable: false,
        rewards: box.rewards.map((reward) => ({
            key: reward.key,
            label: reward.label,
            chance: reward.chance,
            type: reward.type,
        })),
    };
}

async function ensureSeasonalRelicSchema(db) {
    await ensureCloverInventorySchema(db);
    await seedSeasonalEventTemplates(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_seasonal_relic_ownership (
            relic_key TEXT PRIMARY KEY,
            player_id TEXT NOT NULL,
            inventory_item_id INTEGER DEFAULT NULL,
            box_opening_id INTEGER NOT NULL UNIQUE,
            claimed_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_seasonal_relic_owner
        ON clover_seasonal_relic_ownership (player_id, claimed_at DESC)
    `);
}

async function getRelicState(db) {
    await ensureSeasonalRelicSchema(db);
    const rows = await db.all(`
        SELECT ownership.*, player.personagem_nome, player.nome, player.display_name
        FROM clover_seasonal_relic_ownership ownership
        LEFT JOIN jogadores player ON player.id = ownership.player_id
        ORDER BY ownership.claimed_at ASC
    `);
    const ownership = new Map(rows.map((row) => [row.relic_key, row]));
    const relics = RELIC_POOL.map((key) => {
        const template = getAnyTemplate(key);
        const owner = ownership.get(key) || null;
        return {
            key,
            name: template?.itemName || key,
            claimed: Boolean(owner),
            owner: owner ? {
                playerId: owner.player_id,
                characterName:
                    owner.personagem_nome
                    || owner.nome
                    || owner.display_name
                    || 'Portador registrado',
                claimedAt: owner.claimed_at,
            } : null,
        };
    });
    return {
        total: relics.length,
        claimed: relics.filter((item) => item.claimed).length,
        available: relics.filter((item) => !item.claimed).length,
        relics,
    };
}

async function availableRelicKeysInTransaction(db, pool = RELIC_POOL) {
    if (!pool?.length) return [];
    const placeholders = pool.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT relic_key
         FROM clover_seasonal_relic_ownership
         WHERE relic_key IN (${placeholders})`,
        pool
    );
    const claimed = new Set(rows.map((row) => row.relic_key));
    return pool.filter((key) => !claimed.has(key));
}

async function resolveRewardInTransaction(db, box, selectedReward, randomInt) {
    if (selectedReward.type !== 'unique_relic_pool') {
        return { reward: selectedReward, relicKey: null, rerolledFrom: null };
    }

    const available = await availableRelicKeysInTransaction(
        db,
        selectedReward.pool
    );
    if (available.length) {
        return {
            reward: selectedReward,
            relicKey: available[randomInt(0, available.length)],
            rerolledFrom: null,
        };
    }

    const fallback = selectWeightedReward(
        box.rewards.filter((reward) => reward.type !== 'unique_relic_pool'),
        randomInt
    );
    return {
        reward: fallback,
        relicKey: null,
        rerolledFrom: selectedReward.key,
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
    const receipt = serializeBoxOpeningReceipt(row, duplicate);
    if (!receipt) return null;
    return {
        ...receipt,
        openingId: receipt.operation.openingId,
        boxKey: receipt.box.key,
        catalogVersion: receipt.box.catalogVersion,
        rewardKey: receipt.rewardKey,
        openedAt: receipt.openedAt,
        receipt: receipt.presentation,
    };
}

async function deliverReward(db, playerId, openingId, box, reward, options) {
    const randomInt = options.randomInt || crypto.randomInt;
    const relatedId = `box_opening:${openingId}`;
    const commonMetadata = {
        box_key: box.key,
        reward_key: reward.key,
        original_reward_key: options.originalRewardKey || reward.key,
        rerolled_from: options.rerolledFrom || null,
    };

    if (reward.type === 'yulls') {
        const amount = drawStepped(
            randomInt,
            reward.min,
            reward.max,
            reward.step || 1
        );
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
                metadata: commonMetadata,
            }
        );
        return {
            type: 'yulls',
            amount,
            label: `${amount}¥`,
            ledgerId: result.ledgerId,
            rerolledFrom: options.rerolledFrom || null,
        };
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
            {
                outside_weekly_cap: true,
                ...commonMetadata,
            },
            relatedId
        );
        return {
            type: 'ph',
            amount,
            outsideWeeklyCap: true,
            ledgerId: result.ledgerId,
            rerolledFrom: options.rerolledFrom || null,
        };
    }

    let templateKey = reward.templateKey;
    if (reward.type === 'item_pool') {
        if (!reward.pool?.length) {
            throw new BoxServiceError(
                'empty_reward_pool',
                'Pool de itens vazio.'
            );
        }
        templateKey = reward.pool[randomInt(0, reward.pool.length)];
    } else if (reward.type === 'unique_relic_pool') {
        templateKey = options.relicKey;
    }

    const template = getAnyTemplate(templateKey);
    if (!template) {
        throw new BoxServiceError(
            'reward_template_not_found',
            'Recompensa não existe no catálogo.'
        );
    }

    if (reward.type === 'title') {
        const titleResult = await grantPlayerTitleInTransaction(
            db,
            playerId,
            {
                key: template.key,
                name: template.itemName,
            },
            {
                source: 'caixa_economia',
                relatedId,
                actorId: playerId,
                reason: `${box.name}: ${reward.label}`,
                idempotencyKey: `title:${relatedId}`,
                metadata: {
                    opening_id: openingId,
                    ...commonMetadata,
                },
            }
        );
        const newlyUnlocked = titleResult.newlyUnlocked;
        let compensationYulls = 0;

        if (!newlyUnlocked) {
            compensationYulls = template.key === 'titulo_temporada_especial'
                ? 3000
                : 1000;
            await addYullsInTransaction(
                db,
                playerId,
                compensationYulls,
                'caixa_titulo_repetido',
                `${box.name}: compensação por título já desbloqueado`,
                playerId,
                {
                    relatedId,
                    idempotencyKey: `yulls:title-duplicate:${relatedId}`,
                    metadata: {
                        ...commonMetadata,
                        title_key: template.key,
                    },
                }
            );
            await recordTitleHistoryInTransaction(db, {
                titleId: titleResult.title.id,
                playerId,
                titleKey: template.key,
                titleName: template.itemName,
                action: 'compensated',
                actorId: playerId,
                source: 'caixa_economia',
                relatedId,
                beforeActive: titleResult.title.active,
                afterActive: titleResult.title.active,
                reason: `Título repetido convertido em ${compensationYulls}¥`,
                idempotencyKey: `title-compensation:${relatedId}`,
                metadata: {
                    compensation_yulls: compensationYulls,
                    opening_id: openingId,
                    ...commonMetadata,
                },
            });
        }

        return {
            type: 'title',
            templateKey,
            itemName: template.itemName,
            newlyUnlocked,
            compensationYulls,
            titleId: titleResult.title.id,
            rerolledFrom: options.rerolledFrom || null,
        };
    }

    if (reward.type === 'unique_relic_pool') {
        if (!templateKey) {
            throw new BoxServiceError(
                'relic_pool_empty',
                'Nenhuma relíquia está disponível.'
            );
        }
        await db.run(
            `INSERT INTO clover_seasonal_relic_ownership (
                relic_key, player_id, inventory_item_id, box_opening_id,
                claimed_at, metadata_json
             ) VALUES (?, ?, NULL, ?, CURRENT_TIMESTAMP, ?)`,
            [
                templateKey,
                playerId,
                openingId,
                JSON.stringify(commonMetadata),
            ]
        );
    }

    const added = await addCatalogItemInTransaction(
        db,
        playerId,
        templateKey,
        1,
        {
            source: 'caixa_economia',
            relatedId,
            createdBy: playerId,
            expiresInDays: reward.expiresInDays || null,
            metadata: {
                opening_id: openingId,
                ...commonMetadata,
                relic_key:
                    reward.type === 'unique_relic_pool'
                        ? templateKey
                        : null,
            },
        }
    );
    const item = added.items[0];

    if (reward.type === 'unique_relic_pool') {
        await db.run(
            `UPDATE clover_seasonal_relic_ownership
             SET inventory_item_id = ?
             WHERE relic_key = ?`,
            [item.id, templateKey]
        );
    }

    return {
        type: reward.type === 'unique_relic_pool' ? 'relic' : 'item',
        templateKey,
        itemId: item.id,
        itemName: item.item_name,
        quantity: 1,
        expiresAt: item.expires_at,
        globallyUnique: reward.type === 'unique_relic_pool',
        rerolledFrom: options.rerolledFrom || null,
    };
}

async function openBox(db, playerId, boxKey, options = {}) {
    const box = getBoxCatalog(boxKey);
    if (!box) {
        throw new BoxServiceError('box_not_found', 'Tipo de caixa inválido.');
    }

    const idempotencyKey = String(options.idempotencyKey || '').trim();
    if (!idempotencyKey) {
        throw new BoxServiceError(
            'missing_idempotency_key',
            'A abertura precisa de uma identificação única.'
        );
    }

    const invalidCatalog = validateBoxCatalogs().find(
        (item) => Math.abs(item.totalChance - 100) > 0.0001
    );
    if (invalidCatalog) {
        throw new BoxServiceError(
            'invalid_catalog',
            `A caixa ${invalidCatalog.key} soma ${invalidCatalog.totalChance}%.`
        );
    }

    await ensureCloverInventorySchema(db);
    await ensureInventoryV1(db);
    await seedSeasonalEventTemplates(db);
    await ensureSeasonalRelicSchema(db);
    await ensurePhState(db, playerId);
    await ensureYullsState(db, playerId);

    const existing = await findOpeningByIdempotency(db, idempotencyKey);
    if (existing) {
        if (
            existing.player_id !== playerId
            || existing.box_key !== box.key
        ) {
            throw new BoxServiceError(
                'idempotency_conflict',
                'Essa identificação já pertence a outra abertura.'
            );
        }
        return openingResult(existing, true);
    }

    const fixedRoll = options.roll === undefined || options.roll === null
        ? null
        : Number(options.roll);
    if (
        fixedRoll !== null
        && (
            !Number.isInteger(fixedRoll)
            || fixedRoll < 1
            || fixedRoll > BOX_ROLL_SCALE
        )
    ) {
        throw new BoxServiceError(
            'invalid_roll',
            `Roll da caixa precisa ficar entre 1 e ${BOX_ROLL_SCALE}.`
        );
    }

    const randomInt = options.randomInt || crypto.randomInt;

    await db.exec('BEGIN IMMEDIATE');
    try {
        const duplicate = await findOpeningByIdempotency(
            db,
            idempotencyKey
        );
        if (duplicate) {
            await db.exec('COMMIT');
            return openingResult(duplicate, true);
        }

        const inventoryItem = await findAvailableCatalogItemInTransaction(
            db,
            playerId,
            box.templateKey
        );
        if (!inventoryItem) {
            throw new BoxServiceError(
                'box_not_owned',
                `Você não possui ${box.name}.`
            );
        }

        const rollBasisPoints = fixedRoll
            ? (fixedRoll <= 100 ? fixedRoll * 100 : fixedRoll)
            : randomInclusive(randomInt, 1, BOX_ROLL_SCALE);
        const roll = Math.max(
            1,
            Math.min(100, Math.ceil(rollBasisPoints / 100))
        );
        const originallySelected = selectReward(box, rollBasisPoints);
        const resolved = await resolveRewardInTransaction(
            db,
            box,
            originallySelected,
            randomInt
        );
        const reward = resolved.reward;

        const inserted = await db.run(
            `INSERT INTO clover_box_openings (
                player_id, inventory_item_id, box_key, catalog_version,
                roll, roll_basis_points, reward_key, result_json, status,
                idempotency_key, created_at, metadata_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, CURRENT_TIMESTAMP, ?)`,
            [
                playerId,
                inventoryItem.id,
                box.key,
                box.version,
                roll,
                rollBasisPoints,
                reward.key,
                idempotencyKey,
                JSON.stringify({
                    source: options.source || 'bot',
                    roll_basis_points: rollBasisPoints,
                    original_reward_key: originallySelected.key,
                    rerolled_from: resolved.rerolledFrom,
                    relic_key: resolved.relicKey,
                }),
            ]
        );
        const openingId = inserted.lastID;

        await consumeInventoryItemInTransaction(db, inventoryItem, 1, {
            action: 'caixa_aberta',
            source: 'caixa_economia',
            relatedId: `box_opening:${openingId}`,
            createdBy: playerId,
            metadata: {
                box_key: box.key,
                roll,
                roll_basis_points: rollBasisPoints,
                reward_key: reward.key,
                original_reward_key: originallySelected.key,
                rerolled_from: resolved.rerolledFrom,
            },
        });

        const result = await deliverReward(
            db,
            playerId,
            openingId,
            box,
            reward,
            {
                ...options,
                randomInt,
                relicKey: resolved.relicKey,
                rerolledFrom: resolved.rerolledFrom,
                originalRewardKey: originallySelected.key,
            }
        );

        await db.run(
            `UPDATE clover_box_openings
             SET result_json = ?,
                 status = 'completed',
                 completed_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [JSON.stringify(result), openingId]
        );
        const completed = await db.get(
            'SELECT * FROM clover_box_openings WHERE id = ?',
            [openingId]
        );
        await db.exec('COMMIT');
        return openingResult(completed, false);
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function getBoxDashboard(db, playerId) {
    await ensureInventoryV1(db);
    await seedSeasonalEventTemplates(db);
    const boxes = [];
    for (const key of ['simples', 'rara']) {
        const box = getBoxCatalog(key);
        const row = await db.get(
            `SELECT COALESCE(SUM(quantity), 0) AS total
             FROM clover_inventory_items
             WHERE player_id = ?
               AND template_key = ?
               AND status = 'disponivel'`,
            [playerId, box.templateKey]
        );
        boxes.push({
            ...publicCatalog(box),
            owned: Number(row?.total || 0),
        });
    }
    const relics = await getRelicState(db);
    return {
        pity: false,
        independentRolls: true,
        relicEmptyPolicy: 'reroll_non_relic',
        boxes,
        relics,
    };
}

async function getBoxHistory(db, playerId, limit = 20) {
    await ensureInventoryV1(db);
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const rows = await db.all(
        `SELECT *
         FROM clover_box_openings
         WHERE player_id = ?
           AND status = 'completed'
         ORDER BY id DESC
         LIMIT ?`,
        [playerId, safeLimit]
    );
    return rows.map((row) => openingResult(row));
}

async function getBoxOpening(db, playerId, openingRef) {
    await ensureInventoryV1(db);
    const ref = String(openingRef || '').trim();
    const numericRef = Number(ref.replace(/^CX-/i, ''));
    const row = await db.get(
        `SELECT *
         FROM clover_box_openings
         WHERE player_id = ?
           AND (
               CAST(id AS TEXT) = ?
               OR idempotency_key = ?
               OR id = ?
           )
         LIMIT 1`,
        [
            playerId,
            ref,
            ref,
            Number.isInteger(numericRef) ? numericRef : -1,
        ]
    );
    if (!row) {
        throw new BoxServiceError(
            'opening_not_found',
            'Abertura de Caixa não encontrada.'
        );
    }
    return openingResult(row);
}

module.exports = {
    BOX_ROLL_SCALE,
    BoxServiceError,
    ensureSeasonalRelicSchema,
    getBoxDashboard,
    getBoxHistory,
    getBoxOpening,
    getRelicState,
    openBox,
    openingResult,
    publicCatalog,
    resolveRewardInTransaction,
    selectReward,
    selectWeightedReward,
};
