'use strict';

const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { criarBanco } = require('../database');
const {
    applyPreresetInventoryRecovery,
    planPreresetInventoryRecovery,
} = require('../helpers/clover/preresetInventoryRecoveryService');

function argument(name) {
    const prefix = `--${name}=`;
    const value = process.argv.find((entry) => entry.startsWith(prefix));
    return value ? value.slice(prefix.length) : null;
}

const execute = process.argv.includes('--execute');
const verbose = process.argv.includes('--verbose');
const dbPath = path.resolve(argument('db') || process.env.CLOVER_RPG_DB || path.join(__dirname, '..', 'banco.sqlite'));

function compact(plan) {
    return {
        ok:plan.ok,
        planHash:plan.planHash,
        summary:plan.summary,
        pendingBuild:plan.entitlements.flatMap((entry) => entry.pendingBuild.map((item) => ({
            playerId:entry.playerId,
            entitlementId:entry.entitlementId,
            key:item.key,
            quantity:Number(item.quantity || 1),
        }))),
        pendingCustom:plan.entitlements.flatMap((entry) => entry.pendingCustom.map((item) => ({
            playerId:entry.playerId,
            entitlementId:entry.entitlementId,
            key:item.key,
            quantity:Number(item.quantity || 1),
        }))),
    };
}

(async () => {
    const db = execute
        ? await criarBanco({ filename:dbPath })
        : await open({ filename:dbPath, driver:sqlite3.Database, mode:sqlite3.OPEN_READONLY });
    try {
        const plan = await planPreresetInventoryRecovery(db);
        if (!execute) {
            console.log(JSON.stringify({ execute:false, dbPath, plan:verbose ? plan : compact(plan) }, null, 2));
            return;
        }
        const result = await applyPreresetInventoryRecovery(db, { execute:true, expectedPlanHash:plan.planHash });
        console.log(JSON.stringify({
            execute:true,
            dbPath,
            result:verbose ? result : { ok:result.ok, applied:result.applied, before:compact(result.before), after:compact(result.after) },
        }, null, 2));
    } finally {
        await db.close();
    }
})().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
