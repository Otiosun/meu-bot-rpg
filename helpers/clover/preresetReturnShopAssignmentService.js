'use strict';

const { equivalentPlayerIds } = require('./playerIdentityEquivalenceService');

class PreresetReturnShopAssignmentError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreresetReturnShopAssignmentError';
        this.code = code;
        this.details = details;
    }
}

function safeJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function normalizePlayerId(value) {
    return String(value || '').trim();
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [tableName]
    );
    return Boolean(row?.ok);
}

async function expandedPlayerIds(db, playerId) {
    const ids = new Set();
    const add = (value) => {
        const text = normalizePlayerId(value);
        if (text) ids.add(text);
    };
    add(playerId);
    for (const id of await equivalentPlayerIds(db, playerId).catch(() => [])) {
        add(id);
    }
    return [...ids];
}

function itemLabels(metadata) {
    if (!Array.isArray(metadata.items)) return [];
    return metadata.items
        .map((item) => {
            const quantity = Number(item.quantity || 1);
            const label = String(item.label || item.key || '').trim();
            if (!label) return null;
            return quantity > 1 ? `${quantity}x ${label}` : label;
        })
        .filter(Boolean);
}

function purchaseLabel(row, metadata) {
    const request = String(metadata?.attempt?.request || '').trim();
    if (request) return request;
    const labels = itemLabels(metadata);
    if (labels.length) return labels.join(' + ');
    return row.catalog_item_key || row.entitlement_key;
}

function exclusiveCategories(metadata) {
    const explicit = Array.isArray(metadata.exclusive_categories)
        ? metadata.exclusive_categories.filter(Boolean)
        : [];
    const fromItems = Array.isArray(metadata.items)
        ? metadata.items.map((item) => item.exclusive_category).filter(Boolean)
        : [];
    return [...new Set([...explicit, ...fromItems])];
}

function requiresRollAssignment(metadata) {
    if (metadata.requires_roll_assignment === true) return true;
    if (String(metadata.fulfillment_status || '') === 'pending_roll_assignment') return true;
    if (exclusiveCategories(metadata).length) return true;
    if (!Array.isArray(metadata.items)) return false;
    return metadata.items.some((item) => ['rareTrait', 'rareMark', 'anomaly'].includes(item.key));
}

function targetRollNumber(metadata) {
    const number = Number(metadata.target_roll_number || 0);
    return Number.isInteger(number) && number > 0 ? number : null;
}

async function listReturnShopEntitlements(db, playerId) {
    if (!await tableExists(db, 'clover_prereset_entitlements')) return [];
    if (!await tableExists(db, 'clover_prereset_purchases')) return [];

    const ids = await expandedPlayerIds(db, playerId);
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT
             e.id AS entitlement_id,
             e.player_id AS entitlement_player_id,
             e.entitlement_key,
             e.status AS entitlement_status,
             e.metadata_json AS entitlement_metadata_json,
             e.created_at AS entitlement_created_at,
             e.consumed_at,
             p.id AS purchase_id,
             p.player_id AS purchase_player_id,
             p.idempotency_key,
             p.catalog_item_key,
             p.price_return_points,
             p.status AS purchase_status,
             p.metadata_json AS purchase_metadata_json,
             p.created_at AS purchase_created_at
         FROM clover_prereset_entitlements e
         JOIN clover_prereset_purchases p ON p.id = e.purchase_id
         WHERE e.player_id IN (${placeholders})
           AND e.status = 'active'
           AND p.status = 'completed'
           AND (
                e.entitlement_key LIKE 'return_shop_package:%'
                OR p.catalog_item_key LIKE 'return_shop_%'
           )
         ORDER BY COALESCE(e.created_at, p.created_at), e.id`,
        ids
    );

    return rows.map((row, index) => {
        const entitlementMetadata = safeJson(row.entitlement_metadata_json);
        const purchaseMetadata = safeJson(row.purchase_metadata_json);
        const metadata = {
            ...purchaseMetadata,
            ...entitlementMetadata,
        };
        const rollRequired = requiresRollAssignment(metadata);
        const rollNumber = targetRollNumber(metadata);
        return {
            index: index + 1,
            entitlementId: row.entitlement_id,
            purchaseId: row.purchase_id,
            playerId: row.entitlement_player_id,
            entitlementKey: row.entitlement_key,
            idempotencyKey: row.idempotency_key,
            catalogItemKey: row.catalog_item_key,
            priceReturnPoints: Number(row.price_return_points || 0),
            label: purchaseLabel(row, metadata),
            metadata,
            requiresRollAssignment: rollRequired,
            targetRollNumber: rollNumber,
            fulfillmentStatus: metadata.fulfillment_status || 'pending',
            exclusiveCategories: exclusiveCategories(metadata),
            createdAt: row.entitlement_created_at || row.purchase_created_at || null,
        };
    });
}

async function getRollByNumber(db, playerId, rollNumber, options = {}) {
    const ids = await expandedPlayerIds(db, playerId);
    if (!ids.length) return null;
    const placeholders = ids.map(() => '?').join(', ');
    if (await tableExists(db, 'clover_prereset_future_rolls')) {
        const campaignKey = options.campaignKey || 'mythic_launch_v1';
        const rows = await db.all(
            `SELECT * FROM clover_prereset_future_rolls
             WHERE campaign_key = ? AND player_id IN (${placeholders}) AND roll_number = ?`,
            [campaignKey, ...ids, rollNumber]
        );
        if (rows.length > 1) {
            throw new PreresetReturnShopAssignmentError(
                'ambiguous_future_roll', 'Ha mais de um roll futuro vinculado a essa identidade. A equipe precisa conferir o cadastro.'
            );
        }
        return rows[0] || null;
    }
    if (options.campaignKey) return null;
    return db.get(
        `SELECT *
           FROM player_rolls
          WHERE player_id IN (${placeholders})
            AND roll_number = ?
          ORDER BY CASE WHEN player_id = ? THEN 0 ELSE 1 END
          LIMIT 1`,
        [...ids, rollNumber, playerId]
    );
}

async function assertReturnShopRollMutable(db, roll) {
    if (!roll?.campaign_key || !await tableExists(db, 'clover_prereset_characters')) return;
    const ids = await expandedPlayerIds(db, roll.player_id);
    const drafts = await db.all(
        `SELECT status FROM clover_prereset_characters WHERE player_id IN (${ids.map(() => '?').join(',')})`, ids
    );
    if (drafts.some((draft) => draft.status !== 'draft')) {
        throw new PreresetReturnShopAssignmentError(
            'future_character_locked', 'Sua ficha futura ja foi enviada. Solicite a revisao antes de alterar compras do roll.'
        );
    }
}

function assignedCategoryMap(entitlements, selectedEntitlementId, rollNumber) {
    const map = new Map();
    for (const entry of entitlements) {
        if (entry.entitlementId === selectedEntitlementId) continue;
        if (Number(entry.targetRollNumber || 0) !== Number(rollNumber)) continue;
        for (const category of entry.exclusiveCategories) {
            if (!map.has(category)) map.set(category, entry);
        }
    }
    return map;
}

function appendAssignmentHistory(metadata, change) {
    const history = Array.isArray(metadata.assignment_history)
        ? metadata.assignment_history.slice(-20)
        : [];
    history.push(change);
    return history;
}

function buildAssignedMetadata(metadata, rollNumber, actorId, source) {
    const now = new Date().toISOString();
    const previousRollNumber = targetRollNumber(metadata);
    const change = {
        at: now,
        by: actorId || null,
        source,
        previous_target_roll_number: previousRollNumber,
        target_roll_number: rollNumber,
    };
    return {
        ...metadata,
        fulfillment_status: 'roll_assigned_pending_fulfillment',
        target_roll_number: rollNumber,
        roll_assigned_at: now,
        roll_assigned_by: actorId || null,
        roll_assignment_source: source,
        assignment_history: appendAssignmentHistory(metadata, change),
    };
}

async function updatePurchaseMetadata(db, purchaseId, patch) {
    const purchase = await db.get(
        'SELECT metadata_json FROM clover_prereset_purchases WHERE id = ?',
        [purchaseId]
    );
    const metadata = {
        ...safeJson(purchase?.metadata_json),
        ...patch,
    };
    await db.run(
        'UPDATE clover_prereset_purchases SET metadata_json = ? WHERE id = ?',
        [JSON.stringify(metadata), purchaseId]
    );
}

async function assignInTransaction(db, playerId, selection, rollNumber, options = {}) {
    const selectedIndex = Number(selection);
    const selectedRollNumber = Number(rollNumber);
    if (!Number.isInteger(selectedIndex) || selectedIndex <= 0) {
        throw new PreresetReturnShopAssignmentError(
            'invalid_entitlement_selection',
            'Informe o numero da compra que aparece em .#pr compras.'
        );
    }
    if (!Number.isInteger(selectedRollNumber) || selectedRollNumber <= 0) {
        throw new PreresetReturnShopAssignmentError(
            'invalid_roll_number',
            'Informe um numero de roll valido.'
        );
    }

    const roll = await getRollByNumber(db, playerId, selectedRollNumber, options);
    if (!roll) {
        throw new PreresetReturnShopAssignmentError(
            'roll_not_found',
            `Nao encontrei o roll #${selectedRollNumber} nos seus sorteios salvos.`,
            { rollNumber: selectedRollNumber }
        );
    }
    await assertReturnShopRollMutable(db, roll);
    if (roll.campaign_key) {
        const { assertReturnShopCharacterReady } = require('./returnShopBuildGuard');
        await assertReturnShopCharacterReady(db, roll.player_id, selectedRollNumber, { campaignKey: roll.campaign_key });
    }

    const entitlements = await listReturnShopEntitlements(db, playerId);
    const selected = entitlements.find((entry) => entry.index === selectedIndex);
    if (!selected) {
        throw new PreresetReturnShopAssignmentError(
            'entitlement_not_found',
            'Nao encontrei essa compra ativa para voce.'
        );
    }
    if (!selected.requiresRollAssignment) {
        throw new PreresetReturnShopAssignmentError(
            'entitlement_does_not_require_roll',
            'Essa compra vai para o proximo personagem e nao precisa escolher roll.'
        );
    }

    const previousRollNumber = selected.targetRollNumber;
    if (previousRollNumber && previousRollNumber !== selectedRollNumber && !options.allowReassign) {
        throw new PreresetReturnShopAssignmentError(
            'entitlement_already_assigned',
            `Essa compra ja esta no roll #${previousRollNumber}. Use trocar se quiser mudar.`,
            { previousRollNumber }
        );
    }

    const assignedCategories = assignedCategoryMap(
        entitlements,
        selected.entitlementId,
        selectedRollNumber
    );
    for (const category of selected.exclusiveCategories) {
        const conflict = assignedCategories.get(category);
        if (conflict) {
            throw new PreresetReturnShopAssignmentError(
                'exclusive_category_conflict',
                `O roll #${selectedRollNumber} ja tem compra de ${category}: ${conflict.label}.`,
                { category, conflictEntitlementId: conflict.entitlementId }
            );
        }
    }

    if (previousRollNumber === selectedRollNumber) {
        return {
            ok: true,
            duplicate: true,
            changed: false,
            entitlement: selected,
            roll,
            previousRollNumber,
            targetRollNumber: selectedRollNumber,
        };
    }

    const assignedMetadata = buildAssignedMetadata(
        selected.metadata,
        selectedRollNumber,
        options.actorId || playerId,
        options.source || 'whatsapp_pr_command'
    );
    if (roll.campaign_key) {
        assignedMetadata.target_campaign_key = roll.campaign_key;
        assignedMetadata.target_player_id = roll.player_id;
    }

        await db.run(
            'UPDATE clover_prereset_entitlements SET metadata_json = ? WHERE id = ? AND status = ?',
            [JSON.stringify(assignedMetadata), selected.entitlementId, 'active']
        );
        await updatePurchaseMetadata(db, selected.purchaseId, {
            fulfillment_status: assignedMetadata.fulfillment_status,
            target_roll_number: assignedMetadata.target_roll_number,
            target_campaign_key: assignedMetadata.target_campaign_key || null,
            target_player_id: assignedMetadata.target_player_id || null,
            roll_assigned_at: assignedMetadata.roll_assigned_at,
            roll_assigned_by: assignedMetadata.roll_assigned_by,
            roll_assignment_source: assignedMetadata.roll_assignment_source,
            assignment_history: assignedMetadata.assignment_history,
        });

    return {
        ok: true,
        duplicate: false,
        changed: true,
        entitlement: {
            ...selected,
            metadata: assignedMetadata,
            targetRollNumber: selectedRollNumber,
            fulfillmentStatus: assignedMetadata.fulfillment_status,
        },
        roll,
        previousRollNumber,
        targetRollNumber: selectedRollNumber,
    };
}

async function assignReturnShopEntitlementToRoll(db, playerId, selection, rollNumber, options = {}) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await assignInTransaction(db, playerId, selection, rollNumber, options);
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    PreresetReturnShopAssignmentError,
    assignReturnShopEntitlementToRoll,
    assertReturnShopRollMutable,
    getRollByNumber,
    listReturnShopEntitlements,
    requiresRollAssignment,
    safeJson,
};
