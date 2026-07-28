'use strict';

const crypto = require('crypto');

const HOOK_TEMPLATE_STATUSES = Object.freeze(['active', 'archived']);
const HOOK_ASSIGNMENT_STATUSES = Object.freeze(['active', 'completed', 'removed']);

class AdminHookServiceError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminHookServiceError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function valuesMatch(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function requireText(value, field, maximum = 4000) {
    const text = String(value || '').trim();
    if (!text) {
        throw new AdminHookServiceError('missing_hook_field', `${field} é obrigatório.`, 400, { field });
    }
    return text.slice(0, maximum);
}

function optionalText(value, maximum = 4000) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maximum) : null;
}

function normalizeKey(value, fallback = 'gancho') {
    return String(value || fallback)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || fallback;
}

function asInteger(value, field, options = {}) {
    const fallback = options.fallback;
    if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
    const number = Number(value);
    const minimum = options.minimum ?? 0;
    const maximum = options.maximum ?? 1000000;
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new AdminHookServiceError('invalid_hook_field', `${field} inválido.`, 400, {
            field,
            minimum,
            maximum,
        });
    }
    return number;
}

function generateHookId(randomBytes = crypto.randomBytes) {
    return `HK-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function nowIso() {
    return new Date().toISOString();
}

async function ensureAdminHookSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_hook_templates (
            id TEXT PRIMARY KEY,
            canonical_key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT DEFAULT NULL,
            objective_text TEXT DEFAULT NULL,
            completion_text TEXT DEFAULT NULL,
            category TEXT NOT NULL DEFAULT 'narrativo',
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
        CREATE INDEX IF NOT EXISTS idx_clover_hook_templates_status_name
        ON clover_hook_templates (status, name, id)
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_player_hooks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assignment_key TEXT NOT NULL UNIQUE,
            player_id TEXT NOT NULL,
            hook_id TEXT NOT NULL,
            title_text TEXT NOT NULL,
            body_text TEXT DEFAULT NULL,
            development_text TEXT DEFAULT NULL,
            completion_note TEXT DEFAULT NULL,
            private_notes TEXT DEFAULT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active',
            operation_code TEXT DEFAULT NULL,
            assigned_by TEXT DEFAULT NULL,
            updated_by TEXT DEFAULT NULL,
            assigned_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT DEFAULT NULL,
            removed_at TEXT DEFAULT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            FOREIGN KEY (hook_id) REFERENCES clover_hook_templates(id)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_player_hooks_player_status
        ON clover_player_hooks (player_id, status, priority DESC, updated_at DESC, id DESC)
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_player_hooks_hook_status
        ON clover_player_hooks (hook_id, status, updated_at DESC)
    `);
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_player_hooks_active_unique
        ON clover_player_hooks (player_id, hook_id)
        WHERE status = 'active'
    `);
}

function mapHookTemplate(row) {
    if (!row) return null;
    return {
        id: row.id,
        canonicalKey: row.canonical_key,
        name: row.name,
        description: row.description || null,
        objectiveText: row.objective_text || null,
        completionText: row.completion_text || null,
        category: row.category || 'narrativo',
        status: row.status,
        version: Number(row.version || 1),
        metadata: parseJson(row.metadata_json, {}),
        operationCode: row.operation_code || null,
        createdBy: row.created_by || null,
        updatedBy: row.updated_by || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
    };
}

function mapHookAssignment(row) {
    if (!row) return null;
    const template = row.template_id ? mapHookTemplate({
        id: row.template_id,
        canonical_key: row.template_canonical_key,
        name: row.template_name,
        description: row.template_description,
        objective_text: row.template_objective_text,
        completion_text: row.template_completion_text,
        category: row.template_category,
        status: row.template_status,
        version: row.template_version,
        metadata_json: row.template_metadata_json,
        operation_code: row.template_operation_code,
        created_by: row.template_created_by,
        updated_by: row.template_updated_by,
        created_at: row.template_created_at,
        updated_at: row.template_updated_at,
    }) : null;
    return {
        id: Number(row.id),
        assignmentKey: row.assignment_key,
        playerId: row.player_id,
        characterName: row.personagem_nome || row.player_id,
        hookId: row.hook_id,
        title: row.title_text,
        body: row.body_text || null,
        developmentText: row.development_text || null,
        completionNote: row.completion_note || null,
        privateNotes: row.private_notes || null,
        priority: Number(row.priority || 0),
        status: row.status,
        operationCode: row.operation_code || null,
        assignedBy: row.assigned_by || null,
        updatedBy: row.updated_by || null,
        assignedAt: row.assigned_at || null,
        updatedAt: row.updated_at || null,
        completedAt: row.completed_at || null,
        removedAt: row.removed_at || null,
        metadata: parseJson(row.metadata_json, {}),
        source: 'catalog',
        template,
    };
}

function assignmentSelectSql() {
    return `SELECT ph.*, j.personagem_nome,
                   ht.id AS template_id, ht.canonical_key AS template_canonical_key,
                   ht.name AS template_name, ht.description AS template_description,
                   ht.objective_text AS template_objective_text,
                   ht.completion_text AS template_completion_text,
                   ht.category AS template_category, ht.status AS template_status,
                   ht.version AS template_version, ht.metadata_json AS template_metadata_json,
                   ht.operation_code AS template_operation_code,
                   ht.created_by AS template_created_by, ht.updated_by AS template_updated_by,
                   ht.created_at AS template_created_at, ht.updated_at AS template_updated_at
            FROM clover_player_hooks ph
            LEFT JOIN jogadores j ON j.id = ph.player_id
            LEFT JOIN clover_hook_templates ht ON ht.id = ph.hook_id`;
}

async function getHookTemplate(db, hookId, options = {}) {
    await ensureAdminHookSchema(db);
    const id = String(hookId || '').trim().toUpperCase();
    const row = await db.get('SELECT * FROM clover_hook_templates WHERE id = ?', [id]);
    if (!row) {
        if (options.nullIfMissing) return null;
        throw new AdminHookServiceError('hook_not_found', 'Gancho não encontrado.', 404, { hookId: id });
    }
    return mapHookTemplate(row);
}

async function listHookTemplates(db, options = {}) {
    await ensureAdminHookSchema(db);
    const conditions = [];
    const params = [];
    if (!options.includeArchived) conditions.push("status = 'active'");
    if (options.query) {
        const pattern = `%${String(options.query).trim()}%`;
        conditions.push(`(LOWER(name) LIKE LOWER(?)
            OR LOWER(COALESCE(description, '')) LIKE LOWER(?)
            OR LOWER(COALESCE(objective_text, '')) LIKE LOWER(?)
            OR LOWER(canonical_key) LIKE LOWER(?))`);
        params.push(pattern, pattern, pattern, pattern);
    }
    params.push(Math.max(1, Math.min(300, Number(options.limit) || 100)));
    const rows = await db.all(
        `SELECT * FROM clover_hook_templates
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY status ASC, updated_at DESC, name ASC, id ASC
         LIMIT ?`,
        params
    );
    return {
        ok: true,
        hooks: rows.map(mapHookTemplate),
        statuses: [...HOOK_TEMPLATE_STATUSES],
    };
}

async function getPlayerHookAssignment(db, assignmentId, options = {}) {
    await ensureAdminHookSchema(db);
    const id = Number(assignmentId);
    const row = Number.isInteger(id) && id > 0
        ? await db.get(`${assignmentSelectSql()} WHERE ph.id = ?`, [id])
        : null;
    if (!row) {
        if (options.nullIfMissing) return null;
        throw new AdminHookServiceError('hook_assignment_not_found', 'Vínculo de gancho não encontrado.', 404, {
            assignmentId,
        });
    }
    return mapHookAssignment(row);
}

async function listPlayerHookAssignments(db, options = {}) {
    await ensureAdminHookSchema(db);
    const conditions = [];
    const params = [];
    if (options.playerId) {
        conditions.push('ph.player_id = ?');
        params.push(String(options.playerId).trim());
    }
    if (options.status) {
        const status = String(options.status).trim().toLowerCase();
        if (!HOOK_ASSIGNMENT_STATUSES.includes(status)) {
            throw new AdminHookServiceError('invalid_hook_status', 'Status de vínculo inválido.', 400, {
                status,
                allowed: HOOK_ASSIGNMENT_STATUSES,
            });
        }
        conditions.push('ph.status = ?');
        params.push(status);
    } else if (!options.includeRemoved) {
        conditions.push("ph.status != 'removed'");
    }
    if (options.query) {
        const pattern = `%${String(options.query).trim()}%`;
        conditions.push(`(LOWER(ph.title_text) LIKE LOWER(?)
            OR LOWER(COALESCE(ph.body_text, '')) LIKE LOWER(?)
            OR LOWER(COALESCE(ph.development_text, '')) LIKE LOWER(?)
            OR LOWER(COALESCE(j.personagem_nome, '')) LIKE LOWER(?))`);
        params.push(pattern, pattern, pattern, pattern);
    }
    params.push(Math.max(1, Math.min(300, Number(options.limit) || 100)));
    const rows = await db.all(
        `${assignmentSelectSql()}
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY CASE ph.status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
                  ph.priority DESC, ph.updated_at DESC, ph.id DESC
         LIMIT ?`,
        params
    );
    return {
        ok: true,
        assignments: rows.map(mapHookAssignment),
        statuses: [...HOOK_ASSIGNMENT_STATUSES],
    };
}

function normalizeTemplatePayload(payload = {}, options = {}) {
    const partial = options.partial === true;
    const has = (...keys) => keys.some((key) => Object.prototype.hasOwnProperty.call(payload, key));
    const result = {};
    if (!partial || has('name', 'nome')) result.name = requireText(payload.name || payload.nome, 'Nome', 160);
    if (!partial || has('description', 'descricao')) result.description = optionalText(payload.description || payload.descricao, 4000);
    if (!partial || has('objectiveText', 'objective_text', 'objective', 'objetivo')) {
        result.objectiveText = optionalText(payload.objectiveText || payload.objective_text || payload.objective || payload.objetivo, 4000);
    }
    if (!partial || has('completionText', 'completion_text', 'completion', 'conclusao')) {
        result.completionText = optionalText(payload.completionText || payload.completion_text || payload.completion || payload.conclusao, 4000);
    }
    if (!partial || has('category', 'categoria')) {
        result.category = normalizeKey(payload.category || payload.categoria || 'narrativo', 'narrativo');
    }
    if (!partial || has('canonicalKey', 'canonical_key', 'key')) {
        result.canonicalKey = normalizeKey(payload.canonicalKey || payload.canonical_key || payload.key || result.name || payload.name);
    }
    if (!partial || has('metadata')) {
        result.metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
            ? stableValue(payload.metadata)
            : {};
    }
    if (partial && !Object.keys(result).length) {
        throw new AdminHookServiceError('empty_hook_update', 'Nenhuma alteração foi informada.');
    }
    return result;
}

function normalizeAssignmentPayload(payload = {}, template, options = {}) {
    const partial = options.partial === true;
    const has = (...keys) => keys.some((key) => Object.prototype.hasOwnProperty.call(payload, key));
    const result = {};
    if (!partial || has('title', 'titleText', 'title_text', 'nome')) {
        result.title = requireText(
            payload.title || payload.titleText || payload.title_text || payload.nome || template?.name,
            'Título',
            180
        );
    }
    if (!partial || has('body', 'bodyText', 'body_text', 'description', 'descricao')) {
        result.body = optionalText(
            payload.body || payload.bodyText || payload.body_text || payload.description || payload.descricao || template?.description,
            4000
        );
    }
    if (!partial || has('developmentText', 'development_text', 'development', 'desenvolvimento')) {
        result.developmentText = optionalText(
            payload.developmentText || payload.development_text || payload.development || payload.desenvolvimento,
            8000
        );
    }
    if (!partial || has('privateNotes', 'private_notes', 'notes', 'notas')) {
        result.privateNotes = optionalText(payload.privateNotes || payload.private_notes || payload.notes || payload.notas, 8000);
    }
    if (!partial || has('priority', 'prioridade')) {
        result.priority = asInteger(payload.priority ?? payload.prioridade, 'Prioridade', {
            fallback: 0,
            minimum: 0,
            maximum: 100,
        });
    }
    if (!partial || has('metadata')) {
        result.metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
            ? stableValue(payload.metadata)
            : {};
    }
    if (partial && !Object.keys(result).length) {
        throw new AdminHookServiceError('empty_hook_assignment_update', 'Nenhuma alteração do vínculo foi informada.');
    }
    return result;
}

async function createHookTemplate(db, payload, context = {}) {
    await ensureAdminHookSchema(db);
    const data = normalizeTemplatePayload(payload);
    const timestamp = context.timestamp || nowIso();
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const id = String(payload.id || generateHookId(context.randomBytes)).trim().toUpperCase();
        try {
            await db.run(
                `INSERT INTO clover_hook_templates
                 (id, canonical_key, name, description, objective_text, completion_text, category,
                  status, version, metadata_json, operation_code, created_by, updated_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?)`,
                [
                    id, data.canonicalKey, data.name, data.description, data.objectiveText,
                    data.completionText, data.category, JSON.stringify(data.metadata),
                    context.operationCode || null, context.actorId || null, context.actorId || null,
                    timestamp, timestamp,
                ]
            );
            return getHookTemplate(db, id);
        } catch (error) {
            const message = String(error?.message || error);
            if (/clover_hook_templates\.id/i.test(message) && !payload.id) continue;
            if (/canonical_key/i.test(message)) {
                throw new AdminHookServiceError('hook_duplicate', 'Já existe um gancho com esse código canônico.', 409, {
                    canonicalKey: data.canonicalKey,
                });
            }
            throw error;
        }
    }
    throw new AdminHookServiceError('hook_id_collision', 'Não foi possível gerar um identificador de gancho.', 503);
}

async function restoreHookTemplateSnapshot(db, snapshot, context = {}) {
    const timestamp = context.timestamp || nowIso();
    await db.run(
        `UPDATE clover_hook_templates
         SET canonical_key = ?, name = ?, description = ?, objective_text = ?, completion_text = ?,
             category = ?, status = ?, version = ?, metadata_json = ?, operation_code = ?,
             updated_by = ?, updated_at = ?
         WHERE id = ?`,
        [
            snapshot.canonicalKey, snapshot.name, snapshot.description, snapshot.objectiveText,
            snapshot.completionText, snapshot.category, snapshot.status, snapshot.version,
            JSON.stringify(snapshot.metadata || {}), snapshot.operationCode || null,
            context.actorId || null, timestamp, snapshot.id,
        ]
    );
}

async function assertTemplateUnchanged(db, expected) {
    const current = await getHookTemplate(db, expected?.id, { nullIfMissing: true });
    if (!current || !expected || !valuesMatch(current, expected)) {
        throw new AdminHookServiceError(
            'hook_changed_since_apply',
            'O gancho foi alterado depois da aplicação e não pode ser desfeito automaticamente.',
            409,
            { hookId: expected?.id || null }
        );
    }
}

async function assertAssignmentUnchanged(db, expected) {
    const current = await getPlayerHookAssignment(db, expected?.id, { nullIfMissing: true });
    if (!current || !expected || !valuesMatch(current, expected)) {
        throw new AdminHookServiceError(
            'hook_assignment_changed_since_apply',
            'O vínculo do gancho mudou depois da aplicação e não pode ser desfeito automaticamente.',
            409,
            { assignmentId: expected?.id || null }
        );
    }
}

async function insertHookAssignment(db, playerId, hookId, payload, context = {}) {
    await ensureAdminHookSchema(db);
    const player = await db.get('SELECT id, personagem_nome FROM jogadores WHERE id = ?', [playerId]);
    if (!player) throw new AdminHookServiceError('player_not_found', 'Jogador não encontrado.', 404, { playerId });
    const template = await getHookTemplate(db, hookId);
    if (template.status !== 'active') {
        throw new AdminHookServiceError('hook_archived', 'O gancho está arquivado.', 409, { hookId: template.id });
    }
    const duplicate = await db.get(
        "SELECT id FROM clover_player_hooks WHERE player_id = ? AND hook_id = ? AND status = 'active'",
        [player.id, template.id]
    );
    if (duplicate) {
        throw new AdminHookServiceError('hook_assignment_duplicate', 'O jogador já possui esse gancho ativo.', 409, {
            assignmentId: Number(duplicate.id),
        });
    }
    const data = normalizeAssignmentPayload(payload, template);
    const timestamp = context.timestamp || nowIso();
    const assignmentKey = String(context.assignmentKey || `HKAS-${crypto.randomBytes(6).toString('hex').toUpperCase()}`);
    const inserted = await db.run(
        `INSERT INTO clover_player_hooks
         (assignment_key, player_id, hook_id, title_text, body_text, development_text,
          private_notes, priority, status, operation_code, assigned_by, updated_by,
          assigned_at, updated_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        [
            assignmentKey, player.id, template.id, data.title, data.body, data.developmentText,
            data.privateNotes, data.priority, context.operationCode || null, context.actorId || null,
            context.actorId || null, timestamp, timestamp, JSON.stringify(data.metadata),
        ]
    );
    return getPlayerHookAssignment(db, inserted.lastID);
}

async function restoreAssignmentSnapshot(db, snapshot, context = {}) {
    const timestamp = context.timestamp || nowIso();
    await db.run(
        `UPDATE clover_player_hooks
         SET player_id = ?, hook_id = ?, title_text = ?, body_text = ?, development_text = ?,
             completion_note = ?, private_notes = ?, priority = ?, status = ?, operation_code = ?,
             assigned_by = ?, updated_by = ?, assigned_at = ?, updated_at = ?, completed_at = ?,
             removed_at = ?, metadata_json = ?
         WHERE id = ?`,
        [
            snapshot.playerId, snapshot.hookId, snapshot.title, snapshot.body,
            snapshot.developmentText, snapshot.completionNote, snapshot.privateNotes,
            snapshot.priority, snapshot.status, snapshot.operationCode, snapshot.assignedBy,
            context.actorId || snapshot.updatedBy, snapshot.assignedAt, timestamp,
            snapshot.completedAt, snapshot.removedAt, JSON.stringify(snapshot.metadata || {}), snapshot.id,
        ]
    );
}

function createHookExecutors() {
    return {
        'catalog.hook.create': {
            async preview({ action }) {
                const data = normalizeTemplatePayload(action.payload || {});
                return {
                    summary: `Criar gancho: ${data.name}`,
                    before: null,
                    after: { ...data, status: 'active', version: 1 },
                };
            },
            async apply({ db, operation, action }) {
                const hook = await createHookTemplate(db, action.payload || {}, {
                    operationCode: operation.code,
                    actorId: operation.actor.id,
                });
                return { before: null, after: hook, summary: `Gancho ${hook.name} criado.` };
            },
            async undo({ db, after }) {
                const hookId = after?.id;
                if (!hookId) throw new AdminHookServiceError('missing_hook_snapshot', 'Snapshot do gancho criado está incompleto.', 409);
                await assertTemplateUnchanged(db, after);
                const usage = await db.get('SELECT COUNT(*) AS total FROM clover_player_hooks WHERE hook_id = ?', [hookId]);
                if (Number(usage?.total || 0) > 0) {
                    throw new AdminHookServiceError('hook_in_use', 'O gancho já possui vínculos e não pode ser removido pelo desfazer.', 409);
                }
                await db.run('DELETE FROM clover_hook_templates WHERE id = ?', [hookId]);
            },
        },
        'catalog.hook.update': {
            async preview({ db, action }) {
                const hookId = requireText(action.payload?.hookId || action.payload?.id, 'hookId', 40).toUpperCase();
                const before = await getHookTemplate(db, hookId);
                const changes = normalizeTemplatePayload(action.payload || {}, { partial: true });
                return {
                    summary: `Editar gancho: ${before.name}`,
                    before,
                    after: { ...before, ...changes, version: before.version + 1 },
                };
            },
            async apply({ db, operation, after }) {
                const timestamp = nowIso();
                await db.run(
                    `UPDATE clover_hook_templates
                     SET canonical_key = ?, name = ?, description = ?, objective_text = ?, completion_text = ?,
                         category = ?, version = ?, metadata_json = ?, operation_code = ?, updated_by = ?, updated_at = ?
                     WHERE id = ?`,
                    [
                        after.canonicalKey, after.name, after.description, after.objectiveText,
                        after.completionText, after.category, after.version, JSON.stringify(after.metadata || {}),
                        operation.code, operation.actor.id, timestamp, after.id,
                    ]
                );
                const current = await getHookTemplate(db, after.id);
                return { after: current, summary: `Gancho ${current.name} atualizado.` };
            },
            async undo({ db, operation, before, after }) {
                await assertTemplateUnchanged(db, after);
                await restoreHookTemplateSnapshot(db, before, { actorId: operation.actor.id });
            },
        },
        'catalog.hook.archive': {
            async preview({ db, action }) {
                const before = await getHookTemplate(db, action.payload?.hookId || action.payload?.id);
                return {
                    summary: `Arquivar gancho: ${before.name}`,
                    before,
                    after: { ...before, status: 'archived', version: before.version + 1 },
                };
            },
            async apply({ db, operation, after }) {
                await db.run(
                    `UPDATE clover_hook_templates
                     SET status = 'archived', version = ?, operation_code = ?, updated_by = ?, updated_at = ?
                     WHERE id = ?`,
                    [after.version, operation.code, operation.actor.id, nowIso(), after.id]
                );
                const current = await getHookTemplate(db, after.id);
                return { after: current, summary: `Gancho ${current.name} arquivado.` };
            },
            async undo({ db, operation, before, after }) {
                await assertTemplateUnchanged(db, after);
                await restoreHookTemplateSnapshot(db, before, { actorId: operation.actor.id });
            },
        },
        'catalog.hook.restore': {
            async preview({ db, action }) {
                const before = await getHookTemplate(db, action.payload?.hookId || action.payload?.id);
                return {
                    summary: `Restaurar gancho: ${before.name}`,
                    before,
                    after: { ...before, status: 'active', version: before.version + 1 },
                };
            },
            async apply({ db, operation, after }) {
                await db.run(
                    `UPDATE clover_hook_templates
                     SET status = 'active', version = ?, operation_code = ?, updated_by = ?, updated_at = ?
                     WHERE id = ?`,
                    [after.version, operation.code, operation.actor.id, nowIso(), after.id]
                );
                const current = await getHookTemplate(db, after.id);
                return { after: current, summary: `Gancho ${current.name} restaurado.` };
            },
            async undo({ db, operation, before, after }) {
                await assertTemplateUnchanged(db, after);
                await restoreHookTemplateSnapshot(db, before, { actorId: operation.actor.id });
            },
        },
        'player.hook.assign': {
            async preview({ db, action, target }) {
                const hook = await getHookTemplate(db, action.payload?.hookId || action.payload?.id);
                if (hook.status !== 'active') throw new AdminHookServiceError('hook_archived', 'O gancho está arquivado.', 409);
                const duplicate = await db.get(
                    "SELECT id FROM clover_player_hooks WHERE player_id = ? AND hook_id = ? AND status = 'active'",
                    [target.playerId, hook.id]
                );
                if (duplicate) {
                    throw new AdminHookServiceError('hook_assignment_duplicate', 'O jogador já possui esse gancho ativo.', 409, {
                        assignmentId: Number(duplicate.id),
                    });
                }
                const data = normalizeAssignmentPayload(action.payload || {}, hook);
                return {
                    summary: `${target.characterName || target.playerId}: vincular ${data.title}`,
                    before: null,
                    after: {
                        playerId: target.playerId,
                        characterName: target.characterName || target.playerId,
                        hookId: hook.id,
                        title: data.title,
                        body: data.body,
                        developmentText: data.developmentText,
                        privateNotes: data.privateNotes,
                        priority: data.priority,
                        status: 'active',
                        metadata: data.metadata,
                        template: hook,
                    },
                };
            },
            async apply({ db, operation, action, target, unit }) {
                const assignment = await insertHookAssignment(
                    db,
                    target.playerId,
                    action.payload?.hookId || action.payload?.id,
                    action.payload || {},
                    {
                        operationCode: operation.code,
                        actorId: operation.actor.id,
                        assignmentKey: `${operation.code}:unit:${unit.id}:hook-assignment`,
                    }
                );
                return {
                    before: null,
                    after: assignment,
                    summary: `${assignment.characterName}: gancho ${assignment.title} vinculado.`,
                };
            },
            async undo({ db, after }) {
                await assertAssignmentUnchanged(db, after);
                await db.run('DELETE FROM clover_player_hooks WHERE id = ?', [after.id]);
            },
        },
        'player.hook.update': {
            async preview({ db, action, target }) {
                const assignmentId = asInteger(action.payload?.assignmentId || action.payload?.assignment_id, 'assignmentId', {
                    minimum: 1,
                });
                const before = await getPlayerHookAssignment(db, assignmentId);
                if (before.playerId !== target.playerId) {
                    throw new AdminHookServiceError('hook_assignment_target_mismatch', 'O vínculo não pertence ao jogador selecionado.', 409);
                }
                if (before.status === 'removed') {
                    throw new AdminHookServiceError('hook_assignment_removed', 'O vínculo removido não pode ser atualizado.', 409);
                }
                const changes = normalizeAssignmentPayload(action.payload || {}, before.template, { partial: true });
                return {
                    summary: `${before.characterName}: atualizar ${before.title}`,
                    before,
                    after: { ...before, ...changes },
                };
            },
            async apply({ db, operation, after }) {
                await db.run(
                    `UPDATE clover_player_hooks
                     SET title_text = ?, body_text = ?, development_text = ?, private_notes = ?,
                         priority = ?, metadata_json = ?, operation_code = ?, updated_by = ?, updated_at = ?
                     WHERE id = ? AND status != 'removed'`,
                    [
                        after.title, after.body, after.developmentText, after.privateNotes,
                        after.priority, JSON.stringify(after.metadata || {}), operation.code,
                        operation.actor.id, nowIso(), after.id,
                    ]
                );
                const current = await getPlayerHookAssignment(db, after.id);
                return { after: current, summary: `${current.characterName}: gancho ${current.title} atualizado.` };
            },
            async undo({ db, operation, before, after }) {
                await assertAssignmentUnchanged(db, after);
                await restoreAssignmentSnapshot(db, before, { actorId: operation.actor.id });
            },
        },
        'player.hook.complete': {
            async preview({ db, action, target }) {
                const assignmentId = asInteger(action.payload?.assignmentId || action.payload?.assignment_id, 'assignmentId', {
                    minimum: 1,
                });
                const before = await getPlayerHookAssignment(db, assignmentId);
                if (before.playerId !== target.playerId) {
                    throw new AdminHookServiceError('hook_assignment_target_mismatch', 'O vínculo não pertence ao jogador selecionado.', 409);
                }
                if (before.status !== 'active') {
                    throw new AdminHookServiceError('hook_assignment_not_active', 'Apenas um gancho ativo pode ser concluído.', 409);
                }
                const completionNote = optionalText(
                    action.payload?.completionNote || action.payload?.completion_note || action.payload?.note || action.payload?.nota
                        || before.template?.completionText,
                    8000
                );
                return {
                    summary: `${before.characterName}: concluir ${before.title}`,
                    before,
                    after: { ...before, status: 'completed', completionNote },
                };
            },
            async apply({ db, operation, after }) {
                const timestamp = nowIso();
                await db.run(
                    `UPDATE clover_player_hooks
                     SET status = 'completed', completion_note = ?, operation_code = ?, updated_by = ?,
                         updated_at = ?, completed_at = ?, removed_at = NULL
                     WHERE id = ? AND status = 'active'`,
                    [after.completionNote, operation.code, operation.actor.id, timestamp, timestamp, after.id]
                );
                const current = await getPlayerHookAssignment(db, after.id);
                return { after: current, summary: `${current.characterName}: gancho ${current.title} concluído.` };
            },
            async undo({ db, operation, before, after }) {
                await assertAssignmentUnchanged(db, after);
                await restoreAssignmentSnapshot(db, before, { actorId: operation.actor.id });
            },
        },
        'player.hook.remove': {
            async preview({ db, action, target }) {
                const assignmentId = asInteger(action.payload?.assignmentId || action.payload?.assignment_id, 'assignmentId', {
                    minimum: 1,
                });
                const before = await getPlayerHookAssignment(db, assignmentId);
                if (before.playerId !== target.playerId) {
                    throw new AdminHookServiceError('hook_assignment_target_mismatch', 'O vínculo não pertence ao jogador selecionado.', 409);
                }
                if (before.status === 'removed') {
                    throw new AdminHookServiceError('hook_assignment_removed', 'O vínculo já está removido.', 409);
                }
                return {
                    summary: `${before.characterName}: remover ${before.title}`,
                    before,
                    after: { ...before, status: 'removed' },
                };
            },
            async apply({ db, operation, after }) {
                const timestamp = nowIso();
                await db.run(
                    `UPDATE clover_player_hooks
                     SET status = 'removed', operation_code = ?, updated_by = ?, updated_at = ?, removed_at = ?
                     WHERE id = ? AND status != 'removed'`,
                    [operation.code, operation.actor.id, timestamp, timestamp, after.id]
                );
                const current = await getPlayerHookAssignment(db, after.id);
                return { after: current, summary: `${current.characterName}: gancho ${current.title} removido.` };
            },
            async undo({ db, operation, before, after }) {
                await assertAssignmentUnchanged(db, after);
                await restoreAssignmentSnapshot(db, before, { actorId: operation.actor.id });
            },
        },
    };
}

module.exports = {
    AdminHookServiceError,
    HOOK_ASSIGNMENT_STATUSES,
    HOOK_TEMPLATE_STATUSES,
    createHookExecutors,
    createHookTemplate,
    ensureAdminHookSchema,
    getHookTemplate,
    getPlayerHookAssignment,
    listHookTemplates,
    listPlayerHookAssignments,
    mapHookAssignment,
    mapHookTemplate,
    normalizeAssignmentPayload,
    normalizeTemplatePayload,
};
