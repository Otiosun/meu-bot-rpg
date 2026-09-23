'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    buildPreresetGlobalResetPlan,
} = require('../helpers/clover/preresetGlobalResetPlanService');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(ROOT, 'banco.sqlite');

function argValue(name) {
    const prefix = `--${name}=`;
    const found = process.argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString('pt-BR');
}

function renderPlan(plan) {
    console.log('\n=== PREVIEW RESET GLOBAL PRE-RESET ===');
    console.log(`Campaign: ${plan.campaignKey}`);
    console.log(`Roster revision: ${plan.rosterRevision}`);
    console.log(`Roster hash: ${plan.rosterHash}`);
    console.log(`Gate: ${plan.gate.status} (${plan.gate.openedAt || 'sem opened_at'})`);
    console.log(`KEEP: ${formatNumber(plan.counts.keep)}`);
    console.log(`RESET: ${formatNumber(plan.counts.reset)}`);
    console.log(`TOTAL: ${formatNumber(plan.counts.total)}`);
    console.log('\nPreservado pelo contrato:');
    console.log(`- PR ledger: ${plan.preservation.returnPointsLedger ? 'sim' : 'nao'}`);
    console.log(`- Return Shop entitlements: ${plan.preservation.returnShopEntitlements ? 'sim' : 'nao'}`);
    console.log(`- Gate/elegibilidade Return Shop: ${plan.preservation.returnShopGateAndEligibility ? 'sim' : 'nao'}`);
    console.log('\nAmostra RESET:');
    for (const playerId of plan.resetPlayerIds.slice(0, 20)) {
        console.log(`- ${playerId}`);
    }
}

async function main() {
    const databasePath = path.resolve(argValue('db') || DEFAULT_DB);
    const campaignKey = argValue('campaign') || 'mythic_launch_v1';

    if (!fs.existsSync(databasePath)) {
        throw new Error(`Banco nao encontrado: ${databasePath}`);
    }

    const db = await open({ filename: databasePath, driver: sqlite3.Database });
    try {
        const plan = await buildPreresetGlobalResetPlan(db, { campaignKey });
        renderPlan(plan);
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('\nFALHA NO PREVIEW DO RESET GLOBAL:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
