'use strict';

const crypto = require('crypto');
const {
    ensureCloverCharacterStatsSchema,
    ensureCloverManaHexagonSchema,
    ensureCloverRaidSchema,
    ensureCloverSquadSchema,
} = require('../../database');
const { isSameUser, normalizeJid } = require('../groupAccess');
const {
    getAccessContext,
    hasAccessPermission,
} = require('./accessControlService');
const { getCharacterBonusSummary } = require('./characterBonusService');
const {
    buildProfileCapacitySummary,
    getPlayerTechnicalCapacity,
} = require('./capacityService');
const {
    addCatalogItemInTransaction,
    calculateCondition,
    consumeInventoryItemInTransaction,
    ensureInventoryV1,
    getItemTemplate,
    recordHistory,
    releaseInventoryReservationInTransaction,
    reserveInventoryItemInTransaction,
    serializeItem,
} = require('./inventoryService');
const { addPhInTransaction, ensurePhState } = require('./phService');
const { ensureSpellbookSchema, listApprovedSpells } = require('./spellbookService');
const { addYullsInTransaction, ensureYullsState } = require('./yullsService');
const { resolvePlayerSquadMembership } = require('./squadMembershipReadService');

const RAID_SLOTS = Object.freeze([
    'body',
    'main_hand',
    'off_hand',
    'quick_1',
    'quick_2',
    'aerial_transport',
]);

const ACTIVE_PARTICIPANT_STATUSES = Object.freeze(['joined', 'active']);
const HOST_MANAGED_STATUSES = Object.freeze(['lobby', 'in_progress', 'finalization']);
const RAID_REWARD_LIMITS = Object.freeze({
    yulls: 20000,
    ph: 50,
    stars: 5,
    catalog_item: 20,
});

const TWO_HANDED_TEMPLATE_KEYS = new Set([
    'bastao', 'cajado_basico', 'bastao_magico', 'arco_caca', 'arco_guerra', 'besta',
    'lanca_caca', 'lanca_guerra', 'alabarda', 'machado_guerra', 'martelo_guerra',
    'espada_grande',
]);

class RaidServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'RaidServiceError';
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

function serializeRaidCapacity(capacity) {
    if (!capacity?.ok) return null;
    const summary = buildProfileCapacitySummary(capacity);
    return {
        ok: true,
        displayName: capacity.displayName || null,
        stageName: capacity.stageName || null,
        manaTotal: capacity.manaTotal === null ? null : Number(capacity.manaTotal || 0),
        poderMagico: Number(capacity.poderMagico || 0),
        attributes: capacity.attributes || {},
        stats: capacity.stats || null,
        ph: capacity.ph || null,
        hexagon: capacity.hexagon || null,
        hexagonLine: capacity.hexagonLine || null,
        limits: capacity.limits || {},
        creation: capacity.creation || {},
        reinforcement: capacity.reinforcement || {},
        mana: capacity.mana || {},
        physical: capacity.physical || {},
        support: capacity.support || {},
        treeSummaries: capacity.treeSummaries || {},
        nextNodes: capacity.nextNodes || {},
        approvalNodes: capacity.approvalNodes || [],
        highRiskNodes: capacity.highRiskNodes || [],
        commonCosts: capacity.commonCosts || {},
        maintenanceTiers: capacity.maintenanceTiers || [],
        summary: {
            criacao: summary.creation,
            reforco: summary.reinforcement,
            mana: summary.mana,
            fisico: summary.physical,
            suporte: capacity.support?.warning || null,
            geral: summary.summary,
        },
    };
}

function serializeRaidBonus(bonus) {
    if (!bonus?.ok) return null;
    return {
        ok: true,
        mana: bonus.mana || null,
        reserve: bonus.reserve || null,
        traits: bonus.traits || null,
        family: bonus.family || null,
        automatic: bonus.automatic || [],
        notAutomatic: bonus.notAutomatic || [],
        customBonuses: bonus.customBonuses || [],
        treeDiscounts: bonus.treeDiscounts || {},
        warnings: bonus.warnings || [],
    };
}

function normalizeCategory(value) {
    return String(value || 'missao')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'missao';
}

function createRaidKey() {
    return `RAID-${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

function serializeRaid(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        key: row.raid_key,
        name: row.name,
        category: row.category,
        description: row.description,
        location: row.location,
        status: row.status,
        ownerPlayerId: row.owner_player_id,
        maxPlayers: Number(row.max_players || 0),
        salaryEligible: Boolean(row.salary_eligible),
        rules: safeJsonParse(row.rules_json, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        finalizationAt: row.finalization_at,
        completedAt: row.completed_at,
        cancelledAt: row.cancelled_at,
        cancellationReason: row.cancellation_reason,
        metadata: safeJsonParse(row.metadata_json, {}),
    };
}

function serializeParticipant(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        raidId: Number(row.raid_id),
        playerId: row.player_id,
        status: row.status,
        joinedAt: row.joined_at,
        joinedVia: row.joined_via,
        removedAt: row.removed_at,
        removalReason: row.removal_reason,
        snapshot: safeJsonParse(row.snapshot_json, null),
        metadata: safeJsonParse(row.metadata_json, {}),
    };
}

function serializeLoadoutItem(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        raidId: Number(row.raid_id),
        participantId: Number(row.participant_id),
        playerId: row.player_id,
        inventoryItemId: Number(row.inventory_item_id),
        reservationId: Number(row.reservation_id),
        slot: row.slot_key,
        quantity: Number(row.quantity || 0),
        quantityConsumed: Number(row.quantity_consumed || 0),
        quantityRemaining: Math.max(0, Number(row.quantity || 0) - Number(row.quantity_consumed || 0)),
        durabilityStart: row.durability_start === null ? null : Number(row.durability_start),
        durabilityCurrent: row.durability_current === null ? null : Number(row.durability_current),
        condition: calculateCondition(row.durability_current, row.snapshot_json
            ? safeJsonParse(row.snapshot_json, {}).durability_max
            : null),
        snapshot: safeJsonParse(row.snapshot_json, null),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function playerCard(row = {}) {
    return {
        id: row.id,
        name: row.personagem_nome && row.personagem_nome !== '-'
            ? row.personagem_nome
            : (row.nome || row.display_name || 'Personagem'),
        displayName: row.display_name || null,
        imagePath: row.site_profile_image_data || row.personagem_aparencia_image_path || null,
        appearanceStatus: row.personagem_aparencia_status || null,
        squad: row.esquadrao || '-',
        patent: row.patente || '-',
        magic: row.magia || '-',
        grimoire: row.grimorio || '-',
        gameStatus: row.jogo_status || null,
    };
}

async function writeRaidEvent(db, raidId, action, actorId, options = {}) {
    const idempotencyKey = options.idempotencyKey || null;
    if (idempotencyKey) {
        const existing = await db.get(
            'SELECT * FROM clover_raid_events WHERE idempotency_key = ?',
            [idempotencyKey]
        );
        if (existing) return existing;
    }
    const inserted = await db.run(
        `INSERT INTO clover_raid_events
         (raid_id, action, actor_id, subject_player_id, before_json, after_json,
          created_at, idempotency_key, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`,
        [
            raidId,
            action,
            actorId,
            options.subjectPlayerId || null,
            options.before ? JSON.stringify(options.before) : null,
            options.after ? JSON.stringify(options.after) : null,
            idempotencyKey,
            JSON.stringify(options.metadata || {}),
        ]
    );
    return db.get('SELECT * FROM clover_raid_events WHERE id = ?', [inserted.lastID]);
}

async function getRaidRow(db, raidKey) {
    await ensureCloverRaidSchema(db);
    const key = String(raidKey || '').trim();
    const row = await db.get(
        `SELECT * FROM clover_raids
         WHERE raid_key = ? OR CAST(id AS TEXT) = ?`,
        [key.toUpperCase(), key]
    );
    if (!row) throw new RaidServiceError('raid_not_found', 'Raid não encontrada.');
    return row;
}

async function requireNarrator(db, actorId) {
    const actor = normalizeJid(actorId);
    const context = await getAccessContext(db, actor);
    if (context.owner || context.roleKeys.includes('admin') || context.roleKeys.includes('narrator')) {
        return { actorId: actor, context };
    }
    throw new RaidServiceError('narrator_required', 'Apenas narradores podem criar ou assumir controle de raids.');
}

async function getHostAccess(db, raid, actorId) {
    const actor = normalizeJid(actorId);
    if (isSameUser(raid.owner_player_id, actor)) {
        return { ok: true, principal: true, role: 'owner', actorId: actor };
    }
    const host = await db.get(
        `SELECT * FROM clover_raid_hosts
         WHERE raid_id = ? AND player_id = ? AND status = 'active'
         ORDER BY id DESC LIMIT 1`,
        [raid.id, actor]
    );
    return host
        ? { ok: true, principal: host.role === 'owner', role: host.role, host, actorId: actor }
        : { ok: false, principal: false, role: null, actorId: actor };
}

async function requireHost(db, raid, actorId, options = {}) {
    const access = await getHostAccess(db, raid, actorId);
    if (!access.ok || (options.principal && !access.principal)) {
        throw new RaidServiceError(
            options.principal ? 'principal_owner_required' : 'raid_host_required',
            options.principal
                ? 'Apenas o owner principal pode realizar essa ação.'
                : 'Apenas um host ativo pode realizar essa ação.'
        );
    }
    return access;
}

async function getActiveParticipant(db, raidId, playerId) {
    return db.get(
        `SELECT * FROM clover_raid_participants
         WHERE raid_id = ? AND player_id = ? AND status IN ('joined', 'active')`,
        [raidId, normalizeJid(playerId)]
    );
}

async function releaseParticipantReservations(db, participantId, actorId, reason) {
    const loadout = await db.all(
        'SELECT * FROM clover_raid_loadout_items WHERE participant_id = ?',
        [participantId]
    );
    for (const item of loadout) {
        await releaseInventoryReservationInTransaction(db, item.reservation_id, {
            metadata: { released_by: actorId, reason },
        });
    }
    await db.run('DELETE FROM clover_raid_loadout_items WHERE participant_id = ?', [participantId]);
}

async function createRaid(db, actorId, input = {}) {
    await ensureCloverRaidSchema(db);
    const narrator = await requireNarrator(db, actorId);
    const name = String(input.name || input.nome || '').trim();
    if (name.length < 3 || name.length > 100) {
        throw new RaidServiceError('invalid_name', 'O nome da raid precisa ter entre 3 e 100 caracteres.');
    }
    const description = String(input.description || input.descricao || '').trim().slice(0, 4000) || null;
    const location = String(input.location || input.local || 'Capital de Clover').trim().slice(0, 120) || 'Capital de Clover';
    const maxPlayers = Number(input.maxPlayers || input.max_players || 12);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 50) {
        throw new RaidServiceError('invalid_max_players', 'O limite precisa ficar entre 1 e 50 jogadores.');
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        let raidKey;
        do {
            raidKey = createRaidKey();
        } while (await db.get('SELECT id FROM clover_raids WHERE raid_key = ?', [raidKey]));
        const raidColumns = await db.all(
            'PRAGMA table_info(clover_raids)'
        );
        const hasLegacyCodeColumn = raidColumns.some(
            (column) => String(column.name || '').toLowerCase() === 'code'
        );

        const insertRaidSql = hasLegacyCodeColumn
            ? `INSERT INTO clover_raids
               (raid_key, code, name, category, description, location,
                status, owner_player_id, max_players, salary_eligible,
                rules_json, created_at, updated_at, metadata_json)
               VALUES (?, ?, ?, ?, ?, ?, 'lobby', ?, ?, ?, ?,
                       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`
            : `INSERT INTO clover_raids
               (raid_key, name, category, description, location,
                status, owner_player_id, max_players, salary_eligible,
                rules_json, created_at, updated_at, metadata_json)
               VALUES (?, ?, ?, ?, ?, 'lobby', ?, ?, ?, ?,
                       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`;

        const insertRaidParams = [
            raidKey,
            ...(hasLegacyCodeColumn ? [raidKey] : []),
            name,
            normalizeCategory(input.category || input.categoria),
            description,
            location,
            narrator.actorId,
            maxPlayers,
            input.salaryEligible === false ||
            input.salary_eligible === false
                ? 0
                : 1,
            JSON.stringify(input.rules || input.regras || {}),
            JSON.stringify(input.metadata || {}),
        ];

        const inserted = await db.run(
            insertRaidSql,
            insertRaidParams
        );
        await db.run(
            `INSERT INTO clover_raid_hosts
             (raid_id, player_id, role, status, assigned_by, created_at, metadata_json)
             VALUES (?, ?, 'owner', 'active', ?, CURRENT_TIMESTAMP, '{}')`,
            [inserted.lastID, narrator.actorId, narrator.actorId]
        );
        const raid = await db.get('SELECT * FROM clover_raids WHERE id = ?', [inserted.lastID]);
        await writeRaidEvent(db, raid.id, 'raid_created', narrator.actorId, { after: serializeRaid(raid) });
        await db.exec('COMMIT');
        return { ok: true, raid: serializeRaid(raid), role: 'owner', principal: true };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function addRaidHost(db, raidKey, actorId, targetPlayerId) {
    const raid = await getRaidRow(db, raidKey);
    const owner = await requireHost(db, raid, actorId, { principal: true });
    if (!HOST_MANAGED_STATUSES.includes(raid.status)) {
        throw new RaidServiceError('raid_closed', 'Essa raid já foi encerrada.');
    }
    const target = normalizeJid(targetPlayerId);
    if (!target || isSameUser(target, raid.owner_player_id)) {
        throw new RaidServiceError('invalid_co_host', 'Escolha outro narrador para ser co-host.');
    }
    await requireNarrator(db, target);
    const player = await db.get('SELECT id FROM jogadores WHERE id = ?', [target]);
    if (!player) throw new RaidServiceError('player_not_found', 'Narrador não encontrado no banco de jogadores.');

    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run(
            `UPDATE clover_raid_hosts
             SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revoked_by = ?
             WHERE raid_id = ? AND player_id = ? AND status = 'active'`,
            [owner.actorId, raid.id, target]
        );
        const inserted = await db.run(
            `INSERT INTO clover_raid_hosts
             (raid_id, player_id, role, status, assigned_by, created_at, metadata_json)
             VALUES (?, ?, 'co_host', 'active', ?, CURRENT_TIMESTAMP, '{}')`,
            [raid.id, target, owner.actorId]
        );
        await writeRaidEvent(db, raid.id, 'host_added', owner.actorId, { subjectPlayerId: target });
        const host = await db.get('SELECT * FROM clover_raid_hosts WHERE id = ?', [inserted.lastID]);
        await db.exec('COMMIT');
        return { ok: true, host };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function revokeRaidHost(db, raidKey, actorId, targetPlayerId) {
    const raid = await getRaidRow(db, raidKey);
    const owner = await requireHost(db, raid, actorId, { principal: true });
    const target = normalizeJid(targetPlayerId);
    if (isSameUser(target, raid.owner_player_id)) {
        throw new RaidServiceError('cannot_revoke_owner', 'O owner principal não pode ser removido.');
    }
    const result = await db.run(
        `UPDATE clover_raid_hosts
         SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revoked_by = ?
         WHERE raid_id = ? AND player_id = ? AND status = 'active'`,
        [owner.actorId, raid.id, target]
    );
    if (!Number(result.changes || 0)) throw new RaidServiceError('host_not_found', 'Co-host ativo não encontrado.');
    await writeRaidEvent(db, raid.id, 'host_revoked', owner.actorId, { subjectPlayerId: target });
    return { ok: true };
}

async function joinRaid(db, raidKey, playerId, options = {}) {
    const raid = await getRaidRow(db, raidKey);
    const player = normalizeJid(playerId);
    if (raid.status !== 'lobby') throw new RaidServiceError('raid_already_started', 'Essa raid já começou e não aceita novas entradas.');
    const playerRow = await db.get('SELECT * FROM jogadores WHERE id = ?', [player]);
    if (!playerRow) throw new RaidServiceError('player_not_found', 'Player não encontrado.');
    if (String(playerRow.jogo_status || '').toLowerCase() !== 'liberado') {
        throw new RaidServiceError('game_blocked', 'O personagem ainda não está liberado para jogar.');
    }
    const count = await db.get(
        `SELECT COUNT(*) AS total FROM clover_raid_participants
         WHERE raid_id = ? AND status IN ('joined', 'active')`,
        [raid.id]
    );
    const existing = await db.get(
        'SELECT * FROM clover_raid_participants WHERE raid_id = ? AND player_id = ?',
        [raid.id, player]
    );
    if (existing && ACTIVE_PARTICIPANT_STATUSES.includes(existing.status)) {
        return { ok: true, duplicate: true, participant: serializeParticipant(existing), raid: serializeRaid(raid) };
    }
    if (Number(count?.total || 0) >= Number(raid.max_players || 0)) {
        throw new RaidServiceError('raid_full', 'O lobby está lotado.');
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        let participant;
        if (existing) {
            await db.run(
                `UPDATE clover_raid_participants
                 SET status = 'joined', joined_at = CURRENT_TIMESTAMP, joined_via = ?,
                     removed_at = NULL, removed_by = NULL, removal_reason = NULL,
                     snapshot_json = NULL, metadata_json = ?
                 WHERE id = ?`,
                [options.via || 'site', JSON.stringify(options.metadata || {}), existing.id]
            );
            participant = await db.get('SELECT * FROM clover_raid_participants WHERE id = ?', [existing.id]);
        } else {
            const inserted = await db.run(
                `INSERT INTO clover_raid_participants
                 (raid_id, player_id, status, joined_at, joined_via, metadata_json)
                 VALUES (?, ?, 'joined', CURRENT_TIMESTAMP, ?, ?)`,
                [raid.id, player, options.via || 'site', JSON.stringify(options.metadata || {})]
            );
            participant = await db.get('SELECT * FROM clover_raid_participants WHERE id = ?', [inserted.lastID]);
        }
        await writeRaidEvent(db, raid.id, 'participant_joined', player, {
            subjectPlayerId: player,
            metadata: options.metadata || {},
        });
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, participant: serializeParticipant(participant), raid: serializeRaid(raid) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function leaveRaid(db, raidKey, playerId) {
    const raid = await getRaidRow(db, raidKey);
    if (!HOST_MANAGED_STATUSES.includes(raid.status)) {
        throw new RaidServiceError('raid_closed', 'Essa raid já foi encerrada.');
    }
    const participant = await getActiveParticipant(db, raid.id, playerId);
    if (!participant) throw new RaidServiceError('participant_not_found', 'Você não está nesse lobby.');
    await db.exec('BEGIN IMMEDIATE');
    try {
        await releaseParticipantReservations(db, participant.id, playerId, 'participant_left');
        await db.run(
            `UPDATE clover_raid_participants
             SET status = 'withdrawn', removed_at = CURRENT_TIMESTAMP,
                 removed_by = ?, removal_reason = 'Saída voluntária'
             WHERE id = ?`,
            [normalizeJid(playerId), participant.id]
        );
        await writeRaidEvent(db, raid.id, 'participant_left', normalizeJid(playerId), {
            subjectPlayerId: normalizeJid(playerId),
        });
        await db.exec('COMMIT');
        return { ok: true };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function removeRaidParticipant(db, raidKey, actorId, targetPlayerId, reason = null) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    if (!HOST_MANAGED_STATUSES.includes(raid.status)) {
        throw new RaidServiceError('raid_closed', 'Essa raid já foi encerrada.');
    }
    const participant = await getActiveParticipant(db, raid.id, targetPlayerId);
    if (!participant) throw new RaidServiceError('participant_not_found', 'Participante não encontrado no lobby.');
    await db.exec('BEGIN IMMEDIATE');
    try {
        await releaseParticipantReservations(db, participant.id, host.actorId, 'participant_removed');
        await db.run(
            `UPDATE clover_raid_participants
             SET status = 'removed', removed_at = CURRENT_TIMESTAMP,
                 removed_by = ?, removal_reason = ?
             WHERE id = ?`,
            [host.actorId, String(reason || '').trim() || null, participant.id]
        );
        await writeRaidEvent(db, raid.id, 'participant_removed', host.actorId, {
            subjectPlayerId: participant.player_id,
            metadata: { reason: String(reason || '').trim() || null },
        });
        await db.exec('COMMIT');
        return { ok: true };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

function itemLoadoutSlots(item) {
    const configured = item.properties?.loadoutSlots || item.properties?.loadout_slots;
    if (Array.isArray(configured) && configured.length) {
        return new Set(configured.map((value) => String(value).trim().toLowerCase()));
    }
    const category = String(item.category || '').toLowerCase();
    const name = String(item.item_name || '');
    const key = String(item.template_key || '');
    if (/vassoura/i.test(name) || key.startsWith('vassoura_')) return new Set(['aerial_transport']);
    if (['consumivel', 'kit'].includes(category)) return new Set(['quick_1', 'quick_2']);
    if (category === 'vestimenta' || /armadura|half plate|full plate|roupas|traje/i.test(name)) return new Set(['body']);
    if (category !== 'equipamento') return new Set();
    if (/escudo/i.test(name) || key.startsWith('escudo_')) return new Set(['off_hand']);
    return TWO_HANDED_TEMPLATE_KEYS.has(key)
        ? new Set(['main_hand'])
        : new Set(['main_hand', 'off_hand']);
}

function isTwoHandedItem(item) {
    const hands = Number(item.properties?.hands || item.properties?.maos || 0);
    return hands === 2 || TWO_HANDED_TEMPLATE_KEYS.has(String(item.template_key || ''));
}

function validateSlotForItem(slot, item) {
    return itemLoadoutSlots(item).has(slot);
}

async function setRaidLoadoutSlot(db, raidKey, actorId, slotInput, input = {}) {
    const raid = await getRaidRow(db, raidKey);
    if (raid.status !== 'lobby') throw new RaidServiceError('loadout_locked', 'O inventário atual foi travado quando a raid começou.');
    const targetPlayerId = normalizeJid(input.playerId || input.player_id || actorId);
    const participant = await getActiveParticipant(db, raid.id, targetPlayerId);
    if (!participant) throw new RaidServiceError('participant_not_found', 'Player não está no lobby.');
    const host = await getHostAccess(db, raid, actorId);
    if (!host.ok && !isSameUser(actorId, participant.player_id)) {
        throw new RaidServiceError('loadout_forbidden', 'Você só pode alterar o próprio inventário atual.');
    }
    const slot = String(slotInput || '').trim().toLowerCase();
    if (!RAID_SLOTS.includes(slot)) throw new RaidServiceError('invalid_slot', 'Slot de missão inválido.');
    const inventoryItemId = input.inventoryItemId ?? input.inventory_item_id ?? null;
    const quantity = Number(input.quantity || input.quantidade || 1);

    await ensureInventoryV1(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const previous = await db.get(
            `SELECT * FROM clover_raid_loadout_items
             WHERE raid_id = ? AND participant_id = ? AND slot_key = ?`,
            [raid.id, participant.id, slot]
        );
        if (previous) {
            await releaseInventoryReservationInTransaction(db, previous.reservation_id, {
                metadata: { replaced_by: normalizeJid(actorId), raid_id: raid.id },
            });
            await db.run('DELETE FROM clover_raid_loadout_items WHERE id = ?', [previous.id]);
        }
        if (inventoryItemId === null || inventoryItemId === '' || Number(inventoryItemId) === 0) {
            await writeRaidEvent(db, raid.id, 'loadout_slot_cleared', normalizeJid(actorId), {
                subjectPlayerId: participant.player_id,
                before: previous ? serializeLoadoutItem(previous) : null,
                metadata: { slot },
            });
            await db.exec('COMMIT');
            return { ok: true, cleared: true, slot, item: null };
        }
        if (!Number.isInteger(quantity) || quantity <= 0) {
            throw new RaidServiceError('invalid_quantity', 'Quantidade do inventário atual inválida.');
        }
        const itemRow = await db.get(
            'SELECT * FROM clover_inventory_items WHERE id = ? AND player_id = ?',
            [Number(inventoryItemId), participant.player_id]
        );
        if (!itemRow) throw new RaidServiceError('item_not_found', 'Item não encontrado no inventário do player.');
        const item = serializeItem(itemRow);
        if (item.condition === 'quebrado' || item.status === 'quebrado') {
            throw new RaidServiceError('item_broken', 'Item quebrado não pode entrar no inventário atual.');
        }
        if (!validateSlotForItem(slot, item)) {
            throw new RaidServiceError('item_slot_mismatch', 'Esse item não é compatível com o slot escolhido.');
        }
        if ((slot === 'quick_1' || slot === 'quick_2') && quantity !== 1) {
            throw new RaidServiceError('quick_slot_quantity', 'Sem mochila, cada slot rápido leva apenas uma unidade.');
        }
        if (item.durability_max !== null && quantity !== 1) {
            throw new RaidServiceError('equipment_quantity', 'Equipamento ocupa o slot como uma única unidade.');
        }
        const oppositeHand = await db.get(
            `SELECT * FROM clover_raid_loadout_items
             WHERE raid_id = ? AND participant_id = ? AND slot_key = ?`,
            [raid.id, participant.id, slot === 'main_hand' ? 'off_hand' : 'main_hand']
        );
        if (slot === 'main_hand' && isTwoHandedItem(item) && oppositeHand) {
            throw new RaidServiceError('two_handed_conflict', 'Item de duas mãos exige a mão secundária vazia.');
        }
        if (slot === 'off_hand' && oppositeHand) {
            const oppositeSnapshot = safeJsonParse(oppositeHand.snapshot_json, {});
            if (isTwoHandedItem(oppositeSnapshot)) {
                throw new RaidServiceError('two_handed_conflict', 'A mão principal já usa um item de duas mãos.');
            }
        }
        const reservation = await reserveInventoryItemInTransaction(
            db,
            participant.player_id,
            item.id,
            quantity,
            {
                reservationKey: `raid:${raid.id}:${participant.id}:${slot}:${crypto.randomUUID()}`,
                sourceType: 'raid',
                sourceId: String(raid.id),
                createdBy: normalizeJid(actorId),
                metadata: { raid_key: raid.raid_key, participant_id: participant.id, slot },
            }
        );
        const inserted = await db.run(
            `INSERT INTO clover_raid_loadout_items
             (raid_id, participant_id, player_id, inventory_item_id, reservation_id, slot_key,
              quantity, quantity_consumed, durability_start, durability_current,
              snapshot_json, created_at, updated_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '{}')`,
            [
                raid.id,
                participant.id,
                participant.player_id,
                item.id,
                reservation.id,
                slot,
                quantity,
                item.durability_current,
                item.durability_current,
                JSON.stringify(item),
            ]
        );
        const loadout = await db.get('SELECT * FROM clover_raid_loadout_items WHERE id = ?', [inserted.lastID]);
        await writeRaidEvent(db, raid.id, 'loadout_slot_set', normalizeJid(actorId), {
            subjectPlayerId: participant.player_id,
            before: previous ? serializeLoadoutItem(previous) : null,
            after: serializeLoadoutItem(loadout),
            metadata: { slot },
        });
        await db.exec('COMMIT');
        return { ok: true, cleared: false, slot, item: serializeLoadoutItem(loadout) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function buildParticipantSnapshot(db, playerId) {
    await ensureCloverCharacterStatsSchema(db);
    await ensureCloverManaHexagonSchema(db);
    await ensureSpellbookSchema(db);
    const [player, stats, hexagon, spells, capacity, bonus] = await Promise.all([
        db.get(
            `SELECT id, nome, display_name, personagem_nome, personagem_idade, personagem_genero,
                    personagem_aparencia, personagem_aparencia_status, personagem_aparencia_image_path,
                    site_profile_image_data,
                    reino, classe, familia, raca, grimorio, magia, formas, esquadrao, estrelas, patente,
                    aptidao_comum, aptidao_rara, marca_comum, marca_rara, anomalia, gancho_narrativo,
                    jogo_status
             FROM jogadores WHERE id = ?`,
            [playerId]
        ),
        db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', [playerId]),
        db.get('SELECT * FROM clover_mana_hexagon WHERE player_id = ?', [playerId]),
        listApprovedSpells(db, playerId),
        getPlayerTechnicalCapacity(db, playerId).catch(() => null),
        getCharacterBonusSummary(db, playerId).catch(() => null),
    ]);
    const serializedCapacity = serializeRaidCapacity(capacity);
    return {
        player,
        stats: stats || null,
        hexagon: hexagon || null,
        spells,
        capacity: serializedCapacity,
        capacidade: serializedCapacity,
        bonus: serializeRaidBonus(bonus),
    };
}

async function startRaid(db, raidKey, actorId) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    if (raid.status !== 'lobby') {
        if (raid.status === 'in_progress') return { ok: true, duplicate: true, raid: serializeRaid(raid) };
        throw new RaidServiceError('invalid_raid_status', 'A raid não está mais no lobby.');
    }
    const participants = await db.all(
        `SELECT * FROM clover_raid_participants
         WHERE raid_id = ? AND status = 'joined'
         ORDER BY joined_at ASC, id ASC`,
        [raid.id]
    );
    if (!participants.length) throw new RaidServiceError('empty_lobby', 'Adicione pelo menos um jogador antes de iniciar.');
    for (const participant of participants) {
        const conflict = await db.get(
            `SELECT p.id, r.raid_key, r.name
             FROM clover_raid_participants p
             JOIN clover_raids r ON r.id = p.raid_id
             WHERE p.player_id = ? AND p.status = 'active' AND r.status = 'in_progress' AND r.id != ?
             LIMIT 1`,
            [participant.player_id, raid.id]
        );
        if (conflict) {
            throw new RaidServiceError('participant_in_another_raid', 'Um participante já está em outra raid em andamento.', {
                playerId: participant.player_id,
                raidKey: conflict.raid_key,
            });
        }
    }
    const snapshots = new Map();
    for (const participant of participants) {
        snapshots.set(participant.id, await buildParticipantSnapshot(db, participant.player_id));
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        for (const participant of participants) {
            await db.run(
                `UPDATE clover_raid_participants
                 SET status = 'active', snapshot_json = ?
                 WHERE id = ? AND status = 'joined'`,
                [JSON.stringify(snapshots.get(participant.id)), participant.id]
            );
            const loadout = await db.all(
                'SELECT * FROM clover_raid_loadout_items WHERE participant_id = ?',
                [participant.id]
            );
            for (const loadoutItem of loadout) {
                const inventory = await db.get(
                    'SELECT * FROM clover_inventory_items WHERE id = ?',
                    [loadoutItem.inventory_item_id]
                );
                if (!inventory) throw new RaidServiceError('reserved_item_missing', 'Um item reservado não existe mais.');
                await db.run(
                    `UPDATE clover_raid_loadout_items
                     SET snapshot_json = ?, durability_start = ?, durability_current = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [
                        JSON.stringify(serializeItem(inventory)),
                        inventory.durability_current,
                        inventory.durability_current,
                        loadoutItem.id,
                    ]
                );
            }
        }
        await db.run(
            `UPDATE clover_raids
             SET status = 'in_progress', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'lobby'`,
            [raid.id]
        );
        const updated = await db.get('SELECT * FROM clover_raids WHERE id = ?', [raid.id]);
        await writeRaidEvent(db, raid.id, 'raid_started', host.actorId, { after: serializeRaid(updated) });
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, raid: serializeRaid(updated), participants: participants.length };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function applyRaidDurabilityLoss(db, raidKey, actorId, loadoutItemId, loss, cause, options = {}) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    if (raid.status !== 'in_progress') throw new RaidServiceError('raid_not_in_progress', 'Desgaste só pode ser aplicado durante a raid.');
    const amount = Number(loss);
    if (![1, 2, 3].includes(amount)) throw new RaidServiceError('invalid_durability_loss', 'Use desgaste leve (1), sério (2) ou crítico (3).');
    const cleanCause = String(cause || '').trim();
    if (!cleanCause) throw new RaidServiceError('missing_cause', 'Informe a causa do desgaste.');
    const idempotencyKey = String(options.idempotencyKey || '').trim() || null;
    if (idempotencyKey) {
        const duplicate = await db.get('SELECT * FROM clover_raid_item_events WHERE idempotency_key = ?', [idempotencyKey]);
        if (duplicate) return { ok: true, duplicate: true, event: duplicate };
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        const loadout = await db.get(
            `SELECT * FROM clover_raid_loadout_items
             WHERE id = ? AND raid_id = ?`,
            [Number(loadoutItemId), raid.id]
        );
        if (!loadout) throw new RaidServiceError('loadout_item_not_found', 'Item não encontrado no inventário atual.');
        const inventory = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [loadout.inventory_item_id]);
        if (!inventory) throw new RaidServiceError('inventory_item_missing', 'Item original não foi encontrado.');
        if (inventory.durability_max === null) throw new RaidServiceError('item_has_no_durability', 'Esse item não usa durabilidade.');
        const before = serializeItem(inventory);
        if (Number(inventory.durability_current || 0) <= 0) throw new RaidServiceError('item_already_broken', 'O item já está quebrado.');
        const next = Math.max(0, Number(inventory.durability_current || 0) - amount);
        await db.run(
            `UPDATE clover_inventory_items
             SET durability_current = ?, status = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [next, next === 0 ? 'quebrado' : inventory.status, inventory.id]
        );
        await db.run(
            `UPDATE clover_raid_loadout_items
             SET durability_current = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [next, loadout.id]
        );
        const after = serializeItem(await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [inventory.id]));
        await recordHistory(db, {
            itemId: inventory.id,
            playerId: inventory.player_id,
            action: 'desgaste_raid',
            durabilityDelta: next - Number(inventory.durability_current || 0),
            before,
            after,
            source: 'raid',
            relatedId: `raid:${raid.id}`,
            idempotencyKey: idempotencyKey ? `inventory:${idempotencyKey}` : null,
            createdBy: host.actorId,
            metadata: { raid_key: raid.raid_key, cause: cleanCause, intensity: amount },
        });
        const inserted = await db.run(
            `INSERT INTO clover_raid_item_events
             (raid_id, participant_id, loadout_item_id, event_type, amount, cause,
              before_json, after_json, created_by, created_at, idempotency_key, metadata_json)
             VALUES (?, ?, ?, 'durability_loss', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, '{}')`,
            [
                raid.id,
                loadout.participant_id,
                loadout.id,
                amount,
                cleanCause,
                JSON.stringify(before),
                JSON.stringify(after),
                host.actorId,
                idempotencyKey,
            ]
        );
        const event = await db.get('SELECT * FROM clover_raid_item_events WHERE id = ?', [inserted.lastID]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, event, item: after };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function consumeRaidItem(db, raidKey, actorId, loadoutItemId, quantity, cause, options = {}) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    if (raid.status !== 'in_progress') throw new RaidServiceError('raid_not_in_progress', 'Consumo só pode ser registrado durante a raid.');
    const amount = Number(quantity);
    if (!Number.isInteger(amount) || amount <= 0) throw new RaidServiceError('invalid_quantity', 'Quantidade consumida inválida.');
    const cleanCause = String(cause || '').trim();
    if (!cleanCause) throw new RaidServiceError('missing_cause', 'Informe como o item foi consumido.');
    const idempotencyKey = String(options.idempotencyKey || '').trim() || null;
    if (idempotencyKey) {
        const duplicate = await db.get('SELECT * FROM clover_raid_item_events WHERE idempotency_key = ?', [idempotencyKey]);
        if (duplicate) return { ok: true, duplicate: true, event: duplicate };
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        const loadout = await db.get(
            'SELECT * FROM clover_raid_loadout_items WHERE id = ? AND raid_id = ?',
            [Number(loadoutItemId), raid.id]
        );
        if (!loadout) throw new RaidServiceError('loadout_item_not_found', 'Item não encontrado no inventário atual.');
        const snapshot = safeJsonParse(loadout.snapshot_json, {});
        if (!['consumivel', 'kit'].includes(String(snapshot.category || '').toLowerCase())) {
            throw new RaidServiceError('item_not_consumable', 'Esse item deve ser desgastado, não consumido.');
        }
        const remaining = Number(loadout.quantity || 0) - Number(loadout.quantity_consumed || 0);
        if (remaining < amount) throw new RaidServiceError('insufficient_loadout_quantity', 'Quantidade insuficiente no inventário atual.');
        const inventory = await db.get('SELECT * FROM clover_inventory_items WHERE id = ?', [loadout.inventory_item_id]);
        if (!inventory) throw new RaidServiceError('inventory_item_missing', 'Item original não foi encontrado.');
        const before = serializeLoadoutItem(loadout);
        await consumeInventoryItemInTransaction(db, inventory, amount, {
            reservationId: loadout.reservation_id,
            action: 'consumido_raid',
            source: 'raid',
            relatedId: `raid:${raid.id}`,
            idempotencyKey: idempotencyKey ? `inventory:${idempotencyKey}` : null,
            createdBy: host.actorId,
            metadata: { raid_key: raid.raid_key, cause: cleanCause },
        });
        await db.run(
            `UPDATE clover_raid_loadout_items
             SET quantity_consumed = quantity_consumed + ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [amount, loadout.id]
        );
        const updated = await db.get('SELECT * FROM clover_raid_loadout_items WHERE id = ?', [loadout.id]);
        const after = serializeLoadoutItem(updated);
        const inserted = await db.run(
            `INSERT INTO clover_raid_item_events
             (raid_id, participant_id, loadout_item_id, event_type, amount, cause,
              before_json, after_json, created_by, created_at, idempotency_key, metadata_json)
             VALUES (?, ?, ?, 'consumed', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, '{}')`,
            [
                raid.id,
                loadout.participant_id,
                loadout.id,
                amount,
                cleanCause,
                JSON.stringify(before),
                JSON.stringify(after),
                host.actorId,
                idempotencyKey,
            ]
        );
        const event = await db.get('SELECT * FROM clover_raid_item_events WHERE id = ?', [inserted.lastID]);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, event, item: after };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function beginRaidFinalization(db, raidKey, actorId) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    if (raid.status === 'finalization') return { ok: true, duplicate: true, raid: serializeRaid(raid) };
    if (raid.status !== 'in_progress') throw new RaidServiceError('raid_not_in_progress', 'A raid não está em andamento.');
    await db.run(
        `UPDATE clover_raids
         SET status = 'finalization', finalization_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [raid.id]
    );
    const updated = await db.get('SELECT * FROM clover_raids WHERE id = ?', [raid.id]);
    await writeRaidEvent(db, raid.id, 'finalization_started', host.actorId, { after: serializeRaid(updated) });
    return { ok: true, duplicate: false, raid: serializeRaid(updated) };
}

async function addRaidCondition(db, raidKey, actorId, input = {}) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    if (!['in_progress', 'finalization'].includes(raid.status)) {
        throw new RaidServiceError('conditions_locked', 'Condições só podem ser aplicadas durante ou ao finalizar a raid.');
    }
    const targetType = String(input.targetType || input.target_type || 'player').toLowerCase();
    if (!['general', 'player'].includes(targetType)) {
        throw new RaidServiceError('invalid_condition_target', 'Alvo da condição inválido.');
    }
    let participant = null;
    const targetPlayerId = targetType === 'player'
        ? normalizeJid(input.targetPlayerId || input.target_player_id)
        : null;
    if (targetType === 'player') {
        participant = await db.get(
            `SELECT * FROM clover_raid_participants
             WHERE raid_id = ? AND player_id = ? AND status = 'active'`,
            [raid.id, targetPlayerId]
        );
        if (!participant) throw new RaidServiceError('condition_target_not_participant', 'O alvo não é participante ativo da raid.');
    }
    const label = String(input.label || input.nome || '').trim().slice(0, 120);
    if (!label) throw new RaidServiceError('condition_label_required', 'Informe o nome da condição.');
    const conditionKey = normalizeCategory(input.conditionKey || input.condition_key || label);
    const severity = String(input.severity || input.gravidade || 'normal').toLowerCase();
    if (!['leve', 'normal', 'seria', 'critica'].includes(severity)) {
        throw new RaidServiceError('invalid_condition_severity', 'Gravidade da condição inválida.');
    }
    const inserted = await db.run(
        `INSERT INTO clover_raid_conditions
         (raid_id, target_type, participant_id, target_player_id, condition_key,
          label, description, severity, status, applied_by, applied_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP, ?)`,
        [
            raid.id,
            targetType,
            participant?.id || null,
            targetPlayerId,
            conditionKey,
            label,
            String(input.description || input.descricao || '').trim() || null,
            severity,
            host.actorId,
            JSON.stringify(input.metadata || {}),
        ]
    );
    const condition = await db.get('SELECT * FROM clover_raid_conditions WHERE id = ?', [inserted.lastID]);
    await writeRaidEvent(db, raid.id, 'condition_applied', host.actorId, {
        subjectPlayerId: targetPlayerId,
        after: condition,
    });
    return { ok: true, condition };
}

async function resolveRaidCondition(db, raidKey, actorId, conditionId, note = null) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    if (!['in_progress', 'finalization'].includes(raid.status)) {
        throw new RaidServiceError('conditions_locked', 'Essa raid não aceita mais alterações de condição.');
    }
    const result = await db.run(
        `UPDATE clover_raid_conditions
         SET status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP,
             resolution_note = ?
         WHERE id = ? AND raid_id = ? AND status = 'active'`,
        [host.actorId, String(note || '').trim() || null, Number(conditionId), raid.id]
    );
    if (!Number(result.changes || 0)) {
        throw new RaidServiceError('condition_not_active', 'Condição não encontrada ou já resolvida.');
    }
    const condition = await db.get('SELECT * FROM clover_raid_conditions WHERE id = ?', [Number(conditionId)]);
    await writeRaidEvent(db, raid.id, 'condition_resolved', host.actorId, {
        subjectPlayerId: condition.target_player_id,
        after: condition,
    });
    return { ok: true, condition };
}

async function addRaidReward(db, raidKey, actorId, input = {}) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    if (!['in_progress', 'finalization'].includes(raid.status)) {
        throw new RaidServiceError('rewards_locked', 'Recompensas só podem ser preparadas durante ou ao finalizar a raid.');
    }
    const targetType = String(input.targetType || input.target_type || 'general').toLowerCase();
    if (!['general', 'player'].includes(targetType)) throw new RaidServiceError('invalid_reward_target', 'Alvo de recompensa inválido.');
    const targetPlayerId = targetType === 'player'
        ? normalizeJid(input.targetPlayerId || input.target_player_id)
        : null;
    if (targetType === 'player') {
        const participant = await db.get(
            `SELECT id FROM clover_raid_participants
             WHERE raid_id = ? AND player_id = ? AND status = 'active'`,
            [raid.id, targetPlayerId]
        );
        if (!participant) throw new RaidServiceError('reward_target_not_participant', 'O alvo não é participante ativo da raid.');
    }
    const rewardType = String(input.rewardType || input.reward_type || '').toLowerCase();
    if (!['yulls', 'ph', 'stars', 'catalog_item'].includes(rewardType)) {
        throw new RaidServiceError('invalid_reward_type', 'Tipo de recompensa inválido.');
    }
    const amount = Number(input.amount || input.quantidade || 1);
    const maximum = RAID_REWARD_LIMITS[rewardType];
    if (!Number.isInteger(amount) || amount <= 0 || amount > maximum) {
        throw new RaidServiceError(
            'invalid_reward_amount',
            `Quantidade fora do limite da V1 para ${rewardType}: máximo ${maximum}.`,
            { rewardType, maximum }
        );
    }
    const templateKey = rewardType === 'catalog_item'
        ? String(input.templateKey || input.template_key || '').trim()
        : null;
    const template = templateKey ? await getItemTemplate(db, templateKey) : null;
    if (rewardType === 'catalog_item' && !template) {
        throw new RaidServiceError('reward_template_not_found', 'Item não existe no catálogo da Economia V1.');
    }
    const label = String(input.label || input.nome || (template ? template.itemName : `${amount} ${rewardType}`)).trim().slice(0, 160);
    const inserted = await db.run(
        `INSERT INTO clover_raid_rewards
         (raid_id, target_type, target_player_id, reward_type, amount, template_key,
          label, reason, status, created_by, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, CURRENT_TIMESTAMP, ?)`,
        [
            raid.id,
            targetType,
            targetPlayerId,
            rewardType,
            amount,
            templateKey,
            label,
            String(input.reason || input.motivo || '').trim() || null,
            host.actorId,
            JSON.stringify(input.metadata || {}),
        ]
    );
    const reward = await db.get('SELECT * FROM clover_raid_rewards WHERE id = ?', [inserted.lastID]);
    await writeRaidEvent(db, raid.id, 'reward_drafted', host.actorId, {
        subjectPlayerId: targetPlayerId,
        after: reward,
    });
    return { ok: true, reward };
}

async function cancelRaidReward(db, raidKey, actorId, rewardId) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    const result = await db.run(
        `UPDATE clover_raid_rewards
         SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancelled_by = ?
         WHERE id = ? AND raid_id = ? AND status = 'draft'`,
        [host.actorId, Number(rewardId), raid.id]
    );
    if (!Number(result.changes || 0)) throw new RaidServiceError('reward_not_editable', 'Recompensa não encontrada ou já aplicada.');
    await writeRaidEvent(db, raid.id, 'reward_cancelled', host.actorId, { metadata: { reward_id: Number(rewardId) } });
    return { ok: true };
}

async function applyStarReward(db, player, reward, actorId) {
    const amount = Number(reward.amount || 0);
    await db.run('UPDATE jogadores SET estrelas = COALESCE(estrelas, 0) + ? WHERE id = ?', [amount, player.id]);
    const membership = await resolvePlayerSquadMembership(db, player.id);
    if (membership.ok) {
        const squadName = membership.squadName;
        const squadKey = membership.squadKey;
        if (squadKey) {
            await db.run(
                `INSERT INTO clover_squads
                 (squad_key, name, historical_stars, current_stars, updated_at)
                 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(squad_key) DO UPDATE SET
                     historical_stars = clover_squads.historical_stars + excluded.historical_stars,
                     current_stars = clover_squads.current_stars + excluded.current_stars,
                     updated_at = CURRENT_TIMESTAMP`,
                [squadKey, squadName, amount, amount]
            );
            await db.run(
                `INSERT INTO clover_squad_star_ledger
                 (squad_key, player_id, evaluation_id, amount, kind, source, reason, created_by, created_at, metadata_json)
                 VALUES (?, ?, NULL, ?, 'ganho', 'raid', ?, ?, CURRENT_TIMESTAMP, ?)`,
                [
                    squadKey,
                    player.id,
                    amount,
                    reward.reason || `Recompensa da raid ${reward.raid_id}`,
                    actorId,
                    JSON.stringify({ raid_id: reward.raid_id, raid_reward_id: reward.id }),
                ]
            );
        }
    }
    return { type: 'stars', amount };
}

async function deliverRaidReward(db, raid, reward, player, actorId) {
    const relatedId = `raid_reward:${reward.id}:${player.id}`;
    if (reward.reward_type === 'yulls') {
        const result = await addYullsInTransaction(
            db,
            player.id,
            Number(reward.amount),
            'raid',
            reward.reason || `Recompensa: ${raid.name}`,
            actorId,
            {
                relatedId,
                idempotencyKey: `yulls:${relatedId}`,
                metadata: { raid_id: raid.id, raid_key: raid.raid_key, reward_id: reward.id },
            }
        );
        return { type: 'yulls', amount: Number(reward.amount), ledgerId: result.ledgerId };
    }
    if (reward.reward_type === 'ph') {
        const result = await addPhInTransaction(
            db,
            player.id,
            Number(reward.amount),
            'raid',
            `${reward.reason || `Recompensa: ${raid.name}`} — fora do teto semanal`,
            actorId,
            { outside_weekly_cap: true, raid_id: raid.id, raid_reward_id: reward.id },
            relatedId
        );
        return { type: 'ph', amount: Number(reward.amount), outsideWeeklyCap: true, ledgerId: result.ledgerId };
    }
    if (reward.reward_type === 'stars') return applyStarReward(db, player, reward, actorId);
    const added = await addCatalogItemInTransaction(db, player.id, reward.template_key, Number(reward.amount), {
        source: 'raid',
        relatedId,
        createdBy: actorId,
        metadata: { raid_id: raid.id, raid_key: raid.raid_key, raid_reward_id: reward.id },
    });
    return {
        type: 'catalog_item',
        templateKey: reward.template_key,
        quantity: Number(reward.amount),
        itemIds: added.items.map((item) => item.id),
    };
}

async function completeRaid(db, raidKey, actorId, options = {}) {
    const raid = await getRaidRow(db, raidKey);
    const host = await requireHost(db, raid, actorId);
    if (raid.status === 'completed') return { ok: true, duplicate: true, raid: serializeRaid(raid) };
    if (raid.status !== 'finalization') throw new RaidServiceError('raid_not_in_finalization', 'Revise as recompensas e inicie a finalização antes de concluir.');
    const participants = await db.all(
        `SELECT p.*, j.esquadrao, j.personagem_nome, j.nome
         FROM clover_raid_participants p
         JOIN jogadores j ON j.id = p.player_id
         WHERE p.raid_id = ? AND p.status = 'active'
         ORDER BY p.id ASC`,
        [raid.id]
    );
    const rewards = await db.all(
        `SELECT * FROM clover_raid_rewards
         WHERE raid_id = ? AND status = 'draft'
         ORDER BY id ASC`,
        [raid.id]
    );
    await ensureInventoryV1(db);
    await ensureCloverSquadSchema(db);
    for (const participant of participants) {
        await ensureYullsState(db, participant.player_id);
        await ensurePhState(db, participant.player_id);
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        let deliveries = 0;
        for (const reward of rewards) {
            const targets = reward.target_type === 'general'
                ? participants
                : participants.filter((participant) => isSameUser(participant.player_id, reward.target_player_id));
            if (!targets.length) {
                throw new RaidServiceError('reward_without_target', `A recompensa ${reward.id} não possui alvo ativo.`);
            }
            for (const player of targets) {
                const existing = await db.get(
                    'SELECT * FROM clover_raid_reward_deliveries WHERE reward_id = ? AND player_id = ?',
                    [reward.id, player.player_id]
                );
                if (existing) continue;
                const playerRow = { ...player, id: player.player_id };
                const result = await deliverRaidReward(db, raid, reward, playerRow, host.actorId);
                await db.run(
                    `INSERT INTO clover_raid_reward_deliveries
                     (raid_id, reward_id, player_id, status, result_json, created_at, metadata_json)
                     VALUES (?, ?, ?, 'completed', ?, CURRENT_TIMESTAMP, ?)`,
                    [
                        raid.id,
                        reward.id,
                        player.player_id,
                        JSON.stringify(result),
                        JSON.stringify({ raid_key: raid.raid_key }),
                    ]
                );
                deliveries += 1;
            }
            await db.run("UPDATE clover_raid_rewards SET status = 'applied' WHERE id = ?", [reward.id]);
        }
        const reservations = await db.all(
            `SELECT reservation.id
             FROM clover_inventory_reservations reservation
             WHERE reservation.source_type = 'raid' AND reservation.source_id = ? AND reservation.status = 'active'`,
            [String(raid.id)]
        );
        for (const reservation of reservations) {
            await releaseInventoryReservationInTransaction(db, reservation.id, {
                metadata: { released_by: host.actorId, reason: 'raid_completed' },
            });
        }
        await db.run(
            `UPDATE clover_raid_participants
             SET status = 'completed'
             WHERE raid_id = ? AND status = 'active'`,
            [raid.id]
        );
        await db.run(
            `UPDATE clover_raids
             SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'finalization'`,
            [raid.id]
        );
        const updated = await db.get('SELECT * FROM clover_raids WHERE id = ?', [raid.id]);
        await writeRaidEvent(db, raid.id, 'raid_completed', host.actorId, {
            after: serializeRaid(updated),
            idempotencyKey: options.idempotencyKey || null,
            metadata: { deliveries },
        });
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, raid: serializeRaid(updated), deliveries };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function cancelRaid(db, raidKey, actorId, reason = null) {
    const raid = await getRaidRow(db, raidKey);
    const owner = await requireHost(db, raid, actorId, { principal: true });
    if (raid.status === 'cancelled') return { ok: true, duplicate: true, raid: serializeRaid(raid) };
    if (raid.status === 'completed') throw new RaidServiceError('raid_completed', 'Raid concluída não pode ser cancelada.');
    const cleanReason = String(reason || '').trim();
    if (raid.status !== 'lobby' && !cleanReason) {
        throw new RaidServiceError('cancellation_reason_required', 'Informe o motivo para cancelar uma raid iniciada.');
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        const reservations = await db.all(
            `SELECT id FROM clover_inventory_reservations
             WHERE source_type = 'raid' AND source_id = ? AND status = 'active'`,
            [String(raid.id)]
        );
        for (const reservation of reservations) {
            await releaseInventoryReservationInTransaction(db, reservation.id, {
                metadata: { released_by: owner.actorId, reason: 'raid_cancelled' },
            });
        }
        await db.run(
            `UPDATE clover_raid_participants
             SET status = 'withdrawn', removed_at = CURRENT_TIMESTAMP,
                 removed_by = ?, removal_reason = ?
             WHERE raid_id = ? AND status IN ('joined', 'active')`,
            [owner.actorId, cleanReason || 'Raid cancelada', raid.id]
        );
        await db.run(
            `UPDATE clover_raids
             SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, cancelled_by = ?,
                 cancellation_reason = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [owner.actorId, cleanReason || null, raid.id]
        );
        const updated = await db.get('SELECT * FROM clover_raids WHERE id = ?', [raid.id]);
        await writeRaidEvent(db, raid.id, 'raid_cancelled', owner.actorId, {
            after: serializeRaid(updated),
            metadata: { reason: cleanReason || null },
        });
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, raid: serializeRaid(updated) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function getRaidDashboard(db, raidKey, actorId) {
    const raid = await getRaidRow(db, raidKey);
    const actor = normalizeJid(actorId);
    const host = await getHostAccess(db, raid, actor);
    const participant = await db.get(
        `SELECT * FROM clover_raid_participants
         WHERE raid_id = ? AND player_id = ?`,
        [raid.id, actor]
    );
    const canReadAll = host.ok || await hasAccessPermission(db, actor, 'raid.read.all');
    if (!participant && !canReadAll) throw new RaidServiceError('raid_forbidden', 'Você não participa dessa raid.');
    const rows = await db.all(
        `SELECT p.*, j.personagem_nome, j.nome, j.display_name,
                j.personagem_aparencia_image_path, j.site_profile_image_data, j.personagem_aparencia_status,
                j.esquadrao, j.patente, j.magia, j.grimorio, j.jogo_status
         FROM clover_raid_participants p
         JOIN jogadores j ON j.id = p.player_id
         WHERE p.raid_id = ? AND p.status IN ('joined', 'active', 'completed')
         ORDER BY p.joined_at ASC, p.id ASC`,
        [raid.id]
    );
    const hosts = await db.all(
        `SELECT player_id, role, assigned_by, created_at
         FROM clover_raid_hosts
         WHERE raid_id = ? AND status = 'active'
         ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, id ASC`,
        [raid.id]
    );
    const rewards = canReadAll
        ? await db.all('SELECT * FROM clover_raid_rewards WHERE raid_id = ? ORDER BY id ASC', [raid.id])
        : [];
    const conditions = await db.all(
        `SELECT * FROM clover_raid_conditions
         WHERE raid_id = ?
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id DESC`,
        [raid.id]
    );
    const participants = [];
    for (const row of rows) {
        const shouldIncludeLoadout = canReadAll || isSameUser(row.player_id, actor);
        const loadout = shouldIncludeLoadout
            ? (await db.all(
                `SELECT * FROM clover_raid_loadout_items
                 WHERE participant_id = ? ORDER BY slot_key ASC`,
                [row.id]
            )).map(serializeLoadoutItem)
            : [];
        participants.push({
            ...serializeParticipant(row),
            player: playerCard({ ...row, id: row.player_id }),
            loadout,
        });
    }
    return {
        raid: serializeRaid(raid),
        access: {
            isHost: host.ok,
            isPrincipalOwner: host.principal,
            hostRole: host.role,
            isParticipant: Boolean(participant && ACTIVE_PARTICIPANT_STATUSES.includes(participant.status)),
            canReadAll,
        },
        hosts,
        participants,
        conditions,
        rewards,
    };
}

async function getRaidParticipantDetail(db, raidKey, actorId, targetPlayerId) {
    const raid = await getRaidRow(db, raidKey);
    const actor = normalizeJid(actorId);
    const target = normalizeJid(targetPlayerId);
    const host = await getHostAccess(db, raid, actor);
    const isSelf = isSameUser(actor, target);
    if (!host.ok && !isSelf) {
        throw new RaidServiceError(
            'raid_participant_detail_forbidden',
            'Você só pode abrir sua própria ficha nesta raid.'
        );
    }
    const participant = await db.get(
        `SELECT * FROM clover_raid_participants
         WHERE raid_id = ? AND player_id = ? AND status IN ('joined', 'active', 'completed')`,
        [raid.id, target]
    );
    if (!participant) throw new RaidServiceError('participant_not_found', 'Participante não encontrado.');
    const snapshot = participant.snapshot_json
        ? safeJsonParse(participant.snapshot_json, null)
        : await buildParticipantSnapshot(db, participant.player_id);
    const loadout = (await db.all(
        'SELECT * FROM clover_raid_loadout_items WHERE participant_id = ? ORDER BY slot_key ASC',
        [participant.id]
    )).map(serializeLoadoutItem);
    const itemEvents = await db.all(
        `SELECT * FROM clover_raid_item_events
         WHERE participant_id = ? ORDER BY created_at DESC, id DESC`,
        [participant.id]
    );
    const conditions = await db.all(
        `SELECT * FROM clover_raid_conditions
         WHERE raid_id = ?
           AND (target_type = 'general' OR participant_id = ?)
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id DESC`,
        [raid.id, participant.id]
    );
    return {
        raid: serializeRaid(raid),
        hostRole: host.ok ? host.role : null,
        access: {
            isHost: host.ok,
            isSelf,
        },
        participant: serializeParticipant(participant),
        profile: snapshot,
        loadout,
        itemEvents,
        conditions,
    };
}

async function listActorRaids(db, actorId, options = {}) {
    await ensureCloverRaidSchema(db);
    const actor = normalizeJid(actorId);
    const canReadAll = await hasAccessPermission(db, actor, 'raid.read.all');
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 30));
    const rows = canReadAll
        ? await db.all('SELECT * FROM clover_raids ORDER BY created_at DESC, id DESC LIMIT ?', [limit])
        : await db.all(
            `SELECT DISTINCT r.*
             FROM clover_raids r
             LEFT JOIN clover_raid_hosts h
               ON h.raid_id = r.id AND h.player_id = ? AND h.status = 'active'
             LEFT JOIN clover_raid_participants p
               ON p.raid_id = r.id AND p.player_id = ?
             WHERE h.id IS NOT NULL OR p.id IS NOT NULL
             ORDER BY r.created_at DESC, r.id DESC
             LIMIT ?`,
            [actor, actor, limit]
        );
    return rows.map(serializeRaid);
}

module.exports = {
    RAID_REWARD_LIMITS,
    RAID_SLOTS,
    RaidServiceError,
    addRaidHost,
    addRaidCondition,
    addRaidReward,
    applyRaidDurabilityLoss,
    beginRaidFinalization,
    cancelRaid,
    cancelRaidReward,
    completeRaid,
    consumeRaidItem,
    createRaid,
    getRaidDashboard,
    getRaidParticipantDetail,
    joinRaid,
    leaveRaid,
    listActorRaids,
    removeRaidParticipant,
    resolveRaidCondition,
    revokeRaidHost,
    serializeLoadoutItem,
    serializeParticipant,
    serializeRaid,
    setRaidLoadoutSlot,
    startRaid,
};
