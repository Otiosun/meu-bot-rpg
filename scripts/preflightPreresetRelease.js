'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { auditPreresetReleaseGate } = require('../helpers/clover/preresetReleaseGateService');

function argValue(name) {
    const prefix = `--${name}=`;
    const found = process.argv.find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
}

async function main() {
    const databasePath = path.resolve(argValue('db') || path.join(__dirname, '..', 'banco.sqlite'));
    if (!fs.existsSync(databasePath)) throw new Error(`Banco nao encontrado: ${databasePath}`);
    const db = await open({ filename: databasePath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
        await db.exec('PRAGMA query_only=ON');
        const result = await auditPreresetReleaseGate(db, { campaignKey: argValue('campaign') || 'mythic_launch_v1' });
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 2;
    } finally {
        await db.close();
    }
}

main().catch(error => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
