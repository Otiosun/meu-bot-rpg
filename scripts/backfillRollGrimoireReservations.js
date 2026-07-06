const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { getSlotConfigOption } = require('../helpers/clover/configLoader');
const { countUsedSlots, expireOldReservations } = require('../helpers/clover/slotManager');

function timestamp() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
}

function backupDatabase(dbPath) {
    const backupDir = path.join(process.cwd(), 'backups', `roll-grimoire-reservations-${timestamp()}`);
    fs.mkdirSync(backupDir, { recursive: true });

    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].forEach((filePath) => {
        if (fs.existsSync(filePath)) {
            fs.copyFileSync(filePath, path.join(backupDir, path.basename(filePath)));
        }
    });

    return backupDir;
}

async function hasActiveReservation(db, roll) {
    const row = await db.get(
        `SELECT id
         FROM slot_reservations
         WHERE player_id = ?
           AND category = 'grimoire'
           AND option_key = ?
           AND roll_number = ?
           AND (
                status = 'confirmed'
                OR (status = 'pending' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP))
           )
         LIMIT 1`,
        [roll.player_id, roll.grimoire_key, roll.roll_number]
    );
    return Boolean(row);
}

async function main() {
    const dbPath = path.join(process.cwd(), 'banco.sqlite');
    if (!fs.existsSync(dbPath)) {
        throw new Error(`Banco nao encontrado: ${dbPath}`);
    }

    const backupDir = backupDatabase(dbPath);
    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    const stats = {
        backupDir,
        scanned: 0,
        reserved: 0,
        skippedUnlimited: 0,
        skippedApproved: 0,
        skippedExisting: 0,
        skippedFull: 0,
    };

    await expireOldReservations(db);

    const rolls = await db.all(`
        SELECT pr.*, j.ficha_status
        FROM player_rolls pr
        LEFT JOIN jogadores j ON j.id = pr.player_id
        WHERE pr.grimoire_key IS NOT NULL
          AND pr.grimoire_key <> ''
        ORDER BY pr.created_at ASC, pr.player_id ASC, pr.roll_number ASC
    `);

    await db.exec('BEGIN IMMEDIATE');
    try {
        for (const roll of rolls) {
            stats.scanned += 1;
            const option = getSlotConfigOption('grimoire', roll.grimoire_key);
            if (!option?.capacity) {
                stats.skippedUnlimited += 1;
                continue;
            }

            if (['aprovada', 'confirmada'].includes(String(roll.ficha_status || '').toLowerCase())) {
                stats.skippedApproved += 1;
                continue;
            }

            if (await hasActiveReservation(db, roll)) {
                stats.skippedExisting += 1;
                continue;
            }

            const usedCount = await countUsedSlots(db, 'grimoire', option.key, { skipExpire: true });
            if (usedCount >= option.capacity) {
                stats.skippedFull += 1;
                continue;
            }

            await db.run(
                `INSERT INTO slot_reservations
                 (player_id, category, option_key, status, source, roll_number, expires_at, created_at)
                 VALUES (?, 'grimoire', ?, 'pending', 'roll_grimoire', ?, datetime('now', '+24 hours'), CURRENT_TIMESTAMP)`,
                [roll.player_id, option.key, roll.roll_number]
            );
            stats.reserved += 1;
        }

        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    } finally {
        await db.close();
    }

    console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
