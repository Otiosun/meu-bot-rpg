'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { pseudonymizePlayerId } = require('../helpers/clover/traitDescriptionAuditPrivacy');

const BASE_SLOTS = 1;

function argumentValue(name) {
    const prefix = `--${name}=`;
    const argument = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
    return argument ? argument.slice(prefix.length) : null;
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [tableName]
    );
    return Boolean(row?.found);
}

async function rowsOrEmpty(db, tableName, sql, params = []) {
    if (!await tableExists(db, tableName)) return [];
    return db.all(sql, params);
}

function increment(map, playerId, key, amount = 1) {
    if (!playerId) return;
    const current = map.get(playerId) || {
        playerId,
        directTicketUses: 0,
        legacyApprovedTicketUses: 0,
        legacyPendingTicketUses: 0,
        legacyRejectedTicketUses: 0,
        legacyCancelledTicketUses: 0,
        approvedSpells: 0,
        activeQueueEntries: 0,
        ownedTicketUnits: 0,
        reservedTicketUnits: 0,
    };
    current[key] = Number(current[key] || 0) + Number(amount || 0);
    map.set(playerId, current);
}

async function main() {
    const databasePath = path.resolve(argumentValue('db') || process.env.CLOVER_DB_PATH || 'banco.sqlite');
    const outputPath = path.resolve(
        argumentValue('output')
        || path.join('artifacts', 'spell-capacity-audit', 'spell-capacity-audit.json')
    );
    if (!fs.existsSync(databasePath)) throw new Error(`Banco não encontrado: ${databasePath}`);

    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    try {
        await db.exec('PRAGMA query_only = ON');
        const integrityRow = await db.get('PRAGMA integrity_check');
        const integrity = integrityRow?.integrity_check || Object.values(integrityRow || {})[0] || null;
        const players = new Map();

        const directUses = await rowsOrEmpty(
            db,
            'clover_consumable_uses',
            `SELECT player_id, COUNT(*) AS total
             FROM clover_consumable_uses
             WHERE template_key = 'ticket_feitico' AND result = 'used'
             GROUP BY player_id`
        );
        directUses.forEach((row) => increment(players, row.player_id, 'directTicketUses', row.total));

        const redemptions = await rowsOrEmpty(
            db,
            'clover_item_redemptions',
            `SELECT player_id, status, COUNT(*) AS total
             FROM clover_item_redemptions
             WHERE template_key = 'ticket_feitico'
             GROUP BY player_id, status`
        );
        for (const row of redemptions) {
            const key = row.status === 'approved'
                ? 'legacyApprovedTicketUses'
                : row.status === 'pending'
                    ? 'legacyPendingTicketUses'
                    : row.status === 'rejected'
                        ? 'legacyRejectedTicketUses'
                        : row.status === 'cancelled'
                            ? 'legacyCancelledTicketUses'
                            : null;
            if (key) increment(players, row.player_id, key, row.total);
        }

        const spells = await rowsOrEmpty(
            db,
            'clover_spellbook_spells',
            `SELECT player_id, COUNT(DISTINCT normalized_name) AS total
             FROM clover_spellbook_spells
             WHERE status = 'approved' AND removed_at IS NULL
             GROUP BY player_id`
        );
        spells.forEach((row) => increment(players, row.player_id, 'approvedSpells', row.total));

        const queue = await rowsOrEmpty(
            db,
            'clover_spell_review_queue',
            `SELECT player_id, COUNT(*) AS total
             FROM clover_spell_review_queue
             WHERE status IN ('waiting', 'called')
             GROUP BY player_id`
        );
        queue.forEach((row) => increment(players, row.player_id, 'activeQueueEntries', row.total));

        const inventory = await rowsOrEmpty(
            db,
            'clover_inventory_items',
            `SELECT item.player_id,
                    COALESCE(SUM(item.quantity), 0) AS owned,
                    COALESCE(SUM((
                        SELECT COALESCE(SUM(reservation.quantity), 0)
                        FROM clover_inventory_reservations reservation
                        WHERE reservation.inventory_item_id = item.id
                          AND reservation.status = 'active'
                    )), 0) AS reserved
             FROM clover_inventory_items item
             WHERE item.template_key = 'ticket_feitico'
             GROUP BY item.player_id`
        );
        for (const row of inventory) {
            increment(players, row.player_id, 'ownedTicketUnits', row.owned);
            increment(players, row.player_id, 'reservedTicketUnits', row.reserved);
        }

        const playerIds = [...players.keys()];
        const names = new Map();
        if (playerIds.length && await tableExists(db, 'jogadores')) {
            const placeholders = playerIds.map(() => '?').join(', ');
            const rows = await db.all(
                `SELECT id, personagem_nome, nome, display_name
                 FROM jogadores WHERE id IN (${placeholders})`,
                playerIds
            );
            rows.forEach((row) => names.set(row.id, row.personagem_nome || row.nome || row.display_name || null));
        }

        const entries = [...players.values()].map((entry) => {
            const additionalSlots = entry.directTicketUses + entry.legacyApprovedTicketUses;
            const totalSlots = BASE_SLOTS + additionalSlots;
            const availableSlots = Math.max(0, totalSlots - entry.approvedSpells);
            return {
                playerKey: pseudonymizePlayerId(entry.playerId),
                characterName: names.get(entry.playerId) || null,
                baseSlots: BASE_SLOTS,
                directTicketUses: entry.directTicketUses,
                legacyApprovedTicketUses: entry.legacyApprovedTicketUses,
                additionalSlots,
                totalSlots,
                approvedSpells: entry.approvedSpells,
                occupiedSlots: entry.approvedSpells,
                reservedSlots: 0,
                availableSlots,
                overCapacity: entry.approvedSpells > totalSlots,
                activeQueueEntries: entry.activeQueueEntries,
                queueCountsAsCapacity: false,
                ownedTicketUnits: entry.ownedTicketUnits,
                reservedTicketUnits: entry.reservedTicketUnits,
                availableTicketUnits: Math.max(0, entry.ownedTicketUnits - entry.reservedTicketUnits),
                legacyPendingTicketUses: entry.legacyPendingTicketUses,
                legacyRejectedTicketUses: entry.legacyRejectedTicketUses,
                legacyCancelledTicketUses: entry.legacyCancelledTicketUses,
            };
        }).sort((left, right) => (
            Number(right.overCapacity) - Number(left.overCapacity)
            || String(left.characterName || left.playerKey).localeCompare(String(right.characterName || right.playerKey), 'pt-BR')
        ));

        const report = {
            generatedAt: new Date().toISOString(),
            readOnly: true,
            database: {
                file: path.basename(databasePath),
                integrity,
            },
            privacy: {
                rawPlayerIdsIncluded: false,
                phoneNumbersIncluded: false,
                playerIds: 'sha256-prefix',
            },
            policy: {
                baseSlots: BASE_SLOTS,
                ticketEffect: '+1 personal spell slot',
                reviewQueueCreatesCapacity: false,
                approvedSpellOccupiesSlot: true,
                legacyApprovedTicketRedemptionCountsAsSlot: true,
            },
            summary: {
                relevantPlayers: entries.length,
                directTicketUses: entries.reduce((sum, entry) => sum + entry.directTicketUses, 0),
                legacyApprovedTicketUses: entries.reduce((sum, entry) => sum + entry.legacyApprovedTicketUses, 0),
                pendingLegacyTicketRequests: entries.reduce((sum, entry) => sum + entry.legacyPendingTicketUses, 0),
                ownedTicketUnits: entries.reduce((sum, entry) => sum + entry.ownedTicketUnits, 0),
                availableTicketUnits: entries.reduce((sum, entry) => sum + entry.availableTicketUnits, 0),
                approvedSpells: entries.reduce((sum, entry) => sum + entry.approvedSpells, 0),
                overCapacityPlayers: entries.filter((entry) => entry.overCapacity).length,
                activeQueuePlayers: entries.filter((entry) => entry.activeQueueEntries > 0).length,
            },
            entries,
        };

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        console.log('Auditoria de capacidade de feitiços concluída em modo somente leitura.');
        console.log(`Integridade: ${integrity || 'não informada'}`);
        console.log(`Jogadores relevantes: ${report.summary.relevantPlayers}`);
        console.log(`Tickets antigos aprovados: ${report.summary.legacyApprovedTicketUses}`);
        console.log(`Tickets usados diretamente: ${report.summary.directTicketUses}`);
        console.log(`Personagens acima do limite: ${report.summary.overCapacityPlayers}`);
        console.log(`Relatório: ${outputPath}`);
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error('Falha na auditoria de capacidade:', error);
    process.exitCode = 1;
});
