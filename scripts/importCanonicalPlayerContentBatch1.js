'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    assertContentRecord,
    ensureCloverPlayerContentSchema,
    normalizeContentKey,
} = require('../helpers/clover/playerContentService');

const args = process.argv.slice(2);
const DATABASE_FILE = path.resolve(args.find((arg) => arg.startsWith('--db='))?.slice('--db='.length) || 'banco.sqlite');
const MANIFEST_FILE = path.resolve(args.find((arg) => arg.startsWith('--manifest='))?.slice('--manifest='.length) || 'data/player-canonical-batch-1-import.json');
const OUTPUT_DIR = path.resolve(args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) || 'backups');
const APPLY = args.includes('--apply');
const CONFIRM = args.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length) || '';
const REQUIRED_CONFIRMATION = 'IMPORT_CANONICAL_PLAYER_CONTENT_BATCH1';

const LEGACY_COLUMNS = [
    'id',
    'aptidao_comum',
    'aptidao_comum_key',
    'aptidao_rara',
    'aptidao_rara_key',
    'marca_comum',
    'marca_comum_key',
    'marca_rara',
    'marca_rara_key',
    'anomalia',
    'anomalia_key',
    'gancho_narrativo',
    'historias_extras',
];

function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function playerName(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome, player.nome_real]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-') || '';
}

function stableJson(value) {
    if (value == null) return null;
    if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
    if (typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function validateInputs() {
    if (!fs.existsSync(DATABASE_FILE)) throw new Error(`Banco não encontrado: ${DATABASE_FILE}`);
    if (!fs.existsSync(MANIFEST_FILE)) throw new Error(`Manifesto não encontrado: ${MANIFEST_FILE}`);
    if (APPLY && CONFIRM !== REQUIRED_CONFIRMATION) {
        throw new Error(`Aplicação exige --confirm=${REQUIRED_CONFIRMATION}`);
    }
}

function loadManifest() {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    if (!manifest || manifest.readOnlyByDefault !== true || !Array.isArray(manifest.players)) {
        throw new Error('Manifesto de importação inválido ou sem readOnlyByDefault=true.');
    }
    const ids = manifest.players.map((player) => player.playerId);
    if (new Set(ids).size !== ids.length) throw new Error('Manifesto contém playerId duplicado.');
    return manifest;
}

async function createBackup(db) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    await db.exec('PRAGMA wal_checkpoint(FULL)');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(OUTPUT_DIR, `before-player-content-batch1-${stamp}.sqlite`);
    fs.copyFileSync(DATABASE_FILE, backupFile);
    return backupFile;
}

async function captureLegacySnapshot(db, playerIds) {
    const placeholders = playerIds.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT ${LEGACY_COLUMNS.map((column) => `"${column}"`).join(', ')}
         FROM jogadores
         WHERE id IN (${placeholders})
         ORDER BY id ASC`,
        playerIds
    );
    return stableJson(rows);
}

function rowMatchesRecord(row, record, linkedContentId) {
    const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null;
    return row.title === record.title
        && (row.body ?? null) === (record.body ?? null)
        && (row.raw_source_text ?? null) === (record.rawSourceText ?? null)
        && row.mechanical_status === record.mechanicalStatus
        && row.review_status === record.reviewStatus
        && Number(row.version || 1) === Number(record.version || 1)
        && Number(row.active || 0) === 1
        && (row.source ?? null) === (record.source ?? null)
        && (row.created_by ?? null) === (record.createdBy ?? null)
        && stableJson(metadata) === stableJson(record.metadata ?? null)
        && (row.linked_content_id == null ? null : Number(row.linked_content_id)) === linkedContentId;
}

async function validatePlayers(db, manifest) {
    const validated = [];
    for (const entry of manifest.players) {
        const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [entry.playerId]);
        if (!player) throw new Error(`Cadastro não encontrado: ${entry.playerId}`);
        const foundName = playerName(player);
        if (normalizeText(foundName) !== normalizeText(entry.expectedName)) {
            throw new Error(`Nome divergente em ${entry.playerId}. Esperado: ${entry.expectedName}; encontrado: ${foundName}`);
        }
        if (normalizeText(player.jogo_status) !== 'liberado') {
            throw new Error(`${foundName} não está ativo: jogo_status=${player.jogo_status || 'vazio'}`);
        }
        validated.push({ playerId: entry.playerId, name: foundName });
    }
    return validated;
}

function prepareRecords(manifest) {
    const output = [];
    for (const player of manifest.players) {
        for (const raw of player.records || []) {
            const record = assertContentRecord({
                ...raw,
                playerId: player.playerId,
                source: manifest.source,
                createdBy: manifest.createdBy,
                version: raw.version || 1,
            });
            output.push(record);
        }
    }
    const unique = new Set();
    for (const record of output) {
        const identity = `${record.playerId}|${record.contentType}|${record.contentKey}|${record.version}`;
        if (unique.has(identity)) throw new Error(`Registro duplicado no manifesto: ${identity}`);
        unique.add(identity);
    }
    return output;
}

async function resolveLinkedContentId(db, record) {
    if (!record.linkedContent) return null;
    const targetType = record.linkedContent.contentType;
    const targetKey = normalizeContentKey(record.linkedContent.contentKey);
    const linked = await db.get(
        `SELECT id
         FROM clover_player_content
         WHERE player_id = ? AND content_type = ? AND content_key = ? AND active = 1`,
        [record.playerId, targetType, targetKey]
    );
    if (!linked) {
        throw new Error(`Vínculo não encontrado para ${record.playerId}/${record.contentType}/${record.contentKey}: ${targetType}/${targetKey}`);
    }
    return Number(linked.id);
}

async function importRecord(db, record, linkedContentId) {
    const existing = await db.get(
        `SELECT *
         FROM clover_player_content
         WHERE player_id = ? AND content_type = ? AND content_key = ? AND active = 1`,
        [record.playerId, record.contentType, record.contentKey]
    );

    if (existing) {
        if (!rowMatchesRecord(existing, record, linkedContentId)) {
            throw new Error(`Conflito com conteúdo já existente: ${record.playerId}/${record.contentType}/${record.contentKey}`);
        }
        return { action: 'skipped_exact', id: Number(existing.id) };
    }

    const result = await db.run(
        `INSERT INTO clover_player_content (
            player_id, content_type, content_key, title, body, raw_source_text,
            mechanical_status, review_status, linked_content_id, version, active,
            source, created_by, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [
            record.playerId,
            record.contentType,
            record.contentKey,
            record.title,
            record.body ?? null,
            record.rawSourceText ?? null,
            record.mechanicalStatus,
            record.reviewStatus,
            linkedContentId,
            Number(record.version || 1),
            record.source ?? null,
            record.createdBy ?? null,
            record.metadata == null ? null : JSON.stringify(record.metadata),
        ]
    );
    return { action: 'inserted', id: Number(result.lastID) };
}

async function assertIntegrity(db, expectedRecords) {
    const playerIds = [...new Set(expectedRecords.map((record) => record.playerId))];
    const placeholders = playerIds.map(() => '?').join(', ');
    const count = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_player_content
         WHERE active = 1 AND player_id IN (${placeholders})`,
        playerIds
    );
    if (Number(count?.total || 0) !== expectedRecords.length) {
        throw new Error(`Contagem canônica inesperada: ${count?.total || 0}/${expectedRecords.length}`);
    }

    const pending = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_player_content
         WHERE active = 1 AND content_type = 'custom_trait'
           AND mechanical_status = 'pending_balance'
           AND player_id IN (${placeholders})`,
        playerIds
    );
    if (Number(pending?.total || 0) !== 7) {
        throw new Error(`Traços pendentes inesperados: ${pending?.total || 0}/7`);
    }

    const linked = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_player_content
         WHERE active = 1 AND content_type = 'narrative_item'
           AND linked_content_id IS NOT NULL
           AND player_id IN (${placeholders})`,
        playerIds
    );
    if (Number(linked?.total || 0) !== 2) {
        throw new Error(`Vínculos item–gancho inesperados: ${linked?.total || 0}/2`);
    }

    const foreignKeyFailures = await db.all('PRAGMA foreign_key_check');
    if (foreignKeyFailures.length) {
        throw new Error(`foreign_key_check encontrou ${foreignKeyFailures.length} falha(s).`);
    }

    const integrityRows = await db.all('PRAGMA integrity_check');
    const failures = integrityRows
        .flatMap((row) => Object.values(row))
        .filter((value) => String(value).toLowerCase() !== 'ok');
    if (failures.length) throw new Error(`integrity_check falhou: ${failures.join('; ')}`);
}

(async () => {
    validateInputs();
    const manifest = loadManifest();
    const records = prepareRecords(manifest);
    const playerIds = manifest.players.map((player) => player.playerId);
    const db = await open({ filename: DATABASE_FILE, driver: sqlite3.Database, mode: sqlite3.OPEN_READWRITE });
    let backupFile = null;
    let report;

    try {
        await db.exec('PRAGMA busy_timeout = 15000');
        await db.exec('PRAGMA foreign_keys = ON');
        const players = await validatePlayers(db, manifest);
        const legacyBefore = await captureLegacySnapshot(db, playerIds);
        if (APPLY) backupFile = await createBackup(db);

        await db.exec('BEGIN IMMEDIATE');
        try {
            await ensureCloverPlayerContentSchema(db);
            const operations = [];
            const ordered = [
                ...records.filter((record) => !record.linkedContent),
                ...records.filter((record) => record.linkedContent),
            ];

            for (const record of ordered) {
                const linkedContentId = await resolveLinkedContentId(db, record);
                const result = await importRecord(db, record, linkedContentId);
                operations.push({
                    playerId: record.playerId,
                    contentType: record.contentType,
                    contentKey: record.contentKey,
                    linkedContentId,
                    ...result,
                });
            }

            await assertIntegrity(db, records);
            const legacyAfter = await captureLegacySnapshot(db, playerIds);
            if (legacyAfter !== legacyBefore) {
                throw new Error('Campos legados de jogadores foram alterados durante a importação.');
            }

            if (APPLY) await db.exec('COMMIT');
            else await db.exec('ROLLBACK');

            report = {
                generatedAt: new Date().toISOString(),
                mode: APPLY ? 'apply' : 'dry_run',
                committed: APPLY,
                database: DATABASE_FILE,
                manifest: MANIFEST_FILE,
                backupFile,
                players,
                expectedRecords: records.length,
                inserted: operations.filter((item) => item.action === 'inserted').length,
                skippedExact: operations.filter((item) => item.action === 'skipped_exact').length,
                pendingBalance: records.filter((item) => item.mechanicalStatus === 'pending_balance').length,
                linkedItems: records.filter((item) => item.linkedContent).length,
                operations,
            };
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => {});
            throw error;
        }
    } finally {
        await db.close();
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportFile = path.join(OUTPUT_DIR, `player-content-batch1-${stamp}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');

    console.log('\n=== CONTEÚDO CANÔNICO — LOTE 1 ===');
    console.log(`Modo: ${APPLY ? 'APLICAÇÃO' : 'SIMULAÇÃO COM ROLLBACK'}`);
    console.log(`Jogadores validados: ${report.players.length}`);
    console.log(`Registros esperados: ${report.expectedRecords}`);
    console.log(`Inseridos nesta execução: ${report.inserted}`);
    console.log(`Já idênticos: ${report.skippedExact}`);
    console.log(`Traços pendentes de balanceamento: ${report.pendingBalance}`);
    console.log(`Itens vinculados a ganchos: ${report.linkedItems}`);
    console.log(`Backup: ${report.backupFile || 'não criado na simulação'}`);
    console.log(`Relatório: ${reportFile}`);
    console.log(report.committed
        ? '\nImportação concluída e validada.'
        : '\nSimulação concluída. Nenhum dado foi alterado.');
})().catch((error) => {
    console.error('\nFALHA NA IMPORTAÇÃO CANÔNICA:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
