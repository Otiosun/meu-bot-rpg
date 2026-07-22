'use strict';

const crypto = require('crypto');

const TRAIT_SLOTS = Object.freeze([
    'aptidao_comum',
    'marca_comum',
    'aptidao_rara',
    'marca_rara',
    'anomalia',
]);

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

function normalizeSlot(value) {
    const slot = String(value || '').trim().toLowerCase();
    if (!TRAIT_SLOTS.includes(slot)) {
        throw new AdminTraitServiceError('invalid_trait_slot', 'Espaço de traço inválido.', 400, {
            slot,
            allowed: TRAIT_SLOTS,
        });
    }
    return slot;
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
            updated_at TEXT NOT NULL
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_trait_templates_status_slot
        ON clover_trait_templates (status, slot_key, name)
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
            removed_at TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_player_traits_active_slot
        ON clover_player_traits (player_id, slot_key)
        WHERE active = 1
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_player_traits_trait
        ON clover_player_traits (trait_id, active, assigned_at DESC)
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
        operationCode: row.operation_code,
        createdBy: row.created_by,
        updatedBy: row.updated_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
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
    return { ok: true, traits: rows.map(mapTrait), slots: TRAIT_SLOTS };
}

async function getPlayerTraitState(db, playerId, slotKey) {
    const slot = normalizeSlot(slotKey);
    const player = await db.get(`SELECT id, personagem_nome, ${slot} AS value FROM jogadores WHERE id = ?`, [playerId]);
    if (!player) throw new AdminTraitServiceError('player_not_found', 'Jogador não encontrado.', 404, { playerId });
    const assignment = await db.get(
        `SELECT * FROM clover_player_traits
         WHERE player_id = ? AND slot_key = ? AND active = 1
         ORDER BY id DESC LIMIT 1`,
        [playerId, slot]
    );
    return {
        playerId: player.id,
        characterName: player.personagem_nome || player.id,
        slotKey: slot,
        value: player.value || null,
        assignment: assignment ? {
            id: assignment.id,
            traitId: assignment.trait_id,
            valueText: assignment.value_text,
            operationCode: assignment.operation_code,
            assignedBy: assignment.assigned_by,
            assignedAt: assignment.assigned_at,
            metadata: parseJson(assignment.metadata_json, {}),
        } : null,
    };
}

function normalizeTemplatePayload(payload = {}, options = {}) {
    const normalized = {
        name: requireText(payload.name, 'Nome'),
        slotKey: normalizeSlot(payload.slotKey || payload.slot_key),
        description: String(payload.description || '').trim() || null,
        effectText: String(payload.effectText || payload.effect_text || '').trim() || null,
        restrictionsText: String(payload.restrictionsText || payload.restrictions_text || '').trim() || null,
        metadata: payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
            ? { ...payload.metadata }
            : {},
    };
    if (options.partial) {
        const result = {};
        for (const [key, value] of Object.entries(normalized)) {
            const sourceKeys = {
                name: ['name'], slotKey: ['slotKey', 'slot_key'], description: ['description'],
                effectText: ['effectText', 'effect_text'], restrictionsText: ['restrictionsText', 'restrictions_text'], metadata: ['metadata'],
            }[key];
            if (sourceKeys.some((sourceKey) => Object.prototype.hasOwnProperty.call(payload, sourceKey))) result[key] = value;
        }
        if (!Object.keys(result).length) throw new AdminTraitServiceError('empty_trait_update', 'Nenhuma alteração foi informada.', 400);
        return result;
    }
    return normalized;
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
                  metadata_json, operation_code, created_by, updated_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?)`,
                [
                    id, normalized.name, normalized.slotKey, normalized.description, normalized.effectText,
                    normalized.restrictionsText, JSON.stringify(normalized.metadata), context.operationCode || null,
                    context.actorId || null, context.actorId || null, timestamp, timestamp,
                ]
            );
            return getTraitTemplate(db, id);
        } catch (error) {
            if (/UNIQUE constraint failed: clover_trait_templates\.id/i.test(String(error?.message || error)) && !payload.id) continue;
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
             status = ?, version = ?, metadata_json = ?, operation_code = ?, updated_by = ?, updated_at = ?
         WHERE id = ?`,
        [
            snapshot.name, snapshot.slotKey, snapshot.description, snapshot.effectText, snapshot.restrictionsText,
            snapshot.status, snapshot.version, JSON.stringify(snapshot.metadata || {}), snapshot.operationCode || null,
            context.actorId || null, timestamp, snapshot.id,
        ]
    );
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
                const used = await db.get(
                    'SELECT COUNT(*) AS total FROM clover_player_traits WHERE trait_id = ? AND active = 1',
                    [traitId]
                );
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
                         metadata_json = ?, version = ?, operation_code = ?, updated_by = ?, updated_at = ?
                     WHERE id = ?`,
                    [
                        after.name, after.slotKey, after.description, after.effectText, after.restrictionsText,
                        JSON.stringify(after.metadata || {}), after.version, operation.code, operation.actor.id, timestamp, after.id,
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
                const before = await getPlayerTraitState(db, target.playerId, slotKey);
                const after = {
                    playerId: target.playerId,
                    characterName: before.characterName,
                    slotKey,
                    value: trait.name,
                    trait,
                };
                return { summary: `${before.characterName}: atribuir ${trait.name}`, before, after };
            },
            async apply({ db, operation, target, before, after }) {
                const timestamp = new Date().toISOString();
                await db.run(
                    `UPDATE clover_player_traits
                     SET active = 0, removed_by = ?, removed_at = ?
                     WHERE player_id = ? AND slot_key = ? AND active = 1`,
                    [operation.actor.id, timestamp, target.playerId, after.slotKey]
                );
                const inserted = await db.run(
                    `INSERT INTO clover_player_traits
                     (player_id, trait_id, slot_key, value_text, active, operation_code, assigned_by, metadata_json, assigned_at)
                     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
                    [
                        target.playerId, after.trait.id, after.slotKey, after.value, operation.code, operation.actor.id,
                        JSON.stringify({ replacedAssignmentId: before.assignment?.id || null }), timestamp,
                    ]
                );
                await db.run(`UPDATE jogadores SET ${after.slotKey} = ? WHERE id = ?`, [after.value, target.playerId]);
                return {
                    before,
                    after: { ...after, assignmentId: inserted.lastID },
                    summary: `${after.characterName}: ${after.trait.name} atribuído.`,
                };
            },
            async undo({ db, operation, target, before, after }) {
                const timestamp = new Date().toISOString();
                await db.run(
                    `UPDATE clover_player_traits
                     SET active = 0, removed_by = ?, removed_at = ?
                     WHERE id = ? AND player_id = ?`,
                    [operation.actor.id, timestamp, after.assignmentId, target.playerId]
                );
                if (before.assignment?.id) {
                    await db.run(
                        `UPDATE clover_player_traits
                         SET active = 1, removed_by = NULL, removed_at = NULL WHERE id = ?`,
                        [before.assignment.id]
                    );
                }
                await db.run(`UPDATE jogadores SET ${before.slotKey} = ? WHERE id = ?`, [before.value, target.playerId]);
            },
        },
        'player.trait.remove': {
            async preview({ db, action, target }) {
                await ensureAdminTraitSchema(db);
                const slotKey = normalizeSlot(action.payload?.slotKey || action.payload?.slot_key);
                const before = await getPlayerTraitState(db, target.playerId, slotKey);
                if (!before.value && !before.assignment) {
                    throw new AdminTraitServiceError('trait_slot_empty', 'O jogador não possui traço nesse espaço.', 409, {
                        playerId: target.playerId, slotKey,
                    });
                }
                return {
                    summary: `${before.characterName}: remover ${before.value || slotKey}`,
                    before,
                    after: { playerId: target.playerId, characterName: before.characterName, slotKey, value: null, assignment: null },
                };
            },
            async apply({ db, operation, target, before, after }) {
                const timestamp = new Date().toISOString();
                await db.run(
                    `UPDATE clover_player_traits
                     SET active = 0, removed_by = ?, removed_at = ?
                     WHERE player_id = ? AND slot_key = ? AND active = 1`,
                    [operation.actor.id, timestamp, target.playerId, after.slotKey]
                );
                await db.run(`UPDATE jogadores SET ${after.slotKey} = NULL WHERE id = ?`, [target.playerId]);
                return { before, after, summary: `${before.characterName}: traço removido.` };
            },
            async undo({ db, operation, target, before }) {
                if (before.assignment?.id) {
                    await db.run(
                        `UPDATE clover_player_traits
                         SET active = 1, removed_by = NULL, removed_at = NULL WHERE id = ?`,
                        [before.assignment.id]
                    );
                }
                await db.run(`UPDATE jogadores SET ${before.slotKey} = ? WHERE id = ?`, [before.value, target.playerId]);
            },
        },
    };
}

module.exports = {
    AdminTraitServiceError,
    TRAIT_SLOTS,
    createTraitExecutors,
    createTraitTemplate,
    ensureAdminTraitSchema,
    generateTraitId,
    getPlayerTraitState,
    getTraitTemplate,
    listTraitTemplates,
    mapTrait,
    normalizeSlot,
    normalizeTemplatePayload,
    restoreTraitSnapshot,
};