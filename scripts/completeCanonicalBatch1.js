'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    assertExpectedCounts,
    runChecked,
} = require('./finishCanonicalBatch1');

const ROOT = path.resolve(__dirname, '..');
const DATABASE = path.join(ROOT, 'banco.sqlite');
const FULL_MANIFEST = path.join(ROOT, 'data', 'player-canonical-batch-1-import.json');
const OUTPUT = path.join(ROOT, 'backups');
const PLAYER_ID = '119516088528998@lid';
const SOURCE = 'admin_whatsapp_2026-07-20';
const PM2 = process.platform === 'win32' ? 'pm2.cmd' : 'pm2';
const REPAIR_CONFIRMATION = 'REPAIR_VITOR_ACCESS_REGRESSION';
const IMPORT_CONFIRMATION = 'IMPORT_CANONICAL_PLAYER_CONTENT_BATCH1';

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHealth() {
    return new Promise((resolve) => {
        const request = http.get('http://127.0.0.1:8787/health', (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch {
                    resolve(null);
                }
            });
        });
        request.setTimeout(5000, () => request.destroy(new Error('timeout')));
        request.on('error', () => resolve(null));
    });
}

async function waitForIdle() {
    console.log('\n=== AGUARDANDO FILA DO CLOVER ===');
    for (let attempt = 1; attempt <= 30; attempt += 1) {
        const health = await getHealth();
        const depth = Number(health?.queue?.depth || 0);
        const active = Boolean(health?.queue?.active);
        if (health) {
            console.log(`Tentativa ${attempt}: online=${Boolean(health.ok)} depth=${depth} active=${active}`);
        }
        if (health?.ok && depth === 0 && !active) return;
        await delay(2000);
    }
    throw new Error('A fila do Clover não ficou livre.');
}

async function waitForOnline() {
    console.log('\n=== AGUARDANDO HEALTH DO CLOVER ===');
    for (let attempt = 1; attempt <= 30; attempt += 1) {
        await delay(2000);
        const health = await getHealth();
        if (health?.ok) {
            console.log(JSON.stringify(health, null, 2));
            return;
        }
    }
    throw new Error('O Clover não voltou a responder ao health.');
}

async function readProgress() {
    const db = await open({
        filename: DATABASE,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    try {
        await db.exec('PRAGMA query_only = ON');
        const totals = await db.all(
            `SELECT content_type, COUNT(*) AS total
             FROM clover_player_content
             WHERE active = 1 AND source = ?
             GROUP BY content_type`,
            [SOURCE]
        );
        const overall = await db.get(
            `SELECT COUNT(*) AS total
             FROM clover_player_content
             WHERE active = 1 AND source = ?`,
            [SOURCE]
        );
        const vitor = await db.get(
            `SELECT COUNT(*) AS total
             FROM clover_player_content
             WHERE active = 1 AND source = ? AND player_id = ?`,
            [SOURCE, PLAYER_ID]
        );
        return {
            total: Number(overall?.total || 0),
            vitor: Number(vitor?.total || 0),
            byType: Object.fromEntries(totals.map((row) => [row.content_type, Number(row.total)])),
        };
    } finally {
        await db.close();
    }
}

function selectResumeMode(progress) {
    if (progress.total === 0 && progress.vitor === 0) return 'full';
    if (progress.total === 22 && progress.vitor === 2) return 'verify_only';
    if (
        progress.total === 20
        && progress.vitor === 0
        && Number(progress.byType.system_trait || 0) === 8
        && Number(progress.byType.custom_trait || 0) === 7
        && Number(progress.byType.narrative_hook || 0) === 3
        && Number(progress.byType.narrative_item || 0) === 2
    ) {
        return 'vitor_only';
    }
    throw new Error(`Estado canônico inesperado: total=${progress.total}, Vitor=${progress.vitor}.`);
}

function createVitorManifest() {
    const manifest = JSON.parse(fs.readFileSync(FULL_MANIFEST, 'utf8').replace(/^\uFEFF/, ''));
    const player = manifest.players?.find((entry) => entry.playerId === PLAYER_ID);
    if (!player || !Array.isArray(player.records) || player.records.length !== 2) {
        throw new Error('O manifesto principal não contém exatamente os 2 registros de Vitor.');
    }
    fs.mkdirSync(OUTPUT, { recursive: true });
    const file = path.join(OUTPUT, 'player-canonical-batch-1-import-vitor-only.json');
    fs.writeFileSync(file, JSON.stringify({ ...manifest, players: [player] }, null, 2), 'utf8');
    return file;
}

async function verifyFinalState() {
    console.log('\n=== VERIFICAÇÃO FINAL SOMENTE LEITURA ===');
    const db = await open({
        filename: DATABASE,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    try {
        await db.exec('PRAGMA query_only = ON');
        const player = await db.get(
            `SELECT personagem_nome, jogo_status, jogo_liberado_at,
                    jogo_liberado_by, jogo_bloqueio_motivo
             FROM jogadores WHERE id = ?`,
            [PLAYER_ID]
        );
        const totals = await db.all(
            `SELECT content_type, COUNT(*) AS total
             FROM clover_player_content
             WHERE active = 1 AND source = ?
             GROUP BY content_type ORDER BY content_type`,
            [SOURCE]
        );
        const overall = await db.get(
            `SELECT COUNT(*) AS total FROM clover_player_content
             WHERE active = 1 AND source = ?`,
            [SOURCE]
        );
        const vitor = await db.all(
            `SELECT content_type, content_key, title
             FROM clover_player_content
             WHERE active = 1 AND source = ? AND player_id = ?
             ORDER BY content_type, content_key`,
            [SOURCE, PLAYER_ID]
        );
        const pending = await db.get(
            `SELECT COUNT(*) AS total FROM clover_player_content
             WHERE active = 1 AND source = ?
               AND content_type = 'custom_trait'
               AND mechanical_status = 'pending_balance'`,
            [SOURCE]
        );
        const linked = await db.get(
            `SELECT COUNT(*) AS total FROM clover_player_content
             WHERE active = 1 AND source = ?
               AND content_type = 'narrative_item'
               AND linked_content_id IS NOT NULL`,
            [SOURCE]
        );

        if (!player || player.personagem_nome !== 'Vitor') throw new Error('Cadastro de Vitor ausente.');
        if (String(player.jogo_status || '').toLowerCase() !== 'liberado') throw new Error('Vitor não está liberado.');
        if (!player.jogo_liberado_at || !player.jogo_liberado_by || player.jogo_bloqueio_motivo) {
            throw new Error('Metadados de acesso de Vitor estão inconsistentes.');
        }

        assertExpectedCounts({ totals, overall, vitor, pending, linked });

        const foreignKeys = await db.all('PRAGMA foreign_key_check');
        if (foreignKeys.length) throw new Error(`foreign_key_check: ${foreignKeys.length} falha(s).`);
        const integrity = await db.all('PRAGMA integrity_check');
        const failures = integrity
            .flatMap((row) => Object.values(row))
            .filter((value) => String(value).toLowerCase() !== 'ok');
        if (failures.length) throw new Error(`integrity_check: ${failures.join('; ')}`);

        console.table(totals);
        console.table(vitor);
        console.log('Total canônico: 22');
        console.log('Integridade SQLite: OK');
    } finally {
        await db.close();
    }
}

async function main() {
    process.chdir(ROOT);
    console.log('\n=== CONCLUSÃO CANÔNICA — LOTE 1 ===');

    const progress = await readProgress();
    const mode = selectResumeMode(progress);
    console.log(`Estado encontrado: total=${progress.total}, Vitor=${progress.vitor}, modo=${mode}`);

    if (mode === 'verify_only') {
        await verifyFinalState();
        console.log('\n=== LOTE 1 CONCLUÍDO: 10 JOGADORES, 22 REGISTROS ===');
        return;
    }

    const manifest = mode === 'vitor_only' ? createVitorManifest() : FULL_MANIFEST;
    await waitForIdle();

    let stopped = false;
    let failure = null;
    try {
        console.log('\n=== PARANDO SOMENTE O CLOVER — PM2 ID 1 ===');
        runChecked(PM2, ['stop', '1'], 'Não foi possível parar o PM2 ID 1.');
        stopped = true;

        console.log('\n=== GARANTINDO ACESSO DE VITOR ===');
        runChecked(process.execPath, [
            'scripts/repairVitorAccessRegression.js',
            `--db=${DATABASE}`,
            `--output=${OUTPUT}`,
            '--apply',
            `--confirm=${REPAIR_CONFIRMATION}`,
        ], 'A validação/reparação de Vitor falhou.');

        console.log(mode === 'vitor_only'
            ? '\n=== IMPORTANDO SOMENTE OS 2 REGISTROS DE VITOR ==='
            : '\n=== IMPORTANDO OS 22 REGISTROS CANÔNICOS ===');
        runChecked(process.execPath, [
            'scripts/importCanonicalPlayerContentBatch1.js',
            `--db=${DATABASE}`,
            `--manifest=${manifest}`,
            `--output=${OUTPUT}`,
            '--apply',
            `--confirm=${IMPORT_CONFIRMATION}`,
        ], 'A importação canônica falhou.');

        await verifyFinalState();
    } catch (error) {
        failure = error;
    } finally {
        if (stopped) {
            console.log('\n=== RELIGANDO SOMENTE O CLOVER — PM2 ID 1 ===');
            try {
                runChecked(PM2, ['restart', '1', '--update-env'], 'Falha ao religar o PM2 ID 1.');
            } catch (restartError) {
                failure = failure || restartError;
            }
        }
        if (mode === 'vitor_only' && manifest !== FULL_MANIFEST) {
            try { fs.unlinkSync(manifest); } catch {}
        }
    }

    if (failure) throw failure;
    await waitForOnline();
    runChecked(PM2, ['save'], 'O lote concluiu, mas o pm2 save falhou.');
    console.log('\n=== LOTE 1 CONCLUÍDO: 10 JOGADORES, 22 REGISTROS ===');
}

if (require.main === module) {
    main().catch((error) => {
        console.error('\nFALHA NA CONCLUSÃO CANÔNICA:');
        console.error(error?.stack || error);
        process.exitCode = 1;
    });
}

module.exports = { selectResumeMode };
