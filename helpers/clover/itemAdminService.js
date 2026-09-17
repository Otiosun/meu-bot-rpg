'use strict';

const crypto = require('crypto');

const { normalizeJid } = require('../groupAccess');
const { getAccessContext } = require('./accessControlService');
const {
    addCatalogItemInTransaction,
    consumeInventoryItemInTransaction,
    ensureInventoryV1,
    getItemTemplateInTransaction,
    getReservedQuantityInTransaction,
    recordHistory,
    restoreInventoryItemSnapshotInTransaction,
    serializeItem,
    serializeTemplateRow,
} = require('./inventoryService');

const QUALITY_KEYS = new Set(['comum', 'refinada', 'superior', 'obra_prima']);
const QUALITY_DURABILITY = Object.freeze({ comum: 5, refinada: 7, superior: 9 });

class ItemAdminServiceError extends Error {
    constructor(code, message, details = {}, status = 400) {
        super(message);
        this.name = 'ItemAdminServiceError';
        this.code = code;
        this.details = details;
        this.status = status;
    }
}

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function normalizeKey(value, fallback = 'item') {
    return String(value || fallback)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || fallback;
}

function asBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'sim', 's', 'yes'].includes(String(value).trim().toLowerCase());
}

function asInteger(value, field, options = {}) {
    if ((value === undefined || value === null || value === '') && options.nullable) return null;
    const number = Number(value);
    const minimum = options.minimum ?? 0;
    const maximum = options.maximum ?? 100000000;
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new ItemAdminServiceError('invalid_item_field', `${field} inválido.`, { field, minimum, maximum });
    }
    return number;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function valuesMatch(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function canonicalJson(value) {
    return stableValue(value || {});
}

async function requireItemManager(db, actorId) {
    const actor = normalizeJid(actorId) || String(actorId || '').trim();
    const context = await getAccessContext(db, actor);
    if (context.owner || context.roleKeys.includes('admin') || context.roleKeys.includes('narrator')) {
        return { actorId: actor, context };
    }
    throw new ItemAdminServiceError('item_manager_required', 'Apenas narradores e administradores podem gerenciar modelos de item.');
}

function normalizeConditionDescriptions(input, durability) {
    if (durability === null) return {};
    const source = input.conditionDescriptions || input.condition_descriptions || input.estados || {};
    const result = {
        integro: String(source.integro || source.íntegro || input.integro || '').trim(),
        desgastado: String(source.desgastado || input.desgastado || '').trim(),
        danificado: String(source.danificado || input.danificado || '').trim(),
        quebrado: String(source.quebrado || input.quebrado || '').trim(),
    };
    const missing = Object.entries(result).filter(([, value]) => !value).map(([key]) => key);
    if (missing.length) {
        throw new ItemAdminServiceError(
            'missing_condition_descriptions',
            `Item com durabilidade precisa descrever: ${missing.join(', ')}.`,
            { missing }
        );
    }
    return result;
}

function normalizeTemplateInput(input = {}, existing = null) {
    const name = String(input.itemName || input.item_name || input.nome || existing?.item_name || '').trim().slice(0, 120);
    const description = String(input.description || input.descricao || existing?.description || '').trim().slice(0, 2000);
    if (!name) throw new ItemAdminServiceError('missing_item_name', 'Informe o nome do item.');
    if (!description) throw new ItemAdminServiceError('missing_item_description', 'Informe a descrição do item.');
    const category = normalizeKey(input.category || input.categoria || existing?.category || 'material', 'material');
    const kind = normalizeKey(input.kind || input.tipo || existing?.kind || category, category);
    const origin = String(input.origin || input.origem || existing?.origin || 'Clover').trim().slice(0, 80) || 'Clover';
    const basePrice = asInteger(input.basePrice ?? input.base_price ?? input.valor ?? existing?.base_price ?? 0, 'Valor de referência');
    const quality = normalizeKey(input.defaultQuality || input.default_quality || input.qualidade || existing?.default_quality || 'comum');
    if (!QUALITY_KEYS.has(quality)) throw new ItemAdminServiceError('invalid_item_quality', 'Qualidade deve ser comum, refinada, superior ou obra-prima.');
    const durabilityRaw = input.defaultDurability ?? input.default_durability ?? input.durabilidade;
    let durability = durabilityRaw === undefined
        ? (existing?.default_durability === undefined ? null : existing.default_durability)
        : asInteger(durabilityRaw, 'Durabilidade', { nullable: true, minimum: 1, maximum: 100 });
    if (durability !== null && quality !== 'obra_prima') {
        const expected = QUALITY_DURABILITY[quality];
        if (durabilityRaw !== undefined && durability !== expected) {
            throw new ItemAdminServiceError(
                'quality_durability_mismatch',
                `Qualidade ${quality} usa ${expected} pontos de durabilidade.`,
                { quality, expectedDurability: expected }
            );
        }
        durability = expected;
    }
    const stackable = asBoolean(input.stackable ?? input.empilhavel, existing ? Boolean(existing.stackable) : durability === null);
    const transferable = asBoolean(input.transferable ?? input.transferivel, existing ? Boolean(existing.transferable) : true);
    const marketable = asBoolean(input.marketable ?? input.vendavel, existing ? Boolean(existing.marketable) : transferable);
    const duplicable = asBoolean(input.duplicable ?? input.duplicavel, existing ? Boolean(existing.duplicable) : true);
    const requested = asBoolean(input.requestable ?? input.pedidos, existing ? Boolean(existing.requestable) : false);
    if (durability !== null && stackable) throw new ItemAdminServiceError('durable_item_stackable', 'Item com durabilidade precisa ter exemplares separados.');
    if (!duplicable && stackable) throw new ItemAdminServiceError('unique_item_stackable', 'Item único não pode ser empilhável.');
    const requestable = requested && transferable && marketable && duplicable && basePrice > 0;
    if (requested && !requestable) {
        throw new ItemAdminServiceError('item_not_requestable', 'Para entrar em pedidos, o item precisa ter valor, ser transferível, vendável e duplicável.');
    }
    const currentProperties = safeJsonParse(existing?.properties_json, {});
    const currentEffects = safeJsonParse(existing?.effects_json, {});
    const conditionDescriptions = durability === null
        ? {}
        : normalizeConditionDescriptions({
            ...input,
            conditionDescriptions: input.conditionDescriptions || input.condition_descriptions || input.estados || currentProperties.conditionDescriptions,
        }, durability);
    return {
        name,
        description,
        category,
        kind,
        origin,
        basePrice,
        quality,
        durability,
        stackable,
        transferable,
        marketable,
        duplicable,
        requestable,
        properties: {
            ...currentProperties,
            ...(input.properties || input.propriedades || {}),
            conditionDescriptions,
        },
        effects: { ...currentEffects, ...(input.effects || input.efeitos || {}) },
        metadata: {
            ...safeJsonParse(existing?.metadata_json, {}),
            ...(input.metadata || {}),
            unique: !duplicable,
        },
    };
}

async function createItemTemplate(db, actorId, input = {}) {
    await ensureInventoryV1(db);
    const manager = await requireItemManager(db, actorId);
    return createItemTemplateInTransaction(db,manager.actorId,input);
}

// Internal primitive: callers authenticate and own transaction/schema setup.
async function createItemTemplateInTransaction(db, actorId, input = {}) {
    const manager = {actorId};
    const data = normalizeTemplateInput(input);
    const requestedKey = normalizeKey(input.templateKey || input.template_key || input.codigo || data.name);
    const key = `custom_${requestedKey}`;
    const collision = await db.get('SELECT template_key FROM clover_item_templates WHERE template_key = ? COLLATE NOCASE', [key]);
    if (collision) throw new ItemAdminServiceError('item_template_exists', `Já existe um modelo com o código ${key}.`);
    const inserted = await db.run(
        `INSERT INTO clover_item_templates
         (template_key, catalog_version, item_name, description, category, kind, origin,
          base_price, default_quality, default_durability, stackable, transferable,
          properties_json, effects_json, metadata_json, active, is_custom, requestable,
          marketable, duplicable, created_by, updated_by, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
            key, data.name, data.description, data.category, data.kind, data.origin,
            data.basePrice, data.quality, data.durability, data.stackable ? 1 : 0, data.transferable ? 1 : 0,
            JSON.stringify(data.properties), JSON.stringify(data.effects), JSON.stringify(data.metadata),
            data.requestable ? 1 : 0, data.marketable ? 1 : 0, data.duplicable ? 1 : 0,
            manager.actorId, manager.actorId,
        ]
    );
    const row = await db.get('SELECT * FROM clover_item_templates WHERE rowid = ?', [inserted.lastID]);
    return { ok: true, template: serializeTemplateRow(row) };
}

async function updateItemTemplate(db, actorId, templateKey, input = {}) {
    await ensureInventoryV1(db);
    const manager = await requireItemManager(db, actorId);
    const existing = await db.get('SELECT * FROM clover_item_templates WHERE template_key = ? COLLATE NOCASE', [String(templateKey || '').trim()]);
    if (!existing) throw new ItemAdminServiceError('item_template_not_found', 'Modelo de item não encontrado.');
    if (!existing.is_custom) throw new ItemAdminServiceError('static_item_locked', 'Itens-base do sistema não são editados por este comando.');
    const data = normalizeTemplateInput(input, existing);
    await db.run(
        `UPDATE clover_item_templates
         SET catalog_version = catalog_version + 1, item_name = ?, description = ?, category = ?, kind = ?, origin = ?,
             base_price = ?, default_quality = ?, default_durability = ?, stackable = ?, transferable = ?,
             properties_json = ?, effects_json = ?, metadata_json = ?, requestable = ?, marketable = ?, duplicable = ?,
             updated_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE template_key = ?`,
        [
            data.name, data.description, data.category, data.kind, data.origin,
            data.basePrice, data.quality, data.durability, data.stackable ? 1 : 0, data.transferable ? 1 : 0,
            JSON.stringify(data.properties), JSON.stringify(data.effects), JSON.stringify(data.metadata),
            data.requestable ? 1 : 0, data.marketable ? 1 : 0, data.duplicable ? 1 : 0,
            manager.actorId, existing.template_key,
        ]
    );
    return { ok: true, template: serializeTemplateRow(await db.get('SELECT * FROM clover_item_templates WHERE template_key = ?', [existing.template_key])) };
}

async function getItemTemplateForAdmin(db, templateKey) {
    await ensureInventoryV1(db);
    const key = String(templateKey || '').trim();
    if (!key) return null;
    const row = await db.get('SELECT * FROM clover_item_templates WHERE template_key = ? COLLATE NOCASE', [key]);
    return serializeTemplateRow(row);
}

async function getTemplateSnapshot(db, templateKey) {
    const key = String(templateKey || '').trim();
    if (!key) return null;
    const row = await db.get('SELECT * FROM clover_item_templates WHERE template_key = ? COLLATE NOCASE', [key]);
    if (!row) return null;
    const serialized = serializeTemplateRow(row);
    return {
        ...serialized,
        archivedAt: row.archived_at || null,
        properties: canonicalJson(serialized.properties),
        effects: canonicalJson(serialized.effects),
        metadata: canonicalJson(serialized.metadata),
    };
}

async function archiveItemTemplate(db, actorId, templateKey) {
    await ensureInventoryV1(db);
    const manager = await requireItemManager(db, actorId);
    const existing = await db.get('SELECT * FROM clover_item_templates WHERE template_key = ? COLLATE NOCASE', [String(templateKey || '').trim()]);
    if (!existing) throw new ItemAdminServiceError('item_template_not_found', 'Modelo de item não encontrado.');
    if (!existing.is_custom) throw new ItemAdminServiceError('static_item_locked', 'Itens-base do sistema não podem ser arquivados.');
    await db.run(
        `UPDATE clover_item_templates
         SET active = 0, requestable = 0, archived_at = CURRENT_TIMESTAMP,
             updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE template_key = ?`,
        [manager.actorId, existing.template_key]
    );
    return { ok: true, archived: true, templateKey: existing.template_key };
}

async function restoreItemTemplate(db, actorId, templateKey) {
    await ensureInventoryV1(db);
    const manager = await requireItemManager(db, actorId);
    const existing = await db.get('SELECT * FROM clover_item_templates WHERE template_key = ? COLLATE NOCASE', [String(templateKey || '').trim()]);
    if (!existing) throw new ItemAdminServiceError('item_template_not_found', 'Modelo de item não encontrado.');
    if (!existing.is_custom) throw new ItemAdminServiceError('static_item_locked', 'Itens-base do sistema não podem ser restaurados por este comando.');
    await db.run(
        `UPDATE clover_item_templates
         SET active = 1, archived_at = NULL, updated_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE template_key = ?`,
        [manager.actorId, existing.template_key]
    );
    return { ok: true, restored: true, template: serializeTemplateRow(await db.get('SELECT * FROM clover_item_templates WHERE template_key = ?', [existing.template_key])) };
}

async function listItemTemplates(db, options = {}) {
    await ensureInventoryV1(db);
    const rows = await db.all(
        `SELECT * FROM clover_item_templates
         WHERE (? = 1 OR active = 1)
           AND (? = 0 OR is_custom = 1)
         ORDER BY is_custom DESC, updated_at DESC, item_name ASC
         LIMIT ?`,
        [options.includeArchived ? 1 : 0, options.customOnly ? 1 : 0, Math.max(1, Math.min(300, Number(options.limit) || 100))]
    );
    return rows.map(serializeTemplateRow);
}

async function grantItemCopies(db, actorId, playerId, templateKey, quantity = 1, options = {}) {
    await ensureInventoryV1(db);
    const manager = await requireItemManager(db, actorId);
    const target = normalizeJid(playerId) || String(playerId || '').trim();
    const player = await db.get('SELECT id, personagem_nome, nome FROM jogadores WHERE id = ?', [target]);
    if (!player) throw new ItemAdminServiceError('player_not_found', 'Jogador não encontrado.');
    const amount = asInteger(quantity, 'Quantidade', { minimum: 1, maximum: 100 });
    const useSavepoint = options.transactionManaged === true || options.useSavepoint === true;
    const savepoint = `item_admin_grant_${crypto.randomBytes(4).toString('hex')}`;
    if (useSavepoint) {
        await db.exec(`SAVEPOINT ${savepoint}`);
    } else {
        await db.exec('BEGIN IMMEDIATE');
    }
    try {
        const idempotencyKey = String(options.idempotencyKey || '').trim() || null;
        if (idempotencyKey) {
            const existingGrant = await db.get('SELECT * FROM clover_item_grants WHERE idempotency_key = ?', [idempotencyKey]);
            if (existingGrant) {
                const ids = safeJsonParse(existingGrant.inventory_item_ids_json, []);
                const items = ids.length
                    ? await db.all(`SELECT * FROM clover_inventory_items WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`, ids)
                    : [];
                const template = await getItemTemplateInTransaction(db, existingGrant.template_key);
                if (useSavepoint) {
                    await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
                } else {
                    await db.exec('COMMIT');
                }
                return { ok: true, duplicate: true, player, template, quantity: Number(existingGrant.quantity), items: items.map(serializeItem) };
            }
        }
        const template = await getItemTemplateInTransaction(db, templateKey);
        if (!template) throw new ItemAdminServiceError('item_template_not_found', 'Modelo de item não encontrado ou arquivado.');
        if (!template.duplicable) {
            if (amount !== 1) throw new ItemAdminServiceError('unique_item_quantity', 'Item único só pode ser gerado em uma unidade.');
            const existing = await db.get(
                'SELECT COALESCE(SUM(quantity), 0) AS total FROM clover_inventory_items WHERE template_key = ?',
                [template.key]
            );
            if (Number(existing?.total || 0) > 0) throw new ItemAdminServiceError('unique_item_exists', 'Já existe um exemplar ativo desse item único.');
        }
        const result = await addCatalogItemInTransaction(db, player.id, template.key, amount, {
            source: options.source || 'item_admin',
            relatedId: options.relatedId || `item-grant:${template.key}:${Date.now()}`,
            createdBy: manager.actorId,
            forceSeparate: options.forceSeparate === true || !template.stackable,
            metadata: { granted_by_item_manager: true, ...(options.metadata || {}) },
        });
        const grantKey = `GRT-${crypto.randomBytes(5).toString('hex')}`;
        await db.run(
            `INSERT INTO clover_item_grants
             (grant_key, template_key, player_id, quantity, status, inventory_item_ids_json,
              idempotency_key, created_by, metadata_json)
             VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
            [
                grantKey, template.key, player.id, amount, JSON.stringify(result.items.map((item) => item.id)),
                idempotencyKey, manager.actorId, JSON.stringify(options.metadata || {}),
            ]
        );
        if (useSavepoint) {
            await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else {
            await db.exec('COMMIT');
        }
        return { ok: true, duplicate: false, grantKey, player, template, quantity: amount, items: result.items, stacked: result.stacked };
    } catch (error) {
        if (useSavepoint) {
            await db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => null);
            await db.exec(`RELEASE SAVEPOINT ${savepoint}`).catch(() => null);
        } else {
            await db.exec('ROLLBACK').catch(() => null);
        }
        throw error;
    }
}

function templatePreviewFromNormalized(row, data, options = {}) {
    const before = serializeTemplateRow(row);
    return {
        ...before,
        ...(options.key ? { key: options.key } : {}),
        catalogVersion: options.bumpVersion ? Number(before?.catalogVersion || 1) + 1 : Number(before?.catalogVersion || 1),
        itemName: data.name,
        description: data.description,
        category: data.category,
        kind: data.kind,
        origin: data.origin,
        basePrice: data.basePrice,
        defaultQuality: data.quality,
        defaultDurability: data.durability,
        stackable: data.stackable,
        transferable: data.transferable,
        requestable: data.requestable,
        marketable: data.marketable,
        duplicable: data.duplicable,
        custom: true,
        active: options.active ?? before?.active ?? true,
        archivedAt: row?.archived_at || before?.archivedAt || null,
        properties: data.properties,
        effects: data.effects,
        metadata: data.metadata,
    };
}

async function restoreTemplateSnapshot(db, snapshot, actorId) {
    if (!snapshot?.key) throw new ItemAdminServiceError('missing_item_snapshot', 'Snapshot do modelo de item está incompleto.');
    const manager = await requireItemManager(db, actorId);
    await db.run(
        `UPDATE clover_item_templates
         SET catalog_version = ?, item_name = ?, description = ?, category = ?, kind = ?, origin = ?,
             base_price = ?, default_quality = ?, default_durability = ?, stackable = ?, transferable = ?,
             properties_json = ?, effects_json = ?, metadata_json = ?, active = ?, requestable = ?,
             marketable = ?, duplicable = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP,
             archived_at = ?
         WHERE template_key = ? AND is_custom = 1`,
        [
            Number(snapshot.catalogVersion || 1), snapshot.itemName, snapshot.description, snapshot.category,
            snapshot.kind, snapshot.origin || 'Clover', Number(snapshot.basePrice || 0), snapshot.defaultQuality || 'comum',
            snapshot.defaultDurability ?? null, snapshot.stackable ? 1 : 0, snapshot.transferable ? 1 : 0,
            JSON.stringify(snapshot.properties || {}), JSON.stringify(snapshot.effects || {}), JSON.stringify(snapshot.metadata || {}),
            snapshot.active ? 1 : 0, snapshot.requestable ? 1 : 0, snapshot.marketable ? 1 : 0, snapshot.duplicable ? 1 : 0,
            manager.actorId, snapshot.archivedAt ?? null, snapshot.key,
        ]
    );
}

function snapshotInventoryItem(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        playerId: row.player_id,
        itemName: row.item_name,
        description: row.description || null,
        quantity: Number(row.quantity || 0),
        kind: row.kind || null,
        source: row.source || null,
        relatedId: row.related_id || null,
        createdBy: row.created_by || null,
        createdAt: row.created_at || null,
        metadata: canonicalJson(safeJsonParse(row.metadata_json, {})),
        templateKey: row.template_key || null,
        catalogVersion: Number(row.catalog_version || 1),
        category: row.category || null,
        origin: row.origin || null,
        status: row.status || null,
        quality: row.quality || null,
        basePrice: Number(row.base_price || 0),
        referencePrice: Number(row.reference_price || 0),
        durabilityCurrent: row.durability_current === null ? null : Number(row.durability_current),
        durabilityMax: row.durability_max === null ? null : Number(row.durability_max),
        bound: Boolean(row.bound),
        transferable: Boolean(row.transferable),
        equippedSlot: row.equipped_slot || null,
        expiresAt: row.expires_at || null,
        updatedAt: row.updated_at || null,
        properties: canonicalJson(safeJsonParse(row.properties_json, {})),
        effects: canonicalJson(safeJsonParse(row.effects_json, {})),
    };
}

async function listGrantScopeSnapshots(db, playerId, templateKey) {
    const rows = await db.all(
        `SELECT * FROM clover_inventory_items
         WHERE player_id = ? AND template_key = ?
         ORDER BY id ASC`,
        [playerId, templateKey]
    );
    return rows.map(snapshotInventoryItem);
}

async function getHistoryWatermarks(db, itemIds) {
    if (!itemIds.length) return {};
    const rows = await db.all(
        `SELECT item_id, MAX(id) AS history_id
         FROM clover_inventory_item_history
         WHERE item_id IN (${itemIds.map(() => '?').join(', ')})
         GROUP BY item_id`,
        itemIds
    );
    return Object.fromEntries(rows.map((row) => [String(row.item_id), Number(row.history_id || 0)]));
}

async function getGrantSnapshot(db, playerId, templateKey, beforeItems, result, grantKey, idempotencyKey) {
    const afterItems = await listGrantScopeSnapshots(db, playerId, templateKey);
    const beforeById = new Map(beforeItems.map((item) => [Number(item.id), item]));
    const resultIds = result.items.map((item) => Number(item.id));
    const afterById = new Map(afterItems.map((item) => [Number(item.id), item]));
    const quantityAddedByItem = {};
    const createdItemIds = [];
    const changedItemIds = [];
    const lineExistedBefore = {};
    for (const id of resultIds) {
        const before = beforeById.get(id) || null;
        const after = afterById.get(id);
        if (!after) continue;
        lineExistedBefore[id] = Boolean(before);
        quantityAddedByItem[id] = Number(after.quantity || 0) - Number(before?.quantity || 0);
        if (before) changedItemIds.push(id);
        else createdItemIds.push(id);
    }
    return {
        beforeItems,
        afterItems,
        createdItemIds,
        changedItemIds,
        grantKey,
        idempotencyKey: idempotencyKey || null,
        quantityAddedByItem,
        lineExistedBefore,
        historyWatermarks: await getHistoryWatermarks(db, afterItems.map((item) => item.id)),
    };
}

function itemMismatchCode(expected, current) {
    if (expected.playerId !== current.playerId) return 'item_grant_transferred';
    if (expected.templateKey !== current.templateKey) return 'item_grant_transferred';
    if (expected.quantity !== current.quantity) return current.quantity < expected.quantity ? 'item_grant_consumed' : 'item_grant_changed_since_apply';
    return 'item_grant_changed_since_apply';
}

async function assertNoGrantItemHistoryAfter(db, itemId, watermark) {
    const later = await db.get(
        `SELECT id, action, source, related_id
         FROM clover_inventory_item_history
         WHERE item_id = ? AND id > ?
         ORDER BY id ASC LIMIT 1`,
        [itemId, Number(watermark || 0)]
    );
    if (later) {
        throw new ItemAdminServiceError(
            'item_grant_history_changed',
            'O item concedido recebeu histórico posterior e não pode ser desfeito automaticamente.',
            { itemId, laterHistoryId: Number(later.id), action: later.action, source: later.source || null, relatedId: later.related_id || null },
            409
        );
    }
}

async function undoGrantedItems(db, grantSnapshot, actorId, operationCode) {
    const afterItems = Array.isArray(grantSnapshot?.afterItems) ? grantSnapshot.afterItems : [];
    const beforeItems = Array.isArray(grantSnapshot?.beforeItems) ? grantSnapshot.beforeItems : [];
    if (!afterItems.length) throw new ItemAdminServiceError('missing_grant_snapshot', 'Snapshot da concessão de item está incompleto.', {}, 409);
    const beforeById = new Map(beforeItems.map((item) => [Number(item.id), item]));
    const createdIds = new Set((grantSnapshot.createdItemIds || []).map(Number));

    for (const expected of afterItems) {
        const row = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [expected.id]);
        if (!row) {
            throw new ItemAdminServiceError('item_grant_consumed', 'O item concedido já não existe para desfazer com segurança.', { itemId: expected.id }, 409);
        }
        const reserved = await getReservedQuantityInTransaction(db, row.id);
        if (reserved > 0) {
            throw new ItemAdminServiceError('item_grant_reserved', 'O item concedido possui reserva ativa e não pode ser desfeito automaticamente.', { itemId: row.id, reserved }, 409);
        }
        await assertNoGrantItemHistoryAfter(db, row.id, grantSnapshot.historyWatermarks?.[String(row.id)]);
        const current = snapshotInventoryItem(row);
        if (!valuesMatch(current, expected)) {
            throw new ItemAdminServiceError(
                itemMismatchCode(expected, current),
                'O item concedido mudou depois da aplicação e não pode ser desfeito automaticamente.',
                { itemId: row.id },
                409
            );
        }
    }

    for (const expected of [...afterItems].reverse()) {
        const before = beforeById.get(Number(expected.id));
        if (createdIds.has(Number(expected.id)) && !before) {
            const current = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [expected.id]);
            await consumeInventoryItemInTransaction(db, current, Number(expected.quantity || 0), {
                action: 'removido',
                source: 'admin_operation_undo',
                relatedId: operationCode,
                createdBy: actorId,
            });
        } else if (before) {
            await restoreInventoryItemSnapshotInTransaction(db, before);
            await recordHistory(db, {
                itemId: expected.id,
                playerId: expected.playerId,
                action: 'removido',
                quantityDelta: Number(before.quantity || 0) - Number(expected.quantity || 0),
                before: expected,
                after: before,
                source: 'admin_operation_undo',
                relatedId: operationCode,
                createdBy: actorId,
            });
        }
    }
    if (grantSnapshot.grantKey) {
        await db.run("UPDATE clover_item_grants SET status = 'reversed' WHERE grant_key = ?", [grantSnapshot.grantKey]);
    }
}

async function assertTemplateUnchangedSinceApply(db, after) {
    const current = await getTemplateSnapshot(db, after?.key);
    if (!current || !after || !valuesMatch(current, {
        ...after,
        properties: canonicalJson(after.properties),
        effects: canonicalJson(after.effects),
        metadata: canonicalJson(after.metadata),
        archivedAt: after.archivedAt || null,
    })) {
        throw new ItemAdminServiceError(
            'item_template_changed_since_apply',
            'O modelo de item foi alterado depois da aplicação e não pode ser desfeito automaticamente.',
            { templateKey: after?.key || null },
            409
        );
    }
}

function createItemExecutors() {
    return {
        'catalog.item.create': {
            async preview({ action }) {
                const data = normalizeTemplateInput(action.payload || {});
                const key = `custom_${normalizeKey(action.payload?.templateKey || action.payload?.template_key || action.payload?.codigo || data.name)}`;
                return { summary: `Criar item: ${data.name}`, before: null, after: templatePreviewFromNormalized(null, data, { key }) };
            },
            async apply({ db, operation, action }) {
                const created = await createItemTemplate(db, operation.actor.id, action.payload || {});
                return { before: null, after: await getTemplateSnapshot(db, created.template.key), summary: `Item ${created.template.itemName} criado.` };
            },
            async undo({ db, after }) {
                const key = after?.key;
                if (!key) throw new ItemAdminServiceError('missing_item_snapshot', 'Snapshot do item criado está incompleto.');
                await assertTemplateUnchangedSinceApply(db, after);
                const usage = await db.get(
                    `SELECT
                        (SELECT COUNT(*) FROM clover_inventory_items WHERE template_key = ?) AS items,
                        (SELECT COUNT(*) FROM clover_item_grants WHERE template_key = ?) AS grants`,
                    [key, key]
                );
                if (Number(usage?.items || 0) > 0 || Number(usage?.grants || 0) > 0) {
                    throw new ItemAdminServiceError('item_template_in_use', 'O item criado já possui cópias ou concessões e não pode ser removido pelo desfazer.');
                }
                await db.run('DELETE FROM clover_item_templates WHERE template_key = ? AND is_custom = 1', [key]);
            },
        },
        'catalog.item.update': {
            async preview({ db, action }) {
                await ensureInventoryV1(db);
                const key = String(action.payload?.templateKey || action.payload?.template_key || action.payload?.key || '').trim();
                const row = await db.get('SELECT * FROM clover_item_templates WHERE template_key = ? COLLATE NOCASE', [key]);
                if (!row) throw new ItemAdminServiceError('item_template_not_found', 'Modelo de item não encontrado.');
                if (!row.is_custom) throw new ItemAdminServiceError('static_item_locked', 'Itens-base do sistema não são editados por este comando.');
                const data = normalizeTemplateInput(action.payload || {}, row);
                return { summary: `Editar item: ${row.item_name}`, before: await getTemplateSnapshot(db, row.template_key), after: templatePreviewFromNormalized(row, data, { bumpVersion: true }) };
            },
            async apply({ db, operation, action, after }) {
                const updated = await updateItemTemplate(db, operation.actor.id, after.key, action.payload || {});
                return { after: await getTemplateSnapshot(db, updated.template.key), summary: `Item ${updated.template.itemName} atualizado.` };
            },
            async undo({ db, operation, before, after }) {
                await assertTemplateUnchangedSinceApply(db, after);
                await restoreTemplateSnapshot(db, before, operation.actor.id);
            },
        },
        'catalog.item.archive': {
            async preview({ db, action }) {
                const before = await getTemplateSnapshot(db, action.payload?.templateKey || action.payload?.template_key || action.payload?.key);
                if (!before) throw new ItemAdminServiceError('item_template_not_found', 'Modelo de item não encontrado.');
                if (!before.custom) throw new ItemAdminServiceError('static_item_locked', 'Itens-base do sistema não podem ser arquivados.');
                return { summary: `Arquivar item: ${before.itemName}`, before, after: { ...before, active: false, requestable: false, archivedAt: before.archivedAt || null } };
            },
            async apply({ db, operation, after }) {
                await archiveItemTemplate(db, operation.actor.id, after.key);
                return { after: await getTemplateSnapshot(db, after.key), summary: `Item ${after.itemName} arquivado.` };
            },
            async undo({ db, operation, before, after }) {
                await assertTemplateUnchangedSinceApply(db, after);
                await restoreTemplateSnapshot(db, before, operation.actor.id);
            },
        },
        'catalog.item.restore': {
            async preview({ db, action }) {
                const before = await getTemplateSnapshot(db, action.payload?.templateKey || action.payload?.template_key || action.payload?.key);
                if (!before) throw new ItemAdminServiceError('item_template_not_found', 'Modelo de item não encontrado.');
                if (!before.custom) throw new ItemAdminServiceError('static_item_locked', 'Itens-base do sistema não podem ser restaurados.');
                return { summary: `Restaurar item: ${before.itemName}`, before, after: { ...before, active: true, archivedAt: null } };
            },
            async apply({ db, operation, after }) {
                const restored = await restoreItemTemplate(db, operation.actor.id, after.key);
                return { after: await getTemplateSnapshot(db, restored.template.key), summary: `Item ${after.itemName} restaurado.` };
            },
            async undo({ db, operation, before, after }) {
                await assertTemplateUnchangedSinceApply(db, after);
                await restoreTemplateSnapshot(db, before, operation.actor.id);
            },
        },
        'player.item.grant': {
            async preview({ db, action, target }) {
                await ensureInventoryV1(db);
                const template = await getItemTemplateInTransaction(db, action.payload?.templateKey || action.payload?.template_key || action.payload?.key);
                if (!template) throw new ItemAdminServiceError('item_template_not_found', 'Modelo de item não encontrado ou arquivado.');
                const quantity = asInteger(action.payload?.quantity || action.payload?.quantidade || 1, 'Quantidade', { minimum: 1, maximum: 100 });
                return {
                    summary: `${target.characterName || target.playerId}: conceder ${quantity}x ${template.itemName}`,
                    before: null,
                    after: { playerId: target.playerId, templateKey: template.key, itemName: template.itemName, quantity },
                };
            },
            async apply({ db, operation, unit, after, action, target }) {
                const beforeItems = await listGrantScopeSnapshots(db, target.playerId, after.templateKey);
                const result = await grantItemCopies(db, operation.actor.id, target.playerId, after.templateKey, after.quantity, {
                    idempotencyKey: `${operation.code}:unit:${unit.id}:item-grant`,
                    source: 'admin_operation',
                    relatedId: operation.code,
                    transactionManaged: true,
                    metadata: { actionPayload: action.payload || {} },
                });
                const grantSnapshot = await getGrantSnapshot(
                    db,
                    target.playerId,
                    after.templateKey,
                    beforeItems,
                    result,
                    result.grantKey || null,
                    `${operation.code}:unit:${unit.id}:item-grant`
                );
                return {
                    after: {
                        ...after,
                        grantKey: result.grantKey || null,
                        duplicate: result.duplicate,
                        stacked: Boolean(result.stacked),
                        itemIds: result.items.map((item) => item.id),
                        items: result.items,
                        ...grantSnapshot,
                    },
                    summary: `${target.characterName || target.playerId}: ${result.quantity}x ${result.template.itemName} concedido.`,
                };
            },
            async undo({ db, operation, after }) {
                await undoGrantedItems(db, after, operation.actor.id, operation.code);
            },
        },
    };
}

module.exports = {
    ItemAdminServiceError,
    archiveItemTemplate,
    createItemTemplate,
    createItemTemplateInTransaction,
    createItemExecutors,
    grantItemCopies,
    getItemTemplateForAdmin,
    listItemTemplates,
    requireItemManager,
    restoreItemTemplate,
    updateItemTemplate,
};
