'use strict';

const crypto = require('crypto');
const { ensureCloverRecruitmentSchema } = require('../../database');
const { getMondayWeekKey } = require('./prService');

const ACTIVE_CYCLE_STATUSES = ['draft', 'confirming', 'active'];
const ACTIVE_MEMBER_STATUSES = ['pending', 'confirmed', 'active', 'absence_requested', 'protected_absence'];
const EMPTY_SQUAD_VALUES = new Set([
    '',
    '-',
    'nenhum',
    'nenhuma',
    'sem esquadrao',
    'sem esquadrão',
    'sem squad',
    'novato',
    'novatos',
]);

class PerformanceTeamServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PerformanceTeamServiceError';
        this.code = code;
        this.details = details;
    }
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function displayName(player = {}) {
    const value = String(player.personagem_nome || player.display_name || player.nome || '').trim();
    return value && value !== '-' ? value : 'Personagem';
}

function isReleased(player = {}) {
    return normalizeText(player.jogo_status) === 'liberado';
}

function isApprovedSheet(player = {}) {
    const status = normalizeText(player.ficha_status);
    return !status || ['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(status);
}

function hasNoOfficialSquad(player = {}) {
    return EMPTY_SQUAD_VALUES.has(normalizeText(player.esquadrao));
}

function assertNovicePlayer(player, details = {}) {
    if (!player) {
        throw new PerformanceTeamServiceError('player_not_found', 'Player não encontrado.', details);
    }
    if (!isReleased(player) || !isApprovedSheet(player)) {
        throw new PerformanceTeamServiceError(
            'player_not_released',
            'Times de Performance são apenas para personagens com ficha e jogo liberados.',
            { playerId: player.id, ...details }
        );
    }
    if (!hasNoOfficialSquad(player)) {
        throw new PerformanceTeamServiceError(
            'player_not_novice',
            'Times de Performance são apenas para novatos sem esquadrão.',
            { playerId: player.id, squad: player.esquadrao || '-', ...details }
        );
    }
}

function toSqlList(values) {
    return values.map(() => '?').join(', ');
}

function makeCycleKey(name = '') {
    const base = normalizeText(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ciclo';
    const suffix = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `${base}-${suffix}`;
}

function currentWeekKey(date = new Date()) {
    return getMondayWeekKey(date);
}

function nextWeekKey(weekKey) {
    const start = new Date(`${weekKey}T00:00:00`);
    start.setDate(start.getDate() + 7);
    return getMondayWeekKey(start);
}

function makeTeamKey(cycleKey) {
    return `${cycleKey}-time-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function shuffleRows(rows) {
    const copy = rows.slice();
    for (let index = copy.length - 1; index > 0; index -= 1) {
        const swapIndex = crypto.randomInt(index + 1);
        [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy;
}

async function ensurePerformanceTeamsSchema(db) {
    await ensureCloverRecruitmentSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_performance_cycles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cycle_key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'confirming', 'active', 'ended', 'cancelled')),
            starts_at TEXT DEFAULT NULL,
            ends_at TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS clover_performance_signups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cycle_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'joined'
                CHECK (status IN ('joined', 'withdrawn', 'selected', 'confirmed', 'reserve', 'rejected')),
            availability_text TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (cycle_id, player_id),
            FOREIGN KEY (cycle_id) REFERENCES clover_performance_cycles(id)
        );

        CREATE TABLE IF NOT EXISTS clover_performance_teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cycle_id INTEGER NOT NULL,
            team_key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'confirming', 'active', 'ended', 'cancelled')),
            representative_player_id TEXT DEFAULT NULL,
            monitor_player_id TEXT DEFAULT NULL,
            prestige INTEGER NOT NULL DEFAULT 0 CHECK (prestige >= 0),
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            FOREIGN KEY (cycle_id) REFERENCES clover_performance_cycles(id)
        );

        CREATE TABLE IF NOT EXISTS clover_performance_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team_id INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('representative', 'member')),
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'confirmed', 'active', 'absence_requested', 'protected_absence', 'removed', 'transferred')),
            joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
            confirmed_at TEXT DEFAULT NULL,
            left_at TEXT DEFAULT NULL,
            absence_used INTEGER NOT NULL DEFAULT 0 CHECK (absence_used IN (0, 1)),
            sort_order INTEGER NOT NULL DEFAULT 0,
            metadata_json TEXT DEFAULT NULL,
            FOREIGN KEY (team_id) REFERENCES clover_performance_teams(id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_performance_member_once
        ON clover_performance_members (player_id)
        WHERE status IN ('pending', 'confirmed', 'active', 'protected_absence');

        CREATE INDEX IF NOT EXISTS idx_clover_performance_members_team
        ON clover_performance_members (team_id, status, sort_order);

        CREATE TABLE IF NOT EXISTS clover_performance_recruit_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team_id INTEGER NOT NULL,
            week_key TEXT NOT NULL,
            actor_player_id TEXT NOT NULL,
            recruit_player_id TEXT NOT NULL,
            action_type TEXT NOT NULL
                CHECK (action_type IN ('welcomed', 'reported', 'validated', 'invalidated')),
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'cancelled')),
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            FOREIGN KEY (team_id) REFERENCES clover_performance_teams(id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_performance_recruit_action_once
        ON clover_performance_recruit_actions (team_id, week_key, actor_player_id, recruit_player_id, action_type)
        WHERE status = 'active';

        CREATE TABLE IF NOT EXISTS clover_performance_week_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team_id INTEGER NOT NULL,
            week_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'preview'
                CHECK (status IN ('preview', 'approved', 'applied', 'cancelled')),
            completed_members INTEGER NOT NULL DEFAULT 0 CHECK (completed_members >= 0),
            eligible_members INTEGER NOT NULL DEFAULT 0 CHECK (eligible_members >= 0),
            validated_recruits INTEGER NOT NULL DEFAULT 0 CHECK (validated_recruits >= 0),
            rewards_json TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (team_id, week_key)
        );
    `);
}

async function getPlayer(db, playerId) {
    return db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
}

async function getOpenCycle(db) {
    await ensurePerformanceTeamsSchema(db);
    return db.get(
        `SELECT * FROM clover_performance_cycles
         WHERE status IN (${toSqlList(ACTIVE_CYCLE_STATUSES)})
         ORDER BY id DESC
         LIMIT 1`,
        ACTIVE_CYCLE_STATUSES
    );
}

async function createCycle(db, { name, actorId }) {
    await ensurePerformanceTeamsSchema(db);
    const label = String(name || '').trim();
    if (!label) {
        throw new PerformanceTeamServiceError('missing_cycle_name', 'Informe o nome do ciclo.');
    }
    const open = await getOpenCycle(db);
    if (open) {
        throw new PerformanceTeamServiceError('cycle_already_open', 'Já existe um ciclo aberto.', { cycleId: open.id });
    }
    const cycleKey = makeCycleKey(label);
    const inserted = await db.run(
        `INSERT INTO clover_performance_cycles (cycle_key, name, status, created_by)
         VALUES (?, ?, 'draft', ?)`,
        [cycleKey, label, actorId || null]
    );
    return db.get('SELECT * FROM clover_performance_cycles WHERE id = ?', [inserted.lastID]);
}

async function getActiveMembership(db, playerId) {
    await ensurePerformanceTeamsSchema(db);
    return db.get(
        `SELECT m.*, t.name AS team_name, t.status AS team_status, t.monitor_player_id,
                c.name AS cycle_name, c.status AS cycle_status
         FROM clover_performance_members m
         JOIN clover_performance_teams t ON t.id = m.team_id
         JOIN clover_performance_cycles c ON c.id = t.cycle_id
         WHERE m.player_id = ?
           AND m.status IN (${toSqlList(ACTIVE_MEMBER_STATUSES)})
           AND t.status IN ('draft', 'confirming', 'active')
           AND c.status IN ('draft', 'confirming', 'active')
         ORDER BY m.id DESC
         LIMIT 1`,
        [playerId, ...ACTIVE_MEMBER_STATUSES]
    );
}

async function isPerformanceMonitor(db, playerId) {
    await ensurePerformanceTeamsSchema(db);
    const row = await db.get(
        `SELECT 1 AS found
         FROM clover_performance_teams t
         JOIN clover_performance_cycles c ON c.id = t.cycle_id
         WHERE t.monitor_player_id = ?
           AND t.status IN ('draft', 'confirming', 'active')
           AND c.status IN ('draft', 'confirming', 'active')
         LIMIT 1`,
        [playerId]
    );
    return Boolean(row);
}

async function joinCycle(db, playerId, availabilityText = '') {
    await ensurePerformanceTeamsSchema(db);
    const cycle = await getOpenCycle(db);
    if (!cycle) {
        throw new PerformanceTeamServiceError('cycle_not_open', 'Nenhum ciclo de Times de Performance está aberto.');
    }
    const player = await getPlayer(db, playerId);
    assertNovicePlayer(player);
    const membership = await getActiveMembership(db, playerId);
    if (membership) {
        throw new PerformanceTeamServiceError('already_in_team', 'Você já está em um Time de Performance ativo.');
    }
    await db.run(
        `INSERT INTO clover_performance_signups (cycle_id, player_id, status, availability_text, updated_at)
         VALUES (?, ?, 'joined', ?, CURRENT_TIMESTAMP)
         ON CONFLICT(cycle_id, player_id) DO UPDATE SET
             status = CASE
                 WHEN clover_performance_signups.status = 'withdrawn' THEN 'joined'
                 ELSE clover_performance_signups.status
             END,
             availability_text = excluded.availability_text,
             updated_at = CURRENT_TIMESTAMP`,
        [cycle.id, playerId, String(availabilityText || '').trim() || null]
    );
    const signup = await db.get(
        'SELECT * FROM clover_performance_signups WHERE cycle_id = ? AND player_id = ?',
        [cycle.id, playerId]
    );
    return { cycle, player, signup, duplicate: signup.status !== 'joined' };
}

async function listEligiblePlayers(db) {
    await ensurePerformanceTeamsSchema(db);
    const rows = await db.all(
        `SELECT j.*
         FROM jogadores j
         WHERE LOWER(COALESCE(j.jogo_status, '')) = 'liberado'
         ORDER BY COALESCE(j.personagem_nome, j.display_name, j.nome, j.id) COLLATE NOCASE ASC`
    );
    const eligible = [];
    for (const player of rows) {
        if (!isApprovedSheet(player) || !hasNoOfficialSquad(player)) continue;
        const membership = await getActiveMembership(db, player.id);
        if (!membership) eligible.push(player);
    }
    return eligible;
}

async function createManualTeam(db, { name, actorId }) {
    await ensurePerformanceTeamsSchema(db);
    const cycle = await getOpenCycle(db);
    if (!cycle) throw new PerformanceTeamServiceError('cycle_not_open', 'Crie um ciclo antes do time.');
    const teamName = String(name || '').trim();
    if (!teamName) throw new PerformanceTeamServiceError('missing_team_name', 'Informe o nome do time.');
    const inserted = await db.run(
        `INSERT INTO clover_performance_teams (cycle_id, team_key, name, status, created_by)
         VALUES (?, ?, ?, 'draft', ?)`,
        [cycle.id, makeTeamKey(cycle.cycle_key), teamName, actorId || null]
    );
    return db.get('SELECT * FROM clover_performance_teams WHERE id = ?', [inserted.lastID]);
}

async function getTeamByNameOrId(db, input) {
    await ensurePerformanceTeamsSchema(db);
    const value = String(input || '').trim();
    if (!value) {
        const membership = null;
        return membership;
    }
    if (/^\d+$/.test(value)) {
        const byId = await db.get('SELECT * FROM clover_performance_teams WHERE id = ?', [Number(value)]);
        if (byId) return byId;
    }
    return db.get(
        `SELECT * FROM clover_performance_teams
         WHERE LOWER(name) = LOWER(?) OR LOWER(team_key) = LOWER(?)
         ORDER BY id DESC LIMIT 1`,
        [value, value]
    );
}

async function addMemberToTeam(db, { teamId, playerId, role = 'member', actorId }) {
    await ensurePerformanceTeamsSchema(db);
    const team = await db.get('SELECT * FROM clover_performance_teams WHERE id = ?', [teamId]);
    if (!team) throw new PerformanceTeamServiceError('team_not_found', 'Time não encontrado.');
    const player = await getPlayer(db, playerId);
    assertNovicePlayer(player);
    const existing = await getActiveMembership(db, playerId);
    if (existing) {
        throw new PerformanceTeamServiceError('already_in_team', 'Esse player já está em um Time de Performance ativo.');
    }
    const count = await db.get(
        `SELECT COUNT(*) AS total FROM clover_performance_members
         WHERE team_id = ? AND status IN (${toSqlList(ACTIVE_MEMBER_STATUSES)})`,
        [teamId, ...ACTIVE_MEMBER_STATUSES]
    );
    if (Number(count?.total || 0) >= 4) {
        throw new PerformanceTeamServiceError('team_full', 'Esse Time de Performance já tem 4 vagas preenchidas.');
    }
    const normalizedRole = role === 'representative' ? 'representative' : 'member';
    const inserted = await db.run(
        `INSERT INTO clover_performance_members
         (team_id, player_id, role, status, sort_order, metadata_json)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
        [
            teamId,
            playerId,
            normalizedRole,
            Number(count?.total || 0) + 1,
            JSON.stringify({ added_by: actorId || null }),
        ]
    );
    if (normalizedRole === 'representative') {
        await db.run(
            `UPDATE clover_performance_teams
             SET representative_player_id = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [playerId, teamId]
        );
    }
    return db.get('SELECT * FROM clover_performance_members WHERE id = ?', [inserted.lastID]);
}

async function generateTeamsFromSignups(db, { actorId } = {}) {
    await ensurePerformanceTeamsSchema(db);
    const cycle = await getOpenCycle(db);
    if (!cycle) throw new PerformanceTeamServiceError('cycle_not_open', 'Nenhum ciclo aberto.');
    const existingTeams = await db.get(
        'SELECT COUNT(*) AS total FROM clover_performance_teams WHERE cycle_id = ?',
        [cycle.id]
    );
    if (Number(existingTeams?.total || 0) > 0) {
        throw new PerformanceTeamServiceError('teams_already_created', 'Esse ciclo já possui times.');
    }
    const signups = await db.all(
        `SELECT s.*, j.personagem_nome, j.display_name, j.nome, j.esquadrao, j.ficha_status, j.jogo_status
         FROM clover_performance_signups s
         JOIN jogadores j ON j.id = s.player_id
         WHERE s.cycle_id = ? AND s.status = 'joined'
         ORDER BY s.updated_at ASC, s.id ASC`,
        [cycle.id]
    );
    const validSignups = [];
    const skipped = [];
    for (const signup of signups) {
        try {
            assertNovicePlayer({ ...signup, id: signup.player_id });
            validSignups.push(signup);
        } catch (error) {
            skipped.push({ playerId: signup.player_id, reason: error.code || 'invalid' });
        }
    }
    const drawnSignups = shuffleRows(validSignups);
    const teams = [];
    const completeSignupCount = Math.floor(drawnSignups.length / 4) * 4;
    const reserves = drawnSignups.slice(completeSignupCount);
    await db.exec('BEGIN IMMEDIATE');
    try {
        for (const signup of reserves) {
            await db.run(
                `UPDATE clover_performance_signups
                 SET status = 'reserve', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [signup.id]
            );
        }
        for (let index = 0; index < completeSignupCount; index += 4) {
            const group = drawnSignups.slice(index, index + 4);
            if (!group.length) continue;
            const teamName = `Time ${teams.length + 1}`;
            const inserted = await db.run(
                `INSERT INTO clover_performance_teams (cycle_id, team_key, name, status, created_by)
                 VALUES (?, ?, ?, 'draft', ?)`,
                [cycle.id, makeTeamKey(cycle.cycle_key), teamName, actorId || null]
            );
            const team = await db.get('SELECT * FROM clover_performance_teams WHERE id = ?', [inserted.lastID]);
            for (let memberIndex = 0; memberIndex < group.length; memberIndex += 1) {
                const signup = group[memberIndex];
                const role = memberIndex === 0 ? 'representative' : 'member';
                await db.run(
                    `INSERT INTO clover_performance_members
                     (team_id, player_id, role, status, sort_order, metadata_json)
                     VALUES (?, ?, ?, 'pending', ?, ?)`,
                    [
                        team.id,
                        signup.player_id,
                        role,
                        memberIndex + 1,
                        JSON.stringify({ added_by: actorId || null, source: 'draw' }),
                    ]
                );
                if (role === 'representative') {
                    await db.run(
                        `UPDATE clover_performance_teams
                         SET representative_player_id = ?, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?`,
                        [signup.player_id, team.id]
                    );
                    team.representative_player_id = signup.player_id;
                }
                await db.run(
                    `UPDATE clover_performance_signups
                     SET status = 'selected', updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [signup.id]
                );
            }
            teams.push(team);
        }
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
    return { cycle, teams, skipped, reserves };
}

async function publishDraw(db, { actorId } = {}) {
    await ensurePerformanceTeamsSchema(db);
    const cycle = await getOpenCycle(db);
    if (!cycle) throw new PerformanceTeamServiceError('cycle_not_open', 'Nenhum ciclo aberto.');
    await db.run(
        `UPDATE clover_performance_cycles
         SET status = 'confirming', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [cycle.id]
    );
    await db.run(
        `UPDATE clover_performance_teams
         SET status = 'confirming', updated_at = CURRENT_TIMESTAMP,
             metadata_json = COALESCE(metadata_json, ?)
         WHERE cycle_id = ? AND status = 'draft'`,
        [JSON.stringify({ published_by: actorId || null }), cycle.id]
    );
    return getCycleSummary(db, cycle.id);
}

async function confirmMembership(db, playerId) {
    await ensurePerformanceTeamsSchema(db);
    const membership = await getActiveMembership(db, playerId);
    if (!membership) {
        throw new PerformanceTeamServiceError('membership_not_found', 'Você não tem vaga pendente em Time de Performance.');
    }
    await db.run(
        `UPDATE clover_performance_members
         SET status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END,
             confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP)
         WHERE id = ?`,
        [membership.id]
    );
    await db.run(
        `UPDATE clover_performance_signups
         SET status = 'confirmed', updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ? AND cycle_id = (
             SELECT cycle_id FROM clover_performance_teams WHERE id = ?
         )`,
        [playerId, membership.team_id]
    );
    return getMyTeam(db, playerId);
}

async function getTeamMembers(db, teamId) {
    return db.all(
        `SELECT m.*, j.personagem_nome, j.display_name, j.nome
         FROM clover_performance_members m
         LEFT JOIN jogadores j ON j.id = m.player_id
         WHERE m.team_id = ?
         ORDER BY m.sort_order ASC, m.id ASC`,
        [teamId]
    );
}

async function getCycleSummary(db, cycleId = null) {
    await ensurePerformanceTeamsSchema(db);
    const cycle = cycleId
        ? await db.get('SELECT * FROM clover_performance_cycles WHERE id = ?', [cycleId])
        : await getOpenCycle(db);
    if (!cycle) return { cycle: null, teams: [], signups: [] };
    const teams = await db.all(
        `SELECT t.*, jm.personagem_nome AS monitor_character_name, jm.display_name AS monitor_display_name,
                jm.nome AS monitor_name
         FROM clover_performance_teams t
         LEFT JOIN jogadores jm ON jm.id = t.monitor_player_id
         WHERE t.cycle_id = ?
         ORDER BY t.id ASC`,
        [cycle.id]
    );
    for (const team of teams) {
        team.members = await getTeamMembers(db, team.id);
        team.progress = await getRecruitmentProgress(db, team.id);
    }
    const signups = await db.all(
        `SELECT s.*, j.personagem_nome, j.display_name, j.nome
         FROM clover_performance_signups s
         LEFT JOIN jogadores j ON j.id = s.player_id
         WHERE s.cycle_id = ?
         ORDER BY s.id ASC`,
        [cycle.id]
    );
    return { cycle, teams, signups };
}

async function getMyTeam(db, playerId) {
    await ensurePerformanceTeamsSchema(db);
    const membership = await getActiveMembership(db, playerId);
    if (!membership) return { membership: null, team: null, members: [], progress: null };
    const team = await db.get('SELECT * FROM clover_performance_teams WHERE id = ?', [membership.team_id]);
    const members = await getTeamMembers(db, membership.team_id);
    const progress = await getRecruitmentProgress(db, membership.team_id);
    return { membership, team, members, progress };
}

async function getRecruitmentProgress(db, teamId, options = {}) {
    await ensurePerformanceTeamsSchema(db);
    const weekKey = options.weekKey || currentWeekKey(options.at || new Date());
    const endWeekKey = nextWeekKey(weekKey);
    const members = await getTeamMembers(db, teamId);
    const activePlayerIds = members
        .filter((member) => ACTIVE_MEMBER_STATUSES.includes(member.status) && member.status !== 'protected_absence')
        .map((member) => member.player_id);
    if (!activePlayerIds.length) {
        return {
            weekKey,
            activeMembers: 0,
            validatedRecruits: 0,
            systemValidatedRecruits: 0,
            manualValidatedRecruits: 0,
            invalidatedRecruits: 0,
            welcomed: 0,
            target: 2,
        };
    }
    const placeholders = toSqlList(activePlayerIds);
    const referralRows = await db.all(
        `SELECT recruit_player_id
         FROM clover_recruitment_referrals
         WHERE recruiter_player_id IN (${placeholders})
           AND status IN ('validated', 'rewarded')
           AND date(COALESCE(validated_at, rewarded_at, submitted_at)) >= date(?)
           AND date(COALESCE(validated_at, rewarded_at, submitted_at)) < date(?)`,
        [...activePlayerIds, weekKey, endWeekKey]
    );
    const actionRows = await db.all(
        `SELECT recruit_player_id, action_type
         FROM clover_performance_recruit_actions
         WHERE team_id = ? AND week_key = ? AND status = 'active'
           AND action_type IN ('welcomed', 'validated', 'invalidated')`,
        [teamId, weekKey]
    );
    const systemValidated = new Set(referralRows.map((row) => row.recruit_player_id));
    const manualValidated = new Set();
    const invalidated = new Set();
    const welcomed = new Set();
    for (const row of actionRows) {
        if (row.action_type === 'validated') manualValidated.add(row.recruit_player_id);
        if (row.action_type === 'invalidated') invalidated.add(row.recruit_player_id);
        if (row.action_type === 'welcomed') welcomed.add(row.recruit_player_id);
    }
    const validated = new Set([...systemValidated, ...manualValidated]);
    for (const playerId of invalidated) validated.delete(playerId);
    return {
        weekKey,
        activeMembers: activePlayerIds.length,
        validatedRecruits: validated.size,
        systemValidatedRecruits: systemValidated.size,
        manualValidatedRecruits: manualValidated.size,
        invalidatedRecruits: invalidated.size,
        welcomed: welcomed.size,
        target: 2,
    };
}

async function getTeamHistory(db, teamId, limit = 8) {
    await ensurePerformanceTeamsSchema(db);
    return db.all(
        `SELECT *
         FROM clover_performance_week_results
         WHERE team_id = ?
         ORDER BY week_key DESC, id DESC
         LIMIT ?`,
        [teamId, Math.max(1, Math.min(20, Number(limit) || 8))]
    );
}

async function getMonitoredTeam(db, playerId) {
    await ensurePerformanceTeamsSchema(db);
    return db.get(
        `SELECT t.*
         FROM clover_performance_teams t
         JOIN clover_performance_cycles c ON c.id = t.cycle_id
         WHERE t.monitor_player_id = ?
           AND t.status IN ('draft', 'confirming', 'active')
           AND c.status IN ('draft', 'confirming', 'active')
         ORDER BY t.id DESC
         LIMIT 1`,
        [playerId]
    );
}

async function recordRecruitAction(db, { actorId, recruitPlayerId, actionType = 'welcomed', createdBy, teamId = null }) {
    await ensurePerformanceTeamsSchema(db);
    const membership = teamId ? null : await getActiveMembership(db, actorId);
    const monitoredTeam = teamId || membership ? null : await getMonitoredTeam(db, actorId);
    const resolvedTeamId = teamId || membership?.team_id || monitoredTeam?.id || null;
    if (!resolvedTeamId) {
        throw new PerformanceTeamServiceError('membership_not_found', 'Você precisa estar em um Time de Performance.');
    }
    const recruit = await getPlayer(db, recruitPlayerId);
    if (!recruit) throw new PerformanceTeamServiceError('recruit_not_found', 'Recruta não encontrado.');
    const weekKey = currentWeekKey();
    await db.run(
        `INSERT OR IGNORE INTO clover_performance_recruit_actions
         (team_id, week_key, actor_player_id, recruit_player_id, action_type, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [resolvedTeamId, weekKey, actorId, recruitPlayerId, actionType, createdBy || actorId]
    );
    return getRecruitmentProgress(db, resolvedTeamId, { weekKey });
}

async function requestProtectedAbsence(db, { playerId, reason }) {
    await ensurePerformanceTeamsSchema(db);
    const membership = await getActiveMembership(db, playerId);
    if (!membership) {
        throw new PerformanceTeamServiceError('membership_not_found', 'Você não está em um Time de Performance ativo.');
    }
    if (Number(membership.absence_used || 0) >= 1) {
        throw new PerformanceTeamServiceError('absence_already_used', 'Você já usou sua ausência protegida neste ciclo.');
    }
    await db.run(
        `UPDATE clover_performance_members
         SET status = 'absence_requested',
             metadata_json = ?
         WHERE id = ?`,
        [JSON.stringify({ reason: String(reason || '').trim() || 'Sem motivo informado.' }), membership.id]
    );
    return getMyTeam(db, playerId);
}

async function approveProtectedAbsence(db, { playerId, actorId }) {
    await ensurePerformanceTeamsSchema(db);
    const membership = await getActiveMembership(db, playerId);
    if (!membership) {
        throw new PerformanceTeamServiceError('membership_not_found', 'Esse player não está em um Time de Performance ativo.');
    }
    if (Number(membership.absence_used || 0) >= 1) {
        throw new PerformanceTeamServiceError('absence_already_used', 'Esse player já usou a ausência protegida neste ciclo.');
    }
    let metadata = {};
    try {
        metadata = JSON.parse(membership.metadata_json || '{}') || {};
    } catch {
        metadata = {};
    }
    metadata.approved_by = actorId || null;
    await db.run(
        `UPDATE clover_performance_members
         SET status = 'protected_absence',
             absence_used = 1,
             left_at = CURRENT_TIMESTAMP,
             metadata_json = ?
         WHERE id = ?`,
        [JSON.stringify(metadata), membership.id]
    );
    return getMyTeam(db, playerId);
}

async function setTeamMonitor(db, { teamId, monitorPlayerId }) {
    await ensurePerformanceTeamsSchema(db);
    await db.run(
        `UPDATE clover_performance_teams
         SET monitor_player_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [monitorPlayerId, teamId]
    );
    return db.get('SELECT * FROM clover_performance_teams WHERE id = ?', [teamId]);
}

async function setRepresentative(db, { teamId, playerId }) {
    await ensurePerformanceTeamsSchema(db);
    const member = await db.get(
        `SELECT * FROM clover_performance_members
         WHERE team_id = ? AND player_id = ? AND status IN (${toSqlList(ACTIVE_MEMBER_STATUSES)})`,
        [teamId, playerId, ...ACTIVE_MEMBER_STATUSES]
    );
    if (!member) throw new PerformanceTeamServiceError('membership_not_found', 'Esse player não está nesse time.');
    await db.run(
        `UPDATE clover_performance_members SET role = 'member' WHERE team_id = ?`,
        [teamId]
    );
    await db.run(
        `UPDATE clover_performance_members SET role = 'representative' WHERE id = ?`,
        [member.id]
    );
    await db.run(
        `UPDATE clover_performance_teams
         SET representative_player_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [playerId, teamId]
    );
    return getCycleSummary(db);
}

async function removeMember(db, { playerId, reason, status = 'removed' }) {
    await ensurePerformanceTeamsSchema(db);
    const membership = await getActiveMembership(db, playerId);
    if (!membership) throw new PerformanceTeamServiceError('membership_not_found', 'Esse player não está em time ativo.');
    await db.run(
        `UPDATE clover_performance_members
         SET status = ?, left_at = CURRENT_TIMESTAMP,
             metadata_json = ?
         WHERE id = ?`,
        [status, JSON.stringify({ reason: String(reason || '').trim() || null }), membership.id]
    );
    if (membership.role === 'representative') {
        await db.run(
            `UPDATE clover_performance_teams
             SET representative_player_id = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND representative_player_id = ?`,
            [membership.team_id, playerId]
        );
    }
    return membership;
}

async function closeWeekPreview(db, { teamId, actorId, weekKey = currentWeekKey() }) {
    await ensurePerformanceTeamsSchema(db);
    const members = await getTeamMembers(db, teamId);
    const eligible = members.filter((member) => (
        ACTIVE_MEMBER_STATUSES.includes(member.status) && member.status !== 'protected_absence'
    ));
    const progress = await getRecruitmentProgress(db, teamId, { weekKey });
    const completedMembers = 0;
    const rewards = {
        mode: 'preview_only',
        note: 'Recompensas econômicas não são aplicadas por este comando nesta versão.',
        recruitmentMissionComplete: progress.validatedRecruits >= progress.target,
        weeklyPhCapRewards: {
            perCompletedPlayer: { phOutsideCap: 5, yulls: 2500 },
            teamPerfectExtra: { phOutsideCap: 5, yulls: 2500, commonBoxes: 1 },
        },
        recruitmentRewards: {
            firstRecruitPr: 2,
            secondRecruitPr: 3,
            distributableTeamPr: 20,
        },
    };
    await db.run(
        `INSERT INTO clover_performance_week_results
         (team_id, week_key, status, completed_members, eligible_members, validated_recruits, rewards_json, created_by)
         VALUES (?, ?, 'preview', ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, week_key) DO UPDATE SET
             status = 'preview',
             completed_members = excluded.completed_members,
             eligible_members = excluded.eligible_members,
             validated_recruits = excluded.validated_recruits,
             rewards_json = excluded.rewards_json,
             updated_at = CURRENT_TIMESTAMP`,
        [
            teamId,
            weekKey,
            completedMembers,
            eligible.length,
            progress.validatedRecruits,
            JSON.stringify(rewards),
            actorId || null,
        ]
    );
    return { weekKey, eligibleMembers: eligible.length, completedMembers, progress, rewards };
}

async function closePerformanceCycle(db, { actorId } = {}) {
    await ensurePerformanceTeamsSchema(db);
    const cycle = await getOpenCycle(db);
    if (!cycle) throw new PerformanceTeamServiceError('cycle_not_open', 'Nenhum ciclo aberto para encerrar.');
    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run(
            `UPDATE clover_performance_cycles
             SET status = 'ended',
                 ends_at = COALESCE(ends_at, CURRENT_TIMESTAMP),
                 updated_at = CURRENT_TIMESTAMP,
                 metadata_json = ?
             WHERE id = ?`,
            [JSON.stringify({ ended_by: actorId || null }), cycle.id]
        );
        await db.run(
            `UPDATE clover_performance_teams
             SET status = 'ended', updated_at = CURRENT_TIMESTAMP
             WHERE cycle_id = ? AND status IN ('draft', 'confirming', 'active')`,
            [cycle.id]
        );
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
    return getCycleSummary(db, cycle.id);
}

module.exports = {
    ACTIVE_MEMBER_STATUSES,
    PerformanceTeamServiceError,
    addMemberToTeam,
    approveProtectedAbsence,
    assertNovicePlayer,
    closeWeekPreview,
    closePerformanceCycle,
    confirmMembership,
    createCycle,
    createManualTeam,
    currentWeekKey,
    displayName,
    ensurePerformanceTeamsSchema,
    generateTeamsFromSignups,
    getActiveMembership,
    getCycleSummary,
    getMyTeam,
    getMonitoredTeam,
    getRecruitmentProgress,
    getTeamHistory,
    getTeamByNameOrId,
    hasNoOfficialSquad,
    isApprovedSheet,
    isPerformanceMonitor,
    isReleased,
    joinCycle,
    listEligiblePlayers,
    publishDraw,
    recordRecruitAction,
    removeMember,
    requestProtectedAbsence,
    setRepresentative,
    setTeamMonitor,
};
