'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    EXPECTED_TOTALS,
    PACKAGES,
    calculateTotals,
} = require('./applyNightmareEventRewards');
const {
    characterNameOf,
    normalizeName,
} = require('./auditNightmareRewardTargets');
const { ensurePhState } = require('../helpers/clover/phService');
const { ensureYullsState } = require('../helpers/clover/yullsService');
const {
    NIGHTMARE_EVENT_KEY,
    NIGHTMARE_TITLE,
    applyNightmareRewardPackageInTransaction,
    ensureNightmareRewardInfrastructure,
} = require('../helpers/clover/nightmareEventRewardService');

const ROOT = path.resolve(__dirname, '..');
const DATABASE_PATH = path.join(ROOT, 'banco.sqlite');
const BACKUP_DIR = path.join(ROOT, 'backups');
const TARGET_MAP_PATH = path.join(BACKUP_DIR, 'nightmare-target-map.json');
const APPLY_CONFIRMATION = 'PESADELO-25';
const ACTOR_ID = 'system:evento_pesadelo';

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function checkBotHealth() {
    return new Promise((resolve) => {
        const request = http.get('http://127.0.0.1:8787/health', { timeout: 800 }, (response) => {
            response.resume();
            resolve(response.statusCode === 200);
        });
        request.on('timeout', () => {
            request.destroy();
            resolve(false);
        });
        request.on('error', () => resolve(false));
    });
}

async function checkpointDatabase() {
    const db = await open({ filename: DATABASE_PATH, driver: sqlite3.Database });
    try {
        await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
        await db.close();
    }
}

function createBackup(runStamp) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, `before-nightmare-rewards-${runStamp}.sqlite`);
    fs.copyFileSync(DATABASE_PATH, backupPath);
    return backupPath;
}

function readAndValidateMap() {
    if (!fs.existsSync(TARGET_MAP_PATH)) {
        throw new Error('Mapa dos 25 alvos não encontrado. Execute npm run preview:nightmare-rewards primeiro.');
    }
    const map = JSON.parse(fs.readFileSync(TARGET_MAP_PATH, 'utf8'));
    if (map.eventKey !== NIGHTMARE_EVENT_KEY) throw new Error('Mapa pertence a outro evento.');
    if (!Array.isArray(map.entries) || map.entries.length !== EXPECTED_TOTALS.players) {
        throw new Error(`Mapa precisa conter exatamente ${EXPECTED_TOTALS.players} entradas.`);
    }
    const ids = new Set();
    for (const entry of map.entries) {
        if (!PACKAGES[entry.packageKey]) throw new Error(`Pacote inválido no mapa para ${entry.characterName}.`);
        if (!entry.playerId) throw new Error(`ID ausente no mapa para ${entry.characterName}.`);
        if (ids.has(entry.playerId)) throw new Error(`ID duplicado no mapa: ${entry.playerId}`);
        ids.add(entry.playerId);
    }
    const totals = calculateTotals(map.entries);
    for (const [field, expected] of Object.entries(EXPECTED_TOTALS)) {
        if (totals[field] !== expected) {
            throw new Error(`Mapa fecha ${field}=${totals[field]}, esperado ${expected}.`);
        }
    }
    return { map, totals };
}

async function validateMapAgainstDatabase(db, entries) {
    const validated = [];
    for (const entry of entries) {
        const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [entry.playerId]);
        if (!player) throw new Error(`Cadastro do mapa não existe mais: ${entry.playerId}`);
        const actualCharacter = characterNameOf(player);
        if (!actualCharacter) throw new Error(`Cadastro do mapa ficou sem personagem: ${entry.playerId}`);
        if (normalizeName(actualCharacter) !== normalizeName(entry.resolvedCharacterName)) {
            throw new Error(
                `Personagem mudou desde a auditoria: ${entry.resolvedCharacterName} -> ${actualCharacter} (${entry.playerId}).`
            );
        }
        validated.push({
            ...entry,
            actualCharacter,
            rewardPackage: PACKAGES[entry.packageKey],
        });
    }
    return validated;
}

async function auditAppliedTotals(db) {
    const yulls = await db.get(
        `SELECT COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS total
         FROM clover_yulls_ledger
         WHERE idempotency_key LIKE ?`,
        [`${NIGHTMARE_EVENT_KEY}:%:yulls`]
    );
    const ph = await db.get(
        `SELECT COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS total
         FROM clover_ph_ledger
         WHERE source = 'evento_pesadelo' AND related_id LIKE ?`,
        [`${NIGHTMARE_EVENT_KEY}:%:ph`]
    );
    const itemRows = await db.all(
        `SELECT idempotency_key,
                COALESCE(SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END), 0) AS total
         FROM clover_inventory_item_history
         WHERE idempotency_key LIKE ?
         GROUP BY idempotency_key`,
        [`${NIGHTMARE_EVENT_KEY}:%`]
    );
    const items = {
        rareBoxes: 0,
        commonBoxes: 0,
        spellTickets: 0,
        priorityCoupons: 0,
        provisionalBlackWands: 0,
    };
    for (const row of itemRows) {
        const key = String(row.idempotency_key || '');
        const value = Number(row.total || 0);
        if (key.endsWith(':caixas_raras')) items.rareBoxes += value;
        else if (key.endsWith(':caixas_comuns')) items.commonBoxes += value;
        else if (key.endsWith(':tickets_feitico')) items.spellTickets += value;
        else if (key.endsWith(':cupons_prioridade')) items.priorityCoupons += value;
        else if (key.endsWith(':varetas_negras_provisorias')) items.provisionalBlackWands += value;
    }
    const titles = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_player_titles
         WHERE title_key = ? AND related_id = ?`,
        [NIGHTMARE_TITLE.key, NIGHTMARE_EVENT_KEY]
    );
    return {
        players: Number(yulls.entries || 0),
        yulls: Number(yulls.total || 0),
        ph: Number(ph.total || 0),
        rareBoxes: items.rareBoxes,
        commonBoxes: items.commonBoxes,
        titles: Number(titles.total || 0),
        spellTickets: items.spellTickets,
        priorityCoupons: items.priorityCoupons,
        provisionalBlackWands: items.provisionalBlackWands,
    };
}

function assertTotals(actual) {
    for (const [field, expected] of Object.entries(EXPECTED_TOTALS)) {
        if (actual[field] !== expected) {
            throw new Error(`Auditoria final falhou em ${field}: esperado ${expected}, encontrado ${actual[field]}.`);
        }
    }
}

async function main() {
    const confirmation = process.argv.find((argument) => argument.startsWith('--confirm='))?.split('=')[1] || '';
    if (confirmation !== APPLY_CONFIRMATION) {
        throw new Error(`Confirmação inválida. Use --confirm=${APPLY_CONFIRMATION}`);
    }
    if (!fs.existsSync(DATABASE_PATH)) throw new Error(`Banco não encontrado: ${DATABASE_PATH}`);
    if (await checkBotHealth()) {
        throw new Error('O Clover ainda está online na porta 8787. Pare somente o processo PM2 do bot antes de aplicar.');
    }

    const { map, totals } = readAndValidateMap();
    const runStamp = stamp();
    await checkpointDatabase();
    const backupPath = createBackup(runStamp);
    console.log(`\nBackup criado: ${backupPath}`);

    const db = await open({ filename: DATABASE_PATH, driver: sqlite3.Database });
    try {
        const entries = await validateMapAgainstDatabase(db, map.entries);
        await ensureNightmareRewardInfrastructure(db);
        for (const entry of entries) {
            await ensurePhState(db, entry.playerId);
            await ensureYullsState(db, entry.playerId);
        }

        const results = [];
        await db.exec('BEGIN IMMEDIATE');
        try {
            for (const entry of entries) {
                results.push({
                    playerId: entry.playerId,
                    characterName: entry.actualCharacter,
                    packageKey: entry.packageKey,
                    result: await applyNightmareRewardPackageInTransaction(
                        db,
                        entry.playerId,
                        entry.rewardPackage,
                        ACTOR_ID
                    ),
                });
            }
            await db.exec('COMMIT');
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => null);
            throw error;
        }

        const appliedTotals = await auditAppliedTotals(db);
        assertTotals(appliedTotals);
        const integrity = await db.get('PRAGMA integrity_check');
        const integrityValue = integrity?.integrity_check || Object.values(integrity || {})[0];
        if (integrityValue !== 'ok') throw new Error(`SQLite integrity_check: ${integrityValue || 'resultado ausente'}`);

        const reportPath = path.join(BACKUP_DIR, `nightmare-rewards-${runStamp}.json`);
        fs.writeFileSync(reportPath, JSON.stringify({
            ok: true,
            generatedAt: new Date().toISOString(),
            eventKey: NIGHTMARE_EVENT_KEY,
            targetMap: TARGET_MAP_PATH,
            backup: backupPath,
            expectedTotals: totals,
            appliedTotals,
            results,
            integrityCheck: integrityValue,
        }, null, 2), 'utf8');

        console.log('\n=== PREMIAÇÃO APLICADA ===');
        console.log(`Jogadores: ${appliedTotals.players}`);
        console.log(`Yulls: ${appliedTotals.yulls.toLocaleString('pt-BR')}`);
        console.log(`PH: ${appliedTotals.ph.toLocaleString('pt-BR')}`);
        console.log(`Caixas Raras: ${appliedTotals.rareBoxes}`);
        console.log(`Caixas Comuns: ${appliedTotals.commonBoxes}`);
        console.log(`Títulos: ${appliedTotals.titles}`);
        console.log(`Tickets de Feitiço: ${appliedTotals.spellTickets}`);
        console.log(`Cupons de Prioridade: ${appliedTotals.priorityCoupons}`);
        console.log(`Varetas Negras provisórias: ${appliedTotals.provisionalBlackWands}`);
        console.log(`SQLite: ${integrityValue}`);
        console.log(`Relatório: ${reportPath}`);
    } finally {
        await db.close();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('\nFALHA NA APLICAÇÃO DA PREMIAÇÃO:');
        console.error(error.stack || error.message || error);
        process.exitCode = 1;
    });
}
