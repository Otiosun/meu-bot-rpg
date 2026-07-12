const { normalizeText } = require('../textUtils');
const { diagnoseSpellReviewQueue } = require('./spellQueueAdminService');

const DEFAULT_SAMPLE_LIMIT = 5;

const PLAYER_REFERENCE_TABLES = [
    ['clover_character_stats', 'player_id'],
    ['clover_ph_ledger', 'player_id'],
    ['clover_inventory_items', 'player_id'],
    ['clover_quick_evaluations', 'player_id'],
    ['clover_skill_nodes', 'player_id'],
    ['clover_pending_skill_purchases', 'player_id'],
    ['clover_mana_hexagon', 'player_id'],
    ['clover_mana_hexagon_ledger', 'player_id'],
    ['clover_pending_hexagon_upgrades', 'player_id'],
    ['clover_trait_attempts', 'player_id'],
    ['clover_appearance_reviews', 'player_id'],
    ['clover_spellbook_spells', 'player_id'],
    ['slot_reservations', 'player_id'],
    ['player_progress', 'player_id'],
    ['player_skill_trees', 'player_id'],
    ['player_onboarding', 'player_id'],
    ['player_rolls', 'player_id'],
    ['pending_profile_confirmations', 'player_id'],
    ['pending_magic_confirmations', 'player_id'],
    ['group_member_welcomes', 'player_id'],
    ['clover_antighost_activity', 'player_id'],
    ['clover_return_bonuses', 'player_id'],
    ['clover_squad_star_ledger', 'player_id'],
    ['clover_admin_service_entries', 'target_player_id'],
];

function normalizeCompact(value) {
    return normalizeText(String(value || ''))
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isEmptyValue(value) {
    const normalized = normalizeCompact(value);
    return !normalized || ['-', 'nenhum', 'na', 'null', 'undefined'].includes(normalized);
}

function isTruthyDbFlag(value) {
    return Number(value || 0) === 1 || String(value || '').toLowerCase() === 'true';
}

function playerLabel(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome, player.id]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-') || '-';
}

function makeIssue(section, severity, code, message, details = {}) {
    return {
        section,
        severity,
        code,
        message,
        playerId: details.playerId || null,
        label: details.label || null,
        table: details.table || null,
        count: Number(details.count || 1),
        data: details.data || null,
    };
}

async function listTables(db) {
    const rows = await db.all(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'`
    );
    return new Set((rows || []).map((row) => row.name));
}

async function tableColumns(db, tableName) {
    const rows = await db.all(`PRAGMA table_info(${tableName})`).catch(() => []);
    return new Set((rows || []).map((row) => row.name));
}

function selectExisting(columns, names) {
    return names.filter((name) => columns.has(name));
}

async function loadPlayers(db, tables) {
    if (!tables.has('jogadores')) return [];
    const columns = await tableColumns(db, 'jogadores');
    const desired = [
        'id',
        'nome',
        'display_name',
        'personagem_nome',
        'ficha_status',
        'jogo_status',
        'esquadrao',
        'canonical_player_id',
        'merged_into',
        'is_shadow',
        'identity_status',
    ];
    const selected = selectExisting(columns, desired);
    if (!selected.includes('id')) return [];
    return db.all(`SELECT ${selected.join(', ')} FROM jogadores ORDER BY id`);
}

function diagnosePlayerLifecycle(players) {
    const issues = [];

    for (const player of players) {
        const gameStatus = normalizeCompact(player.jogo_status);
        const profileStatus = normalizeCompact(player.ficha_status);
        const emptyCharacter = isEmptyValue(player.personagem_nome);
        const shadow = isTruthyDbFlag(player.is_shadow);
        const label = playerLabel(player);

        if (gameStatus === 'liberado' && emptyCharacter) {
            issues.push(makeIssue(
                'players',
                'critical',
                'released_without_character',
                `${label}: jogo liberado sem personagem válido.`,
                { playerId: player.id, label }
            ));
        }

        if (gameStatus === 'liberado' && profileStatus && profileStatus !== 'aprovada') {
            issues.push(makeIssue(
                'players',
                'critical',
                'released_without_approved_profile',
                `${label}: jogo liberado com ficha em ${player.ficha_status || '-'}.`,
                { playerId: player.id, label }
            ));
        }

        if (profileStatus === 'aprovada' && emptyCharacter) {
            issues.push(makeIssue(
                'players',
                'warning',
                'approved_profile_without_character',
                `${label}: ficha aprovada sem personagem válido.`,
                { playerId: player.id, label }
            ));
        }

        if (shadow && gameStatus === 'liberado') {
            issues.push(makeIssue(
                'identity',
                'critical',
                'shadow_player_released',
                `${label}: cadastro sombra ainda está com jogo liberado.`,
                { playerId: player.id, label }
            ));
        }
    }

    return issues;
}

function diagnoseIdentityPointers(players) {
    const issues = [];
    const byId = new Map(players.map((player) => [player.id, player]));

    for (const player of players) {
        const shadow = isTruthyDbFlag(player.is_shadow);
        const label = playerLabel(player);

        if (shadow && !player.merged_into) {
            issues.push(makeIssue(
                'identity',
                'critical',
                'shadow_without_destination',
                `${label}: cadastro sombra sem destino de mesclagem.`,
                { playerId: player.id, label }
            ));
        }

        if (player.merged_into && !byId.has(player.merged_into)) {
            issues.push(makeIssue(
                'identity',
                'critical',
                'merge_destination_missing',
                `${label}: merged_into aponta para cadastro inexistente.`,
                { playerId: player.id, label, data: { mergedInto: player.merged_into } }
            ));
        }

        if (player.canonical_player_id && !byId.has(player.canonical_player_id)) {
            issues.push(makeIssue(
                'identity',
                'critical',
                'canonical_player_missing',
                `${label}: canonical_player_id aponta para cadastro inexistente.`,
                { playerId: player.id, label, data: { canonicalPlayerId: player.canonical_player_id } }
            ));
        }
    }

    return issues;
}

function diagnoseDuplicateCharacters(players) {
    const groups = new Map();

    for (const player of players) {
        if (isTruthyDbFlag(player.is_shadow) || isEmptyValue(player.personagem_nome)) continue;
        const key = normalizeCompact(player.personagem_nome);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(player);
    }

    const issues = [];
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const names = group.map((player) => `${playerLabel(player)} [${player.id}]`);
        issues.push(makeIssue(
            'identity',
            'warning',
            'duplicate_character_name',
            `Mesmo nome de personagem em ${group.length} cadastros: ${names.join(' | ')}`,
            { count: group.length, data: { playerIds: group.map((player) => player.id) } }
        ));
    }

    return issues;
}

async function diagnoseAliasTable(db, tables, players, config) {
    if (!tables.has(config.table)) return [];
    const columns = await tableColumns(db, config.table);
    if (!columns.has(config.playerColumn)) return [];

    const selected = [config.playerColumn];
    if (config.activeColumn && columns.has(config.activeColumn)) selected.push(config.activeColumn);
    if (config.labelColumn && columns.has(config.labelColumn)) selected.push(config.labelColumn);
    if (config.keyColumn && columns.has(config.keyColumn)) selected.push(config.keyColumn);

    let sql = `SELECT ${selected.join(', ')} FROM ${config.table}`;
    if (config.activeColumn && columns.has(config.activeColumn)) {
        sql += ` WHERE ${config.activeColumn} = 1`;
    }

    const rows = await db.all(sql);
    const byId = new Map(players.map((player) => [player.id, player]));
    const issues = [];

    for (const row of rows || []) {
        const playerId = row[config.playerColumn];
        const target = byId.get(playerId);
        const alias = row[config.labelColumn] || row[config.keyColumn] || '-';

        if (!target) {
            issues.push(makeIssue(
                'aliases',
                'critical',
                'alias_target_missing',
                `${config.table}: alias ${alias} aponta para player inexistente ${playerId || '-'}.`,
                { playerId, table: config.table, data: { alias } }
            ));
        } else if (isTruthyDbFlag(target.is_shadow)) {
            issues.push(makeIssue(
                'aliases',
                'warning',
                'alias_targets_shadow',
                `${config.table}: alias ${alias} aponta diretamente para cadastro sombra.`,
                { playerId, label: playerLabel(target), table: config.table, data: { alias } }
            ));
        }
    }

    return issues;
}

async function diagnoseAliases(db, tables, players) {
    return [
        ...await diagnoseAliasTable(db, tables, players, {
            table: 'clover_player_aliases',
            playerColumn: 'player_id_destino',
            activeColumn: 'active',
            labelColumn: 'alias_value',
            keyColumn: 'alias_type',
        }),
        ...await diagnoseAliasTable(db, tables, players, {
            table: 'clover_player_target_aliases',
            playerColumn: 'player_id',
            labelColumn: 'alias_label',
            keyColumn: 'alias_key',
        }),
    ];
}

async function diagnoseOrphanReferences(db, tables, sampleLimit) {
    const issues = [];
    if (!tables.has('jogadores')) return issues;

    for (const [table, column] of PLAYER_REFERENCE_TABLES) {
        if (!tables.has(table)) continue;
        const columns = await tableColumns(db, table);
        if (!columns.has(column)) continue;

        const rows = await db.all(
            `SELECT child.${column} AS player_id, COUNT(*) AS total
             FROM ${table} child
             LEFT JOIN jogadores player ON player.id = child.${column}
             WHERE child.${column} IS NOT NULL
               AND child.${column} <> ''
               AND player.id IS NULL
             GROUP BY child.${column}
             ORDER BY total DESC, child.${column}
             LIMIT ?`,
            [sampleLimit]
        );

        const countRow = await db.get(
            `SELECT COUNT(*) AS total
             FROM ${table} child
             LEFT JOIN jogadores player ON player.id = child.${column}
             WHERE child.${column} IS NOT NULL
               AND child.${column} <> ''
               AND player.id IS NULL`
        );
        const total = Number(countRow?.total || 0);
        if (!total) continue;

        issues.push(makeIssue(
            'orphan_records',
            'warning',
            'orphan_player_reference',
            `${table}.${column}: ${total} registro(s) apontam para player inexistente.`,
            {
                table,
                count: total,
                data: { samples: (rows || []).map((row) => ({ playerId: row.player_id, count: Number(row.total || 0) })) },
            }
        ));
    }

    return issues;
}

async function diagnoseSquads(db, tables, players) {
    if (!tables.has('clover_squads')) return [];
    const columns = await tableColumns(db, 'clover_squads');
    if (!columns.has('squad_key') || !columns.has('name')) return [];

    const squads = await db.all('SELECT squad_key, name FROM clover_squads');
    const valid = new Set();
    for (const squad of squads || []) {
        const key = normalizeCompact(squad.squad_key);
        const name = normalizeCompact(squad.name);
        if (key) valid.add(key);
        if (name) valid.add(name);
    }

    const issues = [];
    for (const player of players) {
        if (isEmptyValue(player.esquadrao)) continue;
        const squad = normalizeCompact(player.esquadrao);
        if (valid.has(squad)) continue;
        issues.push(makeIssue(
            'squads',
            'warning',
            'unknown_player_squad',
            `${playerLabel(player)}: esquadrão "${player.esquadrao}" não existe no cadastro oficial.`,
            { playerId: player.id, label: playerLabel(player), data: { squad: player.esquadrao } }
        ));
    }
    return issues;
}

async function diagnoseCommunityMismatch(db, tables, players) {
    if (!tables.has('clover_antighost_activity')) return [];
    const columns = await tableColumns(db, 'clover_antighost_activity');
    if (!columns.has('player_id') || !columns.has('community_status')) return [];

    const activity = await db.all(
        `SELECT player_id, community_status
         FROM clover_antighost_activity
         WHERE community_status = 'out'`
    );
    const byId = new Map(players.map((player) => [player.id, player]));
    const issues = [];

    for (const row of activity || []) {
        const player = byId.get(row.player_id);
        if (!player) continue;
        if (normalizeCompact(player.jogo_status) !== 'liberado') continue;
        issues.push(makeIssue(
            'community',
            'critical',
            'outside_community_but_released',
            `${playerLabel(player)}: marcado fora da comunidade, mas o jogo continua liberado.`,
            { playerId: player.id, label: playerLabel(player) }
        ));
    }

    return issues;
}

async function diagnoseQueue(db, tables) {
    if (!tables.has('clover_spell_review_queue')) return [];
    const diagnosis = await diagnoseSpellReviewQueue(db);
    const issues = [];

    for (const entry of diagnosis.blocking) {
        issues.push(makeIssue(
            'queue',
            'critical',
            'active_queue_entry_blocked',
            `Fila #${entry.position}: ${entry.integrity.blocking.map((item) => item.message).join(' ')}`,
            { playerId: entry.player_id, label: playerLabel(entry), data: { queueId: entry.id, status: entry.status } }
        ));
    }

    for (const entry of diagnosis.warnings) {
        issues.push(makeIssue(
            'queue',
            'warning',
            'active_queue_entry_warning',
            `Fila #${entry.position}: ${entry.integrity.warnings.map((item) => item.message).join(' ')}`,
            { playerId: entry.player_id, label: playerLabel(entry), data: { queueId: entry.id, status: entry.status } }
        ));
    }

    return issues;
}

function summarizeIssues(issues) {
    const summary = {
        total: issues.length,
        critical: 0,
        warning: 0,
        info: 0,
        bySection: {},
    };

    for (const item of issues) {
        if (Object.prototype.hasOwnProperty.call(summary, item.severity)) {
            summary[item.severity] += 1;
        }
        if (!summary.bySection[item.section]) {
            summary.bySection[item.section] = { total: 0, critical: 0, warning: 0, info: 0 };
        }
        const section = summary.bySection[item.section];
        section.total += 1;
        if (Object.prototype.hasOwnProperty.call(section, item.severity)) {
            section[item.severity] += 1;
        }
    }

    return summary;
}

async function diagnoseDatabaseIntegrity(db, options = {}) {
    const sampleLimit = Math.max(1, Math.min(20, Number(options.sampleLimit || DEFAULT_SAMPLE_LIMIT)));
    const tables = await listTables(db);
    const players = await loadPlayers(db, tables);
    const issues = [
        ...diagnosePlayerLifecycle(players),
        ...diagnoseIdentityPointers(players),
        ...diagnoseDuplicateCharacters(players),
        ...await diagnoseAliases(db, tables, players),
        ...await diagnoseQueue(db, tables),
        ...await diagnoseOrphanReferences(db, tables, sampleLimit),
        ...await diagnoseSquads(db, tables, players),
        ...await diagnoseCommunityMismatch(db, tables, players),
    ];

    const severityOrder = { critical: 0, warning: 1, info: 2 };
    issues.sort((a, b) => (
        (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9)
        || a.section.localeCompare(b.section)
        || a.code.localeCompare(b.code)
    ));

    return {
        generatedAt: new Date().toISOString(),
        readOnly: true,
        players: players.length,
        tables: tables.size,
        issues,
        summary: summarizeIssues(issues),
    };
}

module.exports = {
    DEFAULT_SAMPLE_LIMIT,
    PLAYER_REFERENCE_TABLES,
    diagnoseDatabaseIntegrity,
    isEmptyValue,
    normalizeCompact,
    playerLabel,
    summarizeIssues,
    tableColumns,
};
