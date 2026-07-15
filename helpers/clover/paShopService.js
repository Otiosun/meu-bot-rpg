'use strict';

const {
    ensureCloverAdminServiceSchema,
    ensureCloverInventorySchema,
    ensureCloverQuickEvaluationsSchema,
    ensureCloverSquadSchema,
} = require('../../database');
const { addPhInTransaction, ensurePhState } = require('./phService');
const { getCanonicalPlayer, isEmptyCharacterPlayer } = require('./targetResolver');
const { formatWeekKey } = require('./adminService');
const { normalizeSquadKey } = require('./cavalierService');
const { PA_SHOP_ITEMS, getPaShopItem } = require('./paShopCatalog');
const { ensureCloverPaShopSchema } = require('./paShopSchema');

const WEEKLY_COMMON_PH_LIMIT = 30;

function asPositiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function isFilled(value) {
    const text = String(value || '').trim();
    return Boolean(text) && !['-', '.', 'nenhum', 'nenhuma'].includes(text.toLowerCase());
}

async function ensurePaShopDependencies(db) {
    await ensureCloverAdminServiceSchema(db);
    await ensureCloverQuickEvaluationsSchema(db);
    await ensureCloverPaShopSchema(db);
}

async function resolvePaShopPlayer(db, evaluatorId) {
    const player = await getCanonicalPlayer(db, evaluatorId).catch(() => null);
    if (!player) return { ok: false, code: 'no_player', player: null };
    if (isEmptyCharacterPlayer(player)) return { ok: false, code: 'no_character', player };
    return { ok: true, player };
}

async function readAvailablePa(db, evaluatorId) {
    const row = await db.get(
        `SELECT COALESCE(SUM(
             CASE
                 WHEN status IN ('pending', 'partial') AND points > paid_points
                 THEN points - paid_points
                 ELSE 0
             END
         ), 0) AS available
         FROM clover_admin_service_entries
         WHERE evaluator_id = ?`,
        [evaluatorId]
    );
    return Math.max(0, Number(row?.available || 0));
}

async function readEarnedPa(db, evaluatorId) {
    const row = await db.get(
        `SELECT COALESCE(SUM(CASE WHEN status <> 'void' THEN points ELSE 0 END), 0) AS earned
         FROM clover_admin_service_entries
         WHERE evaluator_id = ?`,
        [evaluatorId]
    );
    return Number(row?.earned || 0);
}

async function readCommonPhUsedThisWeek(db, playerId, weekKey) {
    const quick = await db.get(
        `SELECT COALESCE(SUM(ph_amount), 0) AS total
         FROM clover_quick_evaluations
         WHERE player_id = ?
           AND week_key = ?
           AND bypass_weekly_limit = 0`,
        [playerId, weekKey]
    );
    const payouts = await db.get(
        `SELECT COALESCE(SUM(ph_paid), 0) AS total
         FROM clover_admin_service_payouts
         WHERE player_id = ?
           AND week_key = ?`,
        [playerId, weekKey]
    );
    return Number(quick?.total || 0) + Number(payouts?.total || 0);
}

async function readWeeklyPurchaseUsage(db, evaluatorId, weekKey) {
    const rows = await db.all(
        `SELECT item_key, COALESCE(SUM(quantity), 0) AS quantity
         FROM clover_pa_shop_purchases
         WHERE evaluator_id = ?
           AND week_key = ?
           AND status = 'completed'
         GROUP BY item_key`,
        [evaluatorId, weekKey]
    );
    return new Map(rows.map((row) => [row.item_key, Number(row.quantity || 0)]));
}

async function getPaShopSpendSummary(db, evaluatorId, { weekKey = null } = {}) {
    await ensureCloverPaShopSchema(db);
    const params = [evaluatorId];
    const weekWhere = weekKey ? ' AND week_key = ?' : '';
    if (weekKey) params.push(weekKey);
    const row = await db.get(
        `SELECT COALESCE(SUM(pa_cost), 0) AS spent,
                COALESCE(SUM(quantity), 0) AS units,
                COUNT(*) AS purchases
         FROM clover_pa_shop_purchases
         WHERE evaluator_id = ?
           AND status = 'completed'
           ${weekWhere}`,
        params
    );
    return {
        spentPa: Number(row?.spent || 0),
        units: Number(row?.units || 0),
        purchases: Number(row?.purchases || 0),
    };
}

function buildItemState(item, { weeklyUsage, commonPhUsed, hasPlayer, hasSquad }) {
    if (item.limitMode === 'common_ph') {
        const used = hasPlayer ? commonPhUsed : 0;
        return {
            ...item,
            used,
            limit: WEEKLY_COMMON_PH_LIMIT,
            available: hasPlayer ? Math.max(0, WEEKLY_COMMON_PH_LIMIT - used) : 0,
            blockedCode: hasPlayer ? null : 'no_character',
        };
    }

    const used = Number(weeklyUsage.get(item.key) || 0);
    const available = Math.max(0, Number(item.weeklyLimit || 0) - used);
    return {
        ...item,
        used,
        limit: item.weeklyLimit,
        available,
        blockedCode: item.key === 'estrela_esquadrao' && !hasSquad ? 'no_squad' : null,
    };
}

async function getPaShopState(db, evaluatorId, { weekKey = formatWeekKey(new Date()) } = {}) {
    await ensurePaShopDependencies(db);
    const playerResult = await resolvePaShopPlayer(db, evaluatorId);
    const player = playerResult.player || null;
    const [availablePa, earnedPa, spend, weeklyUsage] = await Promise.all([
        readAvailablePa(db, evaluatorId),
        readEarnedPa(db, evaluatorId),
        getPaShopSpendSummary(db, evaluatorId),
        readWeeklyPurchaseUsage(db, evaluatorId, weekKey),
    ]);
    const commonPhUsed = playerResult.ok
        ? await readCommonPhUsedThisWeek(db, player.id, weekKey)
        : 0;
    const hasSquad = playerResult.ok && isFilled(player.esquadrao) && Boolean(normalizeSquadKey(player.esquadrao));

    return {
        evaluatorId,
        playerResult,
        player,
        weekKey,
        availablePa,
        earnedPa,
        spentPa: spend.spentPa,
        purchases: spend.purchases,
        commonPhUsed,
        items: PA_SHOP_ITEMS.map((item) => buildItemState(item, {
            weeklyUsage,
            commonPhUsed,
            hasPlayer: playerResult.ok,
            hasSquad,
        })),
    };
}

function normalizePurchaseQuantity(item, quantity) {
    const parsed = asPositiveInteger(quantity);
    if (item.quantityMode === 'required') {
        return parsed
            ? { ok: true, quantity: parsed }
            : { ok: false, code: 'quantity_required' };
    }
    if (item.quantityMode === 'single') {
        if (quantity !== null && quantity !== undefined && String(quantity).trim() && parsed !== 1) {
            return { ok: false, code: 'single_only' };
        }
        return { ok: true, quantity: 1 };
    }
    return { ok: true, quantity: parsed || 1 };
}

async function consumeAvailablePa(db, evaluatorId, amount) {
    let remaining = Number(amount || 0);
    const consumed = [];
    const entries = await db.all(
        `SELECT id, points, paid_points
         FROM clover_admin_service_entries
         WHERE evaluator_id = ?
           AND status IN ('pending', 'partial')
           AND points > paid_points
         ORDER BY created_at ASC, id ASC`,
        [evaluatorId]
    );

    for (const entry of entries) {
        if (remaining <= 0) break;
        const available = Number(entry.points || 0) - Number(entry.paid_points || 0);
        const used = Math.min(available, remaining);
        const nextPaid = Number(entry.paid_points || 0) + used;
        const nextStatus = nextPaid >= Number(entry.points || 0) ? 'paid' : 'partial';
        await db.run(
            `UPDATE clover_admin_service_entries
             SET paid_points = ?, status = ?
             WHERE id = ?`,
            [nextPaid, nextStatus, entry.id]
        );
        consumed.push({ entryId: entry.id, points: used });
        remaining -= used;
    }

    if (remaining > 0) {
        const error = new Error('Saldo de PA mudou durante a compra.');
        error.code = 'insufficient_pa';
        throw error;
    }
    return consumed;
}

async function applyYullsReward(db, playerId, quantity) {
    const yulls = 500 * quantity;
    await db.run(
        `UPDATE jogadores
         SET dinheiro = COALESCE(dinheiro, 0) + ?
         WHERE id = ?`,
        [yulls, playerId]
    );
    return { type: 'yulls', amount: yulls };
}

async function applyInventoryReward(db, playerId, item, purchaseId, evaluatorId) {
    await ensureCloverInventorySchema(db);
    const inventory = item.key === 'caixa_simples'
        ? {
            name: 'Caixa Simples de Serviço',
            description: 'Caixa selada adquirida na Loja de PA. Contém recompensa narrativa leve ou consumível comum, definida no momento da abertura.',
            kind: 'caixa_pa',
        }
        : {
            name: 'Cupom de Prioridade',
            description: 'Permite solicitar prioridade em uma avaliação simples própria. O cupom deve ser consumido quando a prioridade for aceita.',
            kind: 'cupom_pa',
        };

    const result = await db.run(
        `INSERT INTO clover_inventory_items
         (player_id, item_name, description, quantity, kind, source, related_id, created_by, created_at, metadata_json)
         VALUES (?, ?, ?, 1, ?, 'pa_shop', ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            playerId,
            inventory.name,
            inventory.description,
            inventory.kind,
            `pa_shop:${purchaseId}`,
            evaluatorId,
            JSON.stringify({ purchase_id: purchaseId, item_key: item.key }),
        ]
    );
    return { type: 'inventory', itemId: result.lastID, itemName: inventory.name, amount: 1 };
}

async function applySquadStarReward(db, player, purchaseId, evaluatorId) {
    await ensureCloverSquadSchema(db);
    if (!isFilled(player.esquadrao)) {
        const error = new Error('Personagem sem esquadrão.');
        error.code = 'no_squad';
        throw error;
    }
    const squadName = String(player.esquadrao).trim();
    const squadKey = normalizeSquadKey(squadName);
    if (!squadKey) {
        const error = new Error('Esquadrão inválido.');
        error.code = 'no_squad';
        throw error;
    }

    await db.run(
        `UPDATE jogadores
         SET estrelas = COALESCE(estrelas, 0) + 1
         WHERE id = ?`,
        [player.id]
    );
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, historical_stars, current_stars, updated_at)
         VALUES (?, ?, 1, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(squad_key) DO UPDATE SET
             name = excluded.name,
             historical_stars = clover_squads.historical_stars + 1,
             current_stars = clover_squads.current_stars + 1,
             updated_at = CURRENT_TIMESTAMP`,
        [squadKey, squadName]
    );
    await db.run(
        `INSERT INTO clover_squad_star_ledger
         (squad_key, player_id, evaluation_id, amount, kind, source, reason, created_by, created_at, metadata_json)
         VALUES (?, ?, NULL, 1, 'ganho', 'pa_shop', ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            squadKey,
            player.id,
            'Estrela comprada na Loja de PA',
            evaluatorId,
            JSON.stringify({ purchase_id: purchaseId, item_key: 'estrela_esquadrao' }),
        ]
    );
    return { type: 'squad_star', amount: 1, squadKey, squadName };
}

async function applyPhReward(db, player, quantity, purchaseId, evaluatorId, weekKey, paCost, consumed) {
    const phResult = await addPhInTransaction(
        db,
        player.id,
        quantity,
        'pa_shop',
        'PH comprado na Loja de PA',
        evaluatorId,
        {
            purchase_id: purchaseId,
            week_key: weekKey,
            pa_cost: paCost,
            consumed_entries: consumed,
        },
        `pa_shop:${purchaseId}`
    );
    const payout = await db.run(
        `INSERT INTO clover_admin_service_payouts
         (evaluator_id, player_id, points_paid, ph_paid, week_key, source, reason, created_by, ledger_id, metadata_json)
         VALUES (?, ?, ?, ?, ?, 'pa_shop_ph', 'Compra de PH na Loja de PA', ?, ?, ?)`,
        [
            evaluatorId,
            player.id,
            paCost,
            quantity,
            weekKey,
            evaluatorId,
            phResult.ledgerId,
            JSON.stringify({ purchase_id: purchaseId, consumed_entries: consumed }),
        ]
    );
    return { type: 'ph', amount: quantity, ledgerId: phResult.ledgerId, payoutId: payout.lastID, phResult };
}

async function listPaShopPurchases(db, evaluatorId, { limit = 10 } = {}) {
    await ensureCloverPaShopSchema(db);
    return db.all(
        `SELECT *
         FROM clover_pa_shop_purchases
         WHERE evaluator_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [evaluatorId, Math.max(1, Math.min(30, Number(limit) || 10))]
    );
}

async function purchasePaShopItem(db, evaluatorId, itemInput, {
    quantity = null,
    createdBy = evaluatorId,
    idempotencyKey = null,
    weekKey = formatWeekKey(new Date()),
} = {}) {
    await ensurePaShopDependencies(db);
    const item = getPaShopItem(itemInput);
    if (!item) return { ok: false, code: 'unknown_item' };

    const quantityResult = normalizePurchaseQuantity(item, quantity);
    if (!quantityResult.ok) return { ok: false, code: quantityResult.code, item };
    const requestedQuantity = quantityResult.quantity;
    const paCost = item.unitPaCost * requestedQuantity;

    const playerResult = await resolvePaShopPlayer(db, evaluatorId);
    if (!playerResult.ok) return { ok: false, code: playerResult.code, item, player: playerResult.player || null };
    const player = playerResult.player;

    if (item.key === 'ph') await ensurePhState(db, player.id);
    if (item.key === 'caixa_simples' || item.key === 'cupom_prioridade') await ensureCloverInventorySchema(db);
    if (item.key === 'estrela_esquadrao') await ensureCloverSquadSchema(db);

    if (idempotencyKey) {
        const existing = await db.get(
            'SELECT * FROM clover_pa_shop_purchases WHERE idempotency_key = ?',
            [idempotencyKey]
        );
        if (existing) return { ok: false, code: 'duplicate', item, purchase: existing };
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        if (idempotencyKey) {
            const duplicate = await db.get(
                'SELECT * FROM clover_pa_shop_purchases WHERE idempotency_key = ?',
                [idempotencyKey]
            );
            if (duplicate) {
                await db.exec('ROLLBACK');
                return { ok: false, code: 'duplicate', item, purchase: duplicate };
            }
        }

        const availablePa = await readAvailablePa(db, evaluatorId);
        if (availablePa < paCost) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'insufficient_pa', item, availablePa, paCost };
        }

        let used = 0;
        let available = 0;
        if (item.limitMode === 'common_ph') {
            used = await readCommonPhUsedThisWeek(db, player.id, weekKey);
            available = Math.max(0, WEEKLY_COMMON_PH_LIMIT - used);
        } else {
            const usage = await db.get(
                `SELECT COALESCE(SUM(quantity), 0) AS quantity
                 FROM clover_pa_shop_purchases
                 WHERE evaluator_id = ?
                   AND week_key = ?
                   AND item_key = ?
                   AND status = 'completed'`,
                [evaluatorId, weekKey, item.key]
            );
            used = Number(usage?.quantity || 0);
            available = Math.max(0, Number(item.weeklyLimit || 0) - used);
        }

        if (item.key === 'estrela_esquadrao' && (!isFilled(player.esquadrao) || !normalizeSquadKey(player.esquadrao))) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'no_squad', item };
        }
        if (requestedQuantity > available) {
            await db.exec('ROLLBACK');
            return {
                ok: false,
                code: item.limitMode === 'common_ph' ? 'weekly_ph_limit' : 'weekly_item_limit',
                item,
                used,
                limit: item.limitMode === 'common_ph' ? WEEKLY_COMMON_PH_LIMIT : item.weeklyLimit,
                available,
                requestedQuantity,
            };
        }

        const consumed = await consumeAvailablePa(db, evaluatorId, paCost);
        const purchaseInsert = await db.run(
            `INSERT INTO clover_pa_shop_purchases
             (evaluator_id, player_id, item_key, quantity, unit_pa_cost, pa_cost,
              reward_json, week_key, status, source, idempotency_key, created_by, reason, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, '{}', ?, 'completed', 'pa_shop', ?, ?, ?, ?)`,
            [
                evaluatorId,
                player.id,
                item.key,
                requestedQuantity,
                item.unitPaCost,
                paCost,
                weekKey,
                idempotencyKey || null,
                createdBy || evaluatorId,
                `Compra: ${item.name}`,
                JSON.stringify({ consumed_entries: consumed }),
            ]
        );
        const purchaseId = purchaseInsert.lastID;

        let reward = null;
        if (item.key === 'ph') {
            reward = await applyPhReward(db, player, requestedQuantity, purchaseId, evaluatorId, weekKey, paCost, consumed);
        } else if (item.key === 'yulls') {
            reward = await applyYullsReward(db, player.id, requestedQuantity);
        } else if (item.key === 'caixa_simples' || item.key === 'cupom_prioridade') {
            reward = await applyInventoryReward(db, player.id, item, purchaseId, evaluatorId);
        } else if (item.key === 'estrela_esquadrao') {
            reward = await applySquadStarReward(db, player, purchaseId, evaluatorId);
        }

        await db.run(
            `UPDATE clover_pa_shop_purchases
             SET reward_json = ?, metadata_json = ?
             WHERE id = ?`,
            [
                JSON.stringify(reward || {}),
                JSON.stringify({ consumed_entries: consumed, reward }),
                purchaseId,
            ]
        );
        await db.exec('COMMIT');

        return {
            ok: true,
            code: 'purchased',
            evaluatorId,
            player,
            item,
            quantity: requestedQuantity,
            paCost,
            purchaseId,
            weekKey,
            reward,
            availablePaBefore: availablePa,
            availablePaAfter: availablePa - paCost,
            usedBefore: used,
            limit: item.limitMode === 'common_ph' ? WEEKLY_COMMON_PH_LIMIT : item.weeklyLimit,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        if (error?.code === 'SQLITE_CONSTRAINT' && idempotencyKey) {
            const existing = await db.get(
                'SELECT * FROM clover_pa_shop_purchases WHERE idempotency_key = ?',
                [idempotencyKey]
            ).catch(() => null);
            if (existing) return { ok: false, code: 'duplicate', item, purchase: existing };
        }
        if (error?.code === 'insufficient_pa' || error?.code === 'no_squad') {
            return { ok: false, code: error.code, item };
        }
        throw error;
    }
}

module.exports = {
    WEEKLY_COMMON_PH_LIMIT,
    ensurePaShopDependencies,
    getPaShopSpendSummary,
    getPaShopState,
    listPaShopPurchases,
    purchasePaShopItem,
    readAvailablePa,
    resolvePaShopPlayer,
};