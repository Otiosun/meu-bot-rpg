'use strict';

const { ensureCloverInventorySchema } = require('../../database');
const { addCatalogItemInTransaction, ensureInventoryV1 } = require('./inventoryService');
const { addPhInTransaction } = require('./phService');
const { unlockPlayerTitleInTransaction } = require('./titleService');
const { addYullsInTransaction } = require('./yullsService');

const NIGHTMARE_EVENT_KEY = 'pesadelo_v1';
const NIGHTMARE_REWARD_SOURCE = 'evento_pesadelo';
const NIGHTMARE_TITLE = Object.freeze({
    key: 'sobrevivente_do_pesadelo',
    name: 'Sobrevivente do Pesadelo',
});
const NIGHTMARE_ITEM_KEYS = Object.freeze({
    commonBox: 'box_simple_v1',
    rareBox: 'box_rare_v1',
    spellTicket: 'ticket_feitico',
    priorityCoupon: 'cupom_prioridade',
    provisionalBlackWand: 'custom_vareta_negra_provisoria',
});

const PROVISIONAL_BLACK_WAND_TEMPLATE = Object.freeze({
    key: NIGHTMARE_ITEM_KEYS.provisionalBlackWand,
    itemName: 'Vareta Negra — Provisória',
    description: 'Registro provisório da Vareta Negra conquistada no Evento Pesadelo. O item permanece bloqueado até a migração definitiva.',
    category: 'equipamento',
    kind: 'item_provisorio',
    origin: 'Evento Pesadelo',
    properties: Object.freeze({
        bound: true,
        sellable: false,
        tradable: false,
        transferable: false,
        usable: false,
        pendingMigration: true,
    }),
    metadata: Object.freeze({
        eventKey: NIGHTMARE_EVENT_KEY,
        provisional: true,
        pendingMigration: true,
        nonSellable: true,
        nonTransferable: true,
        nonUsable: true,
    }),
});

class NightmareRewardServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'NightmareRewardServiceError';
        this.code = code;
        this.details = details;
    }
}

function keyFor(playerId, component) {
    return `${NIGHTMARE_EVENT_KEY}:${String(playerId || '').trim()}:${component}`;
}

function assertPositiveInteger(value, field, options = {}) {
    const number = Number(value || 0);
    if (!Number.isInteger(number) || number < 0 || (!options.allowZero && number === 0)) {
        throw new NightmareRewardServiceError('invalid_reward_package', `${field} inválido.`, { field, value });
    }
    return number;
}

async function ensureNightmareRewardInfrastructure(db) {
    await ensureCloverInventorySchema(db);
    await ensureInventoryV1(db);
    const item = PROVISIONAL_BLACK_WAND_TEMPLATE;
    await db.run(
        `INSERT INTO clover_item_templates (
            template_key, catalog_version, item_name, description, category, kind, origin,
            base_price, default_quality, default_durability, stackable, transferable,
            properties_json, effects_json, metadata_json, active, is_custom, requestable,
            marketable, duplicable, created_by, updated_by, created_at, updated_at
         ) VALUES (?, 1, ?, ?, ?, ?, ?, 0, 'comum', NULL, 0, 0, ?, '{}', ?, 1, 1, 0, 0, 1,
                   'system:evento_pesadelo', 'system:evento_pesadelo', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(template_key) DO UPDATE SET
            item_name = excluded.item_name,
            description = excluded.description,
            category = excluded.category,
            kind = excluded.kind,
            origin = excluded.origin,
            base_price = 0,
            default_durability = NULL,
            stackable = 0,
            transferable = 0,
            properties_json = excluded.properties_json,
            effects_json = '{}',
            metadata_json = excluded.metadata_json,
            active = 1,
            requestable = 0,
            marketable = 0,
            duplicable = 1,
            updated_by = 'system:evento_pesadelo',
            updated_at = CURRENT_TIMESTAMP`,
        [
            item.key,
            item.itemName,
            item.description,
            item.category,
            item.kind,
            item.origin,
            JSON.stringify(item.properties),
            JSON.stringify(item.metadata),
        ]
    );
}

async function existingPhGrant(db, playerId, relatedId, expectedAmount) {
    const rows = await db.all(
        `SELECT id, amount, kind, source, related_id
         FROM clover_ph_ledger
         WHERE player_id = ? AND source = ? AND related_id = ?
         ORDER BY id ASC`,
        [playerId, NIGHTMARE_REWARD_SOURCE, relatedId]
    );
    if (!rows.length) return null;
    if (rows.length !== 1 || rows[0].kind !== 'ganho' || Number(rows[0].amount) !== expectedAmount) {
        throw new NightmareRewardServiceError('ph_idempotency_conflict', 'O PH do evento já possui um registro incompatível.', {
            playerId,
            relatedId,
            expectedAmount,
            rows,
        });
    }
    return rows[0];
}

async function grantPhOnceInTransaction(db, playerId, amount, actorId) {
    const value = assertPositiveInteger(amount, 'PH');
    const relatedId = keyFor(playerId, 'ph');
    const existing = await existingPhGrant(db, playerId, relatedId, value);
    if (existing) return { ok: true, duplicate: true, ledgerId: existing.id, amount: value };
    const result = await addPhInTransaction(
        db,
        playerId,
        value,
        NIGHTMARE_REWARD_SOURCE,
        'Premiação do Evento Pesadelo — PH fora do teto semanal',
        actorId,
        { outside_weekly_cap: true, event_key: NIGHTMARE_EVENT_KEY },
        relatedId
    );
    return { ...result, duplicate: false };
}

async function grantYullsOnceInTransaction(db, playerId, amount, actorId) {
    const value = assertPositiveInteger(amount, 'Yulls');
    const idempotencyKey = keyFor(playerId, 'yulls');
    const existing = await db.get(
        `SELECT * FROM clover_yulls_ledger WHERE idempotency_key = ?`,
        [idempotencyKey]
    );
    if (existing) {
        if (existing.player_id !== playerId || Number(existing.amount) !== value) {
            throw new NightmareRewardServiceError('yulls_idempotency_conflict', 'Os Yulls do evento já possuem um registro incompatível.', {
                playerId,
                idempotencyKey,
                expectedAmount: value,
                existing,
            });
        }
        return { ok: true, duplicate: true, ledgerId: existing.id, amount: value };
    }
    return addYullsInTransaction(
        db,
        playerId,
        value,
        NIGHTMARE_REWARD_SOURCE,
        'Premiação do Evento Pesadelo',
        actorId,
        {
            relatedId: NIGHTMARE_EVENT_KEY,
            idempotencyKey,
            metadata: { event_key: NIGHTMARE_EVENT_KEY },
        }
    );
}

async function existingItemGrant(db, playerId, idempotencyKey, expectedQuantity) {
    const rows = await db.all(
        `SELECT id, item_id, quantity_delta, action, idempotency_key
         FROM clover_inventory_item_history
         WHERE player_id = ? AND idempotency_key = ?
         ORDER BY id ASC`,
        [playerId, idempotencyKey]
    );
    if (!rows.length) return null;
    const delivered = rows.reduce((total, row) => total + Math.max(0, Number(row.quantity_delta || 0)), 0);
    if (delivered !== expectedQuantity) {
        throw new NightmareRewardServiceError('item_idempotency_conflict', 'O item do evento já possui um histórico incompatível.', {
            playerId,
            idempotencyKey,
            expectedQuantity,
            delivered,
            rows,
        });
    }
    return rows;
}

async function grantItemOnceInTransaction(db, playerId, templateKey, quantity, component, actorId, options = {}) {
    const value = assertPositiveInteger(quantity, component, { allowZero: true });
    if (value === 0) return { ok: true, skipped: true, duplicate: false, quantity: 0, items: [] };
    const idempotencyKey = keyFor(playerId, component);
    const existing = await existingItemGrant(db, playerId, idempotencyKey, value);
    if (existing) return { ok: true, duplicate: true, quantity: value, historyIds: existing.map((row) => row.id), items: [] };
    const result = await addCatalogItemInTransaction(db, playerId, templateKey, value, {
        source: NIGHTMARE_REWARD_SOURCE,
        relatedId: NIGHTMARE_EVENT_KEY,
        idempotencyKey,
        createdBy: actorId,
        bound: options.bound,
        forceSeparate: options.forceSeparate,
        properties: options.properties,
        metadata: {
            event_key: NIGHTMARE_EVENT_KEY,
            reward_component: component,
            ...(options.metadata || {}),
        },
    });
    return { ...result, duplicate: false };
}

async function grantTitleOnceInTransaction(db, playerId, actorId) {
    return unlockPlayerTitleInTransaction(db, playerId, {
        titleKey: NIGHTMARE_TITLE.key,
        titleName: NIGHTMARE_TITLE.name,
        source: NIGHTMARE_REWARD_SOURCE,
        relatedId: NIGHTMARE_EVENT_KEY,
        metadata: { event_key: NIGHTMARE_EVENT_KEY, unlocked_by: actorId },
    });
}

async function applyNightmareRewardPackageInTransaction(db, playerId, rewardPackage, actorId = 'system:evento_pesadelo') {
    const target = await db.get('SELECT id FROM jogadores WHERE id = ?', [playerId]);
    if (!target) throw new NightmareRewardServiceError('player_not_found', 'Player não encontrado.', { playerId });

    const normalized = {
        yulls: assertPositiveInteger(rewardPackage.yulls, 'Yulls'),
        ph: assertPositiveInteger(rewardPackage.ph, 'PH'),
        rareBoxes: assertPositiveInteger(rewardPackage.rareBoxes, 'Caixas Raras', { allowZero: true }),
        commonBoxes: assertPositiveInteger(rewardPackage.commonBoxes, 'Caixas Comuns', { allowZero: true }),
        spellTickets: assertPositiveInteger(rewardPackage.spellTickets, 'Tickets de Feitiço', { allowZero: true }),
        priorityCoupons: assertPositiveInteger(rewardPackage.priorityCoupons, 'Cupons de Prioridade', { allowZero: true }),
        provisionalBlackWands: assertPositiveInteger(rewardPackage.provisionalBlackWands, 'Varetas Negras', { allowZero: true }),
    };

    return {
        playerId,
        yulls: await grantYullsOnceInTransaction(db, playerId, normalized.yulls, actorId),
        ph: await grantPhOnceInTransaction(db, playerId, normalized.ph, actorId),
        rareBoxes: await grantItemOnceInTransaction(db, playerId, NIGHTMARE_ITEM_KEYS.rareBox, normalized.rareBoxes, 'caixas_raras', actorId),
        commonBoxes: await grantItemOnceInTransaction(db, playerId, NIGHTMARE_ITEM_KEYS.commonBox, normalized.commonBoxes, 'caixas_comuns', actorId),
        spellTickets: await grantItemOnceInTransaction(db, playerId, NIGHTMARE_ITEM_KEYS.spellTicket, normalized.spellTickets, 'tickets_feitico', actorId),
        priorityCoupons: await grantItemOnceInTransaction(db, playerId, NIGHTMARE_ITEM_KEYS.priorityCoupon, normalized.priorityCoupons, 'cupons_prioridade', actorId),
        provisionalBlackWands: await grantItemOnceInTransaction(
            db,
            playerId,
            NIGHTMARE_ITEM_KEYS.provisionalBlackWand,
            normalized.provisionalBlackWands,
            'varetas_negras_provisorias',
            actorId,
            {
                bound: true,
                forceSeparate: true,
                properties: PROVISIONAL_BLACK_WAND_TEMPLATE.properties,
                metadata: PROVISIONAL_BLACK_WAND_TEMPLATE.metadata,
            }
        ),
        title: await grantTitleOnceInTransaction(db, playerId, actorId),
    };
}

module.exports = {
    NIGHTMARE_EVENT_KEY,
    NIGHTMARE_ITEM_KEYS,
    NIGHTMARE_REWARD_SOURCE,
    NIGHTMARE_TITLE,
    NightmareRewardServiceError,
    PROVISIONAL_BLACK_WAND_TEMPLATE,
    applyNightmareRewardPackageInTransaction,
    ensureNightmareRewardInfrastructure,
    keyFor,
};
