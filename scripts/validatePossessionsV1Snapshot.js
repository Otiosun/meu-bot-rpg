'use strict';

const path = require('node:path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3').verbose();
const { ensurePossessionsV1Schema } = require('../helpers/clover/possessionsSchema');
const { getBoxHistory } = require('../helpers/clover/boxService');
const { getPlayerPossessions } = require('../helpers/clover/possessionsService');

async function main() {
    const databasePath = path.resolve(process.argv[2] || 'banco.sqlite');
    const db = await open({ filename: databasePath, driver: sqlite3.Database });
    try {
        await ensurePossessionsV1Schema(db);
        const integrity = await db.get('PRAGMA integrity_check');
        const counts = {
            titles: Number((await db.get('SELECT COUNT(*) AS total FROM clover_player_titles')).total || 0),
            titleHistory: Number((await db.get('SELECT COUNT(*) AS total FROM clover_title_history')).total || 0),
            activeTitleConflicts: Number((await db.get(`SELECT COUNT(*) AS total FROM (SELECT player_id FROM clover_player_titles WHERE active = 1 GROUP BY player_id HAVING COUNT(*) > 1)`)).total || 0),
            legacyItems: Number((await db.get(`SELECT COUNT(*) AS total FROM clover_inventory_items WHERE template_key IS NULL OR TRIM(template_key) = ''`)).total || 0),
            boxOpenings: Number((await db.get(`SELECT COUNT(*) AS total FROM clover_box_openings WHERE status = 'completed'`)).total || 0),
            redemptions: Number((await db.get('SELECT COUNT(*) AS total FROM clover_item_redemptions')).total || 0),
        };
        const samplePlayer = await db.get(`SELECT id FROM jogadores WHERE id IS NOT NULL AND TRIM(id) != '' ORDER BY id LIMIT 1`);
        let sample = null;
        if (samplePlayer) {
            const possessions = await getPlayerPossessions(db, samplePlayer.id, { historyLimit: 5 });
            sample = {
                spellCapacityStatus: possessions.spellCapacity.status,
                latestBoxOpening: (await getBoxHistory(db, samplePlayer.id, 1))[0]?.operation?.code || null,
            };
        }
        console.log(JSON.stringify({ ok: Object.values(integrity)[0] === 'ok', databasePath, integrity: Object.values(integrity)[0], counts, sample }, null, 2));
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
});
