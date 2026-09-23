'use strict';

const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { criarBanco } = require('../database');
const service = require('../helpers/clover/preresetParticipantRoyalBoxBonusService');

const execute = process.argv.includes('--execute');
const dbArg = process.argv.find((arg) => arg.startsWith('--db='));
const dbPath = path.resolve(dbArg ? dbArg.slice(5) : process.env.CLOVER_RPG_DB || path.join(__dirname, '..', 'banco.sqlite'));

function compact(plan) {
    return {
        ok:plan.ok,
        planHash:plan.planHash,
        startedAt:plan.startedAt,
        summary:plan.summary,
        blockers:plan.blockers,
        pending:plan.recipients.filter((row) => !row.delivered).map((row) => ({
            playerId:row.playerId,
            name:row.name,
            reasons:row.reasons,
        })),
    };
}

(async () => {
    const db = execute
        ? await criarBanco({ filename:dbPath })
        : await open({ filename:dbPath, driver:sqlite3.Database, mode:sqlite3.OPEN_READONLY });
    try {
        const plan = await service.planPreresetParticipantRoyalBoxBonus(db);
        if (!execute) return console.log(JSON.stringify({ execute:false, dbPath, plan:compact(plan) }, null, 2));
        const result = await service.applyPreresetParticipantRoyalBoxBonus(db, { execute:true, expectedPlanHash:plan.planHash });
        console.log(JSON.stringify({ execute:true, dbPath, before:compact(result.before), after:compact(result.after) }, null, 2));
    } finally {
        await db.close();
    }
})().catch((error) => { console.error(error.stack || error); process.exitCode=1; });
