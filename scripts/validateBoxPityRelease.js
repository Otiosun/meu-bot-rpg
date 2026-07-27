'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { addCatalogItem } = require('../helpers/clover/inventoryService');
const { getBoxCatalog } = require('../helpers/clover/seasonalEventCatalog');
const {
    ensureBoxPitySchema,
    getOrCreatePityStateInTransaction,
    previewPlayerPityState,
    reconstructPityStateFromHistory,
} = require('../helpers/clover/boxPityStateService');
const { openBox } = require('../helpers/clover/boxService');
const {
    backupSqliteDatabase,
    verifySqliteDatabase,
} = require('../helpers/clover/sqliteBackupService');

const BOX_KEYS = Object.freeze(['simples', 'rara']);
const SOURCE_TABLES = Object.freeze([
    'clover_box_openings',
    'clover_inventory_items',
    'clover_yulls_ledger',
    'clover_ph_ledger',
    'clover_seasonal_relic_ownership',
    'clover_player_titles',
]);

function parseArgs(argv) {
    const values = {};
    for (const argument of argv.slice(2)) {
        if (!argument.startsWith('--')) continue;
        const separator = argument.indexOf('=');
        if (separator < 0) {
            values[argument.slice(2)] = true;
            continue;
        }
        values[argument.slice(2, separator)] = argument.slice(separator + 1);
    }
    return values;
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

async function sha256(filename) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filename);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function openDatabase(filename, readonly = false) {
    return open({
        filename,
        driver: sqlite3.Database,
        mode: readonly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE,
    });
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT 1 AS present
         FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
        [tableName]
    );
    return Boolean(row?.present);
}

async function integrityCheck(db) {
    const rows = await db.all('PRAGMA integrity_check');
    const values = rows.map((row) => String(Object.values(row)[0] || ''));
    return {
        ok: values.length === 1 && values[0].toLowerCase() === 'ok',
        values,
    };
}

async function rowCount(db, tableName) {
    if (!await tableExists(db, tableName)) return null;
    const row = await db.get(`SELECT COUNT(*) AS total FROM "${tableName}"`);
    return Number(row?.total || 0);
}

async function snapshotCounts(db, tableNames = SOURCE_TABLES) {
    const result = {};
    for (const tableName of tableNames) {
        result[tableName] = await rowCount(db, tableName);
    }
    return result;
}

function compareSnapshots(before, after) {
    return Object.keys(before).filter((key) => before[key] !== after[key]);
}

function catalogDescriptor(boxKey) {
    const box = getBoxCatalog(boxKey);
    if (!box) throw new Error(`Catálogo ausente: ${boxKey}`);
    return {
        box,
        boxKey,
        version: Number(box.version),
        rewardKeys: new Set(box.rewards.map((reward) => reward.key)),
    };
}

async function openingSummary(db) {
    if (!await tableExists(db, 'clover_box_openings')) return [];
    return db.all(
        `SELECT box_key, catalog_version, status, COUNT(*) AS total
         FROM clover_box_openings
         GROUP BY box_key, catalog_version, status
         ORDER BY box_key, catalog_version, status`
    );
}

async function currentPairs(db, descriptors) {
    const pairs = [];
    if (!await tableExists(db, 'clover_box_openings')) return pairs;
    for (const descriptor of descriptors) {
        const rows = await db.all(
            `SELECT DISTINCT player_id
             FROM clover_box_openings
             WHERE box_key = ?
               AND catalog_version = ?
               AND status = 'completed'
             ORDER BY player_id`,
            [descriptor.boxKey, descriptor.version]
        );
        for (const row of rows) {
            pairs.push({
                playerId: row.player_id,
                boxKey: descriptor.boxKey,
                catalogVersion: descriptor.version,
            });
        }
    }
    return pairs;
}

async function unknownCurrentRewards(db, descriptors) {
    const unknown = [];
    if (!await tableExists(db, 'clover_box_openings')) return unknown;
    for (const descriptor of descriptors) {
        const rows = await db.all(
            `SELECT reward_key, COUNT(*) AS total
             FROM clover_box_openings
             WHERE box_key = ?
               AND catalog_version = ?
               AND status = 'completed'
             GROUP BY reward_key
             ORDER BY reward_key`,
            [descriptor.boxKey, descriptor.version]
        );
        for (const row of rows) {
            if (!descriptor.rewardKeys.has(row.reward_key)) {
                unknown.push({
                    boxKey: descriptor.boxKey,
                    catalogVersion: descriptor.version,
                    rewardKey: row.reward_key,
                    total: Number(row.total || 0),
                });
            }
        }
    }
    return unknown;
}

async function historicalRowsOutsideCurrentVersion(db, descriptors) {
    const result = [];
    if (!await tableExists(db, 'clover_box_openings')) return result;
    for (const descriptor of descriptors) {
        const rows = await db.all(
            `SELECT catalog_version, COUNT(*) AS total
             FROM clover_box_openings
             WHERE box_key = ?
               AND status = 'completed'
               AND catalog_version <> ?
             GROUP BY catalog_version
             ORDER BY catalog_version`,
            [descriptor.boxKey, descriptor.version]
        );
        for (const row of rows) {
            result.push({
                boxKey: descriptor.boxKey,
                currentCatalogVersion: descriptor.version,
                historicalCatalogVersion: Number(row.catalog_version),
                total: Number(row.total || 0),
            });
        }
    }
    return result;
}

async function reconstructPairs(db, pairs) {
    const states = [];
    for (const pair of pairs) {
        const state = await reconstructPityStateFromHistory(
            db,
            pair.playerId,
            getBoxCatalog(pair.boxKey)
        );
        states.push({
            playerId: pair.playerId,
            boxKey: pair.boxKey,
            catalogVersion: pair.catalogVersion,
            qualityMissStreak: state.qualityMissStreak,
            relicMissStreak: state.relicMissStreak,
            lastRewardKey: state.lastRewardKey,
            lastOpeningId: state.lastOpeningId,
            migration: state.migration,
        });
    }
    return states;
}

function migrationSummary(states) {
    return {
        pairCount: states.length,
        historicalRows: states.reduce(
            (sum, state) => sum + Number(state.migration?.historicalRows || 0),
            0
        ),
        reliableRows: states.reduce(
            (sum, state) => sum + Number(state.migration?.reliableRows || 0),
            0
        ),
        ambiguousRows: states.reduce(
            (sum, state) => sum + Number(state.migration?.ambiguousRows || 0),
            0
        ),
        cappedPairs: states.filter(
            (state) => state.migration?.qualityCappedAtHardMinusOne
        ).length,
        maxImportedQualityMissStreak: states.reduce(
            (max, state) => Math.max(max, Number(state.qualityMissStreak || 0)),
            0
        ),
        maxImportedRelicMissStreak: states.reduce(
            (max, state) => Math.max(max, Number(state.relicMissStreak || 0)),
            0
        ),
    };
}

async function auditSourceDatabase(sourcePath, descriptors) {
    const beforeStat = fs.statSync(sourcePath);
    const beforeHash = await sha256(sourcePath);
    const db = await openDatabase(sourcePath, true);
    const blockers = [];
    const warnings = [];
    let report;

    try {
        await db.exec('PRAGMA query_only = ON');
        await db.exec('BEGIN');
        try {
            const integrity = await integrityCheck(db);
            if (!integrity.ok) blockers.push('source_integrity_failed');

            const requiredTables = [
                'clover_box_openings',
                'clover_seasonal_relic_ownership',
            ];
            const missingTables = [];
            for (const tableName of requiredTables) {
                if (!await tableExists(db, tableName)) missingTables.push(tableName);
            }
            if (missingTables.length) blockers.push('required_tables_missing');

            const pairs = missingTables.length
                ? []
                : await currentPairs(db, descriptors);
            const states = missingTables.length
                ? []
                : await reconstructPairs(db, pairs);
            const unknownRewards = await unknownCurrentRewards(db, descriptors);
            const olderVersions = await historicalRowsOutsideCurrentVersion(
                db,
                descriptors
            );

            if (unknownRewards.length) warnings.push('unknown_current_reward_keys');
            if (olderVersions.length) warnings.push('older_catalog_versions_not_imported');
            if (states.some((state) => Number(state.migration?.ambiguousRows || 0) > 0)) {
                warnings.push('ambiguous_history_rows_reset_streaks');
            }

            report = {
                readonly: true,
                connectionMode: 'sqlite3.OPEN_READONLY + PRAGMA query_only + read transaction',
                integrity,
                requiredTables,
                missingTables,
                sourceCounts: await snapshotCounts(db),
                openingSummary: await openingSummary(db),
                currentPairs: pairs,
                reconstructedStates: states,
                migrationSummary: migrationSummary(states),
                unknownCurrentRewards: unknownRewards,
                historicalRowsOutsideCurrentVersion: olderVersions,
                blockers,
                warnings,
            };
            await db.exec('COMMIT');
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => null);
            throw error;
        }
    } finally {
        await db.close();
    }

    const afterStat = fs.statSync(sourcePath);
    const afterHash = await sha256(sourcePath);
    const unchangedDuringAudit = beforeHash === afterHash
        && beforeStat.size === afterStat.size
        && beforeStat.mtimeMs === afterStat.mtimeMs;
    if (!unchangedDuringAudit) warnings.push('source_changed_concurrently_during_audit');

    return {
        ...report,
        sourceBefore: {
            sha256: beforeHash,
            sizeBytes: beforeStat.size,
            modifiedAt: beforeStat.mtime.toISOString(),
        },
        sourceAfter: {
            sha256: afterHash,
            sizeBytes: afterStat.size,
            modifiedAt: afterStat.mtime.toISOString(),
        },
        sourceUnchangedDuringAudit: unchangedDuringAudit,
        liveDatabaseWritesByValidator: false,
    };
}

async function quantityForBox(db, playerId, templateKey) {
    const row = await db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS total
         FROM clover_inventory_items
         WHERE player_id = ?
           AND template_key = ?
           AND status = 'disponivel'`,
        [playerId, templateKey]
    );
    return Number(row?.total || 0);
}

async function playerMoney(db, playerId) {
    const row = await db.get(
        'SELECT dinheiro FROM jogadores WHERE id = ?',
        [playerId]
    );
    return Number(row?.dinheiro || 0);
}

async function idempotencyOpeningCount(db, key) {
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_box_openings
         WHERE idempotency_key = ?`,
        [key]
    );
    return Number(row?.total || 0);
}

async function chooseOpeningCandidate(db) {
    if (await tableExists(db, 'clover_inventory_items')) {
        const existing = await db.get(
            `SELECT player_id, template_key, SUM(quantity) AS quantity
             FROM clover_inventory_items
             WHERE template_key IN ('box_simple_v1', 'box_rare_v1')
               AND status = 'disponivel'
               AND quantity > 0
             GROUP BY player_id, template_key
             ORDER BY CASE template_key
                 WHEN 'box_simple_v1' THEN 0 ELSE 1 END,
                 player_id
             LIMIT 1`
        );
        if (existing) {
            return {
                playerId: existing.player_id,
                templateKey: existing.template_key,
                syntheticBoxGranted: false,
            };
        }
    }

    const player = await db.get(
        `SELECT id
         FROM jogadores
         ORDER BY CASE WHEN jogo_status = 'liberado' THEN 0 ELSE 1 END, id
         LIMIT 1`
    );
    if (!player?.id) throw new Error('Nenhum jogador disponível na cópia.');

    await addCatalogItem(db, player.id, 'box_simple_v1', 1, {
        source: 'box_pity_release_validation_copy',
        relatedId: 'synthetic_validation_box',
    });
    return {
        playerId: player.id,
        templateKey: 'box_simple_v1',
        syntheticBoxGranted: true,
    };
}

async function validateOpeningOnCopy(db) {
    const candidate = await chooseOpeningCandidate(db);
    const boxKey = candidate.templateKey === 'box_rare_v1' ? 'rara' : 'simples';
    const box = getBoxCatalog(boxKey);
    const expectedYulls = boxKey === 'rara' ? 3000 : 1000;
    const idempotencyKey = `box-pity-release-validation:${Date.now()}`;

    await ensureBoxPitySchema(db);
    await db.run(
        `DELETE FROM clover_box_pity_state
         WHERE player_id = ? AND box_key = ? AND catalog_version = ?`,
        [candidate.playerId, boxKey, box.version]
    );
    await db.run(
        `INSERT INTO clover_box_pity_state (
            player_id, box_key, catalog_version, quality_miss_streak,
            relic_miss_streak, last_reward_key, last_opening_id,
            initialized_from, migration_json, created_at, updated_at
         ) VALUES (?, ?, ?, 0, 0, NULL, NULL, 'validation_copy', NULL,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [candidate.playerId, boxKey, box.version]
    );

    const before = {
        quantity: await quantityForBox(
            db,
            candidate.playerId,
            candidate.templateKey
        ),
        money: await playerMoney(db, candidate.playerId),
        openingCount: await idempotencyOpeningCount(db, idempotencyKey),
        pity: await previewPlayerPityState(db, candidate.playerId, boxKey),
    };

    const first = await openBox(db, candidate.playerId, boxKey, {
        idempotencyKey,
        roll: 1,
        randomInt: (min) => min,
        source: 'box_pity_release_validation_copy',
    });
    const afterFirst = {
        quantity: await quantityForBox(
            db,
            candidate.playerId,
            candidate.templateKey
        ),
        money: await playerMoney(db, candidate.playerId),
        openingCount: await idempotencyOpeningCount(db, idempotencyKey),
        pity: await previewPlayerPityState(db, candidate.playerId, boxKey),
    };

    const second = await openBox(db, candidate.playerId, boxKey, {
        idempotencyKey,
        roll: 1,
        randomInt: (min) => min,
        source: 'box_pity_release_validation_copy',
    });
    const afterSecond = {
        quantity: await quantityForBox(
            db,
            candidate.playerId,
            candidate.templateKey
        ),
        money: await playerMoney(db, candidate.playerId),
        openingCount: await idempotencyOpeningCount(db, idempotencyKey),
        pity: await previewPlayerPityState(db, candidate.playerId, boxKey),
    };

    const checks = {
        consumedExactlyOneBox: afterFirst.quantity === before.quantity - 1,
        grantedExpectedYulls: afterFirst.money === before.money + expectedYulls,
        createdExactlyOneOpening: afterFirst.openingCount === 1,
        replayDidNotConsumeAgain: afterSecond.quantity === afterFirst.quantity,
        replayDidNotGrantAgain: afterSecond.money === afterFirst.money,
        replayDidNotCreateAgain: afterSecond.openingCount === afterFirst.openingCount,
        replayDidNotAdvancePity: afterSecond.pity.lastOpeningId === afterFirst.pity.lastOpeningId
            && afterSecond.pity.qualityMissStreak === afterFirst.pity.qualityMissStreak
            && afterSecond.pity.relicMissStreak === afterFirst.pity.relicMissStreak,
        firstRewardIsExpectedCommonYulls: first.rewardKey === (
            boxKey === 'rara' ? 'yulls_3000_5000' : 'yulls_1000_3000'
        ),
        secondReceiptIsDuplicate: second.duplicate === true,
    };
    const failedChecks = Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);

    return {
        candidate,
        boxKey,
        expectedYulls,
        idempotencyKey,
        before,
        firstReceipt: first,
        afterFirst,
        secondReceipt: second,
        afterSecond,
        checks,
        failedChecks,
        ok: failedChecks.length === 0,
    };
}

async function validateDatabaseCopy(sourcePath, outputDirectory, descriptors) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    const copyPath = path.join(outputDirectory, 'box-pity-validation.sqlite');
    const backup = await backupSqliteDatabase(sourcePath, copyPath);
    const backupVerification = await verifySqliteDatabase(copyPath);
    if (!backupVerification.ok) {
        throw new Error(`Snapshot inválido: ${backupVerification.integrity || 'desconhecido'}`);
    }

    const db = await openDatabase(copyPath, false);
    const blockers = [];
    const warnings = [];
    let report;

    try {
        const integrityBefore = await integrityCheck(db);
        if (!integrityBefore.ok) blockers.push('copy_integrity_failed_before');
        const sourceCountsBefore = await snapshotCounts(db);
        const pityRowsBefore = await rowCount(db, 'clover_box_pity_state');
        const pairs = await currentPairs(db, descriptors);

        await ensureBoxPitySchema(db);
        await db.exec('BEGIN IMMEDIATE');
        try {
            for (const pair of pairs) {
                await getOrCreatePityStateInTransaction(
                    db,
                    pair.playerId,
                    getBoxCatalog(pair.boxKey)
                );
            }
            await db.exec('COMMIT');
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => null);
            throw error;
        }

        const persistedStates = [];
        const stateMismatches = [];
        for (const pair of pairs) {
            const state = await previewPlayerPityState(
                db,
                pair.playerId,
                pair.boxKey
            );
            const row = await db.get(
                `SELECT * FROM clover_box_pity_state
                 WHERE player_id = ? AND box_key = ? AND catalog_version = ?`,
                [pair.playerId, pair.boxKey, pair.catalogVersion]
            );
            const matches = Boolean(row)
                && Number(row.quality_miss_streak) === state.qualityMissStreak
                && Number(row.relic_miss_streak) === state.relicMissStreak
                && (row.last_reward_key || null) === state.lastRewardKey
                && Number(row.last_opening_id || 0) === Number(state.lastOpeningId || 0);
            if (!matches) stateMismatches.push(pair);
            persistedStates.push({
                ...pair,
                qualityMissStreak: state.qualityMissStreak,
                relicMissStreak: state.relicMissStreak,
                lastRewardKey: state.lastRewardKey,
                lastOpeningId: state.lastOpeningId,
                matchesStoredRow: matches,
            });
        }
        if (stateMismatches.length) blockers.push('persisted_state_mismatch');

        const sourceCountsAfterMigration = await snapshotCounts(db);
        const changedSourceTables = compareSnapshots(
            sourceCountsBefore,
            sourceCountsAfterMigration
        );
        if (changedSourceTables.length) {
            blockers.push('source_tables_changed_during_state_migration');
        }

        const pityRowsAfterMigration = await rowCount(db, 'clover_box_pity_state');
        const openingValidation = await validateOpeningOnCopy(db);
        if (!openingValidation.ok) blockers.push('copy_opening_validation_failed');

        const integrityAfter = await integrityCheck(db);
        if (!integrityAfter.ok) blockers.push('copy_integrity_failed_after');

        report = {
            copyPath,
            backup,
            backupVerification,
            integrityBefore,
            integrityAfter,
            sourceCountsBefore,
            sourceCountsAfterMigration,
            changedSourceTables,
            pityRowsBefore,
            pityRowsAfterMigration,
            pairCount: pairs.length,
            persistedStates,
            stateMismatches,
            openingValidation,
            blockers,
            warnings,
        };
    } finally {
        await db.close();
    }

    return {
        ...report,
        copyFinalSha256: await sha256(copyPath),
    };
}

async function run() {
    const args = parseArgs(process.argv);
    const sourcePath = path.resolve(
        String(args.database || path.join(process.cwd(), 'banco.sqlite'))
    );
    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Banco não encontrado: ${sourcePath}`);
    }
    const outputDirectory = path.resolve(
        String(args.output || path.join(
            process.cwd(),
            'artifacts',
            `box-pity-release-${timestamp()}`
        ))
    );
    const descriptors = BOX_KEYS.map(catalogDescriptor);

    console.log('===== AUDITORIA READONLY DO BANCO DE ORIGEM =====');
    const sourceAudit = await auditSourceDatabase(sourcePath, descriptors);
    console.log(`Integridade: ${sourceAudit.integrity.ok ? 'OK' : 'FALHA'}`);
    console.log(`Conexão: ${sourceAudit.connectionMode}`);
    console.log(`Pares históricos atuais: ${sourceAudit.migrationSummary.pairCount}`);
    console.log(`Linhas ambíguas: ${sourceAudit.migrationSummary.ambiguousRows}`);
    console.log(`Versões antigas fora da migração: ${sourceAudit.historicalRowsOutsideCurrentVersion.length}`);

    console.log('\n===== SNAPSHOT E VALIDAÇÃO INTEGRADA =====');
    const copyValidation = await validateDatabaseCopy(
        sourcePath,
        outputDirectory,
        descriptors
    );
    console.log(`Snapshot: ${copyValidation.backup.method}`);
    console.log(`Estados persistidos: ${copyValidation.pityRowsAfterMigration}`);
    console.log(`Tabelas-fonte alteradas pela migração: ${copyValidation.changedSourceTables.length}`);
    console.log(`Abertura real na cópia: ${copyValidation.openingValidation.ok ? 'OK' : 'FALHA'}`);
    console.log(`Integridade final da cópia: ${copyValidation.integrityAfter.ok ? 'OK' : 'FALHA'}`);

    const finalSourceHash = await sha256(sourcePath);
    const sourceChangedWhileValidating = finalSourceHash !== sourceAudit.sourceBefore.sha256;
    const warnings = [
        ...sourceAudit.warnings,
        ...copyValidation.warnings,
    ];
    if (sourceChangedWhileValidating) {
        warnings.push('source_changed_concurrently_while_validator_was_running');
    }
    const blockers = [
        ...sourceAudit.blockers,
        ...copyValidation.blockers,
    ];

    const finalReport = {
        generatedAt: new Date().toISOString(),
        sourcePath,
        outputDirectory,
        sourceChangedWhileValidating,
        sourceAudit,
        copyValidation,
        blockers: [...new Set(blockers)],
        warnings: [...new Set(warnings)],
        releaseReady: blockers.length === 0,
        liveDatabaseWrites: false,
        liveDatabaseAccess: 'OPEN_READONLY + query_only; all mutations executed only on node:sqlite.backup snapshot',
        pm2Changed: false,
    };
    fs.mkdirSync(outputDirectory, { recursive: true });
    const reportPath = path.join(outputDirectory, 'box-pity-release-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(finalReport, null, 2), 'utf8');

    console.log('\n========================================');
    console.log(finalReport.releaseReady
        ? 'VALIDAÇÃO DO PITY APROVADA'
        : 'VALIDAÇÃO DO PITY BLOQUEADA');
    console.log('========================================');
    console.log(`Relatório: ${reportPath}`);
    console.log(`Cópia: ${copyValidation.copyPath}`);
    console.log(`Banco vivo alterado pelo validador: NÃO`);
    console.log(`PM2 alterado: NÃO`);
    if (finalReport.blockers.length) {
        console.log(`Bloqueios: ${finalReport.blockers.join(', ')}`);
        process.exitCode = 1;
    }
    if (finalReport.warnings.length) {
        console.log(`Avisos: ${finalReport.warnings.join(', ')}`);
    }
}

if (require.main === module) {
    run().catch((error) => {
        console.error(`[box-pity-release] ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    auditSourceDatabase,
    compareSnapshots,
    integrityCheck,
    migrationSummary,
    parseArgs,
    snapshotCounts,
    validateDatabaseCopy,
    validateOpeningOnCopy,
};
