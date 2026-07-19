'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { extractPhoneNumber, normalizeJid } = require('../helpers/groupAccess');

const DATABASE_FILE = path.resolve(process.argv[2] || 'banco.sqlite');
const REPORT_DIR = path.resolve(process.argv[3] || 'backups');

const ACTIVITY_SOURCES = [
    { table: 'player_rolls', column: 'player_id', label: 'rolls' },
    { table: 'clover_trait_attempts', column: 'player_id', label: 'traitAttempts' },
    { table: 'clover_inventory_items', column: 'player_id', label: 'inventoryItems' },
    { table: 'clover_character_stats', column: 'player_id', label: 'characterStats' },
    { table: 'clover_site_sessions', column: 'player_id', label: 'siteSessions' },
    { table: 'player_onboarding', column: 'player_id', label: 'onboardingRows' },
    { table: 'clover_market_listings', column: 'seller_id', label: 'marketListings' },
    { table: 'clover_raid_participants', column: 'player_id', label: 'raidParticipations' },
];

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

function safeName(player) {
    for (const field of ['personagem_nome', 'nome', 'display_name', 'nome_real']) {
        const value = String(player?.[field] || '').trim();
        if (value && value !== '-') return value;
    }
    return String(player?.id || 'Sem identificação');
}

function normalizedStatus(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function profileScore(player) {
    let score = 0;
    const game = normalizedStatus(player.jogo_status);
    const profile = normalizedStatus(player.ficha_status);
    const history = normalizedStatus(player.historia_status);
    const appearance = normalizedStatus(player.personagem_aparencia_status);

    if (game === 'liberado') score += 1000;
    if (['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(profile)) score += 500;
    if (['aprovada', 'aprovado'].includes(history)) score += 100;
    if (['approved', 'aprovada', 'aprovado'].includes(appearance)) score += 100;

    for (const field of ['personagem_nome', 'nome', 'raca', 'classe', 'grimorio', 'magia']) {
        const value = String(player[field] || '').trim();
        if (value && value !== '-') score += 10;
    }

    return score;
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

    const activityTotal = Object.values(activity).reduce((sum, value) => sum + Number(value || 0), 0);
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
        activityTotal,
        score: profileScore(player) + activityTotal * 25,
    };
}

function chooseRecommendation(candidates) {
    const mappedCanonicalIds = new Set(candidates.map((candidate) => candidate.canonicalId).filter(Boolean));
    const canonicalRecords = candidates.filter((candidate) => mappedCanonicalIds.has(candidate.id));
    const pool = canonicalRecords.length ? canonicalRecords : candidates;
    return [...pool].sort((left, right) => right.score - left.score || right.activityTotal - left.activityTotal)[0] || null;
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
            const recommendation = chooseRecommendation(candidates);
            const activeCandidates = candidates.filter((candidate) => candidate.activityTotal > 0 || candidate.score >= 500);
            duplicateGroups.push({
                phone,
                candidateCount: candidates.length,
                recommendedCanonicalId: recommendation?.id || null,
                classification: activeCandidates.length > 1 ? 'manual_merge_required' : 'simple_alias',
                candidates,
            });
        }

        duplicateGroups.sort((left, right) => {
            if (left.classification !== right.classification) {
                return left.classification === 'manual_merge_required' ? -1 : 1;
            }
            return left.phone.localeCompare(right.phone);
        });

        const report = {
            generatedAt: new Date().toISOString(),
            database: DATABASE_FILE,
            playersScanned: players.length,
            duplicatePhones: duplicateGroups.length,
            manualMergeRequired: duplicateGroups.filter((group) => group.classification === 'manual_merge_required').length,
            simpleAliases: duplicateGroups.filter((group) => group.classification === 'simple_alias').length,
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
        console.log(`Aliases simples: ${report.simpleAliases}`);

        for (const group of duplicateGroups) {
            console.log('\n----------------------------------------');
            console.log(`Telefone: +${group.phone}`);
            console.log(`Classificação: ${group.classification}`);
            console.log(`Recomendado: ${group.recommendedCanonicalId}`);
            console.table(group.candidates.map((candidate) => ({
                id: candidate.id,
                nome: candidate.name,
                score: candidate.score,
                atividade: candidate.activityTotal,
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
