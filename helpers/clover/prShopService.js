'use strict';

const crypto = require('crypto');
const { ensureCloverRecruitmentSchema } = require('../../database');
const { addPhInTransaction, ensurePhState } = require('./phService');
const {
    DEFAULT_EVENT_KEY,
    getEvent,
    getMondayWeekKey,
    getPrBalance,
    mutatePrInTransaction,
} = require('./prService');
const { ensureRecruitmentGroupSchema } = require('./recruitmentGroupService');
const {
    addCatalogItemInTransaction,
    ensureInventoryV1,
} = require('./inventoryService');
const { seedSeasonalEventTemplates } = require('./seasonalEventCatalog');
const { grantPlayerTitleInTransaction } = require('./titleService');
const { addYullsInTransaction, ensureYullsState } = require('./yullsService');

const SHOP_CATALOG_VERSION = 1;

function item(key, name, cost, reward, limits, presentation = {}) {
    return Object.freeze({ key, name, cost, reward, limits, presentation });
}

const PR_SHOP_CATALOG = Object.freeze([
    item('yulls_2500', '2.500 Yulls', 1, { type: 'yulls', amount: 2500 }, { weekly: 10 }, { icon: 'coins', tier: 'common', impulse: 'baixo_custo' }),
    item('caixa_simples', 'Caixa Simples', 3, { type: 'item', templateKey: 'box_simple_v1' }, { weekly: 10 }, { icon: 'box', tier: 'common', impulse: 'recompensa_variavel' }),
    item('ph_5', '5 PH fora do teto', 5, { type: 'ph', amount: 5 }, { weekly: 6 }, { icon: 'spark', tier: 'growth', impulse: 'progresso' }),
    item('caixa_rara', 'Caixa Rara', 6, { type: 'item', templateKey: 'box_rare_v1' }, { weekly: 5 }, { icon: 'gem', tier: 'rare', impulse: 'escassez' }),
    item('ticket_feitico', 'Ticket de Feitiço', 15, { type: 'item', templateKey: 'ticket_feitico' }, { weekly: 1 }, { icon: 'ticket', tier: 'special', impulse: 'planejamento' }),
    item('cupom_prioridade_feitico', 'Cupom de Prioridade em Feitiço', 20, { type: 'item', templateKey: 'cupom_prioridade' }, { weekly: 1 }, { icon: 'priority', tier: 'special', impulse: 'urgencia' }),
    item('titulo_recrutador', 'Título de Recrutador', 20, { type: 'title', titleKey: 'titulo_recrutador', titleName: 'Título de Recrutador' }, { oneTime: true }, { icon: 'crown', tier: 'permanent', impulse: 'identidade' }),
    item('dungeon_exclusiva', 'Dungeon Exclusiva', 30, { type: 'item', templateKey: 'acesso_dungeon_exclusiva' }, { eventGlobal: 8 }, { icon: 'dungeon', tier: 'legendary', impulse: 'competicao_global' }),
]);

const SHOP_ITEM_MAP = new Map(
    PR_SHOP_CATALOG.map((entry) => [entry.key, entry])
);

class PrShopServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PrShopServiceError';
        this.code = code;
        this.details = details;
    }
}

function parseSqliteDate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const date = new Date(text.includes('T') ? text : text.replace(' ', 'T'));
    return Number.isNaN(date.getTime()) ? null : date;
}

function eventIsActive(event, at = new Date()) {
    if (String(event?.status || '') !== 'active') return false;
    const now = new Date(at);
    const startsAt = parseSqliteDate(event.starts_at);
    const endsAt = parseSqliteDate(event.ends_at);
    return (!startsAt || now >= startsAt) && (!endsAt || now <= endsAt);
}

function nextWeeklyReset(at = new Date()) {
    const current = new Date(at);
    current.setHours(0, 0, 0, 0);
    const daysUntilMonday = (8 - current.getDay()) % 7 || 7;
    current.setDate(current.getDate() + daysUntilMonday);
    return current.toISOString();
}

function normalizeQuantity(value) {
    const quantity = Number(value ?? 1);
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100) {
        throw new PrShopServiceError(
            'invalid_quantity',
            'Informe uma quantidade entre 1 e 100.'
        );
    }
    return quantity;
}

function safeJson(value, fallback = null) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function ensurePrShopSchema(db) {
    await ensureCloverRecruitmentSchema(db);
    await ensureRecruitmentGroupSchema(db);
    await ensureInventoryV1(db);
    await seedSeasonalEventTemplates(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_pr_shop_purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            purchase_key TEXT NOT NULL UNIQUE,
            event_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            item_key TEXT NOT NULL,
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_pr_cost INTEGER NOT NULL CHECK (unit_pr_cost > 0),
            total_pr_cost INTEGER NOT NULL CHECK (total_pr_cost > 0),
            week_key TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
            pr_ledger_id INTEGER DEFAULT NULL,
            result_json TEXT DEFAULT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            completed_at TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            FOREIGN KEY (event_id) REFERENCES clover_recruitment_events(id),
            FOREIGN KEY (pr_ledger_id) REFERENCES clover_pr_ledger(id)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_pr_shop_player_week
        ON clover_pr_shop_purchases
        (player_id, event_id, item_key, week_key, status)
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_pr_shop_event_item
        ON clover_pr_shop_purchases (event_id, item_key, status, id)
    `);
    await db.run(
        `UPDATE clover_recruitment_events
         SET shop_enabled = 1, updated_at = CURRENT_TIMESTAMP
         WHERE event_key = ? AND shop_enabled = 0`,
        [DEFAULT_EVENT_KEY]
    );
}

async function ensureReleasedPlayer(db, playerId) {
    const player = await db.get(
        `SELECT id, personagem_nome, nome, display_name, jogo_status
         FROM jogadores
         WHERE id = ?`,
        [playerId]
    );
    if (!player) {
        throw new PrShopServiceError(
            'player_not_found',
            'Player não encontrado.'
        );
    }
    if (String(player.jogo_status || '').toLowerCase() !== 'liberado') {
        throw new PrShopServiceError(
            'game_blocked',
            'A loja de PR fica disponível depois da liberação do personagem.'
        );
    }
    return player;
}

async function purchaseCount(db, filters) {
    const clauses = [`status = 'completed'`];
    const params = [];
    for (const [column, value] of Object.entries(filters)) {
        clauses.push(`${column} = ?`);
        params.push(value);
    }
    const row = await db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS total
         FROM clover_pr_shop_purchases
         WHERE ${clauses.join(' AND ')}`,
        params
    );
    return Number(row?.total || 0);
}

async function buildCatalogEntry(db, playerId, event, weekKey, entry) {
    const weeklyPurchased = entry.limits.weekly
        ? await purchaseCount(db, {
            player_id: playerId,
            event_id: event.id,
            item_key: entry.key,
            week_key: weekKey,
        })
        : 0;
    const playerEventPurchased = entry.limits.oneTime
        ? await purchaseCount(db, {
            player_id: playerId,
            item_key: entry.key,
        })
        : 0;
    const globalPurchased = entry.limits.eventGlobal
        ? await purchaseCount(db, {
            event_id: event.id,
            item_key: entry.key,
        })
        : 0;
    const weeklyRemaining = entry.limits.weekly === undefined
        ? null
        : Math.max(0, entry.limits.weekly - weeklyPurchased);
    const globalRemaining = entry.limits.eventGlobal === undefined
        ? null
        : Math.max(0, entry.limits.eventGlobal - globalPurchased);
    const available =
        (!entry.limits.oneTime || playerEventPurchased === 0)
        && (weeklyRemaining === null || weeklyRemaining > 0)
        && (globalRemaining === null || globalRemaining > 0);

    return {
        ...entry,
        limits: {
            ...entry.limits,
            weeklyPurchased,
            weeklyRemaining,
            playerEventPurchased,
            globalPurchased,
            globalRemaining,
        },
        available,
        soldOut: !available,
        scarcity: globalRemaining === null ? null : {
            used: globalPurchased,
            total: entry.limits.eventGlobal,
            remaining: globalRemaining,
            percentUsed: Math.round(
                (globalPurchased / entry.limits.eventGlobal) * 100
            ),
        },
    };
}

async function getPrShopDashboard(db, playerId, options = {}) {
    await ensurePrShopSchema(db);
    await ensureReleasedPlayer(db, playerId);
    const at = new Date(options.at || new Date());
    const event = await getEvent(
        db,
        options.eventKey || DEFAULT_EVENT_KEY
    );
    const weekKey = options.weekKey || getMondayWeekKey(at);
    const balance = await getPrBalance(db, playerId);
    const catalog = [];
    for (const entry of PR_SHOP_CATALOG) {
        catalog.push(
            await buildCatalogEntry(db, playerId, event, weekKey, entry)
        );
    }
    return {
        catalogVersion: SHOP_CATALOG_VERSION,
        event: {
            id: event.id,
            key: event.event_key,
            name: event.name,
            status: event.status,
            active: eventIsActive(event, at),
            shopEnabled: Boolean(event.shop_enabled),
            startsAt: event.starts_at,
            endsAt: event.ends_at,
        },
        playerId,
        balance,
        weekKey,
        nextWeeklyReset: nextWeeklyReset(at),
        resetPolicy: {
            weekly: [
                'yulls_2500',
                'caixa_simples',
                'ph_5',
                'caixa_rara',
                'ticket_feitico',
                'cupom_prioridade_feitico',
            ],
            oneTime: ['titulo_recrutador'],
            eventGlobal: ['dungeon_exclusiva'],
        },
        items: catalog,
    };
}

async function deliverShopReward(
    db,
    playerId,
    event,
    purchaseId,
    entry,
    quantity
) {
    const relatedId = `pr_shop_purchase:${purchaseId}`;
    const metadata = {
        shop_item_key: entry.key,
        quantity,
        event_id: event.id,
    };

    if (entry.reward.type === 'yulls') {
        const amount = entry.reward.amount * quantity;
        const result = await addYullsInTransaction(
            db,
            playerId,
            amount,
            'loja_pr',
            `Loja de PR: ${entry.name}`,
            playerId,
            {
                relatedId,
                idempotencyKey: `yulls:${relatedId}`,
                metadata,
            }
        );
        return { type: 'yulls', amount, ledgerId: result.ledgerId };
    }

    if (entry.reward.type === 'ph') {
        const amount = entry.reward.amount * quantity;
        const result = await addPhInTransaction(
            db,
            playerId,
            amount,
            'loja_pr',
            `Loja de PR: ${entry.name} — fora do teto semanal`,
            playerId,
            { ...metadata, outside_weekly_cap: true },
            relatedId
        );
        return {
            type: 'ph',
            amount,
            outsideWeeklyCap: true,
            ledgerId: result.ledgerId,
        };
    }

    if (entry.reward.type === 'title') {
        if (quantity !== 1) {
            throw new PrShopServiceError(
                'title_quantity_invalid',
                'O título só pode ser comprado uma vez.'
            );
        }
        const titleResult = await grantPlayerTitleInTransaction(
            db,
            playerId,
            {
                key: entry.reward.titleKey,
                name: entry.reward.titleName,
            },
            {
                source: 'loja_pr',
                relatedId,
                actorId: playerId,
                reason: `Loja de PR: ${entry.name}`,
                idempotencyKey: `title:${relatedId}`,
                metadata,
            }
        );
        if (!titleResult.newlyUnlocked) {
            throw new PrShopServiceError(
                'one_time_already_owned',
                'Esse título já pertence ao player.'
            );
        }
        return {
            type: 'title',
            titleKey: entry.reward.titleKey,
            titleName: entry.reward.titleName,
            titleId: titleResult.title.id,
            newlyUnlocked: true,
        };
    }

    if (entry.reward.type === 'item') {
        const added = await addCatalogItemInTransaction(
            db,
            playerId,
            entry.reward.templateKey,
            quantity,
            {
                source: 'loja_pr',
                relatedId,
                createdBy: playerId,
                metadata,
            }
        );
        return {
            type: 'item',
            templateKey: entry.reward.templateKey,
            quantity,
            items: added.items.map((row) => ({
                id: row.id,
                name: row.item_name,
                quantity: row.quantity,
            })),
        };
    }

    throw new PrShopServiceError(
        'unsupported_reward',
        'A recompensa desta oferta ainda não está configurada.'
    );
}

async function findPurchaseByIdempotency(db, idempotencyKey) {
    return db.get(
        'SELECT * FROM clover_pr_shop_purchases WHERE idempotency_key = ?',
        [idempotencyKey]
    );
}

function serializePurchase(row, duplicate = false) {
    return {
        ok: row.status === 'completed',
        duplicate,
        purchaseId: row.id,
        purchaseKey: row.purchase_key,
        itemKey: row.item_key,
        quantity: Number(row.quantity),
        unitPrCost: Number(row.unit_pr_cost),
        totalPrCost: Number(row.total_pr_cost),
        weekKey: row.week_key,
        reward: safeJson(row.result_json, null),
        completedAt: row.completed_at,
    };
}

async function purchasePrShopItem(
    db,
    playerId,
    itemKey,
    quantityInput = 1,
    options = {}
) {
    const key = String(itemKey || '').trim().toLowerCase();
    const entry = SHOP_ITEM_MAP.get(key);
    if (!entry) {
        throw new PrShopServiceError(
            'shop_item_not_found',
            'Oferta de PR não encontrada.'
        );
    }
    const quantity = normalizeQuantity(quantityInput);
    const idempotencyKey = String(options.idempotencyKey || '').trim();
    if (!idempotencyKey) {
        throw new PrShopServiceError(
            'missing_idempotency_key',
            'A compra precisa de uma identificação única.'
        );
    }

    await ensurePrShopSchema(db);
    await ensureReleasedPlayer(db, playerId);
    await ensurePhState(db, playerId);
    await ensureYullsState(db, playerId);
    const event = await getEvent(
        db,
        options.eventKey || DEFAULT_EVENT_KEY
    );
    const at = new Date(options.at || new Date());
    if (!Boolean(event.shop_enabled) || !eventIsActive(event, at)) {
        throw new PrShopServiceError(
            'shop_not_active',
            'A Loja de PR não está disponível neste momento.'
        );
    }
    const weekKey = options.weekKey || getMondayWeekKey(at);
    const existing = await findPurchaseByIdempotency(db, idempotencyKey);
    if (existing) {
        if (
            existing.player_id !== playerId
            || existing.item_key !== key
        ) {
            throw new PrShopServiceError(
                'idempotency_conflict',
                'Essa identificação já pertence a outra compra.'
            );
        }
        return {
            ...serializePurchase(existing, true),
            dashboard: await getPrShopDashboard(db, playerId, {
                at,
                weekKey,
            }),
        };
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const duplicate = await findPurchaseByIdempotency(
            db,
            idempotencyKey
        );
        if (duplicate) {
            await db.exec('COMMIT');
            return {
                ...serializePurchase(duplicate, true),
                dashboard: await getPrShopDashboard(db, playerId, {
                    at,
                    weekKey,
                }),
            };
        }

        const state = await buildCatalogEntry(
            db,
            playerId,
            event,
            weekKey,
            entry
        );
        if (
            entry.limits.weekly
            && quantity > Number(state.limits.weeklyRemaining || 0)
        ) {
            throw new PrShopServiceError(
                'weekly_limit',
                `Restam ${state.limits.weeklyRemaining} unidade(s) desta oferta na semana.`,
                { remaining: state.limits.weeklyRemaining }
            );
        }
        if (entry.limits.oneTime && !state.available) {
            throw new PrShopServiceError(
                'one_time_limit',
                'Essa recompensa é uma compra única e já foi adquirida.'
            );
        }
        if (
            entry.limits.eventGlobal
            && quantity > Number(state.limits.globalRemaining || 0)
        ) {
            throw new PrShopServiceError(
                'global_stock',
                `Restam ${state.limits.globalRemaining} unidade(s) globais no evento.`,
                { remaining: state.limits.globalRemaining }
            );
        }

        const totalCost = entry.cost * quantity;
        const balance = await getPrBalance(db, playerId);
        if (balance < totalCost) {
            throw new PrShopServiceError(
                'insufficient_pr',
                `Saldo insuficiente: a compra custa ${totalCost} PR e o saldo é ${balance} PR.`,
                { balance, totalCost }
            );
        }

        const purchaseKey = typeof crypto.randomUUID === 'function'
            ? `prshop_${crypto.randomUUID()}`
            : `prshop_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
        const inserted = await db.run(
            `INSERT INTO clover_pr_shop_purchases (
                purchase_key, event_id, player_id, item_key, quantity,
                unit_pr_cost, total_pr_cost, week_key, status, pr_ledger_id,
                result_json, idempotency_key, created_by, created_at,
                metadata_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, CURRENT_TIMESTAMP, ?)`,
            [
                purchaseKey,
                event.id,
                playerId,
                key,
                quantity,
                entry.cost,
                totalCost,
                entry.limits.weekly ? weekKey : null,
                idempotencyKey,
                options.createdBy || playerId,
                JSON.stringify({
                    via: options.via || 'bot',
                    catalog_version: SHOP_CATALOG_VERSION,
                }),
            ]
        );
        const purchaseId = inserted.lastID;
        const spend = await mutatePrInTransaction(db, playerId, {
            amount: -totalCost,
            kind: 'gasto',
            source: 'loja',
            reason: `Loja de PR: ${entry.name} x${quantity}`,
            createdBy: options.createdBy || playerId,
            eventKey: event.event_key,
            weekKey,
            relatedId: `pr_shop_purchase:${purchaseId}`,
            idempotencyKey: `pr:${idempotencyKey}`,
            metadata: {
                item_key: key,
                quantity,
                unit_cost: entry.cost,
                total_cost: totalCost,
            },
        });

        const reward = await deliverShopReward(
            db,
            playerId,
            event,
            purchaseId,
            entry,
            quantity
        );
        await db.run(
            `UPDATE clover_pr_shop_purchases
             SET status = 'completed',
                 pr_ledger_id = ?,
                 result_json = ?,
                 completed_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [spend.ledgerId, JSON.stringify(reward), purchaseId]
        );
        const completed = await db.get(
            'SELECT * FROM clover_pr_shop_purchases WHERE id = ?',
            [purchaseId]
        );
        await db.exec('COMMIT');
        return {
            ...serializePurchase(completed, false),
            balanceBefore: spend.balanceBefore,
            balanceAfter: spend.balanceAfter,
            dashboard: await getPrShopDashboard(db, playerId, {
                at,
                weekKey,
            }),
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    PR_SHOP_CATALOG,
    SHOP_CATALOG_VERSION,
    PrShopServiceError,
    ensurePrShopSchema,
    getPrShopDashboard,
    nextWeeklyReset,
    purchasePrShopItem,
};
