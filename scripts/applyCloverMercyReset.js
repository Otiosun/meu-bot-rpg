const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { getRollQualityScore } = require('../helpers/clover/rollEngine');

function timestamp() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
}

function backupDatabase(dbPath) {
    const backupDir = path.join(process.cwd(), 'backups', `clover-mercy-reset-${timestamp()}`);
    fs.mkdirSync(backupDir, { recursive: true });

    const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    files.forEach((filePath) => {
        if (fs.existsSync(filePath)) {
            fs.copyFileSync(filePath, path.join(backupDir, path.basename(filePath)));
        }
    });

    return backupDir;
}

function isApprovedStatus(value) {
    return ['aprovada', 'confirmada'].includes(String(value || '').toLowerCase());
}

function parsePayload(value) {
    try {
        return JSON.parse(value || '{}');
    } catch (_) {
        return {};
    }
}

function getPayloadRollNumber(payload) {
    return Number(payload.numeroRoll || payload.rollNumber || payload.numero_roll || payload.roll?.roll_number || 0);
}

function pickWorstRoll(rolls) {
    return [...rolls].sort((left, right) => {
        const scoreDiff = getRollQualityScore(left) - getRollQualityScore(right);
        if (scoreDiff !== 0) return scoreDiff;
        return Number(right.roll_number) - Number(left.roll_number);
    })[0] || null;
}

function pickBestRemainingRoll(rolls) {
    return [...rolls].sort((left, right) => {
        const scoreDiff = getRollQualityScore(right) - getRollQualityScore(left);
        if (scoreDiff !== 0) return scoreDiff;
        return Number(left.roll_number) - Number(right.roll_number);
    })[0] || null;
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
        deletedFailedTraitAttempts: 0,
        deletedRolls: 0,
        releasedReservations: 0,
        deletedPendingMagics: 0,
        deletedPendingProfiles: 0,
        changedSelectedRolls: 0,
        clearedUnapprovedChoices: 0,
    };

    await db.exec('BEGIN IMMEDIATE');
    try {
        const traitResult = await db.run(`
            DELETE FROM clover_trait_attempts
            WHERE result = 'failure'
              AND player_id NOT IN (
                  SELECT id
                  FROM jogadores
                  WHERE ficha_status IN ('aprovada', 'confirmada')
              )
        `);
        stats.deletedFailedTraitAttempts = Number(traitResult?.changes || 0);

        const players = await db.all(`
            SELECT DISTINCT player_id
            FROM player_rolls
            ORDER BY player_id ASC
        `);

        for (const item of players) {
            const playerId = item.player_id;
            const rolls = await db.all(
                `SELECT *
                 FROM player_rolls
                 WHERE player_id = ?
                 ORDER BY roll_number ASC`,
                [playerId]
            );
            const worst = pickWorstRoll(rolls);
            if (!worst) continue;

            const player = await db.get(
                `SELECT id, numero_roll_escolhido, ficha_status
                 FROM jogadores
                 WHERE id = ?`,
                [playerId]
            );
            const approved = isApprovedStatus(player?.ficha_status);
            const deletedRollNumber = Number(worst.roll_number);

            await db.run(
                `DELETE FROM player_rolls
                 WHERE player_id = ? AND roll_number = ?`,
                [playerId, deletedRollNumber]
            );
            stats.deletedRolls += 1;

            const released = await db.run(
                `UPDATE slot_reservations
                 SET status = 'released'
                 WHERE player_id = ?
                   AND roll_number = ?
                   AND status = 'pending'`,
                [playerId, deletedRollNumber]
            );
            stats.releasedReservations += Number(released?.changes || 0);

            const pendingMagic = await db.run(
                `DELETE FROM pending_magic_confirmations
                 WHERE player_id = ? AND roll_number = ?`,
                [playerId, deletedRollNumber]
            );
            stats.deletedPendingMagics += Number(pendingMagic?.changes || 0);

            const pendingProfile = await db.get(
                `SELECT player_id, payload
                 FROM pending_profile_confirmations
                 WHERE player_id = ?`,
                [playerId]
            );
            if (pendingProfile && getPayloadRollNumber(parsePayload(pendingProfile.payload)) === deletedRollNumber) {
                await db.run('DELETE FROM pending_profile_confirmations WHERE player_id = ?', [playerId]);
                stats.deletedPendingProfiles += 1;
            }

            if (Number(player?.numero_roll_escolhido || 0) === deletedRollNumber) {
                const remaining = rolls.filter((roll) => Number(roll.roll_number) !== deletedRollNumber);
                const bestRemaining = pickBestRemainingRoll(remaining);
                await db.run(
                    `UPDATE jogadores
                     SET numero_roll_escolhido = ?
                     WHERE id = ?`,
                    [bestRemaining?.roll_number || null, playerId]
                );
                stats.changedSelectedRolls += 1;

                if (!approved) {
                    await db.run(
                        `UPDATE jogadores
                         SET ficha_status = 'incompleta',
                             magia = '-',
                             magia_key = NULL,
                             familia = '-',
                             familia_key = NULL
                         WHERE id = ?`,
                        [playerId]
                    );
                    stats.clearedUnapprovedChoices += 1;

                    const releasedMagic = await db.run(
                        `UPDATE slot_reservations
                         SET status = 'released'
                         WHERE player_id = ?
                           AND roll_number = ?
                           AND source = 'magic_choice'
                           AND status IN ('pending', 'confirmed')`,
                        [playerId, deletedRollNumber]
                    );
                    stats.releasedReservations += Number(releasedMagic?.changes || 0);
                }
            }
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
