'use strict';

const crypto = require('crypto');
const { pseudonymizePlayerId } = require('./traitDescriptionAuditPrivacy');

const ALLOWED_OPERATIONS = new Set([
    'inventory.legacy.merge_fragments.propose',
    'inventory.template.create_and_link.propose',
]);

const ITEM_DEPENDENCIES = Object.freeze([
    ['clover_inventory_reservations', 'inventory_item_id'],
    ['clover_item_redemptions', 'inventory_item_id'],
    ['clover_box_openings', 'inventory_item_id'],
    ['clover_consumable_uses', 'inventory_item_id'],
    ['clover_active_item_effects', 'inventory_item_id'],
    ['clover_economy_sale_intents', 'inventory_item_id'],
    ['clover_repair_orders', 'inventory_item_id'],
    ['clover_market_listings', 'inventory_item_id'],
]);

class LegacyInventoryRepairError extends Error {
    constructor(code, message, details = null) {
        super(message || code);
        this.name = 'LegacyInventoryRepairError';
        this.code = code;
        this.details = details;
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function planHash(plan) {
    return crypto.createHash('sha256').update(JSON.stringify(stableValue(plan))).digest('hex');
}

function cleanText(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    return text || null;
}

function normalizeCode(value, hash) {
    const code = cleanText(value) || `LIR-${hash.slice(0, 12).toUpperCase()}`;
    if (!/^[A-Z0-9_-]{6,80}$/i.test(code)) {
        throw new LegacyInventoryRepairError('invalid_repair_code', 'Código de reparo inválido.', { code });
    }
    return code.toUpperCase();
}

function parseJson(value, fallback = {}) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [tableName]
    );
    return Boolean(row?.found);
}

async function tableColumns(db, tableName) {
    if (!await tableExists(db, tableName)) return [];
    return db.all(`PRAGMA table_info(${tableName})`);
}

async function columnSet(db, tableName) {
    return new Set((await tableColumns(db, tableName)).map((column) => column.name));
}

async function getItem(db, id) {
    const row = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [Number(id)]);
    if (!row) {
        throw new LegacyInventoryRepairError('inventory_item_not_found', 'Item de inventário não encontrado.', { id: Number(id) });
    }
    return row;
}

function sameNullable(left, right) {
    return String(left ?? '').trim() === String(right ?? '').trim();
}

async function dependencyCounts(db, itemId) {
    const dependencies = [];
    for (const [table, column] of ITEM_DEPENDENCIES) {
        if (!await tableExists(db, table)) continue;
        const columns = await columnSet(db, table);
        if (!columns.has(column)) continue;
        const row = await db.get(`SELECT COUNT(*) AS total FROM ${table} WHERE ${column} = ?`, [Number(itemId)]);
        const total = Number(row?.total || 0);
        if (total > 0) dependencies.push({ table, column, total });
    }
    return dependencies;
}

function normalizedTemplate(templateInput) {
    const template = templateInput && typeof templateInput === 'object' ? templateInput : {};
    const normalized = {
        template_key: cleanText(template.templateKey),
        catalog_version: 1,
        item_name: cleanText(template.itemName),
        description: cleanText(template.description),
        category: cleanText(template.category),
        kind: cleanText(template.kind),
        origin: cleanText(template.origin) || 'Clover',
        base_price: 0,
        default_quality: 'comum',
        default_durability: null,
        stackable: 0,
        transferable: Number(template.transferable ?? 1) ? 1 : 0,
        properties_json: JSON.stringify(template.properties || {}),
        effects_json: JSON.stringify(template.effects || {}),
        metadata_json: JSON.stringify({ legacyRepair: true }),
        active: 1,
        is_custom: 1,
        requestable: 0,
        marketable: 0,
        duplicable: 0,
        created_by: 'legacy_inventory_repair',
        updated_by: 'legacy_inventory_repair',
        archived_at: null,
    };
    for (const field of ['template_key', 'item_name', 'description', 'category', 'kind']) {
        if (!normalized[field]) {
            throw new LegacyInventoryRepairError('incomplete_template', 'Proposta de modelo incompleta.', { field, template });
        }
    }
    return normalized;
}

function comparableTemplate(row) {
    if (!row) return null;
    return {
        template_key: cleanText(row.template_key),
        item_name: cleanText(row.item_name),
        description: cleanText(row.description),
        category: cleanText(row.category),
        kind: cleanText(row.kind),
        origin: cleanText(row.origin) || 'Clover',
        transferable: Number(row.transferable ?? 1) ? 1 : 0,
        properties: stableValue(parseJson(row.properties_json, {})),
        effects: stableValue(parseJson(row.effects_json, {})),
    };
}

function proposedComparable(template) {
    return {
        template_key: template.template_key,
        item_name: template.item_name,
        description: template.description,
        category: template.category,
        kind: template.kind,
        origin: template.origin,
        transferable: template.transferable,
        properties: stableValue(parseJson(template.properties_json, {})),
        effects: stableValue(parseJson(template.effects_json, {})),
    };
}

function ensureSupportedPlan(planInput) {
    const plan = planInput && typeof planInput === 'object' ? planInput : {};
    const proposals = Array.isArray(plan.readyForManualApproval) ? plan.readyForManualApproval : [];
    if (!proposals.length) {
        throw new LegacyInventoryRepairError('empty_repair_plan', 'O plano não possui propostas aprováveis.');
    }
    proposals.forEach((proposal, index) => {
        if (!ALLOWED_OPERATIONS.has(proposal?.operation)) {
            throw new LegacyInventoryRepairError('unsupported_repair_operation', 'Operação de reparo não suportada.', {
                index,
                operation: proposal?.operation,
            });
        }
        if (proposal.requiresManualApproval !== true || proposal.confidence !== 'high') {
            throw new LegacyInventoryRepairError('unapproved_repair_proposal', 'A proposta não está marcada como forte e sujeita a aprovação manual.', { index });
        }
    });
    return { ...plan, readyForManualApproval: proposals };
}

async function validateMerge(db, proposal) {
    const keepId = Number(proposal.keepInventoryItemId);
    const removeId = Number(proposal.removeInventoryItemId);
    if (!Number.isInteger(keepId) || !Number.isInteger(removeId) || keepId === removeId) {
        throw new LegacyInventoryRepairError('invalid_fragment_ids', 'IDs do fragmento são inválidos.', { keepId, removeId });
    }
    const [keep, remove] = await Promise.all([getItem(db, keepId), getItem(db, removeId)]);
    if (cleanText(keep.template_key) || cleanText(remove.template_key)) {
        throw new LegacyInventoryRepairError('fragment_already_migrated', 'Um dos fragmentos já possui modelo.', { keepId, removeId });
    }
    for (const field of ['player_id', 'source', 'related_id', 'created_at']) {
        if (!sameNullable(keep[field], remove[field])) {
            throw new LegacyInventoryRepairError('fragment_origin_mismatch', 'Os fragmentos não possuem a mesma origem.', { field, keepId, removeId });
        }
    }
    const dependencies = await dependencyCounts(db, removeId);
    if (dependencies.length) {
        throw new LegacyInventoryRepairError('fragment_has_dependencies', 'O fragmento removível possui dependências.', {
            removeId,
            dependencies,
        });
    }
    const proposedItemName = cleanText(proposal.proposedItemName);
    const proposedDescription = cleanText(proposal.proposedDescription);
    if (!proposedItemName || !proposedDescription) {
        throw new LegacyInventoryRepairError('incomplete_fragment_repair', 'Nome e descrição consolidados são obrigatórios.');
    }
    return { keep, remove, proposedItemName, proposedDescription };
}

async function validateCreateAndLink(db, proposal) {
    const ids = [...new Set((proposal.inventoryItemIds || []).map(Number))];
    if (!ids.length || ids.some((id) => !Number.isInteger(id))) {
        throw new LegacyInventoryRepairError('invalid_inventory_ids', 'A proposta não possui IDs válidos.');
    }
    const items = [];
    for (const id of ids) {
        const item = await getItem(db, id);
        if (cleanText(item.template_key)) {
            throw new LegacyInventoryRepairError('item_already_linked', 'O item já possui modelo.', { id, templateKey: item.template_key });
        }
        items.push(item);
    }
    const template = normalizedTemplate(proposal.proposedTemplate);
    const existing = await db.get('SELECT * FROM clover_item_templates WHERE template_key = ?', [template.template_key]);
    if (existing) {
        const expected = JSON.stringify(stableValue(proposedComparable(template)));
        const actual = JSON.stringify(stableValue(comparableTemplate(existing)));
        if (expected !== actual) {
            throw new LegacyInventoryRepairError('template_conflict', 'Já existe um modelo diferente com a mesma chave.', {
                templateKey: template.template_key,
            });
        }
    }
    for (const item of items) {
        if (!sameNullable(item.item_name, template.item_name)
            || !sameNullable(item.description, template.description)
            || !sameNullable(item.category, template.category)
            || !sameNullable(item.kind, template.kind)) {
            throw new LegacyInventoryRepairError('item_template_mismatch', 'O item não corresponde integralmente ao modelo proposto.', {
                itemId: item.id,
                templateKey: template.template_key,
            });
        }
    }
    return { items, template, existing };
}

async function preflightPlan(db, planInput) {
    const plan = ensureSupportedPlan(planInput);
    const units = [];
    for (let index = 0; index < plan.readyForManualApproval.length; index += 1) {
        const proposal = plan.readyForManualApproval[index];
        if (proposal.operation === 'inventory.legacy.merge_fragments.propose') {
            units.push({ index, proposal, type: 'merge_fragments', validated: await validateMerge(db, proposal) });
        } else {
            units.push({ index, proposal, type: 'create_and_link', validated: await validateCreateAndLink(db, proposal) });
        }
    }
    return { plan, hash: planHash(plan), units };
}

async function previewRepairPlan(db, planInput) {
    const preflight = await preflightPlan(db, planInput);
    return {
        mode: 'preview',
        writesPerformed: false,
        planHash: preflight.hash,
        summary: {
            proposals: preflight.units.length,
            inventoryItemsCovered: preflight.units.reduce((total, unit) => {
                if (unit.type === 'merge_fragments') return total + 2;
                return total + unit.validated.items.length;
            }, 0),
        },
        units: preflight.units.map((unit) => unit.type === 'merge_fragments'
            ? {
                index: unit.index,
                type: unit.type,
                keepInventoryItemId: unit.validated.keep.id,
                removeInventoryItemId: unit.validated.remove.id,
                playerKey: pseudonymizePlayerId(unit.validated.keep.player_id),
                proposedItemName: unit.validated.proposedItemName,
                proposedDescription: unit.validated.proposedDescription,
            }
            : {
                index: unit.index,
                type: unit.type,
                inventoryItemIds: unit.validated.items.map((item) => item.id),
                playerKeys: unit.validated.items.map((item) => pseudonymizePlayerId(item.player_id)),
                templateKey: unit.validated.template.template_key,
                itemName: unit.validated.template.item_name,
                willCreateTemplate: !unit.validated.existing,
            }),
    };
}

async function ensureRepairSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_legacy_inventory_repair_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repair_code TEXT NOT NULL UNIQUE,
            plan_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('applying', 'applied', 'undone', 'failed')),
            actor_id TEXT DEFAULT NULL,
            plan_json TEXT NOT NULL,
            result_json TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            applied_at TEXT DEFAULT NULL,
            undone_at TEXT DEFAULT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS clover_legacy_inventory_repair_units (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id INTEGER NOT NULL,
            unit_index INTEGER NOT NULL,
            operation_type TEXT NOT NULL,
            before_json TEXT NOT NULL,
            after_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            undone_at TEXT DEFAULT NULL,
            FOREIGN KEY (batch_id) REFERENCES clover_legacy_inventory_repair_batches(id),
            UNIQUE (batch_id, unit_index)
        );
    `);
}

async function insertDynamic(db, table, row) {
    const columns = await columnSet(db, table);
    const entries = Object.entries(row).filter(([key]) => columns.has(key));
    const names = entries.map(([key]) => key);
    const placeholders = names.map(() => '?');
    await db.run(
        `INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders.join(', ')})`,
        entries.map(([, value]) => value)
    );
}

async function updateDynamicById(db, table, row, id) {
    const columns = await columnSet(db, table);
    const entries = Object.entries(row).filter(([key]) => key !== 'id' && columns.has(key));
    await db.run(
        `UPDATE ${table} SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`,
        [...entries.map(([, value]) => value), Number(id)]
    );
}

async function appendItemHistory(db, options) {
    if (!await tableExists(db, 'clover_inventory_item_history')) return;
    await insertDynamic(db, 'clover_inventory_item_history', {
        item_id: options.itemId,
        player_id: options.playerId,
        action: options.action,
        quantity_delta: 0,
        durability_delta: 0,
        before_json: JSON.stringify(options.before),
        after_json: JSON.stringify(options.after),
        source: 'legacy_inventory_repair',
        related_id: options.repairCode,
        idempotency_key: options.idempotencyKey,
        created_by: options.actorId || 'system',
        created_at: options.timestamp,
        metadata_json: JSON.stringify({ repairCode: options.repairCode, unitIndex: options.unitIndex }),
    });
}

async function applyRepairPlan(db, planInput, options = {}) {
    if (options.confirm !== 'APPLY') {
        throw new LegacyInventoryRepairError('apply_confirmation_required', 'Confirmação literal APPLY é obrigatória.');
    }
    const timestamp = options.timestamp || new Date().toISOString();
    const preflight = await preflightPlan(db, planInput);
    const repairCode = normalizeCode(options.repairCode, preflight.hash);

    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensureRepairSchema(db);
        const existingBatch = await db.get(
            'SELECT * FROM clover_legacy_inventory_repair_batches WHERE repair_code = ?',
            [repairCode]
        );
        if (existingBatch) {
            if (existingBatch.plan_hash === preflight.hash && existingBatch.status === 'applied') {
                await db.exec('ROLLBACK');
                return { duplicate: true, repairCode, status: existingBatch.status };
            }
            throw new LegacyInventoryRepairError('repair_code_conflict', 'Código de reparo já utilizado.', {
                repairCode,
                status: existingBatch.status,
            });
        }

        const batchInsert = await db.run(
            `INSERT INTO clover_legacy_inventory_repair_batches
             (repair_code, plan_hash, status, actor_id, plan_json, created_at, updated_at)
             VALUES (?, ?, 'applying', ?, ?, ?, ?)`,
            [repairCode, preflight.hash, options.actorId || null, JSON.stringify(preflight.plan), timestamp, timestamp]
        );
        const batchId = batchInsert.lastID;
        const resultUnits = [];

        for (const unit of preflight.units) {
            if (unit.type === 'merge_fragments') {
                const { keep, remove, proposedItemName, proposedDescription } = unit.validated;
                const before = { keep, remove };
                const itemColumns = await columnSet(db, 'clover_inventory_items');
                const updates = { item_name: proposedItemName, description: proposedDescription };
                if (itemColumns.has('updated_at')) updates.updated_at = timestamp;
                await updateDynamicById(db, 'clover_inventory_items', { id: keep.id, ...updates }, keep.id);
                await db.run('DELETE FROM clover_inventory_items WHERE id = ?', [remove.id]);
                const afterKeep = await getItem(db, keep.id);
                const after = { keep: afterKeep, removedInventoryItemId: remove.id };
                await appendItemHistory(db, {
                    itemId: keep.id,
                    playerId: keep.player_id,
                    action: 'legacy_fragments_merged',
                    before,
                    after,
                    repairCode,
                    unitIndex: unit.index,
                    idempotencyKey: `${repairCode}:${unit.index}:${keep.id}:apply`,
                    actorId: options.actorId,
                    timestamp,
                });
                await db.run(
                    `INSERT INTO clover_legacy_inventory_repair_units
                     (batch_id, unit_index, operation_type, before_json, after_json, created_at)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [batchId, unit.index, unit.type, JSON.stringify(before), JSON.stringify(after), timestamp]
                );
                resultUnits.push({ unitIndex: unit.index, type: unit.type, itemIds: [keep.id, remove.id] });
                continue;
            }

            const { items, template, existing } = unit.validated;
            const before = { items, template: existing || null };
            let templateCreated = false;
            if (!existing) {
                await insertDynamic(db, 'clover_item_templates', template);
                templateCreated = true;
            }
            const afterItems = [];
            for (const item of items) {
                const itemColumns = await columnSet(db, 'clover_inventory_items');
                const updates = { template_key: template.template_key };
                if (itemColumns.has('catalog_version')) updates.catalog_version = 1;
                if (itemColumns.has('updated_at')) updates.updated_at = timestamp;
                await updateDynamicById(db, 'clover_inventory_items', { id: item.id, ...updates }, item.id);
                const afterItem = await getItem(db, item.id);
                afterItems.push(afterItem);
                await appendItemHistory(db, {
                    itemId: item.id,
                    playerId: item.player_id,
                    action: 'legacy_template_linked',
                    before: item,
                    after: afterItem,
                    repairCode,
                    unitIndex: unit.index,
                    idempotencyKey: `${repairCode}:${unit.index}:${item.id}:apply`,
                    actorId: options.actorId,
                    timestamp,
                });
            }
            const after = { items: afterItems, templateKey: template.template_key, templateCreated };
            await db.run(
                `INSERT INTO clover_legacy_inventory_repair_units
                 (batch_id, unit_index, operation_type, before_json, after_json, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [batchId, unit.index, unit.type, JSON.stringify(before), JSON.stringify(after), timestamp]
            );
            resultUnits.push({
                unitIndex: unit.index,
                type: unit.type,
                itemIds: items.map((item) => item.id),
                templateKey: template.template_key,
                templateCreated,
            });
        }

        const result = { repairCode, planHash: preflight.hash, units: resultUnits };
        await db.run(
            `UPDATE clover_legacy_inventory_repair_batches
             SET status = 'applied', result_json = ?, applied_at = ?, updated_at = ? WHERE id = ?`,
            [JSON.stringify(result), timestamp, timestamp, batchId]
        );
        await db.exec('COMMIT');
        return { duplicate: false, status: 'applied', ...result };
    } catch (error) {
        try { await db.exec('ROLLBACK'); } catch {}
        throw error;
    }
}

async function undoRepairBatch(db, options = {}) {
    if (options.confirm !== 'UNDO') {
        throw new LegacyInventoryRepairError('undo_confirmation_required', 'Confirmação literal UNDO é obrigatória.');
    }
    const repairCode = normalizeCode(options.repairCode, '000000000000');
    const timestamp = options.timestamp || new Date().toISOString();

    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensureRepairSchema(db);
        const batch = await db.get(
            'SELECT * FROM clover_legacy_inventory_repair_batches WHERE repair_code = ?',
            [repairCode]
        );
        if (!batch) throw new LegacyInventoryRepairError('repair_batch_not_found', 'Lote de reparo não encontrado.', { repairCode });
        if (batch.status === 'undone') {
            await db.exec('ROLLBACK');
            return { duplicate: true, repairCode, status: 'undone' };
        }
        if (batch.status !== 'applied') {
            throw new LegacyInventoryRepairError('repair_batch_not_applied', 'Somente lotes aplicados podem ser desfeitos.', {
                repairCode,
                status: batch.status,
            });
        }
        const units = await db.all(
            'SELECT * FROM clover_legacy_inventory_repair_units WHERE batch_id = ? ORDER BY unit_index DESC',
            [batch.id]
        );

        for (const unit of units) {
            const before = parseJson(unit.before_json, {});
            const after = parseJson(unit.after_json, {});
            if (unit.operation_type === 'merge_fragments') {
                const currentKeep = await getItem(db, before.keep.id);
                await updateDynamicById(db, 'clover_inventory_items', before.keep, before.keep.id);
                const removedExists = await db.get('SELECT id FROM clover_inventory_items WHERE id = ?', [before.remove.id]);
                if (removedExists) {
                    throw new LegacyInventoryRepairError('removed_fragment_id_reused', 'O ID do fragmento removido foi reutilizado.', {
                        itemId: before.remove.id,
                    });
                }
                await insertDynamic(db, 'clover_inventory_items', before.remove);
                await appendItemHistory(db, {
                    itemId: before.keep.id,
                    playerId: before.keep.player_id,
                    action: 'legacy_fragments_merge_undone',
                    before: currentKeep,
                    after: before.keep,
                    repairCode,
                    unitIndex: unit.unit_index,
                    idempotencyKey: `${repairCode}:${unit.unit_index}:${before.keep.id}:undo`,
                    actorId: options.actorId,
                    timestamp,
                });
            } else if (unit.operation_type === 'create_and_link') {
                for (const originalItem of before.items || []) {
                    const currentItem = await getItem(db, originalItem.id);
                    await updateDynamicById(db, 'clover_inventory_items', originalItem, originalItem.id);
                    await appendItemHistory(db, {
                        itemId: originalItem.id,
                        playerId: originalItem.player_id,
                        action: 'legacy_template_link_undone',
                        before: currentItem,
                        after: originalItem,
                        repairCode,
                        unitIndex: unit.unit_index,
                        idempotencyKey: `${repairCode}:${unit.unit_index}:${originalItem.id}:undo`,
                        actorId: options.actorId,
                        timestamp,
                    });
                }
                if (after.templateCreated) {
                    const external = await db.get(
                        'SELECT COUNT(*) AS total FROM clover_inventory_items WHERE template_key = ?',
                        [after.templateKey]
                    );
                    if (Number(external?.total || 0) > 0) {
                        throw new LegacyInventoryRepairError('template_still_in_use', 'O modelo criado ainda está em uso e não pode ser removido.', {
                            templateKey: after.templateKey,
                            total: Number(external.total),
                        });
                    }
                    await db.run('DELETE FROM clover_item_templates WHERE template_key = ?', [after.templateKey]);
                }
            } else {
                throw new LegacyInventoryRepairError('unknown_repair_unit', 'Unidade de reparo desconhecida.', {
                    operationType: unit.operation_type,
                });
            }
            await db.run(
                'UPDATE clover_legacy_inventory_repair_units SET undone_at = ? WHERE id = ?',
                [timestamp, unit.id]
            );
        }

        await db.run(
            `UPDATE clover_legacy_inventory_repair_batches
             SET status = 'undone', undone_at = ?, updated_at = ? WHERE id = ?`,
            [timestamp, timestamp, batch.id]
        );
        await db.exec('COMMIT');
        return { duplicate: false, repairCode, status: 'undone', units: units.length };
    } catch (error) {
        try { await db.exec('ROLLBACK'); } catch {}
        throw error;
    }
}

module.exports = {
    ALLOWED_OPERATIONS,
    LegacyInventoryRepairError,
    applyRepairPlan,
    dependencyCounts,
    ensureRepairSchema,
    planHash,
    preflightPlan,
    previewRepairPlan,
    undoRepairBatch,
};
