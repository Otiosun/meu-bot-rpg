'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    RPG_TIME_ZONE,
    applyQuickEvaluationWeekRepair,
} = require('../helpers/clover/quickEvaluationWeekRepairService');

const APPLY_CONFIRMATION = 'REPAIR_WEEK_KEYS_V3';

function argValue(name) {
    const prefix = `--${name}=`;
    const item = process.argv.find((arg) => arg.startsWith(prefix));
    return item ? item.slice(prefix.length) : null;
}

function hasFlag(name) {
    return process.argv.includes(`--${name}`);
}

function parseExpectedInteger(name) {
    const raw = argValue(name);
    if (raw === null) return null;
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 0) {
        throw new Error(`--${name} precisa ser inteiro >= 0.`);
    }
    return number;
}

async function getLegacyRule(db) {
    const table = await db.get(
        `SELECT 1 AS present FROM sqlite_master
         WHERE type = 'table' AND name = 'clover_settings' LIMIT 1`
    );
    if (!table?.present) return null;
    const row = await db.get(
        `SELECT value FROM clover_settings
         WHERE key = 'quick_evaluation_week_key_rule'`
    );
    return row?.value || null;
}

async function verifyDatabase(db) {
    const quickCheck = await db.get('PRAGMA quick_check');
    const quickValue = quickCheck ? Object.values(quickCheck)[0] : null;
    const foreignKeys = await db.all('PRAGMA foreign_key_check');
    return {
        quickCheck: quickValue,
        foreignKeyViolations: foreignKeys.length,
    };
}

async function main() {
    const apply = hasFlag('apply');
    const allowInvalid = hasFlag('allow-invalid');
    const confirmation = argValue('confirm');
    const expectedChanges = parseExpectedInteger('expected-changes');
    const dbArg = argValue('db');
    const filename = path.resolve(dbArg || path.join(__dirname, '..', 'banco.sqlite'));
    const db = await open({ filename, driver: sqlite3.Database });

    try {
        await db.exec('PRAGMA busy_timeout = 10000');
        const legacyRule = await getLegacyRule(db);
        const integrityBefore = await verifyDatabase(db);
        if (integrityBefore.quickCheck !== 'ok' || integrityBefore.foreignKeyViolations !== 0) {
            throw new Error(
                `Banco recusado antes do reparo: quick_check=${integrityBefore.quickCheck}, ` +
                `foreign_keys=${integrityBefore.foreignKeyViolations}.`
            );
        }

        const preview = await applyQuickEvaluationWeekRepair(db, {
            apply: false,
            timeZone: RPG_TIME_ZONE,
        });

        if (apply) {
            if (legacyRule !== 'monday_scene_v2') {
                throw new Error(
                    `Aplicacao recusada: quick_evaluation_week_key_rule=${legacyRule || 'ausente'}. ` +
                    'O reparo so pode ser aplicado depois que a migracao monday_scene_v2 estiver estabilizada.'
                );
            }
            if (confirmation !== APPLY_CONFIRMATION) {
                throw new Error(`Aplicacao recusada: use --confirm=${APPLY_CONFIRMATION}.`);
            }
            if (expectedChanges === null) {
                throw new Error('Aplicacao recusada: informe --expected-changes=<valor observado no preview>.');
            }
            if (preview.changed !== expectedChanges) {
                throw new Error(
                    `Aplicacao recusada: preview atual tem ${preview.changed} mudanca(s), ` +
                    `mas --expected-changes=${expectedChanges}.`
                );
            }
            if (preview.invalid > 0 && !allowInvalid) {
                throw new Error(
                    `Aplicacao recusada: ${preview.invalid} avaliacao(oes) sem scene_sent_at valido. ` +
                    'Revise esses casos; use --allow-invalid somente para aplicar as rows comprovaveis.'
                );
            }
        }

        const result = apply
            ? await applyQuickEvaluationWeekRepair(db, {
                apply: true,
                allowInvalid,
                timeZone: RPG_TIME_ZONE,
            })
            : preview;

        const integrityAfter = await verifyDatabase(db);
        const summary = {
            mode: apply ? 'apply' : 'preview',
            timeZone: RPG_TIME_ZONE,
            legacyRule,
            allowInvalid,
            expectedChanges,
            tableExists: result.tableExists,
            scanned: result.scanned,
            changed: result.changed,
            unchanged: result.unchanged,
            invalid: result.invalid,
            applied: result.applied,
            // IDs + before/after week only: enough to inspect the repair without exposing player data.
            changes: result.changes,
            integrityBefore,
            integrityAfter,
        };

        console.log(JSON.stringify(summary, null, 2));

        if (integrityAfter.quickCheck !== 'ok' || integrityAfter.foreignKeyViolations !== 0) {
            process.exitCode = 2;
        }
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    const code = error?.code ? ` (${error.code})` : '';
    console.error(`[weekly-scene-repair]${code} ${error?.message || error}`);
    process.exitCode = 1;
});
