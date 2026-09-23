'use strict';

const path = require('node:path');
const { criarBanco } = require('../database');
const {
    applyReturnShopOwnerCorrection,
    planReturnShopOwnerCorrection,
} = require('../helpers/clover/returnShopOwnerCorrection20260918Service');

function databasePath() {
    const argument = process.argv.find((value) => value.startsWith('--db='));
    return path.resolve(argument ? argument.slice(5) : 'banco.sqlite');
}

(async () => {
    const execute = process.argv.includes('--execute');
    const dbPath = databasePath();
    const db = await criarBanco({ filename:dbPath });
    try {
        const before = await planReturnShopOwnerCorrection(db);
        if (!execute) {
            console.log(JSON.stringify({ execute:false,dbPath,plan:before },null,2));
            return;
        }
        if (!before.ok) throw new Error(`Preflight bloqueado: ${JSON.stringify(before.blockers)}`);
        const result = await applyReturnShopOwnerCorrection(db,{ execute:true,expectedPlanHash:before.planHash });
        console.log(JSON.stringify({ execute:true,dbPath,result },null,2));
    } finally {
        await db.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
