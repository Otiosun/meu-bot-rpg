'use strict';

const crypto = require('crypto');

const { normalizeJid } = require('../groupAccess');
const { getAccessContext } = require('./accessControlService');
const {
    addCatalogItemInTransaction,
    ensureInventoryV1,
    getItemTemplateInTransaction,
    serializeItem,
    serializeTemplateRow,
} = require('./inventoryService');

const QUALITY_KEYS = new Set(['comum', 'refinada', 'superior', 'obra_prima']);
const QUALITY_DURABILITY = Object.freeze({ comum: 5, refinada: 7, superior: 9 });

class ItemAdminServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ItemAdminServiceError';
        this.code = code;
        this.details = details;
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
    await db.exec('BEGIN IMMEDIATE');
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
                await db.exec('COMMIT');
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
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, grantKey, player, template, quantity: amount, items: result.items, stacked: result.stacked };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    ItemAdminServiceError,
    archiveItemTemplate,
    createItemTemplate,
    grantItemCopies,
    listItemTemplates,
    requireItemManager,
    updateItemTemplate,
};
