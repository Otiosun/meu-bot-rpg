'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { extractPhoneNumber, normalizeJid } = require('../helpers/groupAccess');

const DATABASE_FILE = path.resolve(process.argv[2] || 'banco.sqlite');
const REPORT_DIR = path.resolve(process.argv[3] || 'backups');

const ACTIVITY_SOURCES = [
    { table: 'player_rolls', column: 'player_id', label: 'rolls', substantive: true },
    { table: 'clover_trait_attempts', column: 'player_id', label: 'traitAttempts', substantive: true },
    { table: 'clover_inventory_items', column: 'player_id', label: 'inventoryItems', substantive: true },
    { table: 'clover_market_listings', column: 'seller_id', label: 'marketListings', substantive: true },
    { table: 'clover_raid_participants', column: 'player_id', label: 'raidParticipations', substantive: true },
    { table: 'clover_character_stats', column: 'player_id', label: 'characterStats', substantive: false },
    { table: 'clover_site_sessions', column: 'player_id', label: 'siteSessions', substantive: false },
    { table: 'player_onboarding', column: 'player_id', label: 'onboardingRows', substantive: false },
];

const GENERIC_NAMES = new Set([
    '', '-', 'cacador', 'caçador', 'jogador', 'player', 'hunter', 'sem identificacao', 'sem identificação',
]);

function openReadOnly(filename) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, sqlite3.OPEN_READONLY, (error) => {
            if (error) reject(error);
            else resolve(db);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(rows || []);
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => {
            if (error) reject(error);
            else resolve(row || null);
        });
    });
}

function close(db) {
    return new Promise((resolve) => db.close(() => resolve()));
}

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function hasFilledValue(value) {
    const text = String(value || '').trim();
    return Boolean(text) && text !== '-';
}

function isGenericName(value) {
    return GENERIC_NAMES.has(normalizeText(value));
}

function safeName(player) {
    for (const field of ['personagem_nome', 'nome', 'display_name', 'nome_real']) {
        const value = String(player?.[field] || '').trim();
        if (value && value !== '-') return value;
    }
    return String(player?.id || 'Sem identificação');
}

function profileSignals(player) {
    const game = normalizeText(player.jogo_status);
    const profile = normalizeText(player.ficha_status);
    const history = normalizeText(player.historia_status);
    const appearance = normalizeText(player.personagem_aparencia_status);
    const approvedProfile = ['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(profile);
    const released = game === 'liberado';
    const approvedHistory = ['aprovada', 'aprovado'].includes(history);
    const approvedAppearance = ['approved', 'aprovada', 'aprovado'].includes(appearance);
    const meaningfulFields = ['personagem_nome', 'raca', 'classe', 'grimorio', 'magia']
        .filter((field) => hasFilledValue(player[field]) && !isGenericName(player[field]));
    const identityName = safeName(player);
    const meaningfulName = !isGenericName(identityName) && !identityName.includes('@');
    const meaningfulProfile = released
        || approvedProfile
        || approvedHistory
        || approvedAppearance
        || meaningfulFields.length > 0
        || meaningfulName;

    let score = 0;
    if (released) score += 1000;
    if (approvedProfile) score += 500;
    if (approvedHistory) score += 100;
    if (approvedAppearance) score += 100;
    score += meaningfulFields.length * 10;
    if (meaningfulName) score += 10;

    return {
        approvedProfile,
        released,
        approvedHistory,
        approvedAppearance,
        meaningfulFields,
        meaningfulName,
        meaningfulProfile,
        score,
    };
}

async function tableColumns(db, table) {
    try {
        return await all(db, `PRAGMA table_info("${table}")`);
    } catch {
        return [];
    }
}

async function countActivity(db, source, playerId) {
    const columns = await tableColumns(db, source.table);
    if (!columns.some((column) => column.name === source.column)) return 0;
    const row = await get(
        db,
        `SELECT COUNT(*) AS total FROM "${source.table}" WHERE "${source.column}" = ?`,
        [playerId]
    );
    return Number(row?.total || 0);
}

async function inspectPlayer(db, player) {
    const activity = {};
    for (const source of ACTIVITY_SOURCES) {
        activity[source.label] = await countActivity(db, source, player.id);
    }

    const substantiveActivityTotal = ACTIVITY_SOURCES
        .filter((source) => source.substantive)
        .reduce((sum, source) => sum + Number(activity[source.label] || 0), 0);
    const supportActivityTotal = ACTIVITY_SOURCES
        .filter((source) => !source.substantive)
        .reduce((sum, source) => sum + Number(activity[source.label] || 0), 0);
    const profile = profileSignals(player);
    const hasSubstantiveData = substantiveActivityTotal > 0 || profile.meaningfulProfile;

    return {
        id: player.id,
        name: safeName(player),
        canonicalId: normalizeJid(player.id),
        phone: extractPhoneNumber(player.id),
        fichaStatus: player.ficha_status || null,
        historiaStatus: player.historia_status || null,
        aparenciaStatus: player.personagem_aparencia_status || null,
        jogoStatus: player.jogo_status || null,
        activity,
        substantiveActivityTotal,
        supportActivityTotal,
        activityTotal: substantiveActivityTotal + supportActivityTotal,
        profile,
        hasSubstantiveData,
        score: profile.score + substantiveActivityTotal * 25 + supportActivityTotal,
    };
}

function compareCandidates(left, right) {
    return Number(right.hasSubstantiveData) - Number(left.hasSubstantiveData)
        || right.score - left.score
        || right.substantiveActivityTotal - left.substantiveActivityTotal
        || right.supportActivityTotal - left.supportActivityTotal
        || left.id.localeCompare(right.id);
}

function chooseDataOwner(candidates) {
    return [...candidates].sort(compareCandidates)[0] || null;
}

function resolveCanonicalTarget(phone, candidates) {
    const normalizedPhoneJid = normalizeJid(`${phone}@s.whatsapp.net`);
    return candidates.find((candidate) => candidate.id === normalizedPhoneJid)
        || candidates.find((candidate) => candidate.canonicalId === normalizedPhoneJid)
        || null;
}

function classifyGroup(candidates, dataOwner, canonicalTarget) {
    const substantive = candidates.filter((candidate) => candidate.hasSubstantiveData);
    if (substantive.length > 1) return 'manual_merge_required';
    if (substantive.length === 0) return 'empty_duplicate';
    if (canonicalTarget && dataOwner && canonicalTarget.id !== dataOwner.id) {
        return 'canonical_migration_required';
    }
    return 'simple_alias';
}

(async () => {
    if (!fs.existsSync(DATABASE_FILE)) {
        throw new Error(`Banco não encontrado: ${DATABASE_FILE}`);
    }

    const db = await openReadOnly(DATABASE_FILE);
    try {
        const players = await all(
            db,
            `SELECT id, nome, display_name, nome_real, personagem_nome, raca, classe, grimorio, magia,
                    ficha_status, historia_status, personagem_aparencia_status, jogo_status
             FROM jogadores
             ORDER BY id ASC`
        );

        const byPhone = new Map();
        for (const player of players) {
            const phone = extractPhoneNumber(player.id);
            if (!phone) continue;
            if (!byPhone.has(phone)) byPhone.set(phone, []);
            byPhone.get(phone).push(player);
        }

        const duplicateGroups = [];
        for (const [phone, group] of byPhone.entries()) {
            if (group.length < 2) continue;
            const candidates = [];
            for (const player of group) candidates.push(await inspectPlayer(db, player));
            const dataOwner = chooseDataOwner(candidates);
            const canonicalTarget = resolveCanonicalTarget(phone, candidates) || dataOwner;
            const classification = classifyGroup(candidates, dataOwner, canonicalTarget);
            duplicateGroups.push({
                phone,
                candidateCount: candidates.length,
                classification,
                recommendedDataOwnerId: dataOwner?.id || null,
                recommendedCanonicalId: canonicalTarget?.id || null,
                migrationRequired: Boolean(dataOwner && canonicalTarget && dataOwner.id !== canonicalTarget.id),
                candidates,
            });
        }

        const classificationOrder = new Map([
            ['manual_merge_required', 0],
            ['canonical_migration_required', 1],
            ['simple_alias', 2],
            ['empty_duplicate', 3],
        ]);
        duplicateGroups.sort((left, right) => (
            (classificationOrder.get(left.classification) ?? 99)
            - (classificationOrder.get(right.classification) ?? 99)
            || left.phone.localeCompare(right.phone)
        ));

        const report = {
            generatedAt: new Date().toISOString(),
            database: DATABASE_FILE,
            playersScanned: players.length,
            duplicatePhones: duplicateGroups.length,
            manualMergeRequired: duplicateGroups.filter((group) => group.classification === 'manual_merge_required').length,
            canonicalMigrationsRequired: duplicateGroups.filter((group) => group.classification === 'canonical_migration_required').length,
            simpleAliases: duplicateGroups.filter((group) => group.classification === 'simple_alias').length,
            emptyDuplicates: duplicateGroups.filter((group) => group.classification === 'empty_duplicate').length,
            groups: duplicateGroups,
        };

        fs.mkdirSync(REPORT_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const reportPath = path.join(REPORT_DIR, `identity-alias-audit-${stamp}.json`);
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

        console.log('\n=== AUDITORIA DE IDENTIDADES ===');
        console.log(`Jogadores analisados: ${report.playersScanned}`);
        console.log(`Telefones duplicados: ${report.duplicatePhones}`);
        console.log(`Exigem fusão manual: ${report.manualMergeRequired}`);
        console.log(`Exigem migração ao ID canônico: ${report.canonicalMigrationsRequired}`);
        console.log(`Aliases simples: ${report.simpleAliases}`);
        console.log(`Duplicatas vazias: ${report.emptyDuplicates}`);

        for (const group of duplicateGroups) {
            console.log('\n----------------------------------------');
            console.log(`Telefone: +${group.phone}`);
            console.log(`Classificação: ${group.classification}`);
            console.log(`Dono dos dados: ${group.recommendedDataOwnerId}`);
            console.log(`ID canônico: ${group.recommendedCanonicalId}`);
            console.table(group.candidates.map((candidate) => ({
                id: candidate.id,
                nome: candidate.name,
                score: candidate.score,
                dados_reais: candidate.hasSubstantiveData,
                atividade_real: candidate.substantiveActivityTotal,
                apoio: candidate.supportActivityTotal,
                rolls: candidate.activity.rolls,
                tracos: candidate.activity.traitAttempts,
                itens: candidate.activity.inventoryItems,
                raids: candidate.activity.raidParticipations,
                anuncios: candidate.activity.marketListings,
            })));
        }

        console.log('\nRelatório salvo em:');
        console.log(reportPath);
        console.log('\nNenhum dado foi alterado.');
    } finally {
        await close(db);
    }
})().catch((error) => {
    console.error('\nFALHA NA AUDITORIA:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
