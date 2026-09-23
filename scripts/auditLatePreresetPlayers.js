'use strict';

const sqlite3 = require('sqlite3');

const DB_PATH = process.env.CLOVER_RPG_DB || './banco.sqlite';
const PLAYER_IDS = process.argv.slice(2).map((value) => String(value || '').trim()).filter(Boolean);

if (!PLAYER_IDS.length) {
    throw new Error('Informe ao menos um player_id.');
}

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows)));
});

async function rowsIfTableExists(tableName, sql, params) {
    const table = await all(
        "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        [tableName]
    );
    return table.length ? all(sql, params) : [];
}

async function main() {
    const placeholders = PLAYER_IDS.map(() => '?').join(',');
    const inPlayers = `(${placeholders})`;
    const report = {
        players: await all(
            `SELECT id,nome,personagem_nome,ficha_status,jogo_status,esquadrao,
                    aptidao_comum,aptidao_rara,marca_comum,marca_rara,anomalia
             FROM jogadores WHERE id IN ${inPlayers} ORDER BY id`,
            PLAYER_IDS
        ),
        futureCharacters: await rowsIfTableExists(
            'clover_prereset_characters',
            `SELECT player_id,status,revision,draft_json,approved_at,locked_at
             FROM clover_prereset_characters WHERE player_id IN ${inPlayers} ORDER BY player_id`,
            PLAYER_IDS
        ),
        launchPlayers: await rowsIfTableExists(
            'clover_prereset_launch_players',
            `SELECT * FROM clover_prereset_launch_players WHERE player_id IN ${inPlayers} ORDER BY player_id`,
            PLAYER_IDS
        ),
        resetEvents: await rowsIfTableExists(
            'clover_player_reset_events',
            `SELECT * FROM clover_player_reset_events WHERE player_id IN ${inPlayers} ORDER BY player_id,id`,
            PLAYER_IDS
        ),
        prConversionClaims: await rowsIfTableExists(
            'clover_prereset_conversion_claims',
            `SELECT * FROM clover_prereset_conversion_claims WHERE player_id IN ${inPlayers} ORDER BY player_id,rowid`,
            PLAYER_IDS
        ),
        returnConversionClaims: await rowsIfTableExists(
            'clover_prereset_return_conversion_claims',
            `SELECT * FROM clover_prereset_return_conversion_claims WHERE player_id IN ${inPlayers} ORDER BY player_id,rowid`,
            PLAYER_IDS
        ),
        futureRollCounts: await rowsIfTableExists(
            'clover_prereset_future_rolls',
            `SELECT player_id,COUNT(*) AS total FROM clover_prereset_future_rolls
             WHERE player_id IN ${inPlayers} GROUP BY player_id ORDER BY player_id`,
            PLAYER_IDS
        ),
        currentRolls: await rowsIfTableExists(
            'player_rolls',
            `SELECT player_id,roll_number,kingdom_key,social_class_key,race_key,grimoire_key,magic_rarity_key,roll_version
             FROM player_rolls WHERE player_id IN ${inPlayers} ORDER BY player_id,roll_number`,
            PLAYER_IDS
        ),
        futureRolls: await rowsIfTableExists(
            'clover_prereset_future_rolls',
            `SELECT player_id,roll_number,kingdom_key,social_class_key,race_key,grimoire_key,magic_rarity_key,roll_version
             FROM clover_prereset_future_rolls WHERE player_id IN ${inPlayers} ORDER BY player_id,roll_number`,
            PLAYER_IDS
        ),
        reservations: await rowsIfTableExists(
            'clover_prereset_future_slot_reservations',
            `SELECT player_id,roll_number,category,option_key,status
             FROM clover_prereset_future_slot_reservations WHERE player_id IN ${inPlayers}
             ORDER BY player_id,roll_number,category`,
            PLAYER_IDS
        ),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main()
    .finally(() => new Promise((resolve) => db.close(() => resolve())))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
