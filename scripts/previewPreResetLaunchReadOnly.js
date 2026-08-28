'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { boxTemplateKeys } = require('../helpers/clover/preResetLaunchService');
const {
    DEFAULT_PRE_RESET_CAMPAIGN_KEY,
    normalizeCampaignKey,
} = require('../helpers/clover/preResetCampaignStateService');
const RESET_DELETE_TABLES = Object.freeze([
    'pending_profile_confirmations',
    'pending_magic_confirmations',
    'clover_pending_skill_purchases',
    'clover_pending_hexagon_upgrades',
    'clover_trait_attempts',
    'clover_appearance_reviews',
    'clover_skill_nodes',
    'clover_inventory_items',
    'clover_quick_evaluations',
    'clover_ph_ledger',
    'clover_mana_hexagon_ledger',
    'clover_mana_hexagon',
    'clover_character_stats',
    'player_rolls',
    'player_skill_trees',
    'player_progress',
    'player_onboarding',
    'clover_spellbook_spells',
    'clover_character_bonuses',
    'clover_return_bonuses',
]);

function sha256File(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS ok FROM sqlite_schema WHERE type='table' AND name=? LIMIT 1",
        [tableName]
    );
    return Boolean(row?.ok);
}

async function sumLedger(db, tableName, playerId) {
    if (!await tableExists(db, tableName)) return 0;
    const row = await db.get(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM ${tableName} WHERE player_id=?`,
        [playerId]
    );
    return Number(row?.total || 0);
}

async function loadPolicy(db, campaignKey) {
    if (!await tableExists(db, 'clover_prereset_pr_pv_policies')) return { status:'pending' };
    return await db.get(
        'SELECT * FROM clover_prereset_pr_pv_policies WHERE campaign_key=?',
        [campaignKey]
    ) || { status:'pending' };
}

async function loadRoster(db, campaignKey) {
    const roster = await db.get(
        'SELECT * FROM clover_prereset_launch_rosters WHERE campaign_key=?',
        [campaignKey]
    ).catch(() => null);
    const frozen = await db.all(
        `SELECT player_id,outcome,status
         FROM clover_prereset_launch_players
         WHERE campaign_key=? ORDER BY player_id`,
        [campaignKey]
    ).catch(() => []);
    if (frozen.length) return { roster, source:'launch_players', players:frozen };

    const keepRows = await db.all(
        'SELECT player_id FROM clover_prereset_launch_keep_roster WHERE campaign_key=? ORDER BY player_id',
        [campaignKey]
    ).catch(() => []);
    const keep = new Set(keepRows.map((row) => String(row.player_id)));
    const hasPurge = await tableExists(db, 'clover_prereset_purge_tombstones');
    const players = await db.all(
        `SELECT id AS player_id
         FROM jogadores j
         WHERE ficha_status='aprovada'
           AND COALESCE(is_shadow,0)<>1
           ${hasPurge ? 'AND NOT EXISTS (SELECT 1 FROM clover_prereset_purge_tombstones p WHERE p.player_id=j.id)' : ''}
         ORDER BY id`
    );
    return {
        roster,
        source:'draft_roster_projection',
        players:players.map((row) => ({
            player_id:String(row.player_id),
            outcome:keep.has(String(row.player_id)) ? 'keep' : 'reset',
            status:'projected',
        })),
    };
}

function conversionFor(legacyPr, currentPv, policy) {
    const approved = policy?.status === 'approved';
    const noConversion = legacyPr <= 0;
    const numerator = approved ? Number(policy.numerator) : null;
    const denominator = approved ? Number(policy.denominator) : null;
    const rounding = approved ? String(policy.rounding || '') : null;
    let convertedPv = null;
    if (noConversion) convertedPv = 0;
    else if (approved) {
        const raw = legacyPr * numerator / denominator;
        convertedPv = rounding === 'ceil' ? Math.ceil(raw) : Math.floor(raw);
    }
    return {
        status:noConversion ? 'not_required' : approved ? 'ready' : 'policy_pending',
        policyVersion:approved ? policy.policy_version : null,
        numerator,
        denominator,
        rounding,
        legacyPr,
        convertedPv,
        resultingPv:convertedPv === null ? null : currentPv + convertedPv,
    };
}

async function loadBoxes(db, playerId) {
    if (!await tableExists(db, 'clover_inventory_items')) return [];
    const keys = boxTemplateKeys();
    if (!keys.length) return [];
    const rows = await db.all(
        `SELECT * FROM clover_inventory_items
         WHERE player_id=? AND template_key IN (${keys.map(() => '?').join(',')})
         ORDER BY id`,
        [playerId, ...keys]
    );
    return rows.map((row) => ({
        inventoryItemId:row.id,
        templateKey:row.template_key,
        quality:row.quality ?? null,
        createdAt:row.created_at ?? null,
    }));
}

async function disposableCounts(db, playerId) {
    const boxKeys = boxTemplateKeys();
    const byTable = {};
    for (const tableName of RESET_DELETE_TABLES) {
        if (!await tableExists(db, tableName)) continue;
        let row;
        if (tableName === 'clover_inventory_items' && boxKeys.length) {
            row = await db.get(
                `SELECT COUNT(*) AS total FROM clover_inventory_items
                 WHERE player_id=? AND template_key NOT IN (${boxKeys.map(() => '?').join(',')})`,
                [playerId, ...boxKeys]
            );
        } else {
            row = await db.get(`SELECT COUNT(*) AS total FROM ${tableName} WHERE player_id=?`, [playerId]);
        }
        const total = Number(row?.total || 0);
        if (total > 0) byTable[tableName] = total;
    }
    return {
        byTable,
        totalRows:Object.values(byTable).reduce((sum, value) => sum + Number(value || 0), 0),
        nonBoxInventoryItems:Number(byTable.clover_inventory_items || 0),
    };
}

function preservationPlan(outcome, boxes) {
    const economic = ['current_pv', 'owned_boxes', 'legacy_pr_converted_to_pv'];
    if (outcome === 'keep') {
        return {
            preserved:['character_and_progress', ...economic],
            discarded:[],
        };
    }
    return {
        preserved:['player_identity', 'aliases', 'admin_history', 'group_membership', ...economic],
        discarded:['character_profile', 'character_progress', 'non_box_inventory', 'rolls', 'skills', 'spellbook', 'onboarding', 'character_stats', 'pending_character_actions'],
        preservedBoxCount:boxes.length,
    };
}

async function buildPreResetLaunchPreviewReadOnly(db, request = {}) {
    const campaignKey = normalizeCampaignKey(request.campaignKey || DEFAULT_PRE_RESET_CAMPAIGN_KEY);
    const policy = await loadPolicy(db, campaignKey);
    const rosterState = await loadRoster(db, campaignKey);
    const details = [];
    for (const launchPlayer of rosterState.players) {
        const playerId = String(launchPlayer.player_id);
        const player = await db.get(
            'SELECT id,nome,personagem_nome,ficha_status,jogo_status FROM jogadores WHERE id=?',
            [playerId]
        );
        const currentPv = await sumLedger(db, 'clover_pv_ledger', playerId);
        const legacyPr = await sumLedger(db, 'clover_pr_ledger', playerId);
        const boxes = await loadBoxes(db, playerId);
        const deletion = launchPlayer.outcome === 'reset'
            ? await disposableCounts(db, playerId)
            : { byTable:{}, totalRows:0, nonBoxInventoryItems:0 };
        const conversion = conversionFor(legacyPr, currentPv, policy);
        details.push({
            playerId,
            outcome:launchPlayer.outcome,
            launchStatus:launchPlayer.status,
            characterName:player?.personagem_nome || player?.nome || null,
            fichaStatus:player?.ficha_status || null,
            gameStatus:player?.jogo_status || null,
            currentPv,
            legacyPr,
            conversion,
            resultingPv:conversion.resultingPv,
            boxesPreserved:boxes,
            deletionPlan:{
                willResetCharacter:launchPlayer.outcome === 'reset',
                ...deletion,
            },
            preservationPlan:preservationPlan(launchPlayer.outcome, boxes),
        });
    }
    return {
        campaignKey,
        roster:{
            source:rosterState.source,
            status:rosterState.roster?.status || 'missing',
            revision:Number(rosterState.roster?.revision || 0),
            finalizedAt:rosterState.roster?.finalized_at || null,
        },
        conversionPolicy:{
            status:policy?.status || 'pending',
            policyVersion:policy?.policy_version || null,
            numerator:policy?.numerator == null ? null : Number(policy.numerator),
            denominator:policy?.denominator == null ? null : Number(policy.denominator),
            rounding:policy?.rounding || null,
        },
        blockedByConversionPolicy:details.some((row) => row.conversion.status === 'policy_pending'),
        allReviewable:details.length > 0
            && rosterState.source === 'launch_players'
            && rosterState.roster?.status === 'finalized',
        counts:{
            players:details.length,
            keep:details.filter((row) => row.outcome === 'keep').length,
            reset:details.filter((row) => row.outcome === 'reset').length,
            boxesPreserved:details.reduce((sum, row) => sum + row.boxesPreserved.length, 0),
        },
        players:details,
    };
}

async function previewAgainstDatabase({ dbPath, campaignKey }) {
    const filename = path.resolve(String(dbPath || ''));
    if (!filename || !fs.existsSync(filename)) throw new Error('Arquivo SQLite nao encontrado.');
    const before = sha256File(filename);
    const db = await open({ filename, driver:sqlite3.Database, mode:sqlite3.OPEN_READONLY });
    try {
        await db.exec('PRAGMA query_only=ON');
        return await buildPreResetLaunchPreviewReadOnly(db, { campaignKey });
    } finally {
        await db.close();
        const after = sha256File(filename);
        if (before !== after) throw new Error('Falha de seguranca: SQLite mudou durante preview read-only.');
    }
}

function parseArgs(argv) {
    const values = {};
    for (const arg of argv) {
        const match = String(arg).match(/^--([^=]+)=(.*)$/);
        if (match) values[match[1]] = match[2];
    }
    return values;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.db) {
        console.error('Uso: node scripts/previewPreResetLaunchReadOnly.js --db=C:\\copia.sqlite [--campaign=mythic_launch_v1]');
        process.exitCode = 2;
        return;
    }
    const report = await previewAgainstDatabase({ dbPath:args.db, campaignKey:args.campaign });
    console.log(JSON.stringify(report, null, 2));
    if (!report.allReviewable || report.blockedByConversionPolicy) process.exitCode = 2;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[prereset-launch-preview-readonly] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    RESET_DELETE_TABLES,
    buildPreResetLaunchPreviewReadOnly,
    conversionFor,
    disposableCounts,
    loadBoxes,
    loadRoster,
    previewAgainstDatabase,
};
