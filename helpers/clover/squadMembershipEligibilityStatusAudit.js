'use strict';

function text(value) {
    return String(value ?? '').trim();
}

function rawStatus(value) {
    const valueText = text(value);
    return valueText && valueText !== '-' ? valueText : null;
}

function normalizeStatus(value) {
    const normalized = text(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    return normalized && normalized !== '-' ? normalized : null;
}

function filled(value) {
    return Boolean(rawStatus(value));
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    );
    return Boolean(row?.found);
}

async function tableColumns(db, tableName) {
    if (!await tableExists(db, tableName)) return new Set();
    const rows = await db.all(`PRAGMA table_info("${String(tableName).replace(/"/g, '""')}")`);
    return new Set((rows || []).map((row) => row.name));
}

function selectColumn(columns, column, fallback = 'NULL') {
    return columns.has(column) ? `"${column}"` : `${fallback} AS "${column}"`;
}

async function readEligibilityStatusSnapshot(db) {
    const playerColumns = await tableColumns(db, 'jogadores');
    const membershipColumns = await tableColumns(db, 'clover_squad_memberships');
    const requiredPlayerColumns = ['id', 'personagem_nome', 'ficha_status', 'jogo_status', 'esquadrao'];
    const missingPlayerColumns = requiredPlayerColumns.filter((column) => !playerColumns.has(column));

    const players = playerColumns.has('id')
        ? await db.all(`
            SELECT
                ${selectColumn(playerColumns, 'id')},
                ${selectColumn(playerColumns, 'personagem_nome')},
                ${selectColumn(playerColumns, 'ficha_status')},
                ${selectColumn(playerColumns, 'jogo_status')},
                ${selectColumn(playerColumns, 'esquadrao')}
            FROM jogadores
            ORDER BY id
        `)
        : [];

    const memberships = membershipColumns.has('player_id') && membershipColumns.has('status')
        ? await db.all(`
            SELECT player_id, squad_key, status
            FROM clover_squad_memberships
            WHERE status = 'active'
            ORDER BY player_id, squad_key
        `)
        : [];

    return {
        write: false,
        queryOnlySafe: true,
        schema: {
            jogadores: playerColumns.size > 0,
            clover_squad_memberships: membershipColumns.size > 0,
            playerColumns: [...playerColumns].sort(),
            membershipColumns: [...membershipColumns].sort(),
            missingPlayerColumns,
        },
        players,
        memberships,
    };
}

function countBy(values, keyBuilder) {
    const counts = new Map();
    for (const value of values || []) {
        const key = keyBuilder(value);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([value, count]) => ({ value: value === '__NULL__' ? null : value, count }))
        .sort((left, right) => right.count - left.count
            || String(left.value ?? '').localeCompare(String(right.value ?? ''), 'pt-BR'));
}

function buildStatusVocabulary(players, field) {
    const raw = countBy(players, (player) => rawStatus(player[field]) ?? '__NULL__');
    const normalized = countBy(players, (player) => normalizeStatus(player[field]) ?? '__NULL__');
    const variants = new Map();
    for (const player of players) {
        const normalizedValue = normalizeStatus(player[field]);
        const rawValue = rawStatus(player[field]);
        if (!normalizedValue || !rawValue) continue;
        if (!variants.has(normalizedValue)) variants.set(normalizedValue, new Set());
        variants.get(normalizedValue).add(rawValue);
    }
    const collisions = [...variants.entries()]
        .filter(([, rawValues]) => rawValues.size > 1)
        .map(([value, rawValues]) => ({ value, rawValues: [...rawValues].sort() }))
        .sort((left, right) => left.value.localeCompare(right.value, 'pt-BR'));
    return { raw, normalized, collisions };
}

function normalizeAllowlist(values) {
    return [...new Set((values || []).map(normalizeStatus).filter(Boolean))].sort();
}

function evaluatePlayerPolicy(player, approvedSheetStatuses, releasedGameStatuses) {
    const characterName = rawStatus(player.personagem_nome);
    const sheetStatus = normalizeStatus(player.ficha_status);
    const gameStatus = normalizeStatus(player.jogo_status);
    if (!characterName) return { eligible: false, reason: 'character_incomplete' };
    if (!approvedSheetStatuses.has(sheetStatus)) return { eligible: false, reason: 'sheet_not_approved' };
    if (!releasedGameStatuses.has(gameStatus)) return { eligible: false, reason: 'game_not_released' };
    return { eligible: true, reason: null };
}

function buildEligibilityStatusInventory(snapshot, options = {}) {
    const activeMembershipsByPlayer = new Map();
    for (const membership of snapshot.memberships || []) {
        const id = text(membership.player_id);
        if (!id) continue;
        if (!activeMembershipsByPlayer.has(id)) activeMembershipsByPlayer.set(id, []);
        activeMembershipsByPlayer.get(id).push(membership);
    }

    const schemaReady = Array.isArray(snapshot.schema?.missingPlayerColumns)
        && snapshot.schema.missingPlayerColumns.length === 0
        && snapshot.schema.jogadores === true;

    const approvedList = normalizeAllowlist(options.approvedSheetStatuses);
    const releasedList = normalizeAllowlist(options.releasedGameStatuses);
    const approvedSet = new Set(approvedList);
    const releasedSet = new Set(releasedList);
    const policyEvaluated = approvedSet.size > 0 && releasedSet.size > 0;

    const records = (snapshot.players || []).map((player) => {
        const id = text(player.id);
        const activeMemberships = activeMembershipsByPlayer.get(id) || [];
        const activeMember = activeMemberships.length > 0;
        const legacyMember = filled(player.esquadrao);
        const namedCharacter = filled(player.personagem_nome);
        const existingMember = activeMember || legacyMember;
        const candidate = namedCharacter && !existingMember;
        const policy = policyEvaluated
            ? evaluatePlayerPolicy(player, approvedSet, releasedSet)
            : { eligible: null, reason: null };
        return {
            playerId: id,
            characterName: rawStatus(player.personagem_nome),
            sheetStatusRaw: rawStatus(player.ficha_status),
            sheetStatus: normalizeStatus(player.ficha_status),
            gameStatusRaw: rawStatus(player.jogo_status),
            gameStatus: normalizeStatus(player.jogo_status),
            legacySquad: rawStatus(player.esquadrao),
            activeSquadKeys: activeMemberships.map((row) => text(row.squad_key)).filter(Boolean),
            population: {
                namedCharacter,
                activeMember,
                legacyMember,
                existingMember,
                candidate,
            },
            policy,
        };
    });

    const pairs = countBy(records, (record) => JSON.stringify([
        record.sheetStatus,
        record.gameStatus,
    ])).map((entry) => {
        const [sheetStatus, gameStatus] = JSON.parse(entry.value);
        return { sheetStatus, gameStatus, count: entry.count };
    });

    const existingMembers = records.filter((record) => record.population.existingMember);
    const candidates = records.filter((record) => record.population.candidate);
    const existingMemberFailures = policyEvaluated
        ? existingMembers.filter((record) => record.policy.eligible === false)
        : [];
    const eligibleCandidates = policyEvaluated
        ? candidates.filter((record) => record.policy.eligible === true)
        : [];
    const blockedCandidates = policyEvaluated
        ? candidates.filter((record) => record.policy.eligible === false)
        : [];

    const observedSheetStatuses = [...new Set(records.map((record) => record.sheetStatus).filter(Boolean))].sort();
    const observedGameStatuses = [...new Set(records.map((record) => record.gameStatus).filter(Boolean))].sort();

    return {
        generatedAt: new Date().toISOString(),
        write: false,
        queryOnlySafe: true,
        policyApplied: false,
        schema: snapshot.schema || {},
        policy: {
            evaluated: policyEvaluated,
            approvedSheetStatuses: approvedList,
            releasedGameStatuses: releasedList,
            observedSheetStatusesOutsidePolicy: policyEvaluated
                ? observedSheetStatuses.filter((value) => !approvedSet.has(value))
                : [],
            observedGameStatusesOutsidePolicy: policyEvaluated
                ? observedGameStatuses.filter((value) => !releasedSet.has(value))
                : [],
            schemaReady,
            safeForExistingMembers: schemaReady
                && policyEvaluated
                && existingMemberFailures.length === 0,
        },
        summary: {
            playerCount: records.length,
            namedCharacterCount: records.filter((record) => record.population.namedCharacter).length,
            activeMembershipPlayerCount: records.filter((record) => record.population.activeMember).length,
            legacyMemberCount: records.filter((record) => record.population.legacyMember).length,
            existingMemberCount: existingMembers.length,
            candidateCount: candidates.length,
            blankSheetStatusCount: records.filter((record) => !record.sheetStatus).length,
            blankGameStatusCount: records.filter((record) => !record.gameStatus).length,
            policyEvaluated,
            existingMemberFailureCount: existingMemberFailures.length,
            eligibleCandidateCount: eligibleCandidates.length,
            blockedCandidateCount: blockedCandidates.length,
        },
        vocabulary: {
            sheet: buildStatusVocabulary(snapshot.players || [], 'ficha_status'),
            game: buildStatusVocabulary(snapshot.players || [], 'jogo_status'),
            pairs,
        },
        policyImpact: {
            existingMemberFailures,
            eligibleCandidates,
            blockedCandidates,
        },
        records,
    };
}

async function buildEligibilityStatusAudit(db, options = {}) {
    return buildEligibilityStatusInventory(await readEligibilityStatusSnapshot(db), options);
}

module.exports = {
    buildEligibilityStatusAudit,
    buildEligibilityStatusInventory,
    buildStatusVocabulary,
    evaluatePlayerPolicy,
    normalizeAllowlist,
    normalizeStatus,
    rawStatus,
    readEligibilityStatusSnapshot,
    tableColumns,
    tableExists,
};
