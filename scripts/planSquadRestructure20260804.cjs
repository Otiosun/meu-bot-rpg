'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { normalizeSquadKey } = require('../helpers/clover/cavalierService');
const { getJidCandidatesForPhone } = require('../helpers/clover/siteAuthService');
const { normalizeJid } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(ROOT, 'banco.sqlite');
const SANITIZED_EXAMPLE_SOURCE_PATH = path.join(ROOT, 'data', 'clover', 'squad-restructure-source.example.json');
const DEFAULT_AUTH_INFO_DIR = path.join(ROOT, 'auth_info');
const BLOCKING_STATUSES = new Set([
    'ambiguous',
    'unresolved',
    'identity_only',
    'ineligible',
    'membership_conflict',
]);
const REPORT_STATUSES = [
    'already_correct',
    'needs_transfer',
    'needs_admission',
    'membership_conflict',
    'ambiguous',
    'unresolved',
    'identity_only',
    'ineligible',
];

function digits(value) {
    return String(value || '').replace(/\D/g, '');
}

function readJsonFile(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function mappedDigitsFromJson(parsed) {
    if (typeof parsed === 'string' || typeof parsed === 'number') return digits(parsed);
    if (!parsed || typeof parsed !== 'object') return '';
    return digits(parsed.phoneNumber || parsed.pn || parsed.jid || parsed.id || parsed.user || parsed.lid);
}

function graphCandidatesFromAuthInfo(phoneDigits, authInfoDir = DEFAULT_AUTH_INFO_DIR) {
    const phone = digits(phoneDigits);
    if (!phone) return [];
    const candidates = new Set([`${phone}@s.whatsapp.net`]);
    const mappedLid = mappedDigitsFromJson(readJsonFile(path.join(authInfoDir, `lid-mapping-${phone}.json`)));
    if (mappedLid) candidates.add(`${mappedLid}@lid`);
    return [...candidates].map(normalizeJid).filter(Boolean);
}

function normalizedName(value) {
    return normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizedStatus(value) {
    return normalizedName(value);
}

function hasUsableName(value) {
    const text = String(value || '').trim();
    return Boolean(text) && text !== '-';
}

function playerNames(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome, player.nome_real]
        .map(normalizedName)
        .filter(Boolean);
}

function normalizeAlias(alias) {
    if (typeof alias === 'string') {
        return { type: 'name', value: alias, source: 'legacy' };
    }
    return {
        type: String(alias?.type || 'name').trim().toLowerCase(),
        value: String(alias?.value || '').trim(),
        source: alias?.source || null,
    };
}

function normalizeTargetEntry(raw = {}, fallbackSource = null) {
    const aliases = Array.isArray(raw.aliases) ? raw.aliases.map(normalizeAlias) : [];
    const personagem = String(raw.personagem ?? raw.characterName ?? raw.name ?? '').trim();
    const phone = digits(raw.phone ?? raw.telefone);
    const phoneLast4 = digits(raw.phoneLast4 ?? raw.last4 ?? phone).slice(-4) || null;
    const nameAliases = [personagem, ...aliases.filter((alias) => alias.type === 'name').map((alias) => alias.value)]
        .map(normalizedName)
        .filter(Boolean);
    const jidAliases = aliases
        .filter((alias) => alias.type === 'jid')
        .map((alias) => normalizeJid(alias.value))
        .filter(Boolean);

    return {
        personagem,
        phone,
        phoneLast4,
        source: raw.source || fallbackSource,
        aliases,
        nameAliases,
        jidAliases,
        identityOnlySource: !hasUsableName(personagem),
    };
}

function normalizeTargetSource(rawSource) {
    if (!rawSource || typeof rawSource !== 'object') {
        throw new Error('Fonte de reestruturação inválida.');
    }

    const squads = rawSource.squads && typeof rawSource.squads === 'object'
        ? rawSource.squads
        : rawSource;
    const normalizedSquads = {};

    for (const [squadKey, squad] of Object.entries(squads)) {
        const entries = Array.isArray(squad.entries)
            ? squad.entries
            : [
                ...(Array.isArray(squad.current) ? squad.current.map((entry) => ({
                    personagem: entry[0],
                    phone: entry[1],
                    aliases: (entry[2] || []).map((value) => ({ type: 'name', value, source: 'legacy' })),
                    source: 'current',
                })) : []),
                ...(Array.isArray(squad.add) ? squad.add.map((entry) => ({
                    personagem: entry[0],
                    phone: entry[1],
                    aliases: (entry[2] || []).map((value) => ({ type: 'name', value, source: 'legacy' })),
                    source: 'add',
                })) : []),
            ];
        normalizedSquads[normalizeSquadKey(squadKey)] = {
            name: squad.name || squadKey,
            entries: entries.map((entry) => normalizeTargetEntry(entry, rawSource.source || null)),
        };
    }

    return {
        schemaVersion: rawSource.schemaVersion || 0,
        source: rawSource.source || null,
        squads: normalizedSquads,
    };
}

function loadTargetSource(sourcePath) {
    if (!sourcePath) throw new Error('Informe a fonte privada com --source=CAMINHO.');
    const raw = readJsonFile(sourcePath);
    if (!raw) throw new Error(`Não foi possível ler a fonte JSON: ${sourcePath}`);
    return normalizeTargetSource(raw);
}

function flattenTargets(source) {
    if (!source) throw new Error('Fonte de reestruturação ausente.');
    const normalizedSource = source.squads ? source : normalizeTargetSource(source);
    const result = [];
    for (const [squadKey, squad] of Object.entries(normalizedSource.squads)) {
        for (const target of squad.entries) {
            result.push({
                squadKey,
                squadName: squad.name,
                planSource: normalizedSource.source,
                target,
            });
        }
    }
    return result;
}

function tableExistsFactory(db) {
    return async (name) => {
        const row = await db.get(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            [name]
        );
        return Boolean(row);
    };
}

async function readPlayers(db) {
    return db.all(
        `SELECT jogadores.*, clover_character_stats.distribution_status
         FROM jogadores
         LEFT JOIN clover_character_stats ON clover_character_stats.player_id = jogadores.id
         WHERE COALESCE(TRIM(jogadores.id), '') <> ''`
    ).catch(() => db.all(
        `SELECT *
         FROM jogadores
         WHERE COALESCE(TRIM(id), '') <> ''`
    ));
}

function matchesAnyName(player, aliases) {
    const names = playerNames(player);
    return aliases.some((alias) => names.includes(alias));
}

function phoneMatches(player, phone) {
    return Boolean(phone) && digits(player.id) === phone;
}

function last4NameMatches(player, target) {
    return Boolean(target.phoneLast4)
        && digits(player.id).endsWith(target.phoneLast4)
        && matchesAnyName(player, target.nameAliases);
}

function phoneGraphCandidates(target, options = {}) {
    const candidates = new Set();
    if (target.phone) {
        for (const jid of getJidCandidatesForPhone(target.phone)) candidates.add(normalizeJid(jid));
        for (const jid of graphCandidatesFromAuthInfo(target.phone, options.authInfoDir)) {
            candidates.add(normalizeJid(jid));
        }
    }
    return [...candidates].filter(Boolean);
}

function uniquePlayers(rows = []) {
    return [...new Map(rows.map((player) => [normalizeJid(player.id), player])).values()];
}

function resolveTier(method, rows, identityCandidates) {
    const unique = uniquePlayers(rows);
    if (!unique.length) return null;

    const eligible = unique.filter(isPlayerEligible);
    if (eligible.length >= 2) {
        return { status: 'ambiguous', method, candidates: unique, identityCandidates };
    }
    if (eligible.length === 1) {
        return { status: 'matched', method, player: eligible[0], identityCandidates };
    }
    if (unique.length === 1) {
        return { status: 'matched', method, player: unique[0], identityCandidates };
    }
    return { status: 'ambiguous', method, candidates: unique, identityCandidates };
}

async function chooseMatch(_db, players, target, options = {}) {
    const controlledJidCandidates = target.jidAliases.map(normalizeJid).filter(Boolean);
    const phoneGraphCandidateIds = phoneGraphCandidates(target, options);
    const controlledJidMatches = controlledJidCandidates.length
        ? players.filter((player) => controlledJidCandidates.includes(normalizeJid(player.id)))
        : [];
    const phoneGraphMatches = phoneGraphCandidateIds.length
        ? players.filter((player) => phoneGraphCandidateIds.includes(normalizeJid(player.id)))
        : [];
    const nameMatches = players.filter((player) => matchesAnyName(player, target.nameAliases));
    const directPhoneMatches = players.filter((player) => phoneMatches(player, target.phone));
    const nameAndPhoneGraph = phoneGraphMatches.filter((player) => matchesAnyName(player, target.nameAliases));
    const nameAndPhone = nameMatches.filter((player) => phoneMatches(player, target.phone));
    const last4Matches = players.filter((player) => last4NameMatches(player, target));
    const identityCandidates = [...new Set([
        ...controlledJidCandidates,
        ...phoneGraphCandidateIds,
    ])];

    const tiers = [
        ['controlled_jid', controlledJidMatches],
        ['name_phone_graph', nameAndPhoneGraph],
        ['name_phone', nameAndPhone],
        ['phone_graph', phoneGraphMatches],
        ['phone', directPhoneMatches],
        ['name', nameMatches],
        ['last4_name', last4Matches],
    ];

    for (const [method, rows] of tiers) {
        const resolution = resolveTier(method, rows, identityCandidates);
        if (resolution) return resolution;
    }
    return { status: 'unresolved', method: 'none', candidates: [], identityCandidates };
}

async function readMembershipHealth(db) {
    const tableExists = tableExistsFactory(db);
    if (!await tableExists('clover_squad_memberships')) {
        return {
            activeMemberships: [],
            duplicateActive: [],
            projectionConflicts: [],
            tablePresent: false,
        };
    }
    const activeMemberships = await db.all(
        `SELECT id, player_id, squad_key, status
         FROM clover_squad_memberships
         WHERE status = 'active'
         ORDER BY player_id, id`
    );
    const byPlayer = new Map();
    for (const membership of activeMemberships) {
        const playerId = normalizeJid(membership.player_id);
        const current = byPlayer.get(playerId) || [];
        current.push(membership);
        byPlayer.set(playerId, current);
    }
    const duplicateActive = [...byPlayer.entries()]
        .filter(([, memberships]) => memberships.length > 1)
        .map(([playerId, memberships]) => ({
            player_id: playerId,
            total: memberships.length,
            squad_keys: memberships.map((membership) => membership.squad_key),
        }));
    const playerRows = await db.all(
        `SELECT id, esquadrao
         FROM jogadores
         WHERE COALESCE(TRIM(id), '') <> ''`
    );
    const projections = new Map(playerRows.map((player) => [normalizeJid(player.id), player.esquadrao]));
    const projectionConflicts = [];
    for (const membership of activeMemberships) {
        const projection = projections.get(normalizeJid(membership.player_id));
        if (normalizeSquadKey(membership.squad_key) !== normalizeSquadKey(projection)) {
            projectionConflicts.push({
                player_id: normalizeJid(membership.player_id),
                membership_squad_key: membership.squad_key,
                projected_squad: projection || null,
            });
        }
    }
    return {
        activeMemberships,
        duplicateActive,
        projectionConflicts,
        tablePresent: true,
    };
}

function identityState(player) {
    if (!player) return 'missing';
    if (Number(player.is_shadow || 0)) return 'shadow';
    return normalizedStatus(player.identity_status || 'active') || 'active';
}

function isPlayerEligible(player) {
    return normalizedStatus(player?.identity_status) === 'active'
        && normalizedStatus(player?.lifecycle_status) === 'active'
        && Number(player?.is_shadow || 0) === 0
        && !String(player?.merged_into || '').trim()
        && hasUsableName(player?.personagem_nome)
        && ['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(normalizedStatus(player?.ficha_status))
        && normalizedStatus(player?.jogo_status) === 'liberado';
}

function membershipsForPlayer(membership, playerId) {
    const normalizedPlayerId = normalizeJid(playerId);
    return (membership?.activeMemberships || [])
        .filter((item) => normalizeJid(item.player_id) === normalizedPlayerId)
        .map((item) => ({
            id: item.id,
            squad_key: item.squad_key,
            status: item.status,
        }));
}

function publicPlayer(player, activeMemberships = []) {
    if (!player) return null;
    return {
        id: normalizeJid(player.id),
        name: player.personagem_nome || player.display_name || player.nome || null,
        squad: player.esquadrao || null,
        ficha_status: player.ficha_status || null,
        jogo_status: player.jogo_status || null,
        personagem_nome: player.personagem_nome || null,
        identity_state: identityState(player),
        lifecycle_status: player.lifecycle_status || null,
        merged_into: player.merged_into || null,
        active_memberships: activeMemberships,
    };
}

function publicTarget(target) {
    return {
        personagem: target.personagem || null,
        phoneLast4: target.phoneLast4,
        source: target.source,
        aliases: target.aliases,
        identityOnlySource: target.identityOnlySource,
    };
}

function classifyMatchedPlayer(player, targetSquadKey, activeMemberships) {
    if (!isPlayerEligible(player)) return 'ineligible';

    const projectionSquadKey = hasUsableName(player.esquadrao)
        ? normalizeSquadKey(player.esquadrao)
        : '';
    if (activeMemberships.length > 1) return 'membership_conflict';
    if (activeMemberships.length === 0) {
        return projectionSquadKey ? 'membership_conflict' : 'needs_admission';
    }

    const membershipSquadKey = normalizeSquadKey(activeMemberships[0].squad_key);
    if (!projectionSquadKey || projectionSquadKey !== membershipSquadKey) {
        return 'membership_conflict';
    }
    return membershipSquadKey === targetSquadKey ? 'already_correct' : 'needs_transfer';
}

async function planSquadRestructure(db, options = {}) {
    const source = options.targets
        ? normalizeTargetSource(options.targets)
        : loadTargetSource(options.sourcePath);
    const targets = flattenTargets(source);
    const players = await readPlayers(db);
    const membership = await readMembershipHealth(db);
    const matchedPlayerIds = new Set();
    const items = [];

    for (const item of targets) {
        const match = await chooseMatch(db, players, item.target, options);
        const base = {
            targetName: item.target.personagem,
            targetSquadKey: item.squadKey,
            targetSquadName: item.squadName,
            target: publicTarget(item.target),
            planSource: item.planSource,
            matchMethod: match.method,
            identityCandidates: match.identityCandidates || [],
        };

        if (match.status === 'matched') {
            const player = match.player;
            matchedPlayerIds.add(normalizeJid(player.id));
            const currentSquadKey = normalizeSquadKey(player.esquadrao);
            const activeMemberships = membershipsForPlayer(membership, player.id);
            const playerReport = publicPlayer(player, activeMemberships);
            const status = item.target.identityOnlySource
                ? (isPlayerEligible(player) ? 'identity_only' : 'ineligible')
                : classifyMatchedPlayer(player, item.squadKey, activeMemberships);

            items.push({
                ...base,
                status,
                player: playerReport,
                fromSquadKey: currentSquadKey || null,
            });
        } else if (match.status === 'ambiguous') {
            items.push({
                ...base,
                status: 'ambiguous',
                candidates: match.candidates.map((candidate) => publicPlayer(
                    candidate,
                    membershipsForPlayer(membership, candidate.id)
                )),
            });
        } else if (item.target.identityOnlySource) {
            items.push({ ...base, status: 'identity_only' });
        } else {
            items.push({ ...base, status: 'unresolved' });
        }
    }

    const targetSquadKeys = new Set(Object.keys(source.squads));
    const extras = players
        .filter((player) => targetSquadKeys.has(normalizeSquadKey(player.esquadrao)))
        .filter((player) => !matchedPlayerIds.has(normalizeJid(player.id)))
        .map((player) => publicPlayer(player, membershipsForPlayer(membership, player.id)));
    const counts = items.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
    }, Object.fromEntries(REPORT_STATUSES.map((status) => [status, 0])));
    const hasBlockingStatus = [...BLOCKING_STATUSES].some((status) => Number(counts[status] || 0) > 0);
    const safeToApply = !hasBlockingStatus
        && membership.duplicateActive.length === 0
        && membership.projectionConflicts.length === 0;

    return {
        kind: 'clover.squad-restructure-plan.20260804',
        generatedAt: new Date().toISOString(),
        readOnly: true,
        SafeToDeploy: false,
        source: {
            path: options.sourcePath || null,
            id: source.source,
            schemaVersion: source.schemaVersion,
        },
        SafeToApply: safeToApply,
        counts,
        blockingStatuses: [...BLOCKING_STATUSES],
        items,
        extras,
        membership,
    };
}

function parseArgs(argv) {
    const options = {
        db: DEFAULT_DB,
        output: null,
        sourcePath: '',
        authInfoDir: process.env.CLOVER_AUTH_INFO_DIR || DEFAULT_AUTH_INFO_DIR,
    };
    for (const arg of argv) {
        if (arg.startsWith('--db=')) options.db = arg.slice('--db='.length).replace(/^"|"$/g, '');
        if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length).replace(/^"|"$/g, '');
        if (arg.startsWith('--source=')) options.sourcePath = arg.slice('--source='.length).replace(/^"|"$/g, '');
        if (arg.startsWith('--auth-info-dir=')) options.authInfoDir = arg.slice('--auth-info-dir='.length).replace(/^"|"$/g, '');
    }
    return options;
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (!options.db || !fs.existsSync(options.db)) {
        throw new Error('Informe um banco existente com --db=CAMINHO.');
    }
    if (!options.sourcePath || !fs.existsSync(options.sourcePath)) {
        throw new Error('Informe uma fonte privada existente com --source=CAMINHO.');
    }
    const db = await open({ filename: options.db, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
        await db.exec('PRAGMA query_only = ON');
        const plan = await planSquadRestructure(db, options);
        const text = `${JSON.stringify(plan, null, 2)}\n`;
        if (options.output) fs.writeFileSync(options.output, text, { flag: 'wx' });
        process.stdout.write(text);
    } finally {
        await db.close();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message || error);
        process.exitCode = 1;
    });
}

module.exports = {
    BLOCKING_STATUSES,
    REPORT_STATUSES,
    SANITIZED_EXAMPLE_SOURCE_PATH,
    classifyMatchedPlayer,
    chooseMatch,
    flattenTargets,
    graphCandidatesFromAuthInfo,
    isPlayerEligible,
    loadTargetSource,
    normalizeTargetSource,
    normalizedName,
    parseArgs,
    planSquadRestructure,
};
