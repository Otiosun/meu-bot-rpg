'use strict';

const { ensureCloverSquadSchema } = require('../../database');
const {
    getGroupAccess,
    isOwner,
    isSameUser,
    normalizeJid,
} = require('../groupAccess');
const { normalizeSquadKey } = require('./cavalierService');
const {
    SQUAD_UPGRADES,
    getRenownGradeFromHistory,
    getSquadUpgrade,
    listUpgradeCategories,
    listUpgradesByCategory,
} = require('./squadUpgradeCatalog');

async function ensureSquadUpgradeSchema(db) {
    await ensureCloverSquadSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_squad_upgrades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            squad_key TEXT NOT NULL,
            upgrade_key TEXT NOT NULL,
            upgrade_name TEXT NOT NULL,
            category_key TEXT NOT NULL,
            category_label TEXT NOT NULL,
            cost_stars INTEGER NOT NULL DEFAULT 0 CHECK (cost_stars >= 0),
            required_grade INTEGER NOT NULL DEFAULT 0 CHECK (required_grade BETWEEN 0 AND 6),
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
            purchased_by TEXT NOT NULL,
            purchased_at TEXT DEFAULT CURRENT_TIMESTAMP,
            revoked_by TEXT DEFAULT NULL,
            revoked_at TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_squad_upgrades_active_unique
        ON clover_squad_upgrades (squad_key, upgrade_key)
        WHERE status = 'active'
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_squad_upgrades_squad
        ON clover_squad_upgrades (squad_key, status, purchased_at DESC, id DESC)
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_squad_upgrade_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            upgrade_id INTEGER DEFAULT NULL,
            squad_key TEXT NOT NULL,
            upgrade_key TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('purchased', 'revoked')),
            stars_delta INTEGER NOT NULL DEFAULT 0,
            performed_by TEXT NOT NULL,
            reason TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_squad_upgrade_events_squad
        ON clover_squad_upgrade_events (squad_key, created_at DESC, id DESC)
    `);
}

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function serializeMetadata(value) {
    return value && typeof value === 'object' ? JSON.stringify(value) : null;
}

async function getSquad(db, squadInput) {
    await ensureCloverSquadSchema(db);
    const key = normalizeSquadKey(squadInput?.squad_key || squadInput?.name || squadInput);
    if (!key) return null;
    return db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [key]);
}

async function resolveSquadForContext(db, { squadName = null, groupId = null, playerId = null } = {}) {
    await ensureCloverSquadSchema(db);
    if (squadName) {
        const direct = await getSquad(db, squadName);
        if (direct) return direct;
    }
    if (groupId) {
        const byGroup = await db.get('SELECT * FROM clover_squads WHERE group_id = ?', [groupId]);
        if (byGroup) return byGroup;
    }
    if (playerId) {
        const player = await db.get('SELECT esquadrao FROM jogadores WHERE id = ?', [playerId]);
        if (player?.esquadrao) return getSquad(db, player.esquadrao);
    }
    return null;
}

async function listActiveSquadUpgrades(db, squadKey) {
    await ensureSquadUpgradeSchema(db);
    return db.all(
        `SELECT * FROM clover_squad_upgrades
         WHERE squad_key = ? AND status = 'active'
         ORDER BY purchased_at ASC, id ASC`,
        [normalizeSquadKey(squadKey)]
    );
}

async function listSquadUpgradeHistory(db, squadKey, limit = 20) {
    await ensureSquadUpgradeSchema(db);
    return db.all(
        `SELECT * FROM clover_squad_upgrade_events
         WHERE squad_key = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [normalizeSquadKey(squadKey), Math.max(1, Math.min(50, Number(limit) || 20))]
    );
}

function getMissingPrerequisites(upgrade, activeKeys) {
    return upgrade.prerequisites.filter((key) => !activeKeys.has(key));
}

async function getSquadUpgradeState(db, squadInput) {
    const squad = await getSquad(db, squadInput);
    if (!squad) return { ok: false, code: 'squad_not_found' };
    const activeRows = await listActiveSquadUpgrades(db, squad.squad_key);
    const activeKeys = new Set(activeRows.map((row) => row.upgrade_key));
    const renownGrade = getRenownGradeFromHistory(squad.historical_stars);
    const currentStars = Math.max(0, Number(squad.current_stars || 0));

    const items = SQUAD_UPGRADES.map((upgrade, index) => {
        const ownedRow = activeRows.find((row) => row.upgrade_key === upgrade.key) || null;
        const missingPrerequisites = getMissingPrerequisites(upgrade, activeKeys);
        const blockedCodes = [];
        if (ownedRow) blockedCodes.push('owned');
        if (renownGrade < upgrade.requiredGrade) blockedCodes.push('grade');
        if (missingPrerequisites.length) blockedCodes.push('prerequisite');
        if (currentStars < upgrade.cost) blockedCodes.push('stars');
        return {
            ...upgrade,
            id: index + 1,
            owned: Boolean(ownedRow),
            ownedRow,
            missingPrerequisites,
            blockedCodes,
            available: blockedCodes.length === 0,
        };
    });

    const categorySummary = listUpgradeCategories().map((category) => {
        const categoryItems = items.filter((item) => item.categoryKey === category.key);
        return {
            ...category,
            total: categoryItems.length,
            owned: categoryItems.filter((item) => item.owned).length,
            available: categoryItems.filter((item) => item.available).length,
        };
    });

    return {
        ok: true,
        squad,
        squadKey: squad.squad_key,
        currentStars,
        historicalStars: Math.max(0, Number(squad.historical_stars || 0)),
        renownGrade,
        activeRows,
        activeKeys,
        items,
        categories: categorySummary,
        ownedCount: activeRows.length,
        totalCount: SQUAD_UPGRADES.length,
    };
}

async function writeUpgradeEvent(db, {
    upgradeId,
    squadKey,
    upgradeKey,
    action,
    starsDelta,
    performedBy,
    reason,
    metadata,
}) {
    await db.run(
        `INSERT INTO clover_squad_upgrade_events
         (upgrade_id, squad_key, upgrade_key, action, stars_delta,
          performed_by, reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            upgradeId || null,
            squadKey,
            upgradeKey,
            action,
            Number(starsDelta || 0),
            normalizeJid(performedBy) || String(performedBy || 'system'),
            String(reason || '').trim() || null,
            serializeMetadata(metadata),
        ]
    );
}

async function purchaseSquadUpgrade(db, squadInput, upgradeInput, {
    purchasedBy,
    reason = 'Benfeitoria adquirida para o QG',
    metadata = {},
} = {}) {
    await ensureSquadUpgradeSchema(db);
    const upgrade = getSquadUpgrade(upgradeInput);
    if (!upgrade) return { ok: false, code: 'unknown_upgrade' };
    const actor = normalizeJid(purchasedBy) || String(purchasedBy || '').trim();
    if (!actor) return { ok: false, code: 'invalid_actor', upgrade };

    await db.exec('BEGIN IMMEDIATE');
    try {
        const squad = await getSquad(db, squadInput);
        if (!squad) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'squad_not_found', upgrade };
        }
        const existing = await db.get(
            `SELECT * FROM clover_squad_upgrades
             WHERE squad_key = ? AND upgrade_key = ? AND status = 'active'`,
            [squad.squad_key, upgrade.key]
        );
        if (existing) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'already_owned', squad, upgrade, existing };
        }

        const activeRows = await db.all(
            `SELECT upgrade_key FROM clover_squad_upgrades
             WHERE squad_key = ? AND status = 'active'`,
            [squad.squad_key]
        );
        const activeKeys = new Set(activeRows.map((row) => row.upgrade_key));
        const missingPrerequisites = getMissingPrerequisites(upgrade, activeKeys);
        const renownGrade = getRenownGradeFromHistory(squad.historical_stars);
        const currentStars = Math.max(0, Number(squad.current_stars || 0));

        if (renownGrade < upgrade.requiredGrade) {
            await db.exec('ROLLBACK');
            return {
                ok: false,
                code: 'grade_required',
                squad,
                upgrade,
                renownGrade,
                requiredGrade: upgrade.requiredGrade,
            };
        }
        if (missingPrerequisites.length) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'missing_prerequisites', squad, upgrade, missingPrerequisites };
        }
        if (currentStars < upgrade.cost) {
            await db.exec('ROLLBACK');
            return { ok: false, code: 'insufficient_stars', squad, upgrade, currentStars };
        }

        const insert = await db.run(
            `INSERT INTO clover_squad_upgrades
             (squad_key, upgrade_key, upgrade_name, category_key, category_label,
              cost_stars, required_grade, status, purchased_by, reason, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
            [
                squad.squad_key,
                upgrade.key,
                upgrade.name,
                upgrade.categoryKey,
                upgrade.categoryLabel,
                upgrade.cost,
                upgrade.requiredGrade,
                actor,
                reason,
                serializeMetadata({ ...metadata, catalog_activation: upgrade.activation, requires_approval: upgrade.requiresApproval }),
            ]
        );

        if (upgrade.cost > 0) {
            await db.run(
                `UPDATE clover_squads
                 SET current_stars = current_stars - ?, updated_at = CURRENT_TIMESTAMP
                 WHERE squad_key = ?`,
                [upgrade.cost, squad.squad_key]
            );
            await db.run(
                `INSERT INTO clover_squad_star_ledger
                 (squad_key, player_id, evaluation_id, amount, kind, source,
                  reason, created_by, metadata_json)
                 VALUES (?, NULL, NULL, ?, 'gasto', 'qg_upgrade', ?, ?, ?)`,
                [
                    squad.squad_key,
                    -upgrade.cost,
                    `Compra da benfeitoria: ${upgrade.name}`,
                    actor,
                    serializeMetadata({ upgrade_id: insert.lastID, upgrade_key: upgrade.key }),
                ]
            );
        }

        await writeUpgradeEvent(db, {
            upgradeId: insert.lastID,
            squadKey: squad.squad_key,
            upgradeKey: upgrade.key,
            action: 'purchased',
            starsDelta: -upgrade.cost,
            performedBy: actor,
            reason,
            metadata: { ...metadata, upgrade_name: upgrade.name },
        });
        const updatedSquad = await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [squad.squad_key]);
        const row = await db.get('SELECT * FROM clover_squad_upgrades WHERE id = ?', [insert.lastID]);
        await db.exec('COMMIT');

        return {
            ok: true,
            code: 'purchased',
            squad: updatedSquad,
            upgrade,
            row,
            starsBefore: currentStars,
            starsAfter: Math.max(0, Number(updatedSquad.current_stars || 0)),
            renownGrade,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        if (error?.code === 'SQLITE_CONSTRAINT') {
            return { ok: false, code: 'already_owned', upgrade };
        }
        throw error;
    }
}

async function canManageSquadUpgrade({ sock, idChat, actorId, squad }) {
    if (isOwner(actorId)) return { ok: true, code: 'owner' };
    if (isSameUser(actorId, squad?.captain_player_id)) return { ok: true, code: 'captain' };
    if (isSameUser(actorId, squad?.vice_captain_player_id)) return { ok: true, code: 'vice_captain' };
    if (idChat?.endsWith('@g.us')) {
        const access = await getGroupAccess(sock, idChat, actorId);
        if (access.isAdmin) return { ok: true, code: 'group_admin' };
    }
    return { ok: false, code: 'forbidden' };
}

function readUpgradeMetadata(row) {
    return safeJsonParse(row?.metadata_json, {});
}

module.exports = {
    canManageSquadUpgrade,
    ensureSquadUpgradeSchema,
    getMissingPrerequisites,
    getSquad,
    getSquadUpgradeState,
    listActiveSquadUpgrades,
    listSquadUpgradeHistory,
    purchaseSquadUpgrade,
    readUpgradeMetadata,
    resolveSquadForContext,
};
