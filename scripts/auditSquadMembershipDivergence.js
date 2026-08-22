'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { auditSquadMembershipDivergence } = require('../helpers/clover/squadMembershipDivergenceAudit');

function parseDatabasePath(argv) {
    const matches = argv.reduce((paths, value, index) => value === '--db' ? [...paths, argv[index + 1]] : paths, []);
    if (matches.length !== 1 || !matches[0] || String(matches[0]).startsWith('--')) {
        throw new Error('Usage: node scripts/auditSquadMembershipDivergence.js --db <snapshot.sqlite>');
    }
    return path.resolve(matches[0]);
}

async function openReadOnlyDatabase(filename) {
    if (!fs.existsSync(filename)) throw new Error(`Database snapshot not found: ${filename}`);
    return open({ filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
}

async function main(argv = process.argv.slice(2)) {
    const filename = parseDatabasePath(argv);
    const db = await openReadOnlyDatabase(filename);
    try {
        return await auditSquadMembershipDivergence(db);
    } finally {
        await db.close();
    }
}

if (require.main === module) {
    main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { main, openReadOnlyDatabase, parseDatabasePath };
