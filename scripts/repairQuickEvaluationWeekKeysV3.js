'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    RPG_TIME_ZONE,
    applyQuickEvaluationWeekRepair,
} = require('../helpers/clover/quickEvaluationWeekRepairService');

function argValue(name) {
    const prefix = `--${name}=`;
    const item = process.argv.find((arg) => arg.startsWith(prefix));
    return item ? item.slice(prefix.length) : null;
}

function hasFlag(name) {
    return process.argv.includes(`--${name}`);
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
    const dbArg = argValue('db');
    const filename = path.resolve(dbArg || path.join(__dirname, '..', 'banco.sqlite'));
    const db = await open({ filename, driver: sqlite3.Database });

    try {
        await db.exec('PRAGMA busy_timeout = 10000');
        const legacyRule = await getLegacyRule(db);

        if (apply && legacyRule !== 'monday_scene_v2') {
            throw new Error(
                `Aplicacao recusada: quick_evaluation_week_key_rule=${legacyRule || 'ausente'}. ` +
                'O reparo so pode ser aplicado depois que a migracao monday_scene_v2 estiver estabilizada.'
            );
        }

        const result = await applyQuickEvaluationWeekRepair(db, {
            apply,
            timeZone: RPG_TIME_ZONE,
        });

        const verification = await verifyDatabase(db);
        const summary = {
            mode: apply ? 'apply' : 'preview',
            timeZone: RPG_TIME_ZONE,
            legacyRule,
            tableExists: result.tableExists,
            scanned: result.scanned,
            changed: result.changed,
            unchanged: result.unchanged,
            invalid: result.invalid,
            applied: result.applied,
            quickCheck: verification.quickCheck,
            foreignKeyViolations: verification.foreignKeyViolations,
        };

        console.log(JSON.stringify(summary, null, 2));

        if (verification.quickCheck !== 'ok' || verification.foreignKeyViolations !== 0) {
            process.exitCode = 2;
        }
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(`[weekly-scene-repair] ${error?.message || error}`);
    process.exitCode = 1;
});
