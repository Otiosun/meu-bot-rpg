'use strict';

function filled(value) {
    const normalized = String(value ?? '').trim();
    return normalized && normalized !== '-' ? normalized : null;
}

function rarity(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (['rare', 'rara', 'raro'].includes(normalized)) return 'rare';
    if (['common', 'comum'].includes(normalized)) return 'common';
    return null;
}

function buildFutureTraitPatch(draft = {}) {
    const traits = draft?.traits && typeof draft.traits === 'object' ? draft.traits : {};
    const aptitude = traits.aptitude && typeof traits.aptitude === 'object' ? traits.aptitude : null;
    const mark = traits.mark && typeof traits.mark === 'object' ? traits.mark : null;
    const anomaly = traits.anomaly && typeof traits.anomaly === 'object' ? traits.anomaly : null;
    const aptitudeRarity = rarity(aptitude?.rarity);
    const markRarity = rarity(mark?.rarity);

    return {
        aptidao_comum: aptitudeRarity === 'common' ? filled(aptitude?.name) || '-' : '-',
        aptidao_comum_key: aptitudeRarity === 'common' ? filled(aptitude?.key) : null,
        aptidao_rara: aptitudeRarity === 'rare' ? filled(aptitude?.name) || '-' : '-',
        aptidao_rara_key: aptitudeRarity === 'rare' ? filled(aptitude?.key) : null,
        marca_comum: markRarity === 'common' ? filled(mark?.name) || '-' : '-',
        marca_comum_key: markRarity === 'common' ? filled(mark?.key) : null,
        marca_rara: markRarity === 'rare' ? filled(mark?.name) || '-' : '-',
        marca_rara_key: markRarity === 'rare' ? filled(mark?.key) : null,
        anomalia: filled(anomaly?.name) || '-',
        anomalia_key: filled(anomaly?.key),
    };
}

function traitPatchMatches(player = {}, patch = {}) {
    return Object.entries(patch).every(([field, expected]) => {
        const actual = player[field] ?? null;
        if (expected === null) return actual === null || actual === '';
        return String(actual) === String(expected);
    });
}

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
        [tableName]
    );
    return Boolean(row?.found);
}

async function tableColumns(db, tableName) {
    if (!await tableExists(db, tableName)) return new Set();
    const rows = await db.all(`PRAGMA table_info("${String(tableName).replace(/"/g, '""')}")`);
    return new Set(rows.map((row) => row.name));
}

async function retireLegacySquadMemberships(db, playerId, options = {}) {
    if (!await tableExists(db, 'clover_squad_memberships')) return { retired: 0, events: 0 };
    const actorId = String(options.actorId || 'prereset_launch');
    const reason = String(options.reason || 'personagem anterior encerrado no PRE_RESET');
    const memberships = await db.all(
        "SELECT * FROM clover_squad_memberships WHERE player_id=? AND status='active' ORDER BY id",
        [String(playerId)]
    );
    if (!memberships.length) return { retired: 0, events: 0 };

    const columns = await tableColumns(db, 'clover_squad_memberships');
    const assignments = ["status='removed'"];
    const params = [];
    if (columns.has('ended_at')) assignments.push('ended_at=CURRENT_TIMESTAMP');
    if (columns.has('changed_by')) {
        assignments.push('changed_by=?');
        params.push(actorId);
    }
    if (columns.has('reason')) {
        assignments.push('reason=?');
        params.push(reason);
    }
    if (columns.has('metadata_json')) {
        assignments.push('metadata_json=?');
        params.push(JSON.stringify({ source: 'prereset_character_materialization' }));
    }
    const result = await db.run(
        `UPDATE clover_squad_memberships SET ${assignments.join(', ')}
         WHERE player_id=? AND status='active'`,
        [...params, String(playerId)]
    );

    let events = 0;
    if (await tableExists(db, 'clover_squad_membership_events')) {
        const eventColumns = await tableColumns(db, 'clover_squad_membership_events');
        const desired = {
            membership_id: null,
            squad_key: null,
            player_id: String(playerId),
            action: 'removed',
            changed_by: actorId,
            performed_by: actorId,
            reason,
            metadata_json: JSON.stringify({ source: 'prereset_character_materialization' }),
        };
        for (const membership of memberships) {
            desired.membership_id = membership.id ?? null;
            desired.squad_key = membership.squad_key ?? null;
            const entries = Object.entries(desired).filter(([column]) => eventColumns.has(column));
            if (!entries.length) continue;
            await db.run(
                `INSERT INTO clover_squad_membership_events
                 (${entries.map(([column]) => `"${column}"`).join(',')})
                 VALUES (${entries.map(() => '?').join(',')})`,
                entries.map(([, value]) => value)
            );
            events += 1;
        }
    }
    return { retired: Number(result?.changes || 0), events };
}

module.exports = {
    buildFutureTraitPatch,
    retireLegacySquadMemberships,
    traitPatchMatches,
};
