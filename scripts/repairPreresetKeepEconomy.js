'use strict';

const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { criarBanco } = require('../database');
const service = require('../helpers/clover/preresetKeepEconomyRepairService');

const execute = process.argv.includes('--execute');
const dbArg = process.argv.find((arg) => arg.startsWith('--db='));
const dbPath = path.resolve(dbArg ? dbArg.slice(5) : process.env.CLOVER_RPG_DB || path.join(__dirname, '..', 'banco.sqlite'));

function compact(plan) {
    return {
        ok:plan.ok,
        planHash:plan.planHash,
        summary:plan.summary,
        blockers:plan.blockers,
        players:plan.players.filter((player) => player.pending).map((player) => ({
            playerId:player.playerId,
            name:player.name,
            moneyBefore:player.moneyBefore,
            itemUnits:player.removableItems.reduce((sum, item) => sum + item.quantity, 0),
            itemNames:player.removableItems.map((item) => `${item.quantity}x ${item.itemName}`),
            boxUnitsPreserved:player.boxes.reduce((sum, item) => sum + item.quantity, 0),
        })),
        relic:plan.relic,
    };
}

(async () => {
    const db = execute
        ? await criarBanco({ filename:dbPath })
        : await open({ filename:dbPath, driver:sqlite3.Database, mode:sqlite3.OPEN_READONLY });
    try {
        const plan = await service.planPreresetKeepEconomyRepair(db);
        if (!execute) return console.log(JSON.stringify({ execute:false, dbPath, plan:compact(plan) }, null, 2));
        const result = await service.applyPreresetKeepEconomyRepair(db, { execute:true, expectedPlanHash:plan.planHash });
        console.log(JSON.stringify({ execute:true, dbPath, before:compact(result.before), relic:result.relic, after:compact(result.after) }, null, 2));
    } finally {
        await db.close();
    }
})().catch((error) => { console.error(error.stack || error); process.exitCode=1; });
