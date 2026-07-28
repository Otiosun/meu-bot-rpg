'use strict';

const crypto = require('node:crypto');
const {
    DreamWorldsServiceError,
    ensureDreamWorldsSchema,
    getPlayerDreamDashboard,
} = require('./dreamWorldsService');

const RUN_MUTABLE_STATUSES = new Set(['forming_group', 'ready']);
const RUN_ACTIVE_STATUSES = new Set(['forming_group', 'ready', 'running', 'paused']);
const FRAGMENT_CATEGORIES = new Set(['ability', 'technique', 'style', 'trait', 'title']);
const FRAGMENT_STATUSES = new Set(['draft', 'review', 'active', 'sealed', 'changed', 'revoked']);
const PUBLIC_FRAGMENT_STATUSES = new Set(['active', 'sealed', 'changed']);

function text(value) {
    const normalized = String(value ?? '').trim();
    return normalized || null;
}

function required(value, code, message) {
    const normalized = text(value);
    if (!normalized) throw new DreamWorldsServiceError(code, message);
    return normalized;
}

function integer(value, min, max, code, message) {
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
        throw new DreamWorldsServiceError(code, message, { value, min, max });
    }
    return normalized;
}

function toJson(value) {
    return value === undefined || value === null ? null : JSON.stringify(value);
}

function fromJson(value, fallback) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch {
        return fallback;
    }
}

function slugify(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 90);
}

function generateKey(prefix) {
    const year = new Date().getFullYear();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
    return `${prefix}-${year}-${suffix}`;
}

async function audit(db, actorId, action, entityType, entityId, payload = {}) {
    await db.run(
        `INSERT INTO clover_dream_audit (
            actor_id, action, entity_type, entity_id,
            before_json, after_json, reason, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            required(actorId, 'missing_actor', 'Responsável inválido.'),
            action,
            entityType,
            String(entityId),
            toJson(payload.before),
            toJson(payload.after),
            text(payload.reason),
            toJson(payload.metadata || {}),
        ]
    );
}

async function ensureDreamOperationsSchema(db) {
    await ensureDreamWorldsSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_resonance_fragment_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fragment_id INTEGER NOT NULL,
            version INTEGER NOT NULL CHECK (version > 0),
            snapshot_json TEXT NOT NULL,
            changed_by TEXT NOT NULL,
            reason TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(fragment_id, version)
        );

        CREATE INDEX IF NOT EXISTS idx_clover_fragment_versions
        ON clover_resonance_fragment_versions (fragment_id, version DESC);
    `);
}

function serializeSlot(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        runId: Number(row.run_id),
        category: row.category,
        playerId: row.player_id,
        playerName: row.player_name || row.player_id || null,
        status: row.status,
        source: row.source,
        invitedAt: row.invited_at,
        confirmedAt: row.confirmed_at,
        updatedAt: row.updated_at,
        metadata: fromJson(row.metadata_json, {}),
    };
}

function serializeRun(row, slots = []) {
    if (!row) return null;
    const confirmed = slots.filter((slot) => slot.status === 'confirmed').length;
    const invited = slots.filter((slot) => slot.status === 'invited').length;
    const open = slots.filter((slot) => slot.status === 'open').length;
    return {
        id: Number(row.id),
        key: row.run_key,
        worldId: Number(row.world_id),
        requestId: Number(row.request_id),
        buyerType: row.buyer_type,
        buyerId: row.buyer_id,
        status: row.status,
        currentChapter: Number(row.current_chapter || 0),
        narratorIds: fromJson(row.narrator_ids_json, []),
        createdAt: row.created_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        updatedAt: row.updated_at,
        metadata: fromJson(row.metadata_json, {}),
        world: row.world_name ? {
            id: Number(row.world_id),
            name: row.world_name,
            slug: row.world_slug,
            status: row.world_status,
            knownChapters: Number(row.known_chapters || 0),
            minPlayers: Number(row.min_players || 0),
            maxPlayers: Number(row.max_players || 0),
        } : undefined,
        counts: { confirmed, invited, open },
        slots,
    };
}

function serializeFragment(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        key: row.fragment_key,
        slug: row.slug,
        name: row.name,
        category: row.category,
        originWorldId: row.origin_world_id ? Number(row.origin_world_id) : null,
        originRunId: row.origin_run_id ? Number(row.origin_run_id) : null,
        ownerPlayerId: row.owner_player_id,
        ownerName: row.owner_name || row.owner_player_id || null,
        rarity: row.rarity,
        publicDescription: row.public_description,
        effectText: row.effect_text,
        restrictionsText: row.restrictions_text,
        status: row.status,
        version: Number(row.version || 1),
        artUrl: row.art_url,
        publicVisible: Boolean(row.public_visible),
        originWorld: row.origin_world_name ? {
            id: Number(row.origin_world_id),
            name: row.origin_world_name,
            slug: row.origin_world_slug,
        } : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: fromJson(row.metadata_json, {}),
    };
}

async function findRunRow(db, runInput) {
    const raw = String(runInput ?? '').trim();
    if (!raw) throw new DreamWorldsServiceError('missing_run', 'Informe a incursão.');
    const base = `SELECT run.*, world.name AS world_name, world.slug AS world_slug,
                         world.status AS world_status, world.known_chapters,
                         world.min_players, world.max_players
                  FROM clover_dream_runs run
                  JOIN clover_dream_worlds world ON world.id = run.world_id`;
    if (/^\d+$/.test(raw)) return db.get(`${base} WHERE run.id = ?`, [Number(raw)]);
    return db.get(`${base} WHERE run.run_key = ? COLLATE NOCASE`, [raw]);
}

async function getRunSlots(db, runId) {
    const rows = await db.all(
        `SELECT slot.*,
                COALESCE(
                    NULLIF(player.personagem_nome, '-'),
                    NULLIF(player.display_name, '-'),
                    NULLIF(player.nome, '-'),
                    slot.player_id
                ) AS player_name
         FROM clover_dream_slots slot
         LEFT JOIN jogadores player ON player.id = slot.player_id
         WHERE slot.run_id = ?
         ORDER BY slot.id`,
        [Number(runId)]
    );
    return rows.map(serializeSlot);
}

async function getDreamRun(db, runInput) {
    await ensureDreamOperationsSchema(db);
    const row = await findRunRow(db, runInput);
    if (!row) throw new DreamWorldsServiceError('run_not_found', 'Incursão não encontrada.');
    return serializeRun(row, await getRunSlots(db, row.id));
}

async function listAdminDreamRuns(db, options = {}) {
    await ensureDreamOperationsSchema(db);
    const status = text(options.status)?.toLowerCase() || null;
    const rows = status
        ? await db.all(
            `SELECT run.*, world.name AS world_name, world.slug AS world_slug,
                    world.status AS world_status, world.known_chapters,
                    world.min_players, world.max_players
             FROM clover_dream_runs run
             JOIN clover_dream_worlds world ON world.id = run.world_id
             WHERE run.status = ? ORDER BY run.id DESC`,
            [status]
        )
        : await db.all(
            `SELECT run.*, world.name AS world_name, world.slug AS world_slug,
                    world.status AS world_status, world.known_chapters,
                    world.min_players, world.max_players
             FROM clover_dream_runs run
             JOIN clover_dream_worlds world ON world.id = run.world_id
             ORDER BY run.id DESC`
        );
    const result = [];
    for (const row of rows) result.push(serializeRun(row, await getRunSlots(db, row.id)));
    return result;
}

async function assertPlayerExists(db, playerId) {
    const id = required(playerId, 'missing_player', 'Informe o personagem.');
    const player = await db.get('SELECT id FROM jogadores WHERE id = ?', [id]);
    if (!player) throw new DreamWorldsServiceError('player_not_found', 'Personagem não encontrado.');
    return id;
}

function assertMutableRun(row) {
    if (!RUN_MUTABLE_STATUSES.has(row.status)) {
        throw new DreamWorldsServiceError('run_slots_locked', 'As vagas desta incursão já estão bloqueadas.', { status: row.status });
    }
}

async function assertPlayerNotActiveInRun(db, runId, playerId, ignoreSlotId = null) {
    const row = await db.get(
        `SELECT id FROM clover_dream_slots
         WHERE run_id = ? AND player_id = ?
           AND status IN ('invited', 'confirmed')
           AND (? IS NULL OR id != ?)`,
        [Number(runId), playerId, ignoreSlotId, ignoreSlotId]
    );
    if (row) throw new DreamWorldsServiceError('player_already_in_run', 'Este personagem já possui vaga ativa na incursão.');
}

async function insertReplacementSlot(db, slot, actorId, reason) {
    const metadata = {
        replacementFor: Number(slot.id),
        previousPlayerId: slot.player_id || null,
        createdBy: actorId,
        reason: text(reason),
    };
    return db.run(
        `INSERT INTO clover_dream_slots (run_id, category, status, source, metadata_json)
         VALUES (?, ?, 'open', 'replacement', ?)`,
        [Number(slot.run_id), slot.category, toJson(metadata)]
    );
}

async function syncRunReadiness(db, runId) {
    const row = await findRunRow(db, runId);
    if (!row || !RUN_MUTABLE_STATUSES.has(row.status)) return row;
    const count = await db.get(
        `SELECT COUNT(*) AS total FROM clover_dream_slots
         WHERE run_id = ? AND status = 'confirmed'`,
        [Number(row.id)]
    );
    const next = Number(count?.total || 0) >= Number(row.min_players) ? 'ready' : 'forming_group';
    if (next !== row.status) {
        await db.run(
            `UPDATE clover_dream_runs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [next, Number(row.id)]
        );
    }
    await db.run(
        `UPDATE clover_dream_worlds
         SET status = 'forming_group', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status IN ('reserved', 'forming_group')`,
        [Number(row.world_id)]
    );
    return findRunRow(db, row.id);
}

async function assignDreamSlot(db, runInput, slotId, playerId, actorId, input = {}) {
    await ensureDreamOperationsSchema(db);
    const mode = String(input.mode || 'invited').trim().toLowerCase();
    if (!['invited', 'confirmed'].includes(mode)) {
        throw new DreamWorldsServiceError('invalid_slot_assignment_mode', 'Modo de atribuição de vaga inválido.');
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        const run = await findRunRow(db, runInput);
        if (!run) throw new DreamWorldsServiceError('run_not_found', 'Incursão não encontrada.');
        assertMutableRun(run);
        const slot = await db.get('SELECT * FROM clover_dream_slots WHERE id = ? AND run_id = ?', [Number(slotId), Number(run.id)]);
        if (!slot) throw new DreamWorldsServiceError('slot_not_found', 'Vaga não encontrada.');
        if (slot.status !== 'open') throw new DreamWorldsServiceError('slot_not_open', 'Esta vaga não está aberta.', { status: slot.status });
        const target = await assertPlayerExists(db, playerId);
        await assertPlayerNotActiveInRun(db, run.id, target);
        const before = serializeSlot(slot);
        await db.run(
            `UPDATE clover_dream_slots
             SET player_id = ?, status = ?, source = ?,
                 invited_at = CURRENT_TIMESTAMP,
                 confirmed_at = CASE WHEN ? = 'confirmed' THEN CURRENT_TIMESTAMP ELSE NULL END,
                 updated_at = CURRENT_TIMESTAMP,
                 metadata_json = ?
             WHERE id = ?`,
            [target, mode, text(input.source) || 'admin', mode, toJson(input.metadata || {}), Number(slot.id)]
        );
        const afterRow = await db.get('SELECT * FROM clover_dream_slots WHERE id = ?', [Number(slot.id)]);
        await audit(db, actorId, mode === 'confirmed' ? 'slot_confirmed_by_admin' : 'slot_invited', 'dream_slot', slot.id, {
            before,
            after: serializeSlot(afterRow),
            reason: input.reason,
            metadata: { runId: Number(run.id) },
        });
        await syncRunReadiness(db, run.id);
        await db.exec('COMMIT');
        return getDreamRun(db, run.id);
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function respondDreamInvite(db, slotId, playerId, action, input = {}) {
    await ensureDreamOperationsSchema(db);
    const decision = String(action || '').trim().toLowerCase();
    if (!['accept', 'decline'].includes(decision)) {
        throw new DreamWorldsServiceError('invalid_invite_decision', 'Resposta ao convite inválida.');
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        const slot = await db.get('SELECT * FROM clover_dream_slots WHERE id = ?', [Number(slotId)]);
        if (!slot) throw new DreamWorldsServiceError('slot_not_found', 'Convite não encontrado.');
        if (slot.player_id !== playerId) throw new DreamWorldsServiceError('invite_forbidden', 'Este convite pertence a outro personagem.');
        if (slot.status !== 'invited') throw new DreamWorldsServiceError('invite_not_pending', 'Este convite já foi respondido.', { status: slot.status });
        const run = await findRunRow(db, slot.run_id);
        if (!run) throw new DreamWorldsServiceError('run_not_found', 'Incursão não encontrada.');
        assertMutableRun(run);
        const before = serializeSlot(slot);
        if (decision === 'accept') {
            await db.run(
                `UPDATE clover_dream_slots
                 SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [Number(slot.id)]
            );
        } else {
            await db.run(
                `UPDATE clover_dream_slots
                 SET status = 'declined', updated_at = CURRENT_TIMESTAMP,
                     metadata_json = ?
                 WHERE id = ?`,
                [toJson({ ...fromJson(slot.metadata_json, {}), declineReason: text(input.reason) }), Number(slot.id)]
            );
            await insertReplacementSlot(db, slot, playerId, input.reason);
        }
        const afterRow = await db.get('SELECT * FROM clover_dream_slots WHERE id = ?', [Number(slot.id)]);
        await audit(db, playerId, decision === 'accept' ? 'invite_accepted' : 'invite_declined', 'dream_slot', slot.id, {
            before,
            after: serializeSlot(afterRow),
            reason: input.reason,
            metadata: { runId: Number(run.id) },
        });
        await syncRunReadiness(db, run.id);
        await db.exec('COMMIT');
        return getDreamRun(db, run.id);
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function removeDreamSlot(db, runInput, slotId, actorId, input = {}) {
    await ensureDreamOperationsSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const run = await findRunRow(db, runInput);
        if (!run) throw new DreamWorldsServiceError('run_not_found', 'Incursão não encontrada.');
        assertMutableRun(run);
        const slot = await db.get('SELECT * FROM clover_dream_slots WHERE id = ? AND run_id = ?', [Number(slotId), Number(run.id)]);
        if (!slot) throw new DreamWorldsServiceError('slot_not_found', 'Vaga não encontrada.');
        if (!['invited', 'confirmed'].includes(slot.status)) {
            throw new DreamWorldsServiceError('slot_not_removable', 'Esta vaga não possui participante ativo.', { status: slot.status });
        }
        const before = serializeSlot(slot);
        await db.run(
            `UPDATE clover_dream_slots
             SET status = 'withdrawn', updated_at = CURRENT_TIMESTAMP,
                 metadata_json = ? WHERE id = ?`,
            [toJson({ ...fromJson(slot.metadata_json, {}), removalReason: text(input.reason) }), Number(slot.id)]
        );
        await insertReplacementSlot(db, slot, actorId, input.reason);
        const afterRow = await db.get('SELECT * FROM clover_dream_slots WHERE id = ?', [Number(slot.id)]);
        await audit(db, actorId, 'slot_removed', 'dream_slot', slot.id, {
            before,
            after: serializeSlot(afterRow),
            reason: input.reason,
            metadata: { runId: Number(run.id), removedPlayerId: slot.player_id },
        });
        await syncRunReadiness(db, run.id);
        await db.exec('COMMIT');
        return getDreamRun(db, run.id);
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function replaceDreamSlot(db, runInput, slotId, playerId, actorId, input = {}) {
    await ensureDreamOperationsSchema(db);
    const mode = String(input.mode || 'invited').trim().toLowerCase();
    if (!['invited', 'confirmed'].includes(mode)) {
        throw new DreamWorldsServiceError('invalid_slot_assignment_mode', 'Modo de substituição inválido.');
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        const run = await findRunRow(db, runInput);
        if (!run) throw new DreamWorldsServiceError('run_not_found', 'Incursão não encontrada.');
        assertMutableRun(run);
        const slot = await db.get('SELECT * FROM clover_dream_slots WHERE id = ? AND run_id = ?', [Number(slotId), Number(run.id)]);
        if (!slot) throw new DreamWorldsServiceError('slot_not_found', 'Vaga não encontrada.');
        const target = await assertPlayerExists(db, playerId);
        await assertPlayerNotActiveInRun(db, run.id, target, slot.id);
        const before = serializeSlot(slot);
        if (slot.status === 'open') {
            await db.run(
                `UPDATE clover_dream_slots
                 SET player_id = ?, status = ?, source = 'replacement',
                     invited_at = CURRENT_TIMESTAMP,
                     confirmed_at = CASE WHEN ? = 'confirmed' THEN CURRENT_TIMESTAMP ELSE NULL END,
                     updated_at = CURRENT_TIMESTAMP, metadata_json = ?
                 WHERE id = ?`,
                [target, mode, mode, toJson({ replacement: true, reason: text(input.reason) }), Number(slot.id)]
            );
        } else {
            if (!['invited', 'confirmed'].includes(slot.status)) {
                throw new DreamWorldsServiceError('slot_not_replaceable', 'Esta vaga não pode ser substituída.', { status: slot.status });
            }
            await db.run(
                `UPDATE clover_dream_slots
                 SET status = 'replaced', updated_at = CURRENT_TIMESTAMP,
                     metadata_json = ? WHERE id = ?`,
                [toJson({ ...fromJson(slot.metadata_json, {}), replacedByPlayerId: target, reason: text(input.reason) }), Number(slot.id)]
            );
            await db.run(
                `INSERT INTO clover_dream_slots (
                    run_id, category, player_id, status, source,
                    invited_at, confirmed_at, metadata_json
                 ) VALUES (?, ?, ?, ?, 'replacement', CURRENT_TIMESTAMP,
                    CASE WHEN ? = 'confirmed' THEN CURRENT_TIMESTAMP ELSE NULL END, ?)`,
                [Number(run.id), slot.category, target, mode, mode, toJson({ replacementFor: Number(slot.id), reason: text(input.reason) })]
            );
        }
        const afterRow = slot.status === 'open'
            ? await db.get('SELECT * FROM clover_dream_slots WHERE id = ?', [Number(slot.id)])
            : await db.get('SELECT * FROM clover_dream_slots WHERE run_id = ? AND player_id = ? ORDER BY id DESC LIMIT 1', [Number(run.id), target]);
        await audit(db, actorId, 'slot_replaced', 'dream_slot', slot.id, {
            before,
            after: serializeSlot(afterRow),
            reason: input.reason,
            metadata: { runId: Number(run.id), newPlayerId: target },
        });
        await syncRunReadiness(db, run.id);
        await db.exec('COMMIT');
        return getDreamRun(db, run.id);
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function transitionDreamRun(db, runInput, action, actorId, input = {}) {
    await ensureDreamOperationsSchema(db);
    const command = String(action || '').trim().toLowerCase();
    await db.exec('BEGIN IMMEDIATE');
    try {
        const run = await findRunRow(db, runInput);
        if (!run) throw new DreamWorldsServiceError('run_not_found', 'Incursão não encontrada.');
        if (!RUN_ACTIVE_STATUSES.has(run.status) && !['completed', 'failed', 'cancelled'].includes(run.status)) {
            throw new DreamWorldsServiceError('invalid_run_status', 'Estado da incursão inválido.', { status: run.status });
        }
        const before = serializeRun(run, await getRunSlots(db, run.id));
        let nextStatus = run.status;
        let nextChapter = Number(run.current_chapter || 0);
        let worldStatus = run.world_status;
        let setStarted = false;
        let setCompleted = false;

        if (command === 'start') {
            if (!RUN_MUTABLE_STATUSES.has(run.status)) throw new DreamWorldsServiceError('run_not_startable', 'A incursão não pode ser iniciada agora.', { status: run.status });
            const count = await db.get(`SELECT COUNT(*) AS total FROM clover_dream_slots WHERE run_id = ? AND status = 'confirmed'`, [Number(run.id)]);
            if (Number(count?.total || 0) < Number(run.min_players)) {
                throw new DreamWorldsServiceError('minimum_players_not_met', 'A incursão ainda não possui magos confirmados suficientes.', {
                    confirmed: Number(count?.total || 0),
                    required: Number(run.min_players),
                });
            }
            nextStatus = 'running';
            nextChapter = Math.max(1, nextChapter);
            worldStatus = 'running';
            setStarted = true;
        } else if (command === 'advance') {
            if (run.status !== 'running') throw new DreamWorldsServiceError('run_not_running', 'A incursão precisa estar ativa para avançar.');
            const requested = input.chapter === undefined ? nextChapter + 1 : integer(input.chapter, 1, 10000, 'invalid_chapter', 'Capítulo inválido.');
            if (!input.allowBeyondKnown && requested > Number(run.known_chapters)) {
                throw new DreamWorldsServiceError('chapter_not_unlocked', 'Este capítulo ainda não foi liberado.', {
                    requested,
                    knownChapters: Number(run.known_chapters),
                });
            }
            if (requested <= nextChapter) throw new DreamWorldsServiceError('chapter_must_advance', 'O novo capítulo precisa avançar a incursão.');
            nextChapter = requested;
        } else if (command === 'pause') {
            if (run.status !== 'running') throw new DreamWorldsServiceError('run_not_pausable', 'A incursão não está em andamento.');
            nextStatus = 'paused';
        } else if (command === 'resume') {
            if (run.status !== 'paused') throw new DreamWorldsServiceError('run_not_resumable', 'A incursão não está pausada.');
            nextStatus = 'running';
        } else if (command === 'complete' || command === 'fail') {
            if (!['running', 'paused'].includes(run.status)) throw new DreamWorldsServiceError('run_not_finishable', 'A incursão não pode ser encerrada agora.', { status: run.status });
            nextStatus = command === 'complete' ? 'completed' : 'failed';
            worldStatus = 'completed';
            setCompleted = true;
        } else if (command === 'cancel') {
            if (!RUN_ACTIVE_STATUSES.has(run.status)) throw new DreamWorldsServiceError('run_not_cancellable', 'A incursão já está encerrada.', { status: run.status });
            nextStatus = 'cancelled';
            worldStatus = 'cancelled';
            setCompleted = true;
        } else {
            throw new DreamWorldsServiceError('invalid_run_action', 'Ação de incursão inválida.');
        }

        await db.run(
            `UPDATE clover_dream_runs
             SET status = ?, current_chapter = ?,
                 started_at = CASE WHEN ? = 1 AND started_at IS NULL THEN CURRENT_TIMESTAMP ELSE started_at END,
                 completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE completed_at END,
                 updated_at = CURRENT_TIMESTAMP,
                 metadata_json = ?
             WHERE id = ?`,
            [nextStatus, nextChapter, setStarted ? 1 : 0, setCompleted ? 1 : 0,
                toJson({ ...fromJson(run.metadata_json, {}), lastActionReason: text(input.reason) }), Number(run.id)]
        );
        if (worldStatus !== run.world_status) {
            await db.run(
                `UPDATE clover_dream_worlds SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [worldStatus, Number(run.world_id)]
            );
        }
        const afterRow = await findRunRow(db, run.id);
        const after = serializeRun(afterRow, await getRunSlots(db, run.id));
        await audit(db, actorId, `run_${command}`, 'dream_run', run.id, {
            before,
            after,
            reason: input.reason,
            metadata: { chapter: nextChapter },
        });
        await db.exec('COMMIT');
        return after;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

function normalizeFragmentCategory(value) {
    const category = String(value || '').trim().toLowerCase();
    if (!FRAGMENT_CATEGORIES.has(category)) throw new DreamWorldsServiceError('invalid_fragment_category', 'Categoria de Fragmento inválida.');
    return category;
}

function normalizeFragmentStatus(value = 'draft') {
    const status = String(value || '').trim().toLowerCase();
    if (!FRAGMENT_STATUSES.has(status)) throw new DreamWorldsServiceError('invalid_fragment_status', 'Estado de Fragmento inválido.');
    return status;
}

async function fetchFragmentRow(db, fragmentInput) {
    const raw = String(fragmentInput ?? '').trim();
    if (!raw) throw new DreamWorldsServiceError('missing_fragment', 'Informe o Fragmento.');
    const select = `SELECT fragment.*,
                           world.name AS origin_world_name, world.slug AS origin_world_slug,
                           COALESCE(NULLIF(owner.personagem_nome, '-'), NULLIF(owner.display_name, '-'), NULLIF(owner.nome, '-'), fragment.owner_player_id) AS owner_name
                    FROM clover_resonance_fragments fragment
                    LEFT JOIN clover_dream_worlds world ON world.id = fragment.origin_world_id
                    LEFT JOIN jogadores owner ON owner.id = fragment.owner_player_id`;
    if (/^\d+$/.test(raw)) return db.get(`${select} WHERE fragment.id = ?`, [Number(raw)]);
    return db.get(`${select} WHERE fragment.slug = ? COLLATE NOCASE OR fragment.fragment_key = ? COLLATE NOCASE`, [raw, raw]);
}

async function snapshotFragment(db, row, actorId, reason) {
    await db.run(
        `INSERT INTO clover_resonance_fragment_versions (
            fragment_id, version, snapshot_json, changed_by, reason
         ) VALUES (?, ?, ?, ?, ?)`,
        [Number(row.id), Number(row.version), toJson(serializeFragment(row)), actorId, text(reason)]
    );
}

async function createResonanceFragment(db, input, actorId) {
    await ensureDreamOperationsSchema(db);
    const name = required(input.name, 'missing_fragment_name', 'Informe o nome do Fragmento.');
    const slug = slugify(input.slug || name);
    if (!slug) throw new DreamWorldsServiceError('invalid_fragment_slug', 'Endereço do Fragmento inválido.');
    const duplicate = await db.get('SELECT id FROM clover_resonance_fragments WHERE slug = ? COLLATE NOCASE', [slug]);
    if (duplicate) throw new DreamWorldsServiceError('fragment_slug_exists', 'Já existe um Fragmento com este endereço.');
    const owner = text(input.ownerPlayerId);
    if (owner) await assertPlayerExists(db, owner);
    const originWorldId = input.originWorldId ? integer(input.originWorldId, 1, Number.MAX_SAFE_INTEGER, 'invalid_origin_world', 'Fenda de origem inválida.') : null;
    const originRunId = input.originRunId ? integer(input.originRunId, 1, Number.MAX_SAFE_INTEGER, 'invalid_origin_run', 'Incursão de origem inválida.') : null;
    if (originWorldId && !(await db.get('SELECT id FROM clover_dream_worlds WHERE id = ?', [originWorldId]))) {
        throw new DreamWorldsServiceError('origin_world_not_found', 'Fenda de origem não encontrada.');
    }
    if (originRunId && !(await db.get('SELECT id FROM clover_dream_runs WHERE id = ?', [originRunId]))) {
        throw new DreamWorldsServiceError('origin_run_not_found', 'Incursão de origem não encontrada.');
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        const insert = await db.run(
            `INSERT INTO clover_resonance_fragments (
                fragment_key, slug, name, category, origin_world_id, origin_run_id,
                owner_player_id, rarity, public_description, effect_text,
                restrictions_text, status, version, art_url, public_visible,
                created_by, metadata_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
            [
                text(input.key) || generateKey('FR'), slug, name,
                normalizeFragmentCategory(input.category), originWorldId, originRunId,
                owner, text(input.rarity) || 'fragment',
                required(input.publicDescription, 'missing_fragment_description', 'Informe a descrição pública.'),
                text(input.effectText), text(input.restrictionsText),
                normalizeFragmentStatus(input.status), text(input.artUrl),
                input.publicVisible === false ? 0 : 1,
                required(actorId, 'missing_actor', 'Responsável inválido.'),
                toJson(input.metadata || {}),
            ]
        );
        const row = await fetchFragmentRow(db, insert.lastID);
        await snapshotFragment(db, row, actorId, input.reason);
        await audit(db, actorId, 'fragment_created', 'resonance_fragment', row.id, { after: serializeFragment(row), reason: input.reason });
        await db.exec('COMMIT');
        return serializeFragment(row);
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function updateResonanceFragment(db, fragmentInput, input, actorId) {
    await ensureDreamOperationsSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const current = await fetchFragmentRow(db, fragmentInput);
        if (!current) throw new DreamWorldsServiceError('fragment_not_found', 'Fragmento não encontrado.');
        const next = {
            name: text(input.name) || current.name,
            category: input.category === undefined ? current.category : normalizeFragmentCategory(input.category),
            rarity: text(input.rarity) || current.rarity,
            publicDescription: input.publicDescription === undefined ? current.public_description : required(input.publicDescription, 'missing_fragment_description', 'Informe a descrição pública.'),
            effectText: input.effectText === undefined ? current.effect_text : text(input.effectText),
            restrictionsText: input.restrictionsText === undefined ? current.restrictions_text : text(input.restrictionsText),
            status: input.status === undefined ? current.status : normalizeFragmentStatus(input.status),
            artUrl: input.artUrl === undefined ? current.art_url : text(input.artUrl),
            publicVisible: input.publicVisible === undefined ? Number(current.public_visible) : (input.publicVisible ? 1 : 0),
            metadata: input.metadata === undefined ? fromJson(current.metadata_json, {}) : input.metadata,
        };
        await db.run(
            `UPDATE clover_resonance_fragments
             SET name = ?, category = ?, rarity = ?, public_description = ?,
                 effect_text = ?, restrictions_text = ?, status = ?, art_url = ?,
                 public_visible = ?, version = version + 1,
                 updated_at = CURRENT_TIMESTAMP, metadata_json = ?
             WHERE id = ?`,
            [next.name, next.category, next.rarity, next.publicDescription,
                next.effectText, next.restrictionsText, next.status, next.artUrl,
                next.publicVisible, toJson(next.metadata || {}), Number(current.id)]
        );
        const updated = await fetchFragmentRow(db, current.id);
        await snapshotFragment(db, updated, actorId, input.reason);
        await audit(db, actorId, 'fragment_updated', 'resonance_fragment', current.id, {
            before: serializeFragment(current),
            after: serializeFragment(updated),
            reason: input.reason,
        });
        await db.exec('COMMIT');
        return serializeFragment(updated);
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function grantResonanceFragment(db, fragmentInput, playerId, actorId, input = {}) {
    await ensureDreamOperationsSchema(db);
    const target = await assertPlayerExists(db, playerId);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const current = await fetchFragmentRow(db, fragmentInput);
        if (!current) throw new DreamWorldsServiceError('fragment_not_found', 'Fragmento não encontrado.');
        if (current.owner_player_id && current.owner_player_id !== target && !input.force) {
            throw new DreamWorldsServiceError('fragment_already_owned', 'Este Fragmento já possui outro portador.', { ownerPlayerId: current.owner_player_id });
        }
        await db.run(
            `UPDATE clover_resonance_fragments
             SET owner_player_id = ?, status = ?, version = version + 1,
                 updated_at = CURRENT_TIMESTAMP,
                 metadata_json = ?
             WHERE id = ?`,
            [target, normalizeFragmentStatus(input.status || 'active'),
                toJson({ ...fromJson(current.metadata_json, {}), grantReason: text(input.reason) }), Number(current.id)]
        );
        const updated = await fetchFragmentRow(db, current.id);
        await snapshotFragment(db, updated, actorId, input.reason);
        await audit(db, actorId, 'fragment_granted', 'resonance_fragment', current.id, {
            before: serializeFragment(current),
            after: serializeFragment(updated),
            reason: input.reason,
            metadata: { playerId: target },
        });
        await db.exec('COMMIT');
        return serializeFragment(updated);
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function listPublicFragments(db, options = {}) {
    await ensureDreamOperationsSchema(db);
    const category = text(options.category)?.toLowerCase() || null;
    if (category && !FRAGMENT_CATEGORIES.has(category)) throw new DreamWorldsServiceError('invalid_fragment_category', 'Categoria de Fragmento inválida.');
    const status = text(options.status)?.toLowerCase() || null;
    if (status && !PUBLIC_FRAGMENT_STATUSES.has(status)) throw new DreamWorldsServiceError('invalid_public_fragment_status', 'Filtro de Fragmentos inválido.');
    const clauses = [`fragment.public_visible = 1`, `fragment.status IN ('active', 'sealed', 'changed')`];
    const params = [];
    if (category) { clauses.push('fragment.category = ?'); params.push(category); }
    if (status) { clauses.push('fragment.status = ?'); params.push(status); }
    const rows = await db.all(
        `SELECT fragment.*,
                world.name AS origin_world_name, world.slug AS origin_world_slug,
                COALESCE(NULLIF(owner.personagem_nome, '-'), NULLIF(owner.display_name, '-'), NULLIF(owner.nome, '-'), fragment.owner_player_id) AS owner_name
         FROM clover_resonance_fragments fragment
         LEFT JOIN clover_dream_worlds world ON world.id = fragment.origin_world_id
         LEFT JOIN jogadores owner ON owner.id = fragment.owner_player_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY fragment.updated_at DESC, fragment.id DESC`,
        params
    );
    return rows.map(serializeFragment);
}

async function getPublicFragmentBySlug(db, slug) {
    await ensureDreamOperationsSchema(db);
    const row = await fetchFragmentRow(db, required(slug, 'missing_fragment_slug', 'Informe o Fragmento.'));
    if (!row || !row.public_visible || !PUBLIC_FRAGMENT_STATUSES.has(row.status)) {
        throw new DreamWorldsServiceError('fragment_not_found', 'Fragmento não encontrado.');
    }
    return serializeFragment(row);
}

async function listAdminFragments(db, options = {}) {
    await ensureDreamOperationsSchema(db);
    const status = text(options.status)?.toLowerCase() || null;
    const category = text(options.category)?.toLowerCase() || null;
    if (status && !FRAGMENT_STATUSES.has(status)) throw new DreamWorldsServiceError('invalid_fragment_status', 'Estado de Fragmento inválido.');
    if (category && !FRAGMENT_CATEGORIES.has(category)) throw new DreamWorldsServiceError('invalid_fragment_category', 'Categoria de Fragmento inválida.');
    const clauses = [];
    const params = [];
    if (status) { clauses.push('fragment.status = ?'); params.push(status); }
    if (category) { clauses.push('fragment.category = ?'); params.push(category); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await db.all(
        `SELECT fragment.*,
                world.name AS origin_world_name, world.slug AS origin_world_slug,
                COALESCE(NULLIF(owner.personagem_nome, '-'), NULLIF(owner.display_name, '-'), NULLIF(owner.nome, '-'), fragment.owner_player_id) AS owner_name
         FROM clover_resonance_fragments fragment
         LEFT JOIN clover_dream_worlds world ON world.id = fragment.origin_world_id
         LEFT JOIN jogadores owner ON owner.id = fragment.owner_player_id
         ${where}
         ORDER BY fragment.updated_at DESC, fragment.id DESC`,
        params
    );
    return rows.map(serializeFragment);
}

async function getPlayerDreamRun(db, runInput, playerId) {
    const run = await getDreamRun(db, runInput);
    const linked = (run.buyerType === 'player' && run.buyerId === playerId)
        || run.slots.some((slot) => slot.playerId === playerId && ['invited', 'confirmed'].includes(slot.status));
    if (!linked) throw new DreamWorldsServiceError('run_forbidden', 'Seu personagem não participa desta incursão.');
    return run;
}

async function getPlayerDreamDashboardDetailed(db, playerId) {
    await ensureDreamOperationsSchema(db);
    const base = await getPlayerDreamDashboard(db, playerId);
    const runs = [];
    for (const raw of base.runs || []) runs.push(await getDreamRun(db, raw.id));
    const fragmentsRows = await db.all(
        `SELECT fragment.*,
                world.name AS origin_world_name, world.slug AS origin_world_slug,
                COALESCE(NULLIF(owner.personagem_nome, '-'), NULLIF(owner.display_name, '-'), NULLIF(owner.nome, '-'), fragment.owner_player_id) AS owner_name
         FROM clover_resonance_fragments fragment
         LEFT JOIN clover_dream_worlds world ON world.id = fragment.origin_world_id
         LEFT JOIN jogadores owner ON owner.id = fragment.owner_player_id
         WHERE fragment.owner_player_id = ?
         ORDER BY fragment.updated_at DESC, fragment.id DESC`,
        [playerId]
    );
    const invites = [];
    for (const run of runs) {
        for (const slot of run.slots) {
            if (slot.playerId === playerId && slot.status === 'invited') {
                invites.push({ slot, run: { id: run.id, key: run.key, status: run.status, world: run.world } });
            }
        }
    }
    return {
        wallet: base.wallet,
        requests: base.requests,
        runs,
        invites,
        fragments: fragmentsRows.map(serializeFragment),
    };
}

module.exports = {
    assignDreamSlot,
    createResonanceFragment,
    ensureDreamOperationsSchema,
    getDreamRun,
    getPlayerDreamDashboardDetailed,
    getPlayerDreamRun,
    getPublicFragmentBySlug,
    grantResonanceFragment,
    listAdminDreamRuns,
    listAdminFragments,
    listPublicFragments,
    removeDreamSlot,
    replaceDreamSlot,
    respondDreamInvite,
    serializeFragment,
    serializeRun,
    serializeSlot,
    transitionDreamRun,
    updateResonanceFragment,
};