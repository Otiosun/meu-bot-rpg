const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

async function main() {
    const dbArg = process.argv[2] || process.env.DEVO_DB_PATH || path.resolve('./temp/devo-test-banco.sqlite');
    console.log('Using DB file:', dbArg);
    const db = await open({ filename: dbArg, driver: sqlite3.Database });

    try {
        const fkCheck = await db.all('PRAGMA foreign_key_check;');
        if (!fkCheck || fkCheck.length === 0) {
            console.log('foreign_key_check: no violations');
        } else {
            console.log('foreign_key_check: violations found');
            console.log(fkCheck);
        }

        const indexes = await db.all(`SELECT name, sql FROM sqlite_master WHERE type = 'index'`);
        console.log('Indexes (sample):', indexes.map(i => i.name).slice(0, 20));
    } finally {
        await db.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
