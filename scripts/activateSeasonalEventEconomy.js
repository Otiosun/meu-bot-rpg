'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { auditRecruitmentFlow } = require('../helpers/clover/recruitmentFlowAuditV2');
const { ensureSeasonalRelicSchema, getRelicState } = require('../helpers/clover/boxService');
const { ensurePrShopSchema, PR_SHOP_CATALOG } = require('../helpers/clover/prShopService');
const { validateBoxCatalogs } = require('../helpers/clover/seasonalEventCatalog');

const ROOT = path.resolve(__dirname, '..');
const DATABASE_PATH = path.join(ROOT, 'banco.sqlite');
const BACKUP_DIR = path.join(ROOT, 'backups');

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
    const backupPath = path.join(BACKUP_DIR, `before-seasonal-event-activation-${runStamp}.sqlite`);
    fs.copyFileSync(DATABASE_PATH, backupPath);
    return backupPath;
}

async function tableExists(db, name) {
    return Boolean(await db.get(
        `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [name]
    ));
}

async function activate(db) {
    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensurePrShopSchema(db);
        await ensureSeasonalRelicSchema(db);
        const event = await db.get(`
            SELECT id, event_key, name, status, shop_enabled, starts_at, ends_at
            FROM clover_recruitment_events
            WHERE event_key = 'divulgacao_v1'
        `);
        if (!event) throw new Error('Evento de Divulgação não encontrado.');
        if (!Number(event.shop_enabled)) throw new Error('A Loja de PR não foi habilitada.');

        const requiredTables = [
            'clover_pr_shop_purchases',
            'clover_recruitment_group_submissions',
            'clover_seasonal_relic_ownership',
        ];
        for (const table of requiredTables) {
            if (!await tableExists(db, table)) throw new Error(`Tabela não inicializada: ${table}`);
        }
        await db.exec('COMMIT');
        return event;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function main() {
    console.log('\n=== ATIVAÇÃO DA ECONOMIA SAZONAL ===');
    console.log('Modo: APLICAÇÃO CONTROLADA');

    if (!fs.existsSync(DATABASE_PATH)) {
        throw new Error(`Banco não encontrado: ${DATABASE_PATH}`);
    }
    if (await checkBotHealth()) {
        throw new Error('O Clover ainda está online na porta 8787. Pare somente o PM2 ID 1 antes de executar.');
    }

    const runStamp = stamp();
    await checkpointDatabase();
    const backupPath = createBackup(runStamp);
    const db = await open({ filename: DATABASE_PATH, driver: sqlite3.Database });

    try {
        const event = await activate(db);
        const boxCatalogs = validateBoxCatalogs();
        const relics = await getRelicState(db);
        const audit = await auditRecruitmentFlow(db);
        const reportPath = path.join(BACKUP_DIR, `seasonal-event-activation-${runStamp}.json`);
        const report = {
            ok: true,
            generatedAt: new Date().toISOString(),
            database: DATABASE_PATH,
            backup: backupPath,
            event,
            shop: {
                enabled: Boolean(event.shop_enabled),
                offers: PR_SHOP_CATALOG.map((item) => ({
                    key: item.key,
                    name: item.name,
                    cost: item.cost,
                    limits: item.limits,
                })),
            },
            boxes: boxCatalogs,
            relics,
            recruitmentAudit: {
                summary: audit.summary,
                capabilities: audit.capabilities,
                issues: audit.issues,
            },
        };
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

        console.log(`Backup: ${backupPath}`);
        console.log(`Relatório: ${reportPath}`);
        console.log(`Loja: ${report.shop.enabled ? 'ativa' : 'inativa'} · ${report.shop.offers.length} ofertas`);
        console.log(`Caixas: ${boxCatalogs.map((box) => `${box.key}=${box.totalChance}%`).join(' · ')}`);
        console.log(`Relíquias: ${relics.available}/${relics.total} disponíveis`);
        console.log(`Recrutamento: ${audit.summary.issues} apontamento(s) · críticos=${audit.summary.critical}`);

        if (Number(audit.summary.critical || 0) > 0) {
            console.log('\nApontamentos críticos restantes:');
            for (const issue of audit.issues.filter((item) => item.severity === 'critical')) {
                console.log(`- ${issue.code}: ${issue.message}`);
            }
            process.exitCode = 2;
            return;
        }
        console.log('\n=== ECONOMIA SAZONAL ATIVADA E VALIDADA ===');
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('\nFALHA NA ATIVAÇÃO:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
