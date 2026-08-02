'use strict';

const { ensureCloverSquadSchema } = require('../../database');
const { isSameUser, normalizeJid } = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const {
    formatStars,
    normalizeSquadKey,
} = require('./cavalierService');

const SYNTHETIC_RECONCILIATION_SOURCE = 'squad_reconcile';

function isFilled(value) {
    const text = String(value || '').trim();
    return Boolean(text) && !['-', '.'].includes(text);
}

function truncateText(value, maxLength = 180) {
    const text = String(value || '').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1).trim()}…`;
}

function displayPlayerName(player = {}) {
    return [player.personagem_nome, player.nome, player.display_name]
        .map((value) => String(value || '').trim())
        .find((value) => isFilled(value))
        || 'Personagem sem nome';
}

function isVisibleSquadMember(player = {}) {
    const ficha = normalizeText(player.ficha_status || '');
    const jogo = normalizeText(player.jogo_status || '');
    return ['aprovada', 'confirmada'].includes(ficha)
        && jogo === 'liberado'
        && isFilled(player.personagem_nome);
}

function normalizeSearch(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function formatNameAndStars(player) {
    if (!player) return '-';
    return `${displayPlayerName(player)} — ${formatStars(player.estrelas)}`;
}

function formatCommandPerson(name, player) {
    if (player) return formatNameAndStars(player);
    return isFilled(name) ? String(name).trim() : '-';
}

function rowToSquad(row) {
    if (!row) return null;
    return {
        key: row.squad_key,
        name: row.name,
        groupId: row.group_id || null,
        phrase: row.phrase || null,
        captainName: row.captain_name || null,
        captainPlayerId: row.captain_player_id || null,
        viceCaptainPlayerId: row.vice_captain_player_id || null,
        historicalStars: Number(row.historical_stars || 0),
        currentStars: Number(row.current_stars || 0),
        blackStars: Number(row.black_stars || 0),
        descriptionSyncedAt: row.description_synced_at || null,
        descriptionSyncStatus: row.description_sync_status || null,
        descriptionSyncError: row.description_sync_error || null,
        updatedAt: row.updated_at || null,
    };
}

async function getSquadByKey(db, squadKey) {
    await ensureCloverSquadSchema(db);
    const row = await db.get(
        'SELECT * FROM clover_squads WHERE squad_key = ?',
        [squadKey]
    );
    return rowToSquad(row);
}

async function listSquads(db, options = {}) {
    await ensureCloverSquadSchema(db);
    const rows = await db.all(
        `SELECT *
         FROM clover_squads
         ${options.withGroupOnly ? 'WHERE group_id IS NOT NULL' : ''}
         ORDER BY name COLLATE NOCASE ASC`
    );
    return rows.map(rowToSquad).filter(Boolean);
}

async function getSquadByName(db, name) {
    const squadKey = normalizeSquadKey(name);
    if (!squadKey) return null;
    return getSquadByKey(db, squadKey);
}

async function getSquadByGroupId(db, groupId) {
    await ensureCloverSquadSchema(db);
    const row = await db.get(
        'SELECT * FROM clover_squads WHERE group_id = ?',
        [normalizeJid(groupId)]
    );
    return rowToSquad(row);
}

async function ensureSquad(db, name) {
    await ensureCloverSquadSchema(db);
    const squadName = String(name || '').trim();
    const squadKey = normalizeSquadKey(squadName);
    if (!squadKey) return null;

    await db.run(
        `INSERT INTO clover_squads (squad_key, name, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(squad_key) DO UPDATE SET
             name = CASE
                 WHEN clover_squads.name IS NULL OR clover_squads.name = '' THEN excluded.name
                 ELSE clover_squads.name
             END,
             updated_at = CURRENT_TIMESTAMP`,
        [squadKey, squadName]
    );

    return getSquadByKey(db, squadKey);
}

async function updateSquadGroup(db, name, groupId) {
    const squad = await ensureSquad(db, name);
    if (!squad) return null;
    const normalizedGroupId = normalizeJid(groupId);

    await db.run(
        `UPDATE clover_squads
         SET group_id = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE group_id = ?
           AND squad_key <> ?`,
        [normalizedGroupId, squad.key]
    );

    await db.run(
        `UPDATE clover_squads
         SET group_id = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE squad_key = ?`,
        [normalizedGroupId, squad.key]
    );

    return getSquadByKey(db, squad.key);
}

async function updateSquadPhrase(db, squadKey, phrase) {
    await ensureCloverSquadSchema(db);
    await db.run(
        `UPDATE clover_squads
         SET phrase = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE squad_key = ?`,
        [isFilled(phrase) ? truncateText(phrase, 240) : null, squadKey]
    );
    return getSquadByKey(db, squadKey);
}

async function updateSquadCaptainName(db, squadKey, captainName) {
    await ensureCloverSquadSchema(db);
    await db.run(
        `UPDATE clover_squads
         SET captain_name = ?,
             captain_player_id = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE squad_key = ?`,
        [isFilled(captainName) ? String(captainName).trim() : null, squadKey]
    );
    return getSquadByKey(db, squadKey);
}

async function updateSquadCaptainPlayer(db, squadKey, playerId, captainName = null) {
    await ensureCloverSquadSchema(db);
    await db.run(
        `UPDATE clover_squads
         SET captain_name = ?,
             captain_player_id = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE squad_key = ?`,
        [isFilled(captainName) ? String(captainName).trim() : null, playerId, squadKey]
    );
    return getSquadByKey(db, squadKey);
}

async function updateSquadViceCaptainPlayer(db, squadKey, playerId) {
    await ensureCloverSquadSchema(db);
    await db.run(
        `UPDATE clover_squads
         SET vice_captain_player_id = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE squad_key = ?`,
        [playerId || null, squadKey]
    );
    return getSquadByKey(db, squadKey);
}

async function getPlayerById(db, playerId) {
    if (!playerId) return null;
    return db.get(
        `SELECT id, nome, personagem_nome, display_name, esquadrao, estrelas, ficha_status, jogo_status
         FROM jogadores
         WHERE id = ?`,
        [playerId]
    );
}

async function findPlayersByName(db, name) {
    const needle = normalizeSearch(name);
    if (!needle) return [];

    const rows = await db.all(
        `SELECT id, nome, personagem_nome, display_name, esquadrao, estrelas, ficha_status, jogo_status
         FROM jogadores
         WHERE personagem_nome IS NOT NULL
           AND personagem_nome <> '-'`
    );

    return rows
        .map((row) => {
            const fields = [row.personagem_nome, row.nome, row.display_name].map(normalizeSearch);
            let score = 0;
            if (fields.some((field) => field === needle)) score = 100;
            else if (fields.some((field) => field.split(' ')[0] === needle)) score = 90;
            else if (fields.some((field) => field.includes(needle))) score = 70;
            else if (fields.some((field) => needle.includes(field) && field.length >= 3)) score = 50;
            return { ...row, score };
        })
        .filter((row) => row.score > 0)
        .sort((left, right) => right.score - left.score
            || displayPlayerName(left).localeCompare(displayPlayerName(right)));
}

async function getSquadMembers(db, squadKey) {
    const rows = await db.all(
        `SELECT id, nome, personagem_nome, display_name, esquadrao, estrelas, ficha_status, jogo_status
         FROM jogadores
         WHERE esquadrao IS NOT NULL
           AND esquadrao <> '-'`
    );

    return rows
        .filter((row) => normalizeSquadKey(row.esquadrao) === squadKey)
        .filter(isVisibleSquadMember)
        .sort((left, right) => Number(right.estrelas || 0) - Number(left.estrelas || 0)
            || displayPlayerName(left).localeCompare(displayPlayerName(right)));
}

async function readSquadLedgerTotals(db, squadKey) {
    const row = await db.get(
        `SELECT
             COUNT(*) AS ledger_count,
             COALESCE(SUM(CASE
                 WHEN COALESCE(source, '') <> ? THEN 1
                 ELSE 0
             END), 0) AS authoritative_count,
             COALESCE(SUM(CASE
                 WHEN COALESCE(source, '') <> ? THEN amount
                 ELSE 0
             END), 0) AS current_total,
             COALESCE(SUM(CASE
                 WHEN COALESCE(source, '') <> ? AND amount > 0 THEN amount
                 ELSE 0
             END), 0) AS historical_total,
             COALESCE(SUM(CASE
                 WHEN COALESCE(source, '') = ? THEN 1
                 ELSE 0
             END), 0) AS ignored_synthetic_count
         FROM clover_squad_star_ledger
         WHERE squad_key = ?`,
        [
            SYNTHETIC_RECONCILIATION_SOURCE,
            SYNTHETIC_RECONCILIATION_SOURCE,
            SYNTHETIC_RECONCILIATION_SOURCE,
            SYNTHETIC_RECONCILIATION_SOURCE,
            squadKey,
        ]
    );

    return {
        ledgerCount: Number(row?.ledger_count || 0),
        authoritativeCount: Number(row?.authoritative_count || 0),
        currentStars: Number(row?.current_total || 0),
        historicalStars: Number(row?.historical_total || 0),
        ignoredSyntheticCount: Number(row?.ignored_synthetic_count || 0),
    };
}

async function getSquadView(db, squadKey) {
    const squad = await getSquadByKey(db, squadKey);
    if (!squad) return null;

    const [members, captainPlayer, viceCaptainPlayer] = await Promise.all([
        getSquadMembers(db, squad.key),
        getPlayerById(db, squad.captainPlayerId),
        getPlayerById(db, squad.viceCaptainPlayerId),
    ]);

    const listedMembers = members.filter((member) => (
        !isSameUser(member.id, squad.captainPlayerId)
        && !isSameUser(member.id, squad.viceCaptainPlayerId)
    ));
    const historicalGap = Math.max(
        0,
        Number(squad.historicalStars || 0) - Number(squad.currentStars || 0)
    );

    return {
        squad,
        members,
        listedMembers,
        captainPlayer,
        viceCaptainPlayer,
        historicalGap,
        memberStarsTotal: members.reduce((total, member) => total + Number(member.estrelas || 0), 0),
    };
}

function renderMemberLines(members, limit = 40) {
    if (!members.length) return ['Nenhum membro registrado.'];
    const visible = members.slice(0, limit)
        .map((member) => `*${displayPlayerName(member)}* — ${formatStars(member.estrelas)}`);
    if (members.length > limit) visible.push(`… e mais ${members.length - limit} membro(s).`);
    return visible;
}

function renderGroupMemberLines(members, limit = 24) {
    if (!members.length) return ['Nenhum membro registrado.'];
    const visible = members.slice(0, limit)
        .map((member) => `${displayPlayerName(member)} — ${Number(member.estrelas || 0)}`);
    if (members.length > limit) visible.push(`… +${members.length - limit}`);
    return visible;
}

function renderSquadMessage(view) {
    const {
        squad,
        listedMembers,
        captainPlayer,
        viceCaptainPlayer,
        members,
        memberStarsTotal,
        historicalGap,
    } = view;
    const lines = [
        `♧┃𝐄𝐒𝐐𝐔𝐀𝐃𝐑𝐀̃𝐎 𖥔 ${squad.name}`,
        '     ──  comando, estrelas e membros registrados  ──',
        '',
    ];

    if (isFilled(squad.phrase)) {
        lines.push(
            '_`─( ❝ )───── 𝗙𝗿𝗮𝘀𝗲`_',
            '',
            `> ${squad.phrase}`,
            ''
        );
    }

    lines.push(
        '_`─( ★ )───── 𝗘𝘀𝘁𝗿𝗲𝗹𝗮𝘀`_',
        '',
        `*Atuais:* ${formatStars(squad.currentStars)}`,
        `*Histórico:* ${formatStars(squad.historicalStars)}`,
        `*Usado/perdido:* ${formatStars(historicalGap)}`,
        `*Membros visíveis:* ${formatStars(memberStarsTotal)}`,
        `*Estrelas Negras:* ${formatStars(squad.blackStars)}`,
        '',
        '_`─( ♚ )───── 𝗖𝗼𝗺𝗮𝗻𝗱𝗼`_',
        '',
        `*𝐂𝐚𝐩𝐢𝐭𝐚̃𝐨:* ${formatCommandPerson(squad.captainName, captainPlayer)}`,
        `*𝐕𝐢𝐜𝐞-𝐂𝐚𝐩𝐢𝐭𝐚̃𝐨:* ${formatCommandPerson(null, viceCaptainPlayer)}`,
        '',
        '_`─( ◆ )───── 𝗠𝗲𝗺𝗯𝗿𝗼𝘀`_',
        '',
        ...renderMemberLines(listedMembers),
        '',
        '_`─( ■ )───── 𝗦𝗶𝘁𝘂𝗮𝗰̧𝗮̃𝗼`_',
        '',
        `*𝐆𝐫𝐮𝐩𝐨:* ${squad.groupId ? 'registrado' : 'não registrado'}`,
        `*𝐃𝐞𝐬𝐜𝐫𝐢𝐜̧𝐚̃𝐨:* ${squad.descriptionSyncStatus === 'ok' ? 'sincronizada' : 'pendente'}`,
        `*𝐌𝐞𝐦𝐛𝐫𝐨𝐬 𝐯𝐢𝐬𝐢́𝐯𝐞𝐢𝐬:* ${members.length} registrados`
    );

    return lines.join('\n');
}

function renderSquadGroupDescription(view) {
    const {
        squad,
        listedMembers,
        captainPlayer,
        viceCaptainPlayer,
        memberStarsTotal,
        historicalGap,
    } = view;
    const lines = [
        `♧┃𝐄𝐒𝐐𝐔𝐀𝐃𝐑𝐀̃𝐎 𖥔 ${squad.name}`,
        '     ──  registro oficial do esquadrão  ──',
        '',
    ];

    if (isFilled(squad.phrase)) {
        lines.push(`> ${squad.phrase}`, '');
    }

    lines.push(
        '_`─( ★ )───── 𝗘𝘀𝘁𝗿𝗲𝗹𝗮𝘀`_',
        '',
        `*Atuais:* ${Number(squad.currentStars || 0)}`,
        `*Histórico:* ${Number(squad.historicalStars || 0)}`,
        `*Usado/perdido:* ${Number(historicalGap || 0)}`,
        `*Membros visíveis:* ${Number(memberStarsTotal || 0)}`,
        `*Negras:* ${Number(squad.blackStars || 0)}`,
        '',
        '_`─( ♚ )───── 𝗖𝗼𝗺𝗮𝗻𝗱𝗼`_',
        '',
        `*𝐂𝐚𝐩𝐢𝐭𝐚̃𝐨:* ${formatCommandPerson(squad.captainName, captainPlayer)}`,
        `*𝐕𝐢𝐜𝐞:* ${formatCommandPerson(null, viceCaptainPlayer)}`,
        '',
        '_`─( ◆ )───── 𝗠𝗲𝗺𝗯𝗿𝗼𝘀`_',
        '',
        ...renderGroupMemberLines(listedMembers)
    );

    return lines.join('\n').slice(0, 2048);
}

async function markSquadDescriptionSync(db, squadKey, status, error = null) {
    await db.run(
        `UPDATE clover_squads
         SET description_synced_at = CASE WHEN ? = 'ok' THEN CURRENT_TIMESTAMP ELSE description_synced_at END,
             description_sync_status = ?,
             description_sync_error = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE squad_key = ?`,
        [status, status, error ? String(error).slice(0, 400) : null, squadKey]
    );
}

async function reconcileSquadStars(db, squadKey) {
    await ensureCloverSquadSchema(db);
    const squad = await getSquadByKey(db, squadKey);
    if (!squad) return { ok: false, reason: 'missing_squad' };

    const ledger = await readSquadLedgerTotals(db, squad.key);
    if (!ledger.authoritativeCount) {
        return {
            ok: true,
            changed: false,
            reason: 'empty_authoritative_ledger',
            squad,
            insertedMissingMemberStars: [],
            ignoredSyntheticCount: ledger.ignoredSyntheticCount,
            ledgerCount: ledger.ledgerCount,
            before: {
                currentStars: squad.currentStars,
                historicalStars: squad.historicalStars,
            },
            after: {
                currentStars: squad.currentStars,
                historicalStars: squad.historicalStars,
            },
        };
    }

    if (ledger.currentStars < 0) {
        return {
            ok: false,
            changed: false,
            reason: 'negative_ledger_balance',
            squad,
            insertedMissingMemberStars: [],
            ignoredSyntheticCount: ledger.ignoredSyntheticCount,
            ledgerCount: ledger.ledgerCount,
            before: {
                currentStars: squad.currentStars,
                historicalStars: squad.historicalStars,
            },
            after: {
                currentStars: squad.currentStars,
                historicalStars: squad.historicalStars,
            },
            ledger,
        };
    }

    const changed = squad.currentStars !== ledger.currentStars
        || squad.historicalStars !== ledger.historicalStars;

    if (changed) {
        await db.run(
            `UPDATE clover_squads
             SET current_stars = ?,
                 historical_stars = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE squad_key = ?`,
            [ledger.currentStars, ledger.historicalStars, squad.key]
        );
    }

    return {
        ok: true,
        changed,
        reason: changed ? 'reconciled_from_authoritative_ledger' : 'already_consistent',
        squad: await getSquadByKey(db, squad.key),
        insertedMissingMemberStars: [],
        ignoredSyntheticCount: ledger.ignoredSyntheticCount,
        ledgerCount: ledger.ledgerCount,
        authoritativeLedgerCount: ledger.authoritativeCount,
        before: {
            currentStars: squad.currentStars,
            historicalStars: squad.historicalStars,
        },
        after: {
            currentStars: ledger.currentStars,
            historicalStars: ledger.historicalStars,
        },
    };
}

async function syncSquadGroupDescription({ sock, db, squadKey }) {
    const view = await getSquadView(db, squadKey);
    if (!view) return { ok: false, reason: 'missing_squad' };

    const { squad } = view;
    if (!squad.groupId) return { ok: false, reason: 'missing_group', squad };
    if (!sock || typeof sock.groupUpdateDescription !== 'function') {
        return { ok: false, reason: 'missing_socket', squad };
    }

    const description = renderSquadGroupDescription(view);
    try {
        await sock.groupUpdateDescription(squad.groupId, description);
        await markSquadDescriptionSync(db, squad.key, 'ok');
        return { ok: true, squad: await getSquadByKey(db, squad.key), description };
    } catch (error) {
        await markSquadDescriptionSync(db, squad.key, 'erro', error?.message || error);
        return { ok: false, reason: 'sync_failed', squad, error, description };
    }
}

async function syncAllSquadGroupDescriptions({ sock, db, withGroupOnly = false, pauseMs = 300 } = {}) {
    const squads = await listSquads(db, { withGroupOnly });
    const results = [];

    for (const squad of squads) {
        const reconcile = await reconcileSquadStars(db, squad.key);
        const syncedSquad = reconcile.squad || squad;

        let sync = null;
        if (!syncedSquad.groupId) {
            sync = { ok: false, reason: 'missing_group', squad: syncedSquad };
        } else {
            sync = await syncSquadGroupDescription({ sock, db, squadKey: syncedSquad.key });
        }

        results.push({
            squad: sync.squad || syncedSquad,
            reconcile,
            sync,
        });

        if (pauseMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, pauseMs));
        }
    }

    return {
        ok: true,
        total: results.length,
        synced: results.filter((item) => item.sync?.ok).length,
        missingGroup: results.filter((item) => item.sync?.reason === 'missing_group').length,
        failed: results.filter((item) => item.sync && !item.sync.ok && item.sync.reason !== 'missing_group').length,
        reconciled: results.filter((item) => item.reconcile?.changed).length,
        reconciliationFailed: results.filter((item) => item.reconcile && !item.reconcile.ok).length,
        results,
    };
}

module.exports = {
    displayPlayerName,
    ensureSquad,
    findPlayersByName,
    getPlayerById,
    getSquadByGroupId,
    getSquadByKey,
    getSquadByName,
    getSquadMembers,
    getSquadView,
    listSquads,
    normalizeSquadKey,
    reconcileSquadStars,
    renderSquadGroupDescription,
    renderSquadMessage,
    syncAllSquadGroupDescriptions,
    syncSquadGroupDescription,
    updateSquadCaptainName,
    updateSquadCaptainPlayer,
    updateSquadGroup,
    updateSquadPhrase,
    updateSquadViceCaptainPlayer,
};
