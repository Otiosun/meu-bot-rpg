'use strict';

const crypto = require('node:crypto');
const {
    calculateReferencePrice,
} = require('./inventoryService');
const {
    LegacyEventRewardResolutionError,
    cleanText,
} = require('./legacyEventRewardResolutionService');

const BLOCKING_DEPENDENCIES = Object.freeze([
    Object.freeze({ table: 'clover_inventory_reservations', column: 'inventory_item_id', statusColumn: 'status', active: ['active'] }),
    Object.freeze({ table: 'clover_item_redemptions', column: 'inventory_item_id', statusColumn: 'status', active: ['pending'] }),
    Object.freeze({ table: 'clover_market_listings', column: 'inventory_item_id', statusColumn: 'status', active: ['active', 'pending', 'reserved'] }),
    Object.freeze({ table: 'clover_economy_sale_intents', column: 'inventory_item_id', statusColumn: 'status', active: ['pending', 'confirmed'] }),
    Object.freeze({ table: 'clover_repair_orders', column: 'inventory_item_id', statusColumn: 'status', active: ['pending', 'active', 'in_progress'] }),
    Object.freeze({ table: 'clover_active_item_effects', column: 'inventory_item_id', statusColumn: null, active: [] }),
]);

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function exactJson(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function parseJson(value, fallback = {}) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function semanticPlan(planInput) {
    const plan = planInput && typeof planInput === 'object' ? planInput : {};
    return {
        source: plan.source || null,
        policy: plan.policy || null,
        templatesToCreate: Array.isArray(plan.templatesToCreate) ? plan.templatesToCreate : [],
        actions: Array.isArray(plan.actions) ? plan.actions : [],
    };
}

function planHash(plan) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(stableValue(semanticPlan(plan))))
        .digest('hex');
}

function normalizeCode(value, hash) {
    const code = cleanText(value) || `LER-${hash.slice(0, 12).toUpperCase()}`;
    if (!/^[A-Z0-9_-]{6,80}$/i.test(code)) {
        throw new LegacyEventRewardResolutionError(
            'invalid_resolution_code',
            'Código de resolução inválido.',
            { code }
        );
    }
    return code.toUpperCase();
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [tableName]
    );
    return Boolean(row?.found);
}

async function columnSet(db, tableName) {
    if (!await tableExists(db, tableName)) return new Set();
    const rows = await db.all(`PRAGMA table_info(${tableName})`);
    return new Set(rows.map((row) => row.name));
}

async function readItem(db, id) {
    const row = await db.get(
        `SELECT i.*, COALESCE(j.personagem_nome, j.nome, j.display_name) AS character_name
         FROM clover_inventory_items i
         LEFT JOIN jogadores j ON j.id = i.player_id
         WHERE i.id = ?`,
        [Number(id)]
    );
    if (!row) {
        throw new LegacyEventRewardResolutionError(
            'inventory_item_not_found',
            'Item legado não encontrado.',
            { id: Number(id) }
        );
    }
    return row;
}

async function readTemplate(db, templateKey) {
    return db.get(
        'SELECT * FROM clover_item_templates WHERE template_key = ?',
        [String(templateKey || '').trim()]
    );
}

function comparablePlanBefore(row) {
    return {
        id: Number(row.id),
        characterName: cleanText(row.character_name),
        relatedId: cleanText(row.related_id),
        source: cleanText(row.source),
        templateKey: cleanText(row.template_key),
        itemName: cleanText(row.item_name),
        description: cleanText(row.description),
        quantity: Number(row.quantity || 0),
        category: cleanText(row.category),
        kind: cleanText(row.kind),
        origin: cleanText(row.origin),
        status: cleanText(row.status),
        transferable: Number(row.transferable ?? 0) ? 1 : 0,
        properties: stableValue(parseJson(row.properties_json, {})),
        effects: stableValue(parseJson(row.effects_json, {})),
    };
}

function comparableExpectedBefore(before) {
    return {
        id: Number(before.id),
        characterName: cleanText(before.characterName),
        relatedId: cleanText(before.relatedId),
        source: cleanText(before.source),
        templateKey: cleanText(before.templateKey),
        itemName: cleanText(before.itemName),
        description: cleanText(before.description),
        quantity: Number(before.quantity || 0),
        category: cleanText(before.category),
        kind: cleanText(before.kind),
        origin: cleanText(before.origin),
        status: cleanText(before.status),
        transferable: Number(before.transferable ?? 0) ? 1 : 0,
        properties: stableValue(before.properties || {}),
        effects: stableValue(before.effects || {}),
    };
}

function templateComparable(row) {
    if (!row) return null;
    return {
        templateKey: cleanText(row.template_key ?? row.templateKey),
        itemName: cleanText(row.item_name ?? row.itemName),
        description: cleanText(row.description),
        category: cleanText(row.category),
        kind: cleanText(row.kind),
        origin: cleanText(row.origin) || 'Clover',
        transferable: Number(row.transferable ?? 0) ? 1 : 0,
        properties: stableValue(parseJson(row.properties_json ?? row.properties, {})),
        effects: stableValue(parseJson(row.effects_json ?? row.effects, {})),
    };
}

function proposedTemplateRow(template, sourceDocumentId) {
    const stackable = template.kind === 'objeto_narrativo_pendente' ? 0 : 1;
    return {
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
        stackable,
        transferable: Number(template.transferable ?? 0) ? 1 : 0,
        properties_json: JSON.stringify(stableValue(template.properties || {})),
        effects_json: JSON.stringify(stableValue(template.effects || {})),
        metadata_json: JSON.stringify({
            legacyEventRewardResolution: true,
            sourceDocumentId,
            specificationStatus: 'pending',
        }),
        active: 1,
        is_custom: 1,
        requestable: 0,
        marketable: 0,
        duplicable: 1,
        created_by: 'legacy_event_reward_resolution',
        updated_by: 'legacy_event_reward_resolution',
        archived_at: null,
    };
}

function expectedTemplateComparable(proposedRow) {
    return {
        templateKey: proposedRow.template_key,
        itemName: proposedRow.item_name,
        description: proposedRow.description,
        category: proposedRow.category,
        kind: proposedRow.kind,
        origin: proposedRow.origin,
        transferable: proposedRow.transferable,
        properties: stableValue(parseJson(proposedRow.properties_json, {})),
        effects: stableValue(parseJson(proposedRow.effects_json, {})),
    };
}

async function blockingDependencies(db, itemId) {
    const found = [];
    for (const rule of BLOCKING_DEPENDENCIES) {
        if (!await tableExists(db, rule.table)) continue;
        const columns = await columnSet(db, rule.table);
        if (!columns.has(rule.column)) continue;
        let sql = `SELECT COUNT(*) AS total FROM ${rule.table} WHERE ${rule.column} = ?`;
        const params = [Number(itemId)];
        if (rule.statusColumn && columns.has(rule.statusColumn) && rule.active.length) {
            sql += ` AND LOWER(COALESCE(${rule.statusColumn}, '')) IN (${rule.active.map(() => '?').join(', ')})`;
            params.push(...rule.active);
        }
        const row = await db.get(sql, params);
        const total = Number(row?.total || 0);
        if (total > 0) found.push({ table: rule.table, total });
    }
    return found;
}

async function preflightPlan(db, planInput) {
    const plan = planInput && typeof planInput === 'object' ? planInput : {};
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    const templatesToCreate = Array.isArray(plan.templatesToCreate) ? plan.templatesToCreate : [];
    if (plan.mode !== 'readonly_plan' || plan.writesPerformed !== false) {
        throw new LegacyEventRewardResolutionError('invalid_resolution_plan', 'Plano não é somente leitura.');
    }
    if (actions.length !== 8 || templatesToCreate.length !== 4) {
        throw new LegacyEventRewardResolutionError(
            'unexpected_resolution_scope',
            'O plano precisa conter oito ações e quatro modelos.',
            { actions: actions.length, templatesToCreate: templatesToCreate.length }
        );
    }
    if (plan.policy?.deletesInventoryItems !== false
        || plan.policy?.preservesQuantities !== true
        || plan.policy?.automaticEffects !== false
        || plan.policy?.convertsSpellRewardToTicket !== false) {
        throw new LegacyEventRewardResolutionError('unsafe_resolution_policy', 'Política do plano é insegura.');
    }

    const sourceDocumentId = cleanText(plan.source?.documentId);
    const proposedByKey = new Map();
    for (const template of templatesToCreate) {
        const proposed = proposedTemplateRow(template, sourceDocumentId);
        const existing = await readTemplate(db, proposed.template_key);
        if (existing && !exactJson(templateComparable(existing), expectedTemplateComparable(proposed))) {
            throw new LegacyEventRewardResolutionError(
                'template_conflict',
                'Modelo pendente existente diverge da proposta.',
                { templateKey: proposed.template_key }
            );
        }
        proposedByKey.set(proposed.template_key, { proposed, existing });
    }

    const units = [];
    for (const [index, action] of actions.entries()) {
        const current = await readItem(db, action.inventoryItemId);
        const actual = comparablePlanBefore(current);
        const expected = comparableExpectedBefore(action.before || {});
        if (!exactJson(actual, expected)) {
            throw new LegacyEventRewardResolutionError(
                'stale_resolution_item',
                'O item mudou desde a criação do plano.',
                { index, itemId: Number(action.inventoryItemId), actual, expected }
            );
        }
        const dependencies = await blockingDependencies(db, current.id);
        if (dependencies.length) {
            throw new LegacyEventRewardResolutionError(
                'active_item_dependency',
                'O item possui operação ativa e não pode ser reclassificado.',
                { index, itemId: current.id, dependencies }
            );
        }

        const targetKey = cleanText(action.after?.templateKey);
        let target = await readTemplate(db, targetKey);
        let willCreateTemplate = false;
        if (!target) {
            const proposal = proposedByKey.get(targetKey);
            if (!proposal) {
                throw new LegacyEventRewardResolutionError(
                    'destination_template_not_found',
                    'Modelo de destino não foi encontrado nem proposto.',
                    { index, targetKey }
                );
            }
            target = proposal.proposed;
            willCreateTemplate = true;
        }
        const targetComparable = templateComparable(target);
        const plannedAfter = action.after || {};
        const expectedTarget = {
            templateKey: cleanText(plannedAfter.templateKey),
            itemName: cleanText(plannedAfter.itemName),
            description: cleanText(plannedAfter.description),
            category: cleanText(plannedAfter.category),
            kind: cleanText(plannedAfter.kind),
            origin: cleanText(plannedAfter.origin) || 'Clover',
            transferable: Number(plannedAfter.transferable ?? 0) ? 1 : 0,
            properties: stableValue(plannedAfter.properties || {}),
            effects: stableValue(plannedAfter.effects || {}),
        };
        if (!exactJson(targetComparable, expectedTarget)) {
            throw new LegacyEventRewardResolutionError(
                'destination_template_mismatch',
                'Modelo de destino diverge do plano.',
                { index, targetKey, target: targetComparable, expected: expectedTarget }
            );
        }
        units.push({ index, action, current, target, willCreateTemplate });
    }

    return {
        plan,
        hash: planHash(plan),
        sourceDocumentId,
        proposedByKey,
        units,
    };
}

function itemUpdatesFromTemplate(current, template, options) {
    const templateMetadata = parseJson(template.metadata_json, {});
    const originalMetadata = parseJson(current.metadata_json, {});
    const defaultQuality = cleanText(template.default_quality) || 'comum';
    const basePrice = Math.max(0, Number(template.base_price || 0));
    const durability = template.default_durability === null || template.default_durability === undefined
        ? null
        : Number(template.default_durability);
    const bound = Number(template.transferable ?? 0) ? Number(current.bound || 0) : 1;
    return {
        item_name: template.item_name,
        description: template.description,
        template_key: template.template_key,
        catalog_version: Number(template.catalog_version || 1),
        category: template.category,
        kind: template.kind,
        origin: template.origin || 'Clover',
        quality: defaultQuality,
        base_price: basePrice,
        reference_price: calculateReferencePrice(basePrice, defaultQuality, basePrice),
        durability_current: durability,
        durability_max: durability,
        bound,
        transferable: Number(template.transferable ?? 0) && !bound ? 1 : 0,
        properties_json: template.properties_json || '{}',
        effects_json: template.effects_json || '{}',
        metadata_json: JSON.stringify({
            ...originalMetadata,
            template_flags: {
                custom: Boolean(template.is_custom),
                marketable: Boolean(template.marketable),
                requestable: Boolean(template.requestable),
                duplicable: Boolean(template.duplicable),
            },
            legacy_event_reward_resolution: {
                resolution_code: options.resolutionCode,
                source_document_id: options.sourceDocumentId,
                related_id: current.related_id,
                previous_item_name: current.item_name,
                previous_kind: current.kind,
            },
            template_metadata: templateMetadata,
        }),
        updated_at: options.timestamp,
    };
}

async function ensureResolutionSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_legacy_event_reward_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resolution_code TEXT NOT NULL UNIQUE,
            plan_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('applying', 'applied', 'undone')),
            actor_id TEXT DEFAULT NULL,
            plan_json TEXT NOT NULL,
            result_json TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            applied_at TEXT DEFAULT NULL,
            undone_at TEXT DEFAULT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS clover_legacy_event_reward_units (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id INTEGER NOT NULL,
            unit_index INTEGER NOT NULL,
            inventory_item_id INTEGER NOT NULL,
            template_key TEXT NOT NULL,
            before_json TEXT NOT NULL,
            after_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            undone_at TEXT DEFAULT NULL,
            FOREIGN KEY (batch_id) REFERENCES clover_legacy_event_reward_batches(id),
            UNIQUE (batch_id, unit_index),
            UNIQUE (batch_id, inventory_item_id)
        );
        CREATE INDEX IF NOT EXISTS idx_legacy_event_reward_units_batch
        ON clover_legacy_event_reward_units (batch_id, unit_index);
    `);
}

async function columnAwareInsert(db, table, row) {
    const columns = await columnSet(db, table);
    const entries = Object.entries(row).filter(([key]) => columns.has(key));
    if (!entries.length) throw new Error(`Nenhuma coluna compatível para ${table}.`);
    const result = await db.run(
        `INSERT INTO ${table} (${entries.map(([key]) => key).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`,
        entries.map(([, value]) => value)
    );
    return result.lastID;
}

async function updateItem(db, id, updates) {
    const columns = await columnSet(db, 'clover_inventory_items');
    const entries = Object.entries(updates).filter(([key]) => columns.has(key));
    if (!entries.length) throw new Error('Nenhuma coluna compatível para atualização do item.');
    await db.run(
        `UPDATE clover_inventory_items SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`,
        [...entries.map(([, value]) => value), Number(id)]
    );
}

async function appendHistory(db, options) {
    if (!await tableExists(db, 'clover_inventory_item_history')) return;
    await columnAwareInsert(db, 'clover_inventory_item_history', {
        item_id: options.item.id,
        player_id: options.item.player_id,
        action: options.action,
        quantity_delta: 0,
        durability_delta: 0,
        before_json: JSON.stringify(options.before),
        after_json: JSON.stringify(options.after),
        source: 'legacy_event_reward_resolution',
        related_id: options.resolutionCode,
        idempotency_key: options.idempotencyKey,
        created_by: options.actorId || 'system',
        created_at: options.timestamp,
        metadata_json: JSON.stringify({
            resolutionCode: options.resolutionCode,
            unitIndex: options.unitIndex,
            sourceDocumentId: options.sourceDocumentId,
        }),
    });
}

async function createTemplate(db, row, timestamp) {
    await columnAwareInsert(db, 'clover_item_templates', {
        ...row,
        created_at: timestamp,
        updated_at: timestamp,
    });
}

async function previewResolutionPlan(db, planInput) {
    const preflight = await preflightPlan(db, planInput);
    return {
        mode: 'preview',
        writesPerformed: false,
        executorVersion: 1,
        planHash: preflight.hash,
        summary: {
            actions: preflight.units.length,
            inventoryUnits: preflight.units.reduce((sum, unit) => sum + Number(unit.current.quantity || 0), 0),
            dungeonAccessUnits: preflight.units
                .filter((unit) => unit.target.template_key === 'acesso_dungeon_exclusiva')
                .reduce((sum, unit) => sum + Number(unit.current.quantity || 0), 0),
            pendingRewards: preflight.units.filter((unit) => (
                parseJson(unit.target.properties_json, {}).specificationStatus === 'pending'
            )).length,
            templatesToCreate: [...preflight.proposedByKey.values()].filter((entry) => !entry.existing).length,
        },
        actions: preflight.units.map((unit) => ({
            index: unit.index,
            inventoryItemId: Number(unit.current.id),
            characterName: cleanText(unit.current.character_name),
            relatedId: cleanText(unit.current.related_id),
            beforeItemName: cleanText(unit.current.item_name),
            quantity: Number(unit.current.quantity || 0),
            targetTemplateKey: unit.target.template_key,
            targetItemName: unit.target.item_name,
            targetKind: unit.target.kind,
            willCreateTemplate: unit.willCreateTemplate,
        })),
    };
}

async function applyResolutionPlan(db, planInput, options = {}) {
    if (options.confirm !== 'APPLY-LEGACY-EVENT-REWARDS') {
        throw new LegacyEventRewardResolutionError(
            'apply_confirmation_required',
            'Confirmação literal APPLY-LEGACY-EVENT-REWARDS é obrigatória.'
        );
    }
    const initialHash = planHash(planInput);
    const resolutionCode = normalizeCode(options.resolutionCode, initialHash);
    const timestamp = options.timestamp || new Date().toISOString();

    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensureResolutionSchema(db);
        const existingBatch = await db.get(
            'SELECT * FROM clover_legacy_event_reward_batches WHERE resolution_code = ?',
            [resolutionCode]
        );
        if (existingBatch) {
            if (existingBatch.plan_hash === initialHash && existingBatch.status === 'applied') {
                await db.exec('ROLLBACK');
                return { duplicate: true, resolutionCode, status: 'applied' };
            }
            throw new LegacyEventRewardResolutionError(
                'resolution_code_conflict',
                'Código de resolução já utilizado.',
                { resolutionCode, status: existingBatch.status }
            );
        }

        const preflight = await preflightPlan(db, planInput);
        const batch = await db.run(
            `INSERT INTO clover_legacy_event_reward_batches
             (resolution_code, plan_hash, status, actor_id, plan_json, created_at, updated_at)
             VALUES (?, ?, 'applying', ?, ?, ?, ?)`,
            [resolutionCode, preflight.hash, options.actorId || null, JSON.stringify(preflight.plan), timestamp, timestamp]
        );
        const batchId = batch.lastID;
        const createdTemplates = [];
        for (const { proposed, existing } of preflight.proposedByKey.values()) {
            if (existing) continue;
            await createTemplate(db, proposed, timestamp);
            createdTemplates.push(proposed.template_key);
        }

        const results = [];
        for (const unit of preflight.units) {
            const currentTemplate = await readTemplate(db, unit.target.template_key);
            const before = await readItem(db, unit.current.id);
            const updates = itemUpdatesFromTemplate(before, currentTemplate, {
                resolutionCode,
                sourceDocumentId: preflight.sourceDocumentId,
                timestamp,
            });
            await updateItem(db, before.id, updates);
            const after = await readItem(db, before.id);
            await db.run(
                `INSERT INTO clover_legacy_event_reward_units
                 (batch_id, unit_index, inventory_item_id, template_key, before_json, after_json, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [batchId, unit.index, before.id, currentTemplate.template_key, JSON.stringify(before), JSON.stringify(after), timestamp]
            );
            await appendHistory(db, {
                item: before,
                action: 'legacy_event_reward_resolved',
                before,
                after,
                resolutionCode,
                unitIndex: unit.index,
                idempotencyKey: `${resolutionCode}:${unit.index}:${before.id}:apply`,
                actorId: options.actorId,
                timestamp,
                sourceDocumentId: preflight.sourceDocumentId,
            });
            results.push({
                unitIndex: unit.index,
                inventoryItemId: Number(before.id),
                quantity: Number(before.quantity || 0),
                templateKey: currentTemplate.template_key,
                itemName: currentTemplate.item_name,
            });
        }

        const result = {
            executorVersion: 1,
            resolutionCode,
            planHash: preflight.hash,
            actions: results,
            createdTemplates,
        };
        await db.run(
            `UPDATE clover_legacy_event_reward_batches
             SET status = 'applied', result_json = ?, applied_at = ?, updated_at = ? WHERE id = ?`,
            [JSON.stringify(result), timestamp, timestamp, batchId]
        );
        await db.exec('COMMIT');
        return {
            duplicate: false,
            status: 'applied',
            ...result,
            updatedRows: results.length,
            updatedUnits: results.reduce((sum, entry) => sum + entry.quantity, 0),
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

function comparableResolvedItem(row) {
    return {
        id: Number(row.id),
        characterName: cleanText(row.character_name),
        relatedId: cleanText(row.related_id),
        source: cleanText(row.source),
        templateKey: cleanText(row.template_key),
        itemName: cleanText(row.item_name),
        description: cleanText(row.description),
        quantity: Number(row.quantity || 0),
        category: cleanText(row.category),
        kind: cleanText(row.kind),
        origin: cleanText(row.origin),
        transferable: Number(row.transferable ?? 0) ? 1 : 0,
        properties: stableValue(parseJson(row.properties_json, {})),
        effects: stableValue(parseJson(row.effects_json, {})),
    };
}

async function verifyResolvedPlan(db, planInput) {
    const plan = planInput && typeof planInput === 'object' ? planInput : {};
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    const verified = [];
    for (const [index, action] of actions.entries()) {
        const row = await readItem(db, action.inventoryItemId);
        const actual = comparableResolvedItem(row);
        const expected = {
            id: Number(action.before.id),
            characterName: cleanText(action.before.characterName),
            relatedId: cleanText(action.relatedId),
            source: cleanText(action.before.source),
            templateKey: cleanText(action.after.templateKey),
            itemName: cleanText(action.after.itemName),
            description: cleanText(action.after.description),
            quantity: Number(action.before.quantity || 0),
            category: cleanText(action.after.category),
            kind: cleanText(action.after.kind),
            origin: cleanText(action.after.origin) || 'Clover',
            transferable: Number(action.after.transferable ?? 0) ? 1 : 0,
            properties: stableValue(action.after.properties || {}),
            effects: stableValue(action.after.effects || {}),
        };
        if (!exactJson(actual, expected)) {
            throw new LegacyEventRewardResolutionError(
                'resolution_verification_failed',
                'Item resolvido diverge do plano.',
                { index, itemId: row.id, actual, expected }
            );
        }
        const metadata = parseJson(row.metadata_json, {});
        if (metadata.legacy_event_reward_resolution?.source_document_id !== cleanText(plan.source?.documentId)) {
            throw new LegacyEventRewardResolutionError(
                'resolution_metadata_missing',
                'Item resolvido não possui metadado da fonte oficial.',
                { index, itemId: row.id }
            );
        }
        verified.push({ inventoryItemId: Number(row.id), quantity: Number(row.quantity || 0), templateKey: row.template_key });
    }
    return {
        mode: 'verify',
        writesPerformed: false,
        executorVersion: 1,
        planHash: planHash(plan),
        verifiedRows: verified.length,
        verifiedUnits: verified.reduce((sum, entry) => sum + entry.quantity, 0),
        dungeonAccessUnits: verified
            .filter((entry) => entry.templateKey === 'acesso_dungeon_exclusiva')
            .reduce((sum, entry) => sum + entry.quantity, 0),
        pendingRewardRows: verified.filter((entry) => entry.templateKey !== 'acesso_dungeon_exclusiva').length,
    };
}

function rawRowComparable(row) {
    const copy = { ...row };
    delete copy.character_name;
    return stableValue(copy);
}

async function undoResolutionBatch(db, options = {}) {
    if (options.confirm !== 'UNDO-LEGACY-EVENT-REWARDS') {
        throw new LegacyEventRewardResolutionError(
            'undo_confirmation_required',
            'Confirmação literal UNDO-LEGACY-EVENT-REWARDS é obrigatória.'
        );
    }
    const resolutionCode = normalizeCode(options.resolutionCode, '000000000000');
    const timestamp = options.timestamp || new Date().toISOString();

    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensureResolutionSchema(db);
        const batch = await db.get(
            'SELECT * FROM clover_legacy_event_reward_batches WHERE resolution_code = ?',
            [resolutionCode]
        );
        if (!batch) {
            throw new LegacyEventRewardResolutionError(
                'resolution_batch_not_found',
                'Lote de resolução não encontrado.',
                { resolutionCode }
            );
        }
        if (batch.status === 'undone') {
            await db.exec('ROLLBACK');
            return { duplicate: true, resolutionCode, status: 'undone' };
        }
        if (batch.status !== 'applied') {
            throw new LegacyEventRewardResolutionError(
                'resolution_batch_not_applied',
                'Somente lote aplicado pode ser desfeito.',
                { resolutionCode, status: batch.status }
            );
        }
        const units = await db.all(
            'SELECT * FROM clover_legacy_event_reward_units WHERE batch_id = ? ORDER BY unit_index DESC',
            [batch.id]
        );
        for (const unit of units) {
            const current = await readItem(db, unit.inventory_item_id);
            const expectedAfter = parseJson(unit.after_json, {});
            if (!exactJson(rawRowComparable(current), rawRowComparable(expectedAfter))) {
                throw new LegacyEventRewardResolutionError(
                    'resolved_item_changed_before_undo',
                    'Item mudou após a resolução; undo foi bloqueado.',
                    { itemId: unit.inventory_item_id, unitIndex: unit.unit_index }
                );
            }
        }

        const result = parseJson(batch.result_json, {});
        for (const unit of units) {
            const before = parseJson(unit.before_json, {});
            const current = await readItem(db, unit.inventory_item_id);
            await updateItem(db, before.id, before);
            const restored = await readItem(db, before.id);
            await appendHistory(db, {
                item: before,
                action: 'legacy_event_reward_resolution_undone',
                before: current,
                after: restored,
                resolutionCode,
                unitIndex: unit.unit_index,
                idempotencyKey: `${resolutionCode}:${unit.unit_index}:${before.id}:undo`,
                actorId: options.actorId,
                timestamp,
                sourceDocumentId: parseJson(batch.plan_json, {}).source?.documentId || null,
            });
            await db.run(
                'UPDATE clover_legacy_event_reward_units SET undone_at = ? WHERE id = ?',
                [timestamp, unit.id]
            );
        }

        for (const templateKey of [...new Set(result.createdTemplates || [])]) {
            const linked = await db.get(
                'SELECT COUNT(*) AS total FROM clover_inventory_items WHERE template_key = ?',
                [templateKey]
            );
            if (Number(linked?.total || 0) > 0) {
                throw new LegacyEventRewardResolutionError(
                    'created_template_still_in_use',
                    'Modelo criado ainda está em uso; undo foi bloqueado.',
                    { templateKey, total: Number(linked.total) }
                );
            }
            await db.run('DELETE FROM clover_item_templates WHERE template_key = ?', [templateKey]);
        }

        await db.run(
            `UPDATE clover_legacy_event_reward_batches
             SET status = 'undone', undone_at = ?, updated_at = ? WHERE id = ?`,
            [timestamp, timestamp, batch.id]
        );
        await db.exec('COMMIT');
        return {
            duplicate: false,
            status: 'undone',
            executorVersion: 1,
            resolutionCode,
            restoredRows: units.length,
            removedTemplates: [...new Set(result.createdTemplates || [])].length,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    BLOCKING_DEPENDENCIES,
    applyResolutionPlan,
    ensureResolutionSchema,
    planHash,
    preflightPlan,
    previewResolutionPlan,
    undoResolutionBatch,
    verifyResolvedPlan,
};
