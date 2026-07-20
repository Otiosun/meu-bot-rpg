'use strict';

const crypto = require('crypto');
const { isSameUser, normalizeJid } = require('../groupAccess');
const { getAccessContext } = require('./accessControlService');
const { normalizeSquadKey } = require('./cavalierService');
const base = require('./raidServiceBase');
const {
    CATEGORY_DEFINITIONS,
    configuredRaidMonthlyLimit,
    getRaidCategoryCatalog,
    raidMonthKey,
    resolveRaidCategory,
    serializeRaidCategory,
} = require('./raidCategoryCatalog');
const { ensureRaidV2Schema, tableColumns } = require('./raidV2Schema');

const { RaidServiceError } = base;
const ACTIVE_MONTHLY_STATUSES = Object.freeze([
    'lobby', 'in_progress', 'finalization', 'completed',
]);

async function requireNarrator(db, actorId) {
    const actor = normalizeJid(actorId);
    const context = await getAccessContext(db, actor);
    if (context.owner || context.roleKeys.includes('admin') || context.roleKeys.includes('narrator')) {
        return { actorId: actor, context };
    }
    throw new RaidServiceError(
        'narrator_required',
        'Apenas narradores podem criar ou assumir controle de raids.'
    );
}

async function resolveRaidScope(db, definition, input) {
    if (definition.scopeType === 'player') {
        const target = normalizeJid(
            input.scopePlayerId || input.scope_player_id
            || input.targetPlayerId || input.target_player_id
            || input.playerId || input.jogador
        );
        if (!target) {
            throw new RaidServiceError(
                'raid_scope_player_required',
                'Informe o jogador principal desta categoria.'
            );
        }
        const player = await db.get(
            `SELECT id, personagem_nome, jogo_status
             FROM jogadores WHERE id = ?`,
            [target]
        );
        if (!player) throw new RaidServiceError('player_not_found', 'Jogador principal não encontrado.');
        if (player.jogo_status && player.jogo_status !== 'liberado') {
            throw new RaidServiceError(
                'game_blocked',
                'O jogador principal precisa estar com o jogo liberado.'
            );
        }
        return {
            type: 'player',
            playerId: player.id,
            playerName: player.personagem_nome || null,
            squadKey: null,
        };
    }

    if (definition.scopeType === 'squad') {
        const raw = String(
            input.scopeSquadKey || input.scope_squad_key
            || input.squadKey || input.squad_key
            || input.esquadrao || ''
        ).trim();
        if (!raw) {
            throw new RaidServiceError(
                'raid_scope_squad_required',
                'Informe o esquadrão desta categoria.'
            );
        }
        const normalized = normalizeSquadKey(raw);
        const squad = await db.get(
            `SELECT squad_key, name FROM clover_squads
             WHERE squad_key = ? OR LOWER(name) = LOWER(?) LIMIT 1`,
            [normalized, raw]
        );
        if (!squad) throw new RaidServiceError('squad_not_found', 'Esquadrão não encontrado.');
        return {
            type: 'squad',
            playerId: null,
            squadKey: squad.squad_key,
            squadName: squad.name,
        };
    }

    return { type: 'global', playerId: null, squadKey: null };
}

function scopeFilter(scope) {
    if (scope.type === 'player') return { sql: 'scope_player_id = ?', params: [scope.playerId] };
    if (scope.type === 'squad') return { sql: 'scope_squad_key = ?', params: [scope.squadKey] };
    return { sql: 'scope_type = ?', params: ['global'] };
}

async function readMonthlyUsage(db, definition, scope, monthKey, excludeRaidId = null) {
    const limit = configuredRaidMonthlyLimit(definition);
    if (!definition.countsMonthly || !limit) {
        return {
            countsMonthly: false,
            monthKey,
            limit: null,
            used: 0,
            remaining: null,
            exhausted: false,
        };
    }
    const filter = scopeFilter(scope);
    const row = await db.get(
        `SELECT COUNT(*) AS total FROM clover_raids
         WHERE counts_monthly = 1
           AND category_key = ? AND month_key = ?
           AND ${filter.sql}
           AND status IN (${ACTIVE_MONTHLY_STATUSES.map(() => '?').join(', ')})
           ${excludeRaidId ? 'AND id <> ?' : ''}`,
        [
            definition.key,
            monthKey,
            ...filter.params,
            ...ACTIVE_MONTHLY_STATUSES,
            ...(excludeRaidId ? [excludeRaidId] : []),
        ]
    );
    const used = Number(row?.total || 0);
    return {
        countsMonthly: true,
        monthKey,
        limit,
        used,
        remaining: Math.max(0, limit - used),
        exhausted: used >= limit,
    };
}

function createRaidKey() {
    return `RAID-${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

async function getRaidV2Row(db, raidInput) {
    await ensureRaidV2Schema(db);
    if (raidInput?.id) return db.get('SELECT * FROM clover_raids WHERE id = ?', [raidInput.id]);
    const key = String(raidInput?.key || raidInput?.raid_key || raidInput || '').trim();
    return db.get(
        `SELECT * FROM clover_raids
         WHERE raid_key = ? OR CAST(id AS TEXT) = ?`,
        [key.toUpperCase(), key]
    );
}

async function serializeRaidV2(db, row) {
    if (!row) return null;
    let definition;
    try {
        definition = resolveRaidCategory(row.category_key || row.category);
    } catch {
        definition = CATEGORY_DEFINITIONS[1];
    }
    const scope = {
        type: row.scope_type || definition.scopeType,
        playerId: row.scope_player_id || null,
        squadKey: row.scope_squad_key || null,
    };
    const monthlyUsage = await readMonthlyUsage(
        db,
        definition,
        scope,
        row.month_key || raidMonthKey(row.created_at)
    );
    return {
        ...base.serializeRaid(row),
        category: definition.key,
        categoryLabel: row.category_label || definition.label,
        categoryPolicy: serializeRaidCategory(definition),
        scope,
        monthlyUsage,
    };
}

async function createRaid(db, actorId, input = {}) {
    await ensureRaidV2Schema(db);
    const narrator = await requireNarrator(db, actorId);
    const definition = resolveRaidCategory(input.category || input.categoria);
    const scope = await resolveRaidScope(db, definition, input);
    const monthKey = raidMonthKey(input.referenceDate || input.reference_date || new Date());
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
        const usage = await readMonthlyUsage(db, definition, scope, monthKey);
        if (usage.exhausted) {
            throw new RaidServiceError(
                'raid_monthly_limit_reached',
                `${definition.label}: o limite mensal já foi atingido.`,
                { category: serializeRaidCategory(definition), scope, usage }
            );
        }

        let raidKey;
        do {
            raidKey = createRaidKey();
        } while (await db.get('SELECT id FROM clover_raids WHERE raid_key = ?', [raidKey]));

        const columns = await tableColumns(db, 'clover_raids');
        const hasLegacyCode = columns.has('code');
        const metadata = {
            ...(input.metadata || {}),
            raidV2: {
                category: definition.key,
                scope,
                monthKey,
                monthlyLimit: configuredRaidMonthlyLimit(definition),
            },
        };
        const names = [
            'raid_key', ...(hasLegacyCode ? ['code'] : []),
            'name', 'category', 'category_key', 'category_label',
            'description', 'location', 'status', 'owner_player_id', 'max_players',
            'salary_eligible', 'rules_json', 'metadata_json',
            'scope_type', 'scope_player_id', 'scope_squad_key',
            'month_key', 'counts_monthly', 'monthly_limit',
            'created_at', 'updated_at',
        ];
        const values = [
            raidKey, ...(hasLegacyCode ? [raidKey] : []),
            name, definition.key, definition.key, definition.label,
            description, location, 'lobby', narrator.actorId, maxPlayers,
            input.salaryEligible === false || input.salary_eligible === false ? 0 : 1,
            JSON.stringify(input.rules || input.regras || {}),
            JSON.stringify(metadata),
            scope.type, scope.playerId, scope.squadKey,
            monthKey, definition.countsMonthly ? 1 : 0,
            configuredRaidMonthlyLimit(definition),
        ];
        const placeholders = names.map((field) => (
            ['created_at', 'updated_at'].includes(field) ? 'CURRENT_TIMESTAMP' : '?'
        ));
        const inserted = await db.run(
            `INSERT INTO clover_raids (${names.join(', ')})
             VALUES (${placeholders.join(', ')})`,
            values
        );
        await db.run(
            `INSERT INTO clover_raid_hosts
             (raid_id, player_id, role, status, assigned_by, created_at, metadata_json)
             VALUES (?, ?, 'owner', 'active', ?, CURRENT_TIMESTAMP, ?)`,
            [inserted.lastID, narrator.actorId, narrator.actorId, JSON.stringify({ category: definition.key, scope })]
        );
        await db.run(
            `INSERT INTO clover_raid_events
             (raid_id, action, actor_id, after_json, created_at, metadata_json)
             VALUES (?, 'raid_created', ?, ?, CURRENT_TIMESTAMP, ?)`,
            [
                inserted.lastID,
                narrator.actorId,
                JSON.stringify({ raidKey, category: definition.key, scope }),
                JSON.stringify({ monthKey, monthlyLimit: configuredRaidMonthlyLimit(definition) }),
            ]
        );
        const row = await db.get('SELECT * FROM clover_raids WHERE id = ?', [inserted.lastID]);
        await db.exec('COMMIT');
        return {
            ok: true,
            raid: await serializeRaidV2(db, row),
            role: 'owner',
            principal: true,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function enrichRaidResult(db, result) {
    if (!result?.raid) return result;
    const row = await getRaidV2Row(db, result.raid);
    return { ...result, raid: await serializeRaidV2(db, row) };
}

async function listActorRaids(db, actorId, options = {}) {
    await ensureRaidV2Schema(db);
    const raids = await base.listActorRaids(db, actorId, options);
    return Promise.all(raids.map(async (raid) => {
        const row = await getRaidV2Row(db, raid);
        return serializeRaidV2(db, row);
    }));
}

async function getRaidDashboard(db, raidKey, actorId) {
    await ensureRaidV2Schema(db);
    const dashboard = await base.getRaidDashboard(db, raidKey, actorId);
    const row = await getRaidV2Row(db, dashboard.raid);
    const actor = normalizeJid(actorId);
    return {
        ...dashboard,
        raid: await serializeRaidV2(db, row),
        categories: getRaidCategoryCatalog(),
        participants: dashboard.participants.map((participant) => ({
            ...participant,
            access: {
                canInspect: Boolean(dashboard.access.isHost || isSameUser(actor, participant.playerId)),
                isSelf: isSameUser(actor, participant.playerId),
            },
        })),
    };
}

function buildParticipantSections(detail) {
    const profile = detail.profile || {};
    return {
        overview: {
            player: profile.player || null,
            stats: profile.stats || profile.capacity?.stats || null,
            hexagon: profile.hexagon || profile.capacity?.hexagon || null,
            bonus: profile.bonus || null,
        },
        capabilities: profile.capacity || profile.capacidade || null,
        spells: Array.isArray(profile.spells) ? profile.spells : [],
        equipment: detail.loadout || [],
        conditions: detail.conditions || [],
        history: detail.itemEvents || [],
    };
}

async function getRaidParticipantDetail(db, raidKey, actorId, targetPlayerId) {
    await ensureRaidV2Schema(db);
    const detail = await base.getRaidParticipantDetail(db, raidKey, actorId, targetPlayerId);
    const row = await getRaidV2Row(db, detail.raid);
    return {
        ...detail,
        raid: await serializeRaidV2(db, row),
        sections: buildParticipantSections(detail),
    };
}

async function cancelRaid(db, raidKey, actorId, reason) {
    return enrichRaidResult(db, await base.cancelRaid(db, raidKey, actorId, reason));
}
async function startRaid(db, raidKey, actorId) {
    return enrichRaidResult(db, await base.startRaid(db, raidKey, actorId));
}
async function beginRaidFinalization(db, raidKey, actorId) {
    return enrichRaidResult(db, await base.beginRaidFinalization(db, raidKey, actorId));
}
async function completeRaid(db, raidKey, actorId, options = {}) {
    return enrichRaidResult(db, await base.completeRaid(db, raidKey, actorId, options));
}

module.exports = {
    ...base,
    ACTIVE_MONTHLY_STATUSES,
    CATEGORY_DEFINITIONS,
    beginRaidFinalization,
    buildParticipantSections,
    cancelRaid,
    completeRaid,
    createRaid,
    ensureRaidV2Schema,
    getRaidCategoryCatalog,
    getRaidDashboard,
    getRaidParticipantDetail,
    listActorRaids,
    raidMonthKey,
    readMonthlyUsage,
    resolveRaidCategory,
    serializeRaidV2,
    startRaid,
};
