'use strict';

const crypto = require('crypto');

const {
    AdminOperationContractError,
    canTransitionOperation,
    normalizeAdminOperationInput,
} = require('./adminOperationContract');
const { resolveTargetDetails } = require('./targetResolver');
const { listEffectiveSquadMembers } = require('./squadMembershipReadService');

class AdminOperationServiceError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminOperationServiceError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function safeJsonParse(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, stableValue(value[key])])
    );
}

function operationFingerprint(operation) {
    const relevant = stableValue({
        version: operation.version,
        title: operation.title,
        reason: operation.reason,
        actor: operation.actor,
        targets: operation.targets,
        actions: operation.actions,
        metadata: operation.metadata,
    });
    return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}

function nowIso() {
    return new Date().toISOString();
}

function normalizeLimit(value, fallback = 50, maximum = 200) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(maximum, Math.floor(parsed)));
}

async function ensureAdminOperationSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_admin_operations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            contract_version TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            title TEXT NOT NULL,
            reason TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            actor_role TEXT NOT NULL,
            targets_json TEXT NOT NULL,
            actions_json TEXT NOT NULL,
            required_capabilities_json TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            preview_json TEXT DEFAULT NULL,
            result_json TEXT DEFAULT NULL,
            error_json TEXT DEFAULT NULL,
            approved_by TEXT DEFAULT NULL,
            applied_by TEXT DEFAULT NULL,
            undone_by TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            simulated_at TEXT DEFAULT NULL,
            approved_at TEXT DEFAULT NULL,
            applied_at TEXT DEFAULT NULL,
            undone_at TEXT DEFAULT NULL,
            updated_at TEXT NOT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_admin_operations_status
        ON clover_admin_operations (status, updated_at DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_admin_operations_actor
        ON clover_admin_operations (actor_id, created_at DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_admin_operation_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_id INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            from_status TEXT DEFAULT NULL,
            to_status TEXT DEFAULT NULL,
            actor_id TEXT DEFAULT NULL,
            payload_json TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (operation_id) REFERENCES clover_admin_operations(id)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_admin_operation_events_operation
        ON clover_admin_operation_events (operation_id, id ASC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_admin_operation_units (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_id INTEGER NOT NULL,
            action_index INTEGER NOT NULL,
            target_index INTEGER NOT NULL,
            action_type TEXT NOT NULL,
            target_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'planned',
            summary TEXT DEFAULT NULL,
            before_json TEXT DEFAULT NULL,
            after_json TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            error_json TEXT DEFAULT NULL,
            applied_at TEXT DEFAULT NULL,
            undone_at TEXT DEFAULT NULL,
            FOREIGN KEY (operation_id) REFERENCES clover_admin_operations(id),
            UNIQUE(operation_id, action_index, target_index)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_admin_operation_units_operation
        ON clover_admin_operation_units (operation_id, action_index, target_index)
    `);
}

function mapOperationRow(row, extras = {}) {
    if (!row) return null;
    return {
        id: row.id,
        version: row.contract_version,
        code: row.code,
        status: row.status,
        title: row.title,
        reason: row.reason,
        actor: { id: row.actor_id, role: row.actor_role },
        targets: safeJsonParse(row.targets_json, []),
        actions: safeJsonParse(row.actions_json, []),
        requiredCapabilities: safeJsonParse(row.required_capabilities_json, []),
        idempotencyKey: row.idempotency_key,
        metadata: safeJsonParse(row.metadata_json, {}),
        preview: safeJsonParse(row.preview_json, null),
        result: safeJsonParse(row.result_json, null),
        error: safeJsonParse(row.error_json, null),
        approvedBy: row.approved_by,
        appliedBy: row.applied_by,
        undoneBy: row.undone_by,
        createdAt: row.created_at,
        simulatedAt: row.simulated_at,
        approvedAt: row.approved_at,
        appliedAt: row.applied_at,
        undoneAt: row.undone_at,
        updatedAt: row.updated_at,
        ...extras,
    };
}

async function appendEvent(db, operationId, eventType, options = {}) {
    await db.run(
        `INSERT INTO clover_admin_operation_events
         (operation_id, event_type, from_status, to_status, actor_id, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            operationId,
            eventType,
            options.fromStatus || null,
            options.toStatus || null,
            options.actorId || null,
            options.payload === undefined ? null : JSON.stringify(options.payload),
            options.createdAt || nowIso(),
        ]
    );
}

async function getOperationByCode(db, code, options = {}) {
    await ensureAdminOperationSchema(db);
    const normalized = String(code || '').trim().toUpperCase();
    const row = await db.get('SELECT * FROM clover_admin_operations WHERE code = ?', [normalized]);
    if (!row) {
        if (options.nullIfMissing) return null;
        throw new AdminOperationServiceError('operation_not_found', 'Operação não encontrada.', 404, { code: normalized });
    }

    let events;
    let units;
    if (options.includeEvents) {
        const rows = await db.all(
            'SELECT * FROM clover_admin_operation_events WHERE operation_id = ? ORDER BY id ASC',
            [row.id]
        );
        events = rows.map((event) => ({
            id: event.id,
            type: event.event_type,
            fromStatus: event.from_status,
            toStatus: event.to_status,
            actorId: event.actor_id,
            payload: safeJsonParse(event.payload_json, null),
            createdAt: event.created_at,
        }));
    }
    if (options.includeUnits) {
        const rows = await db.all(
            'SELECT * FROM clover_admin_operation_units WHERE operation_id = ? ORDER BY action_index ASC, target_index ASC',
            [row.id]
        );
        units = rows.map((unit) => ({
            id: unit.id,
            actionIndex: unit.action_index,
            targetIndex: unit.target_index,
            actionType: unit.action_type,
            targetKey: unit.target_key,
            status: unit.status,
            summary: unit.summary,
            before: safeJsonParse(unit.before_json, null),
            after: safeJsonParse(unit.after_json, null),
            metadata: safeJsonParse(unit.metadata_json, {}),
            error: safeJsonParse(unit.error_json, null),
            appliedAt: unit.applied_at,
            undoneAt: unit.undone_at,
        }));
    }
    return mapOperationRow(row, {
        ...(events ? { events } : {}),
        ...(units ? { units } : {}),
    });
}

async function listAdminOperations(db, options = {}) {
    await ensureAdminOperationSchema(db);
    const conditions = [];
    const params = [];
    if (options.status) {
        conditions.push('status = ?');
        params.push(String(options.status).trim());
    }
    if (options.actorId) {
        conditions.push('actor_id = ?');
        params.push(String(options.actorId).trim());
    }
    if (options.query) {
        conditions.push('(UPPER(code) LIKE UPPER(?) OR LOWER(title) LIKE LOWER(?) OR LOWER(reason) LIKE LOWER(?))');
        const pattern = `%${String(options.query).trim()}%`;
        params.push(pattern, pattern, pattern);
    }
    params.push(normalizeLimit(options.limit));
    const rows = await db.all(
        `SELECT * FROM clover_admin_operations
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
        params
    );
    return { ok: true, operations: rows.map((row) => mapOperationRow(row)) };
}

async function createAdminOperation(db, input, actor, options = {}) {
    await ensureAdminOperationSchema(db);
    const actorId = String(actor?.id || '').trim();
    const actorRole = String(actor?.role || '').trim();
    let lastConflict = null;

    for (let attempt = 0; attempt < 6; attempt += 1) {
        let normalized;
        try {
            normalized = normalizeAdminOperationInput(
                attempt === 0 ? input : { ...input, code: undefined },
                { actorId, actorRole, now: options.now, randomBytes: options.randomBytes }
            );
        } catch (error) {
            if (error instanceof AdminOperationContractError) {
                throw new AdminOperationServiceError(error.code, error.message, 400, error.details);
            }
            throw error;
        }

        const fingerprint = operationFingerprint(normalized);
        const existing = await db.get(
            'SELECT * FROM clover_admin_operations WHERE idempotency_key = ?',
            [normalized.idempotencyKey]
        );
        if (existing) {
            if (existing.fingerprint !== fingerprint) {
                throw new AdminOperationServiceError(
                    'idempotency_conflict',
                    'Esta chave de idempotência já pertence a outra operação.',
                    409,
                    { code: existing.code }
                );
            }
            return { ok: true, duplicate: true, operation: mapOperationRow(existing) };
        }

        try {
            const timestamp = normalized.createdAt;
            const inserted = await db.run(
                `INSERT INTO clover_admin_operations
                 (code, contract_version, fingerprint, status, title, reason, actor_id, actor_role,
                  targets_json, actions_json, required_capabilities_json, idempotency_key,
                  metadata_json, created_at, updated_at)
                 VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    normalized.code,
                    normalized.version,
                    fingerprint,
                    normalized.title,
                    normalized.reason,
                    normalized.actor.id,
                    normalized.actor.role,
                    JSON.stringify(normalized.targets),
                    JSON.stringify(normalized.actions),
                    JSON.stringify(normalized.requiredCapabilities),
                    normalized.idempotencyKey,
                    JSON.stringify(normalized.metadata),
                    timestamp,
                    timestamp,
                ]
            );
            await appendEvent(db, inserted.lastID, 'created', {
                toStatus: 'draft',
                actorId,
                payload: { source: normalized.metadata?.source || 'admin_site' },
                createdAt: timestamp,
            });
            return {
                ok: true,
                duplicate: false,
                operation: await getOperationByCode(db, normalized.code, { includeEvents: true }),
            };
        } catch (error) {
            if (/UNIQUE constraint failed: clover_admin_operations\.code/i.test(String(error?.message || error))) {
                lastConflict = error;
                continue;
            }
            throw error;
        }
    }

    throw new AdminOperationServiceError(
        'operation_code_collision',
        'Não foi possível gerar um código OP único.',
        503,
        { cause: String(lastConflict?.message || lastConflict || '') }
    );
}

async function resolveSelector(db, selector) {
    if (selector.kind === 'player') {
        const requested = selector.playerId || selector.query;
        const resolved = await resolveTargetDetails(db, selector.playerId || null, selector.query || '', {
            allowShadow: true,
        });
        if (!resolved.ok || !resolved.player?.id) {
            throw new AdminOperationServiceError(
                'target_not_found',
                resolved.error || 'Jogador não encontrado.',
                404,
                { selector, ...(resolved.details || {}) }
            );
        }
        return [{
            kind: 'player',
            playerId: resolved.player.id,
            characterName: resolved.player.personagem_nome || resolved.player.nome || resolved.player.id,
            requested,
            redirectedFrom: resolved.redirectedFrom || null,
            source: resolved.source || 'resolved',
        }];
    }

    if (selector.kind === 'players') {
        const resolvedTargets = [];
        for (const value of selector.values) {
            const resolved = await resolveTargetDetails(db, value, '', { allowShadow: true });
            if (!resolved.ok || !resolved.player?.id) {
                throw new AdminOperationServiceError(
                    'target_not_found',
                    resolved.error || `Jogador não encontrado: ${value}.`,
                    404,
                    { selector, value, ...(resolved.details || {}) }
                );
            }
            resolvedTargets.push({
                kind: 'player',
                playerId: resolved.player.id,
                characterName: resolved.player.personagem_nome || resolved.player.nome || resolved.player.id,
                requested: value,
                redirectedFrom: resolved.redirectedFrom || null,
                source: resolved.source || 'resolved',
            });
        }
        return resolvedTargets;
    }

    if (selector.kind === 'squad') {
        const membership = await listEffectiveSquadMembers(db, selector.squadKey);
        const rows = membership.members;
        if (!rows.length) {
            throw new AdminOperationServiceError('empty_target', 'O esquadrão não possui jogadores encontrados.', 404, { selector });
        }
        return rows.map((player) => ({
            kind: 'player',
            playerId: player.id,
            characterName: player.personagem_nome || player.nome || player.id,
            requested: selector.squadKey,
            redirectedFrom: null,
            source: 'squad',
        }));
    }

    if (selector.kind === 'system') {
        const systemKey = String(selector.systemKey || 'clover').trim().toLowerCase();
        if (systemKey !== 'clover') {
            throw new AdminOperationServiceError(
                'unsupported_system_target',
                'O alvo global informado não pertence ao Clover.',
                400,
                { selector }
            );
        }
        return [{
            kind: 'system',
            systemKey: 'clover',
            label: 'Clover RPG',
            source: 'system',
        }];
    }

    if (selector.kind === 'filter') {
        const filters = selector.filters || {};
        const clauses = [];
        const params = [];
        if (filters.gameStatus) {
            clauses.push("LOWER(COALESCE(jogo_status, '')) = LOWER(?)");
            params.push(filters.gameStatus);
        }
        if (!clauses.length && !filters.squad) {
            throw new AdminOperationServiceError('unsupported_target_filter', 'O filtro informado ainda não é suportado.', 400, { selector });
        }
        const rows = clauses.length
            ? await db.all(`SELECT * FROM jogadores WHERE ${clauses.join(' AND ')} ORDER BY personagem_nome ASC, id ASC`, params)
            : await db.all('SELECT * FROM jogadores ORDER BY personagem_nome ASC, id ASC');
        let filteredRows = rows;
        if (filters.squad) {
            const membership = await listEffectiveSquadMembers(db, filters.squad);
            const memberIds = new Set(membership.members.map((player) => player.id));
            filteredRows = rows.filter((player) => memberIds.has(player.id));
        }
        if (!filteredRows.length) {
            throw new AdminOperationServiceError('empty_target', 'O filtro não encontrou jogadores.', 404, { selector });
        }
        return filteredRows.map((player) => ({
            kind: 'player',
            playerId: player.id,
            characterName: player.personagem_nome || player.nome || player.id,
            requested: filters,
            redirectedFrom: null,
            source: 'filter',
        }));
    }

    throw new AdminOperationServiceError(
        'unsupported_target_kind',
        `O alvo ${selector.kind} ainda não é suportado pelo motor.`,
        400,
        { selector }
    );
}

async function resolveAdminOperationTargets(db, selectors) {
    const all = [];
    for (const selector of selectors || []) all.push(...await resolveSelector(db, selector));
    const deduped = [];
    const seen = new Set();
    for (const target of all) {
        const key = `${target.kind}:${target.playerId || JSON.stringify(target)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(target);
    }
    if (!deduped.length) {
        throw new AdminOperationServiceError('empty_target', 'A operação não possui alvos resolvidos.', 400);
    }
    return deduped;
}

function getExecutor(registry, actionType) {
    if (!registry) return null;
    if (registry instanceof Map) return registry.get(actionType) || null;
    return registry[actionType] || null;
}

function assertTransition(operation, toStatus) {
    if (!canTransitionOperation(operation.status, toStatus)) {
        throw new AdminOperationServiceError(
            'invalid_operation_transition',
            `Não é possível mover ${operation.code} de ${operation.status} para ${toStatus}.`,
            409,
            { code: operation.code, from: operation.status, to: toStatus }
        );
    }
}

async function simulateAdminOperation(db, code, actor, options = {}) {
    const operation = await getOperationByCode(db, code, { includeEvents: true });
    if (operation.status === 'simulated') return { ok: true, duplicate: true, operation };
    assertTransition(operation, 'simulated');

    const targets = await resolveAdminOperationTargets(db, operation.targets);
    const units = [];
    for (let actionIndex = 0; actionIndex < operation.actions.length; actionIndex += 1) {
        const action = operation.actions[actionIndex];
        const executor = getExecutor(options.executors, action.type);
        if (!executor?.preview) {
            throw new AdminOperationServiceError(
                'action_not_implemented',
                `A ação ${action.type} ainda não possui executor.`,
                501,
                { actionType: action.type }
            );
        }
        for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
            const target = targets[targetIndex];
            const preview = await executor.preview({ db, operation, action, target, actionIndex, targetIndex });
            units.push({
                actionIndex,
                targetIndex,
                actionType: action.type,
                targetKey: target.playerId
                    || (target.kind === 'system' ? `system:${target.systemKey}` : `${target.kind}:${targetIndex}`),
                target,
                summary: preview?.summary || action.label || action.type,
                before: preview?.before ?? null,
                after: preview?.after ?? null,
                metadata: preview?.metadata || {},
            });
        }
    }

    const timestamp = nowIso();
    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run('DELETE FROM clover_admin_operation_units WHERE operation_id = ?', [operation.id]);
        for (const unit of units) {
            await db.run(
                `INSERT INTO clover_admin_operation_units
                 (operation_id, action_index, target_index, action_type, target_key, status,
                  summary, before_json, after_json, metadata_json)
                 VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?)`,
                [
                    operation.id,
                    unit.actionIndex,
                    unit.targetIndex,
                    unit.actionType,
                    unit.targetKey,
                    unit.summary,
                    JSON.stringify(unit.before),
                    JSON.stringify(unit.after),
                    JSON.stringify({ ...unit.metadata, target: unit.target }),
                ]
            );
        }
        const preview = {
            targetCount: targets.length,
            unitCount: units.length,
            targets,
            units,
            warnings: [],
        };
        await db.run(
            `UPDATE clover_admin_operations
             SET status = 'simulated', preview_json = ?, simulated_at = ?, updated_at = ?, error_json = NULL
             WHERE id = ? AND status = 'draft'`,
            [JSON.stringify(preview), timestamp, timestamp, operation.id]
        );
        await appendEvent(db, operation.id, 'simulated', {
            fromStatus: 'draft', toStatus: 'simulated', actorId: actor?.id, payload: { targetCount: targets.length, unitCount: units.length }, createdAt: timestamp,
        });
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
    return { ok: true, duplicate: false, operation: await getOperationByCode(db, operation.code, { includeEvents: true, includeUnits: true }) };
}

async function approveAdminOperation(db, code, actor) {
    const operation = await getOperationByCode(db, code);
    if (operation.status === 'approved') return { ok: true, duplicate: true, operation };
    assertTransition(operation, 'approved');
    const timestamp = nowIso();
    await db.run(
        `UPDATE clover_admin_operations
         SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
         WHERE id = ? AND status = 'simulated'`,
        [actor?.id || null, timestamp, timestamp, operation.id]
    );
    await appendEvent(db, operation.id, 'approved', {
        fromStatus: 'simulated', toStatus: 'approved', actorId: actor?.id, createdAt: timestamp,
    });
    return { ok: true, duplicate: false, operation: await getOperationByCode(db, operation.code, { includeEvents: true, includeUnits: true }) };
}

async function applyAdminOperation(db, code, actor, options = {}) {
    let operation = await getOperationByCode(db, code, { includeUnits: true });
    if (operation.status === 'applied' || operation.status === 'partially_applied') {
        return { ok: true, duplicate: true, operation };
    }
    assertTransition(operation, 'applying');
    if (!operation.units?.length) {
        throw new AdminOperationServiceError('operation_not_simulated', 'A operação não possui unidades simuladas.', 409);
    }

    const startedAt = nowIso();
    await db.run(
        `UPDATE clover_admin_operations SET status = 'applying', applied_by = ?, updated_at = ?
         WHERE id = ? AND status = 'approved'`,
        [actor?.id || null, startedAt, operation.id]
    );
    await appendEvent(db, operation.id, 'applying', {
        fromStatus: 'approved', toStatus: 'applying', actorId: actor?.id, createdAt: startedAt,
    });
    operation = await getOperationByCode(db, code, { includeUnits: true });

    let appliedCount = 0;
    let failedCount = 0;
    const failures = [];
    for (const unit of operation.units) {
        if (unit.status === 'applied') {
            appliedCount += 1;
            continue;
        }
        const action = operation.actions[unit.actionIndex];
        const executor = getExecutor(options.executors, unit.actionType);
        if (!executor?.apply) {
            failedCount += 1;
            const error = { code: 'action_not_implemented', message: `Ação sem executor: ${unit.actionType}.` };
            failures.push({ unitId: unit.id, ...error });
            await db.run(
                `UPDATE clover_admin_operation_units SET status = 'failed', error_json = ? WHERE id = ?`,
                [JSON.stringify(error), unit.id]
            );
            continue;
        }

        const metadata = unit.metadata || {};
        const target = metadata.target || { kind: 'player', playerId: unit.targetKey };
        const savepoint = `admin_op_unit_${unit.id}`;
        await db.exec(`SAVEPOINT ${savepoint}`);
        try {
            const applied = await executor.apply({
                db, operation, action, target, unit,
                before: unit.before,
                after: unit.after,
            });
            const timestamp = nowIso();
            await db.run(
                `UPDATE clover_admin_operation_units
                 SET status = 'applied', summary = COALESCE(?, summary), before_json = ?, after_json = ?,
                     metadata_json = ?, error_json = NULL, applied_at = ?
                 WHERE id = ?`,
                [
                    applied?.summary || unit.summary,
                    JSON.stringify(applied?.before ?? unit.before),
                    JSON.stringify(applied?.after ?? unit.after),
                    JSON.stringify({ ...metadata, ...(applied?.metadata || {}), target }),
                    timestamp,
                    unit.id,
                ]
            );
            await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
            appliedCount += 1;
        } catch (error) {
            await db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await db.exec(`RELEASE SAVEPOINT ${savepoint}`);
            failedCount += 1;
            const serialized = {
                code: error?.code || 'action_apply_failed',
                message: error?.message || String(error),
                details: error?.details || null,
            };
            failures.push({ unitId: unit.id, ...serialized });
            await db.run(
                `UPDATE clover_admin_operation_units SET status = 'failed', error_json = ? WHERE id = ?`,
                [JSON.stringify(serialized), unit.id]
            );
        }
    }

    const finalStatus = failedCount === 0 ? 'applied' : appliedCount > 0 ? 'partially_applied' : 'failed';
    const completedAt = nowIso();
    const result = { appliedCount, failedCount, totalCount: appliedCount + failedCount, failures };
    await db.run(
        `UPDATE clover_admin_operations
         SET status = ?, result_json = ?, error_json = ?, applied_at = ?, updated_at = ?
         WHERE id = ? AND status = 'applying'`,
        [
            finalStatus,
            JSON.stringify(result),
            failures.length ? JSON.stringify({ failures }) : null,
            completedAt,
            completedAt,
            operation.id,
        ]
    );
    await appendEvent(db, operation.id, finalStatus, {
        fromStatus: 'applying', toStatus: finalStatus, actorId: actor?.id, payload: result, createdAt: completedAt,
    });
    return { ok: finalStatus !== 'failed', duplicate: false, operation: await getOperationByCode(db, code, { includeEvents: true, includeUnits: true }) };
}

async function undoAdminOperation(db, code, actor, options = {}) {
    const operation = await getOperationByCode(db, code, { includeUnits: true });
    if (operation.status === 'undone') return { ok: true, duplicate: true, operation };
    assertTransition(operation, 'undone');
    const appliedUnits = (operation.units || []).filter((unit) => unit.status === 'applied').reverse();
    if (!appliedUnits.length) {
        throw new AdminOperationServiceError('nothing_to_undo', 'A operação não possui unidades aplicadas.', 409);
    }

    const timestamp = nowIso();
    await db.exec('BEGIN IMMEDIATE');
    try {
        for (const unit of appliedUnits) {
            const action = operation.actions[unit.actionIndex];
            const executor = getExecutor(options.executors, unit.actionType);
            if (!executor?.undo) {
                throw new AdminOperationServiceError(
                    'action_not_undoable',
                    `A ação ${unit.actionType} não pode ser desfeita.`,
                    409,
                    { unitId: unit.id }
                );
            }
            const target = unit.metadata?.target || { kind: 'player', playerId: unit.targetKey };
            await executor.undo({ db, operation, action, target, unit, before: unit.before, after: unit.after });
            await db.run(
                `UPDATE clover_admin_operation_units SET status = 'undone', undone_at = ? WHERE id = ?`,
                [timestamp, unit.id]
            );
        }
        await db.run(
            `UPDATE clover_admin_operations
             SET status = 'undone', undone_by = ?, undone_at = ?, updated_at = ?
             WHERE id = ? AND status = 'applied'`,
            [actor?.id || null, timestamp, timestamp, operation.id]
        );
        await appendEvent(db, operation.id, 'undone', {
            fromStatus: 'applied', toStatus: 'undone', actorId: actor?.id, payload: { unitCount: appliedUnits.length }, createdAt: timestamp,
        });
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
    return { ok: true, duplicate: false, operation: await getOperationByCode(db, code, { includeEvents: true, includeUnits: true }) };
}

module.exports = {
    AdminOperationServiceError,
    applyAdminOperation,
    approveAdminOperation,
    createAdminOperation,
    ensureAdminOperationSchema,
    getOperationByCode,
    listAdminOperations,
    mapOperationRow,
    operationFingerprint,
    resolveAdminOperationTargets,
    simulateAdminOperation,
    undoAdminOperation,
};
