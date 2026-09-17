'use strict';

const crypto = require('crypto');
const { ensureCloverInventorySchema } = require('../../database');
const {
    ensureSpellbookSchema,
    getActiveQueueEntry,
    getQueuePosition,
} = require('./spellbookService');
const { ensureCloverPaShopSchema } = require('./paShopSchema');
const { getCanonicalPlayer, isEmptyCharacterPlayer } = require('./targetResolver');
const { addYullsInTransaction, ensureYullsState } = require('./yullsService');
const {
    addUncatalogedItemInTransaction,
    consumeInventoryItemInTransaction,
} = require('./inventoryService');

const PRIORITY_DATE_PREFIX = '0001-01-01 ';

const SIMPLE_BOX_REWARDS = Object.freeze([
    {
        key: 'yulls_500',
        maxRoll: 39,
        type: 'yulls',
        amount: 500,
        label: '500¥',
    },
    {
        key: 'yulls_750',
        maxRoll: 64,
        type: 'yulls',
        amount: 750,
        label: '750¥',
    },
    {
        key: 'yulls_1000',
        maxRoll: 74,
        type: 'yulls',
        amount: 1000,
        label: '1.000¥',
    },
    {
        key: 'pocao_mana_simples',
        maxRoll: 89,
        type: 'inventory',
        itemName: 'Poção de Mana Simples',
        description: 'Consumível comum. Ajuda na recuperação leve de mana fora de combate; não restaura tudo nem substitui descanso.',
        label: 'Poção de Mana Simples',
    },
    {
        key: 'kit_primeiros_socorros',
        maxRoll: 99,
        type: 'inventory',
        itemName: 'Kit de Primeiros Socorros',
        description: 'Consumível comum para cuidados leves após uma cena. Não cura ferimentos graves nem remove condições especiais.',
        label: 'Kit de Primeiros Socorros',
    },
]);

function isFilledCharacter(player) {
    return player && !isEmptyCharacterPlayer(player);
}

async function resolveUsablePlayer(db, evaluatorId) {
    const player = await getCanonicalPlayer(db, evaluatorId).catch(() => null);
    if (!player) return { ok: false, code: 'no_player', player: null };
    if (!isFilledCharacter(player)) return { ok: false, code: 'no_character', player };
    return { ok: true, player };
}

function normalizeRoll(value) {
    if (value === null || value === undefined || value === '') return crypto.randomInt(100);
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 99) {
        throw new Error('Roll da Caixa Simples precisa estar entre 0 e 99.');
    }
    return number;
}

function selectSimpleBoxReward(roll) {
    return SIMPLE_BOX_REWARDS.find((reward) => roll <= reward.maxRoll)
        || SIMPLE_BOX_REWARDS[SIMPLE_BOX_REWARDS.length - 1];
}

function isPriorityQueueEntry(entry) {
    return String(entry?.requested_at || '').startsWith(PRIORITY_DATE_PREFIX);
}

function buildPriorityRequestedAt(entryId) {
    const suffix = String(Math.max(0, Number(entryId) || 0)).padStart(12, '0');
    return `${PRIORITY_DATE_PREFIX}00:00:00.${suffix}`;
}

async function ensurePriorityQueueSupport(db) {
    await ensureSpellbookSchema(db);
    await db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_clover_spell_queue_preserve_pa_priority
        AFTER UPDATE OF requested_at, status ON clover_spell_review_queue
        WHEN OLD.requested_at LIKE '0001-01-01 %'
          AND NEW.status = 'waiting'
          AND NEW.requested_at NOT LIKE '0001-01-01 %'
        BEGIN
            UPDATE clover_spell_review_queue
            SET requested_at = OLD.requested_at
            WHERE id = NEW.id;
        END
    `);
}

async function ensurePaItemUseDependencies(db, { queue = false } = {}) {
    await ensureCloverInventorySchema(db);
    await ensureCloverPaShopSchema(db);
    if (queue) await ensurePriorityQueueSupport(db);
}

async function findInventoryItemByKind(db, playerId, kind) {
    return db.get(
        `SELECT *
         FROM clover_inventory_items
         WHERE player_id = ?
           AND kind = ?
           AND quantity > 0
           AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
        [playerId, kind]
    );
}

async function countInventoryKind(db, playerId, kind) {
    const row = await db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS total
         FROM clover_inventory_items
         WHERE player_id = ?
           AND kind = ?
           AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)`,
        [playerId, kind]
    );
    return Math.max(0, Number(row?.total || 0));
}

async function consumeInventoryRow(db, row, options = {}) {
    if (!row) return false;
    const quantity = Number(row.quantity || 0);
    if (quantity <= 0) return false;
    await consumeInventoryItemInTransaction(db, row, 1, options);
    return true;
}

async function findItemUseByIdempotency(db, idempotencyKey) {
    if (!idempotencyKey) return null;
    return db.get(
        'SELECT * FROM clover_pa_item_uses WHERE idempotency_key = ?',
        [idempotencyKey]
    );
}

async function recordItemUse(db, {
    evaluatorId,
    playerId,
    itemKey,
    inventoryItemId,
    action,
    result,
    idempotencyKey,
    createdBy,
    metadata = {},
}) {
    const inserted = await db.run(
        `INSERT INTO clover_pa_item_uses
         (evaluator_id, player_id, item_key, inventory_item_id, action, result_json,
          status, source, idempotency_key, created_by, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, 'completed', 'pa_item_use', ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            evaluatorId,
            playerId,
            itemKey,
            inventoryItemId || null,
            action,
            JSON.stringify(result || {}),
            idempotencyKey || null,
            createdBy || evaluatorId,
            JSON.stringify(metadata || {}),
        ]
    );
    return inserted.lastID;
}

async function addBoxInventoryReward(db, playerId, reward, relatedId, createdBy) {
    const result = await addUncatalogedItemInTransaction(db, playerId, {
        itemName: reward.itemName, description: reward.description, quantity: 1,
        kind: 'consumivel_comum', category: 'consumivel',
    }, {
        source: 'pa_box', relatedId, createdBy: createdBy || playerId,
        idempotencyKey: `inventory:${relatedId}`, stackByName: true,
        metadata: { box_reward_key: reward.key },
    });
    return { type: 'inventory', itemId: result.items[0]?.id || null, itemName: reward.itemName, amount: 1 };
}

async function applySimpleBoxReward(db, player, reward, relatedId, createdBy) {
    if (reward.type === 'yulls') {
        await addYullsInTransaction(
            db,
            player.id,
            reward.amount,
            'caixa_pa',
            `Caixa Simples da loja de PA: ${reward.label}`,
            createdBy || player.id,
            {
                relatedId,
                idempotencyKey: `yulls:${relatedId}`,
                metadata: { reward_key: reward.key },
            }
        );
        return { type: 'yulls', amount: reward.amount, label: reward.label, key: reward.key };
    }

    const inventory = await addBoxInventoryReward(db, player.id, reward, relatedId, createdBy);
    return { ...inventory, label: reward.label, key: reward.key };
}

async function openSimplePaBox(db, evaluatorId, {
    createdBy = evaluatorId,
    idempotencyKey = null,
    roll = null,
} = {}) {
    await ensurePaItemUseDependencies(db);
    const playerResult = await resolveUsablePlayer(db, evaluatorId);
    if (!playerResult.ok) return playerResult;
    const player = playerResult.player;
    await ensureYullsState(db, player.id);

    const existing = await findItemUseByIdempotency(db, idempotencyKey);
    if (existing) return { ok: false, code: 'duplicate', use: existing };

    await db.exec('BEGIN IMMEDIATE');
    try {
        const duplicate = await findItemUseByIdempotency(db, idempotencyKey);
        if (duplicate) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'duplicate', use: duplicate };
        }

        const box = await findInventoryItemByKind(db, player.id, 'caixa_pa');
        if (!box) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'no_box', player };
        }

        const selectedRoll = normalizeRoll(roll);
        const rewardDefinition = selectSimpleBoxReward(selectedRoll);
        const useToken = crypto.randomUUID();
        await consumeInventoryRow(db, box, {
            action: 'caixa_aberta', source: 'pa_item_use', relatedId: `pa_box:${useToken}`,
            idempotencyKey: `inventory:pa-box-consume:${useToken}`, createdBy,
        });
        const reward = await applySimpleBoxReward(
            db,
            player,
            rewardDefinition,
            `pa_box:${useToken}`,
            createdBy
        );
        const useId = await recordItemUse(db, {
            evaluatorId,
            playerId: player.id,
            itemKey: 'caixa_simples',
            inventoryItemId: box.id,
            action: 'open',
            result: reward,
            idempotencyKey,
            createdBy,
            metadata: { roll: selectedRoll, reward_key: rewardDefinition.key, token: useToken },
        });
        const remainingBoxes = await countInventoryKind(db, player.id, 'caixa_pa');
        await db.exec('COMMIT');

        return {
            ok: true,
            code: 'box_opened',
            evaluatorId,
            player,
            useId,
            roll: selectedRoll,
            reward,
            remainingBoxes,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        if (error?.code === 'SQLITE_CONSTRAINT' && idempotencyKey) {
            const duplicate = await findItemUseByIdempotency(db, idempotencyKey).catch(() => null);
            if (duplicate) return { ok: false, code: 'duplicate', use: duplicate };
        }
        throw error;
    }
}

async function activatePriorityCoupon(db, evaluatorId, {
    createdBy = evaluatorId,
    idempotencyKey = null,
} = {}) {
    await ensurePaItemUseDependencies(db, { queue: true });
    const playerResult = await resolveUsablePlayer(db, evaluatorId);
    if (!playerResult.ok) return playerResult;
    const player = playerResult.player;

    const existing = await findItemUseByIdempotency(db, idempotencyKey);
    if (existing) return { ok: false, code: 'duplicate', use: existing };

    await db.exec('BEGIN IMMEDIATE');
    try {
        const duplicate = await findItemUseByIdempotency(db, idempotencyKey);
        if (duplicate) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'duplicate', use: duplicate };
        }

        const entry = await getActiveQueueEntry(db, player.id);
        if (!entry) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'not_in_queue', player };
        }
        if (entry.status === 'called') {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'already_called', player, entry };
        }
        if (isPriorityQueueEntry(entry)) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'already_priority', player, entry };
        }

        const coupon = await findInventoryItemByKind(db, player.id, 'cupom_pa');
        if (!coupon) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'no_coupon', player, entry };
        }

        const priorityRequestedAt = buildPriorityRequestedAt(entry.id);
        await consumeInventoryRow(db, coupon, {
            action: 'cupom_usado', source: 'pa_item_use', relatedId: `spell_queue:${entry.id}`,
            idempotencyKey: idempotencyKey ? `inventory:${idempotencyKey}` : null, createdBy,
        });
        await db.run(
            `UPDATE clover_spell_review_queue
             SET requested_at = ?
             WHERE id = ? AND status = 'waiting'`,
            [priorityRequestedAt, entry.id]
        );
        const useId = await recordItemUse(db, {
            evaluatorId,
            playerId: player.id,
            itemKey: 'cupom_prioridade',
            inventoryItemId: coupon.id,
            action: 'activate_queue_priority',
            result: { queue_entry_id: entry.id, requested_at: priorityRequestedAt },
            idempotencyKey,
            createdBy,
            metadata: { queue_entry_id: entry.id, previous_requested_at: entry.requested_at },
        });
        const remainingCoupons = await countInventoryKind(db, player.id, 'cupom_pa');
        await db.exec('COMMIT');

        const updatedEntry = await getActiveQueueEntry(db, player.id);
        const position = await getQueuePosition(db, updatedEntry);
        return {
            ok: true,
            code: 'priority_activated',
            evaluatorId,
            player,
            useId,
            entry: updatedEntry,
            position,
            remainingCoupons,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        if (error?.code === 'SQLITE_CONSTRAINT' && idempotencyKey) {
            const duplicate = await findItemUseByIdempotency(db, idempotencyKey).catch(() => null);
            if (duplicate) return { ok: false, code: 'duplicate', use: duplicate };
        }
        throw error;
    }
}

module.exports = {
    PRIORITY_DATE_PREFIX,
    SIMPLE_BOX_REWARDS,
    activatePriorityCoupon,
    buildPriorityRequestedAt,
    ensurePriorityQueueSupport,
    isPriorityQueueEntry,
    openSimplePaBox,
    selectSimpleBoxReward,
};
