'use strict';

const crypto = require('crypto');

const FIXED_TRAIT_SLOTS = Object.freeze([
    'aptidao_comum',
    'marca_comum',
    'aptidao_rara',
    'marca_rara',
    'anomalia',
]);
const EXTRA_TRAIT_SLOTS = Object.freeze(['extra_trait', 'extra_anomaly']);
const CATALOG_TRAIT_SLOTS = Object.freeze([...FIXED_TRAIT_SLOTS, ...EXTRA_TRAIT_SLOTS]);
const TRAIT_SLOTS = FIXED_TRAIT_SLOTS;
const EMPTY_TRAIT_VALUES = new Set(['', '-', '—', '–', 'null', 'none']);

class AdminTraitServiceError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminTraitServiceError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function requireText(value, field) {
    const text = String(value || '').trim();
    if (!text) throw new AdminTraitServiceError('missing_trait_field', `${field} é obrigatório.`, 400, { field });
    return text;
}

function isEmptyTraitValue(value) {
    if (value === null || value === undefined) return true;
    return EMPTY_TRAIT_VALUES.has(String(value).trim().toLowerCase());
}

function normalizeSlot(value, options = {}) {
    const slot = String(value || '').trim().toLowerCase();
    const allowed = options.fixedOnly ? FIXED_TRAIT_SLOTS : CATALOG_TRAIT_SLOTS;
    if (!allowed.includes(slot)) {
        throw new AdminTraitServiceError('invalid_trait_slot', 'Espaço de traço inválido.', 400, {
            slot,
            allowed,
        });
    }
    return slot;
}

function slugifyTraitKey(value) {
    const text = String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || crypto.randomBytes(8).toString('hex');
}

function generateTraitId(randomBytes = crypto.randomBytes) {
    return `TR-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function ensureColumn(db, table, column, definition) {
    const columns = await db.all(`PRAGMA table_info(${table})`);
    if (!columns.some((item) => item.name === column)) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
}

async function ensureAdminTraitSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_trait_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slot_key TEXT NOT NULL,
            description TEXT DEFAULT NULL,
            effect_text TEXT DEFAULT NULL,
            restrictions_text TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            version INTEGER NOT NULL DEFAULT 1,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            operation_code TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            updated_by TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            canonical_key TEXT DEFAULT NULL,
            trait_kind TEXT NOT NULL DEFAULT 'system',
            source TEXT DEFAULT NULL
        )
    `);
    await ensureColumn(db, 'clover_trait_templates', 'canonical_key', 'canonical_key TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_trait_templates', 'trait_kind', "trait_kind TEXT NOT NULL DEFAULT 'system'");
    await ensureColumn(db, 'clover_trait_templates', 'source', 'source TEXT DEFAULT NULL');
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_trait_templates_status_slot
        ON clover_trait_templates (status, slot_key, name)
    `);
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_trait_templates_slot_canonical
        ON clover_trait_templates (slot_key, canonical_key)
        WHERE canonical_key IS NOT NULL
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_player_traits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            trait_id TEXT NOT NULL,
            slot_key TEXT NOT NULL,
            value_text TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            operation_code TEXT DEFAULT NULL,
            assigned_by TEXT DEFAULT NULL,
            removed_by TEXT DEFAULT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            assigned_at TEXT NOT NULL,
            removed_at TEXT DEFAULT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            source TEXT DEFAULT NULL,
            legacy_ref TEXT DEFAULT NULL,
            assignment_key TEXT DEFAULT NULL
        )
    `);
    await ensureColumn(db, 'clover_player_traits', 'position', 'position INTEGER NOT NULL DEFAULT 0');
    await ensureColumn(db, 'clover_player_traits', 'source', 'source TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_player_traits', 'legacy_ref', 'legacy_ref TEXT DEFAULT NULL');
    await ensureColumn(db, 'clover_player_traits', 'assignment_key', 'assignment_key TEXT DEFAULT NULL');
    await db.exec('DROP INDEX IF EXISTS idx_clover_player_traits_active_slot');
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_player_traits_active_fixed_slot
        ON clover_player_traits (player_id, slot_key)
        WHERE active = 1 AND slot_key IN ('aptidao_comum','marca_comum','aptidao_rara','marca_rara','anomalia')
    `);
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_player_traits_assignment_key
        ON clover_player_traits (assignment_key)
        WHERE assignment_key IS NOT NULL
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_player_traits_trait
        ON clover_player_traits (trait_id, active, assigned_at DESC)
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_player_traits_player_active_position
        ON clover_player_traits (player_id, active, slot_key, position, id)
    `);
}

function mapTrait(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        slotKey: row.slot_key,
        description: row.description,
        effectText: row.effect_text,
        restrictionsText: row.restrictions_text,
        status: row.status,
        version: Number(row.version || 1),
        metadata: parseJson(row.metadata_json, {}),
        canonicalKey: row.canonical_key || null,
        traitKind: row.trait_kind || 'system',
        source: row.source || null,
        operationCode: row.operation_code,
        createdBy: row.created_by,
        updatedBy: row.updated_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function mapAssignment(row) {
    if (!row) return null;
    return {
        id: row.id,
        traitId: row.trait_id,
        valueText: row.value_text,
        slotKey: row.slot_key,
        position: Number(row.position || 0),
        operationCode: row.operation_code,
        assignedBy: row.assigned_by,
        assignedAt: row.assigned_at,
        source: row.source || null,
        legacyRef: row.legacy_ref || null,
        metadata: parseJson(row.metadata_json, {}),
    };
}

async function getTraitTemplate(db, traitId, options = {}) {
    await ensureAdminTraitSchema(db);
    const id = String(traitId || '').trim().toUpperCase();
    const row = await db.get('SELECT * FROM clover_trait_templates WHERE id = ?', [id]);
    if (!row) {
        if (options.nullIfMissing) return null;
        throw new AdminTraitServiceError('trait_not_found', 'Traço não encontrado.', 404, { traitId: id });
    }
    return mapTrait(row);
}

async function listTraitTemplates(db, options = {}) {
    await ensureAdminTraitSchema(db);
    const conditions = [];
    const params = [];
    if (!options.includeArchived) conditions.push("status = 'active'");
    if (options.slotKey) {
        conditions.push('slot_key = ?');
        params.push(normalizeSlot(options.slotKey));
    }
    if (options.query) {
        conditions.push('(LOWER(name) LIKE LOWER(?) OR LOWER(COALESCE(description, \'\')) LIKE LOWER(?))');
        const pattern = `%${String(options.query).trim()}%`;
        params.push(pattern, pattern);
    }
    params.push(Math.max(1, Math.min(300, Number(options.limit) || 100)));
    const rows = await db.all(
        `SELECT * FROM clover_trait_templates
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY slot_key ASC, name ASC, id ASC
         LIMIT ?`,
        params
    );
    return { ok: true, traits: rows.map(mapTrait), slots: CATALOG_TRAIT_SLOTS };
}

async function getPlayerTraitState(db, playerId, slotKey) {
    const slot = normalizeSlot(slotKey, { fixedOnly: true });
    const player = await db.get(`SELECT id, personagem_nome, ${slot} AS value FROM jogadores WHERE id = ?`, [playerId]);
    if (!player) throw new AdminTraitServiceError('player_not_found', 'Jogador não encontrado.', 404, { playerId });
    const assignment = await db.get(
        `SELECT * FROM clover_player_traits
         WHERE player_id = ? AND slot_key = ? AND active = 1
         ORDER BY id DESC LIMIT 1`,
        [playerId, slot]
    );
    const normalizedValue = isEmptyTraitValue(player.value) ? null : String(player.value).trim();
    return {
        playerId: player.id,
        characterName: player.personagem_nome || player.id,
        slotKey: slot,
        value: assignment?.value_text || normalizedValue,
        legacyValue: normalizedValue,
        assignment: mapAssignment(assignment),
    };
}

async function listPlayerExtraTraits(db, playerId, slotKey = null) {
    await ensureAdminTraitSchema(db);
    const player = await db.get('SELECT id, personagem_nome FROM jogadores WHERE id = ?', [playerId]);
    if (!player) throw new AdminTraitServiceError('player_not_found', 'Jogador não encontrado.', 404, { playerId });
    const params = [playerId];
    let slotSql = "slot_key IN ('extra_trait','extra_anomaly')";
    if (slotKey) {
        const normalized = normalizeSlot(slotKey);
        if (!EXTRA_TRAIT_SLOTS.includes(normalized)) {
            throw new AdminTraitServiceError('invalid_extra_trait_slot', 'O espaço informado não é adicional.', 400);
        }
        slotSql = 'slot_key = ?';
        params.push(normalized);
    }
    const rows = await db.all(
        `SELECT pt.*,
                pt.id AS assignment_id, pt.slot_key AS assignment_slot_key,
                pt.source AS assignment_source, pt.metadata_json AS assignment_metadata_json,
                tt.id AS template_id, tt.name AS template_name, tt.slot_key AS template_slot_key,
                tt.description AS template_description, tt.effect_text AS template_effect_text,
                tt.restrictions_text AS template_restrictions_text, tt.status AS template_status,
                tt.version AS template_version, tt.metadata_json AS template_metadata_json,
                tt.operation_code AS template_operation_code, tt.created_by AS template_created_by,
                tt.updated_by AS template_updated_by, tt.created_at AS template_created_at,
                tt.updated_at AS template_updated_at, tt.canonical_key AS template_canonical_key,
                tt.trait_kind AS template_trait_kind, tt.source AS template_source
         FROM clover_player_traits pt
         LEFT JOIN clover_trait_templates tt ON tt.id = pt.trait_id
         WHERE pt.player_id = ? AND pt.active = 1 AND ${slotSql}
         ORDER BY pt.slot_key ASC, pt.position ASC, pt.id ASC`,
        params
    );
    return rows.map((row) => ({
        playerId: player.id,
        characterName: player.personagem_nome || player.id,
        slotKey: row.assignment_slot_key,
        value: row.value_text,
        source: 'catalog',
        assignment: {
            id: row.assignment_id,
            traitId: row.trait_id,
            valueText: row.value_text,
            slotKey: row.assignment_slot_key,
            position: Number(row.position || 0),
            operationCode: row.operation_code,
            assignedBy: row.assigned_by,
            assignedAt: row.assigned_at,
            source: row.assignment_source || null,
            metadata: parseJson(row.assignment_metadata_json, {}),
        },
        trait: row.template_id ? mapTrait({
            id: row.template_id, name: row.template_name, slot_key: row.template_slot_key,
            description: row.template_description, effect_text: row.template_effect_text,
            restrictions_text: row.template_restrictions_text, status: row.template_status,
            version: row.template_version, metadata_json: row.template_metadata_json,
            operation_code: row.template_operation_code, created_by: row.template_created_by,
            updated_by: row.template_updated_by, created_at: row.template_created_at,
            updated_at: row.template_updated_at, canonical_key: row.template_canonical_key,
            trait_kind: row.template_trait_kind, source: row.template_source,
        }) : null,
    }));
}

function normalizeTemplatePayload(payload = {}, options = {}) {
    const partial = Boolean(options.partial);
    const has = (keys) => keys.some((key) => Object.prototype.hasOwnProperty.call(payload, key));
    const result = {};

    if (!partial || has(['name'])) result.name = requireText(payload.name, 'Nome');
    if (!partial || has(['slotKey', 'slot_key'])) result.slotKey = normalizeSlot(payload.slotKey || payload.slot_key);
    if (!partial || has(['description'])) result.description = String(payload.description || '').trim() || null;
    if (!partial || has(['effectText', 'effect_text'])) result.effectText = String(payload.effectText || payload.effect_text || '').trim() || null;
    if (!partial || has(['restrictionsText', 'restrictions_text'])) result.restrictionsText = String(payload.restrictionsText || payload.restrictions_text || '').trim() || null;
    if (!partial || has(['metadata'])) {
        result.metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
            ? { ...payload.metadata }
            : {};
    }
    if (!partial || has(['canonicalKey', 'canonical_key'])) {
        result.canonicalKey = String(payload.canonicalKey || payload.canonical_key || slugifyTraitKey(result.name || payload.name)).trim();
    }
    if (!partial || has(['traitKind', 'trait_kind'])) result.traitKind = String(payload.traitKind || payload.trait_kind || 'system').trim() || 'system';
    if (!partial || has(['source'])) result.source = String(payload.source || 'admin').trim() || 'admin';

    if (partial && !Object.keys(result).length) {
        throw new AdminTraitServiceError('empty_trait_update', 'Nenhuma alteração foi informada.', 400);
    }
    return result;
}

async function createTraitTemplate(db, payload, context = {}) {
    await ensureAdminTraitSchema(db);
    const normalized = normalizeTemplatePayload(payload);
    const timestamp = context.timestamp || new Date().toISOString();
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const id = String(payload.id || generateTraitId(context.randomBytes)).trim().toUpperCase();
        try {
            await db.run(
                `INSERT INTO clover_trait_templates
                 (id, name, slot_key, description, effect_text, restrictions_text, status, version,
                  metadata_json, operation_code, created_by, updated_by, created_at, updated_at,
                  canonical_key, trait_kind, source)
                 VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id, normalized.name, normalized.slotKey, normalized.description, normalized.effectText,
                    normalized.restrictionsText, JSON.stringify(normalized.metadata), context.operationCode || null,
                    context.actorId || null, context.actorId || null, timestamp, timestamp,
                    normalized.canonicalKey, normalized.traitKind, normalized.source,
                ]
            );
            return getTraitTemplate(db, id);
        } catch (error) {
            const message = String(error?.message || error);
            if (/UNIQUE constraint failed: clover_trait_templates\.id/i.test(message) && !payload.id) continue;
            if (/idx_clover_trait_templates_slot_canonical|clover_trait_templates\.slot_key, clover_trait_templates\.canonical_key/i.test(message)) {
                throw new AdminTraitServiceError('trait_duplicate', 'Já existe um traço com esse nome nesse espaço.', 409, {
                    slotKey: normalized.slotKey,
                    canonicalKey: normalized.canonicalKey,
                });
            }
            throw error;
        }
    }
    throw new AdminTraitServiceError('trait_id_collision', 'Não foi possível gerar um identificador de traço.', 503);
}

async function restoreTraitSnapshot(db, snapshot, context = {}) {
    const timestamp = context.timestamp || new Date().toISOString();
    await db.run(
        `UPDATE clover_trait_templates
         SET name = ?, slot_key = ?, description = ?, effect_text = ?, restrictions_text = ?,
             status = ?, version = ?, metadata_json = ?, operation_code = ?, updated_by = ?, updated_at = ?,
             canonical_key = ?, trait_kind = ?, source = ?
         WHERE id = ?`,
        [
            snapshot.name, snapshot.slotKey, snapshot.description, snapshot.effectText, snapshot.restrictionsText,
            snapshot.status, snapshot.version, JSON.stringify(snapshot.metadata || {}), snapshot.operationCode || null,
            context.actorId || null, timestamp, snapshot.canonicalKey || slugifyTraitKey(snapshot.name),
            snapshot.traitKind || 'system', snapshot.source || 'admin', snapshot.id,
        ]
    );
}

async function getExtraAssignment(db, playerId, assignmentId) {
    const row = await db.get(
        `SELECT pt.*, tt.name AS trait_name, tt.slot_key AS trait_slot_key, j.personagem_nome
         FROM clover_player_traits pt
         LEFT JOIN clover_trait_templates tt ON tt.id = pt.trait_id
         LEFT JOIN jogadores j ON j.id = pt.player_id
         WHERE pt.id = ? AND pt.player_id = ? AND pt.active = 1`,
        [Number(assignmentId), playerId]
    );
    if (!row || !EXTRA_TRAIT_SLOTS.includes(row.slot_key)) {
        throw new AdminTraitServiceError('extra_trait_assignment_not_found', 'A atribuição adicional não foi encontrada.', 404);
    }
    return row;
}

function createTraitExecutors() {
    return {
        'catalog.trait.create': {
            async preview({ action }) {
                const payload = normalizeTemplatePayload(action.payload || {});
                return { summary: `Criar traço: ${payload.name}`, before: null, after: payload };
            },
            async apply({ db, operation, action, after }) {
                const trait = await createTraitTemplate(db, { ...(action.payload || {}), ...after }, {
                    operationCode: operation.code,
                    actorId: operation.actor.id,
                });
                return { before: null, after: trait, summary: `Traço ${trait.name} criado.` };
            },
            async undo({ db, after }) {
                const traitId = after?.id;
                if (!traitId) throw new AdminTraitServiceError('missing_trait_snapshot', 'Snapshot do traço criado está incompleto.', 409);
                const used = await db.get('SELECT COUNT(*) AS total FROM clover_player_traits WHERE trait_id = ? AND active = 1', [traitId]);
                if (Number(used?.total || 0) > 0) {
                    throw new AdminTraitServiceError('trait_in_use', 'O traço criado já está atribuído e não pode ser removido pelo desfazer.', 409);
                }
                await db.run('DELETE FROM clover_trait_templates WHERE id = ?', [traitId]);
            },
        },
        'catalog.trait.update': {
            async preview({ db, action }) {
                const traitId = requireText(action.payload?.traitId || action.payload?.id, 'traitId').toUpperCase();
                const before = await getTraitTemplate(db, traitId);
                const changes = normalizeTemplatePayload(action.payload || {}, { partial: true });
                const after = { ...before, ...changes, version: before.version + 1 };
                return { summary: `Editar traço: ${before.name}`, before, after };
            },
            async apply({ db, operation, after }) {
                const timestamp = new Date().toISOString();
                await db.run(
                    `UPDATE clover_trait_templates
                     SET name = ?, slot_key = ?, description = ?, effect_text = ?, restrictions_text = ?,
                         metadata_json = ?, version = ?, operation_code = ?, updated_by = ?, updated_at = ?,
                         canonical_key = ?, trait_kind = ?, source = ?
                     WHERE id = ?`,
                    [
                        after.name, after.slotKey, after.description, after.effectText, after.restrictionsText,
                        JSON.stringify(after.metadata || {}), after.version, operation.code, operation.actor.id, timestamp,
                        after.canonicalKey || slugifyTraitKey(after.name), after.traitKind || 'system', after.source || 'admin', after.id,
                    ]
                );
                return { after: await getTraitTemplate(db, after.id), summary: `Traço ${after.name} atualizado.` };
            },
            async undo({ db, operation, before }) {
                await restoreTraitSnapshot(db, before, { actorId: operation.actor.id });
            },
        },
        'catalog.trait.archive': {
            async preview({ db, action }) {
                const before = await getTraitTemplate(db, action.payload?.traitId || action.payload?.id);
                return { summary: `Arquivar traço: ${before.name}`, before, after: { ...before, status: 'archived', version: before.version + 1 } };
            },
            async apply({ db, operation, after }) {
                await db.run(
                    `UPDATE clover_trait_templates
                     SET status = 'archived', version = ?, operation_code = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
                    [after.version, operation.code, operation.actor.id, new Date().toISOString(), after.id]
                );
                return { after: await getTraitTemplate(db, after.id), summary: `Traço ${after.name} arquivado.` };
            },
            async undo({ db, operation, before }) {
                await restoreTraitSnapshot(db, before, { actorId: operation.actor.id });
            },
        },
        'catalog.trait.restore': {
            async preview({ db, action }) {
                const before = await getTraitTemplate(db, action.payload?.traitId || action.payload?.id);
                return { summary: `Restaurar traço: ${before.name}`, before, after: { ...before, status: 'active', version: before.version + 1 } };
            },
            async apply({ db, operation, after }) {
                await db.run(
                    `UPDATE clover_trait_templates
                     SET status = 'active', version = ?, operation_code = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
                    [after.version, operation.code, operation.actor.id, new Date().toISOString(), after.id]
                );
                return { after: await getTraitTemplate(db, after.id), summary: `Traço ${after.name} restaurado.` };
            },
            async undo({ db, operation, before }) {
                await restoreTraitSnapshot(db, before, { actorId: operation.actor.id });
            },
        },
        'player.trait.assign': {
            async preview({ db, action, target }) {
                await ensureAdminTraitSchema(db);
                const trait = await getTraitTemplate(db, action.payload?.traitId || action.payload?.id);
                if (trait.status !== 'active') throw new AdminTraitServiceError('trait_archived', 'O traço está arquivado.', 409, { traitId: trait.id });
                const slotKey = action.payload?.slotKey ? normalizeSlot(action.payload.slotKey) : trait.slotKey;
                if (FIXED_TRAIT_SLOTS.includes(slotKey)) {
                    const before = await getPlayerTraitState(db, target.playerId, slotKey);
                    const after = { playerId: target.playerId, characterName: before.characterName, slotKey, value: trait.name, trait };
                    return { summary: `${before.characterName}: atribuir ${trait.name}`, before, after };
                }
                const player = await db.get('SELECT id, personagem_nome FROM jogadores WHERE id = ?', [target.playerId]);
                if (!player) throw new AdminTraitServiceError('player_not_found', 'Jogador não encontrado.', 404, { playerId: target.playerId });
                const duplicate = await db.get(
                    'SELECT id FROM clover_player_traits WHERE player_id = ? AND trait_id = ? AND slot_key = ? AND active = 1',
                    [target.playerId, trait.id, slotKey]
                );
                if (duplicate) throw new AdminTraitServiceError('extra_trait_duplicate', 'O jogador já possui esse traço adicional.', 409);
                const before = { playerId: target.playerId, characterName: player.personagem_nome || player.id, slotKey, assignment: null, value: null };
                const after = { ...before, value: trait.name, trait };
                return { summary: `${before.characterName}: adicionar ${trait.name}`, before, after };
            },
            async apply({ db, operation, target, before, after }) {
                const timestamp = new Date().toISOString();
                if (FIXED_TRAIT_SLOTS.includes(after.slotKey)) {
                    await db.run(
                        `UPDATE clover_player_traits SET active = 0, removed_by = ?, removed_at = ?
                         WHERE player_id = ? AND slot_key = ? AND active = 1`,
                        [operation.actor.id, timestamp, target.playerId, after.slotKey]
                    );
                }
                const positionRow = EXTRA_TRAIT_SLOTS.includes(after.slotKey)
                    ? await db.get('SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM clover_player_traits WHERE player_id = ? AND slot_key = ? AND active = 1', [target.playerId, after.slotKey])
                    : { next_position: 0 };
                const inserted = await db.run(
                    `INSERT INTO clover_player_traits
                     (player_id, trait_id, slot_key, value_text, active, operation_code, assigned_by, metadata_json, assigned_at, position, source)
                     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'admin_operation')`,
                    [
                        target.playerId, after.trait.id, after.slotKey, after.value, operation.code, operation.actor.id,
                        JSON.stringify({ replacedAssignmentId: before.assignment?.id || null }), timestamp, Number(positionRow?.next_position || 0),
                    ]
                );
                if (FIXED_TRAIT_SLOTS.includes(after.slotKey)) {
                    await db.run(`UPDATE jogadores SET ${after.slotKey} = ? WHERE id = ?`, [after.value, target.playerId]);
                }
                return { before, after: { ...after, assignmentId: inserted.lastID }, summary: `${after.characterName}: ${after.trait.name} atribuído.` };
            },
            async undo({ db, operation, target, before, after }) {
                const timestamp = new Date().toISOString();
                await db.run(
                    `UPDATE clover_player_traits SET active = 0, removed_by = ?, removed_at = ? WHERE id = ? AND player_id = ?`,
                    [operation.actor.id, timestamp, after.assignmentId, target.playerId]
                );
                if (FIXED_TRAIT_SLOTS.includes(after.slotKey)) {
                    if (before.assignment?.id) {
                        await db.run('UPDATE clover_player_traits SET active = 1, removed_by = NULL, removed_at = NULL WHERE id = ?', [before.assignment.id]);
                    }
                    await db.run(`UPDATE jogadores SET ${before.slotKey} = ? WHERE id = ?`, [before.value, target.playerId]);
                }
            },
        },
        'player.trait.remove': {
            async preview({ db, action, target }) {
                await ensureAdminTraitSchema(db);
                if (action.payload?.assignmentId || action.payload?.assignment_id) {
                    const row = await getExtraAssignment(db, target.playerId, action.payload.assignmentId || action.payload.assignment_id);
                    const before = {
                        playerId: target.playerId,
                        characterName: row.personagem_nome || target.playerId,
                        slotKey: row.slot_key,
                        value: row.value_text,
                        assignment: mapAssignment(row),
                    };
                    return {
                        summary: `${before.characterName}: remover ${before.value}`,
                        before,
                        after: { playerId: target.playerId, characterName: before.characterName, slotKey: before.slotKey, value: null, assignment: null },
                    };
                }
                const slotKey = normalizeSlot(action.payload?.slotKey || action.payload?.slot_key, { fixedOnly: true });
                const before = await getPlayerTraitState(db, target.playerId, slotKey);
                if (!before.value && !before.assignment) {
                    throw new AdminTraitServiceError('trait_slot_empty', 'O jogador não possui traço nesse espaço.', 409, { playerId: target.playerId, slotKey });
                }
                return {
                    summary: `${before.characterName}: remover ${before.value || slotKey}`,
                    before,
                    after: { playerId: target.playerId, characterName: before.characterName, slotKey, value: null, assignment: null },
                };
            },
            async apply({ db, operation, target, before, after }) {
                const timestamp = new Date().toISOString();
                if (EXTRA_TRAIT_SLOTS.includes(before.slotKey)) {
                    await db.run(
                        'UPDATE clover_player_traits SET active = 0, removed_by = ?, removed_at = ? WHERE id = ? AND player_id = ?',
                        [operation.actor.id, timestamp, before.assignment.id, target.playerId]
                    );
                } else {
                    await db.run(
                        `UPDATE clover_player_traits SET active = 0, removed_by = ?, removed_at = ?
                         WHERE player_id = ? AND slot_key = ? AND active = 1`,
                        [operation.actor.id, timestamp, target.playerId, after.slotKey]
                    );
                    await db.run(`UPDATE jogadores SET ${after.slotKey} = NULL WHERE id = ?`, [target.playerId]);
                }
                return { before, after, summary: `${before.characterName}: traço removido.` };
            },
            async undo({ db, target, before }) {
                if (before.assignment?.id) {
                    await db.run('UPDATE clover_player_traits SET active = 1, removed_by = NULL, removed_at = NULL WHERE id = ?', [before.assignment.id]);
                }
                if (FIXED_TRAIT_SLOTS.includes(before.slotKey)) {
                    await db.run(`UPDATE jogadores SET ${before.slotKey} = ? WHERE id = ?`, [before.value, target.playerId]);
                }
            },
        },
    };
}

module.exports = {
    AdminTraitServiceError,
    CATALOG_TRAIT_SLOTS,
    EXTRA_TRAIT_SLOTS,
    FIXED_TRAIT_SLOTS,
    TRAIT_SLOTS,
    createTraitExecutors,
    createTraitTemplate,
    ensureAdminTraitSchema,
    generateTraitId,
    getPlayerTraitState,
    getTraitTemplate,
    isEmptyTraitValue,
    listPlayerExtraTraits,
    listTraitTemplates,
    mapAssignment,
    mapTrait,
    normalizeSlot,
    normalizeTemplatePayload,
    restoreTraitSnapshot,
    slugifyTraitKey,
};
