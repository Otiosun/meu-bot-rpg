const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { sendReaction } = require('../chatReply');
const { getPlayerRollByNumber, listPlayerRolls } = require('../rollManager');
const { renderConfirmedFicha } = require('../profileForms');
const { normalizeJid } = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const { getCharacterBonusSummary, formatNumber } = require('./characterBonusService');
const { getCloverGroup } = require('./groupManager');
const { getPlayerPhase } = require('./playerPhase');

const ARCHIVE_STATUS = {
    ACTIVE: 'active',
    DELETED: 'deleted',
};

const ARCHIVE_REACTIONS = {
    active: '✅',
    deleted: '❌',
};

const AUTH_INFO_DIR = path.join(__dirname, '..', '..', 'auth_info');

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function display(value, fallback = '-') {
    const text = String(value ?? '').trim();
    return text && text !== '-' ? text : fallback;
}

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function readMappedPhoneDigits(lidDigits) {
    if (!lidDigits) return '';

    const mappingPath = path.join(AUTH_INFO_DIR, `lid-mapping-${lidDigits}_reverse.json`);
    try {
        if (!fs.existsSync(mappingPath)) return '';

        const parsed = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        if (typeof parsed === 'string' || typeof parsed === 'number') {
            return extractDigits(parsed);
        }

        if (parsed && typeof parsed === 'object') {
            return extractDigits(parsed.phoneNumber || parsed.pn || parsed.jid || parsed.id || parsed.user);
        }
    } catch {
        return '';
    }

    return '';
}

function resolvePlayerPhoneDigits(playerId) {
    const normalized = normalizeJid(playerId);
    if (!normalized) return '';

    const [userPart, domain] = normalized.split('@');
    const digits = extractDigits(userPart);
    if (domain !== 'lid') return digits;

    return readMappedPhoneDigits(digits);
}

function formatPlayerTag(playerId) {
    const digits = resolvePlayerPhoneDigits(playerId) || extractDigits(String(playerId || '').split('@')[0]);
    return digits ? `#${digits.slice(-4).padStart(4, '0')}` : '#----';
}

function formatMention(playerId) {
    return `@${String(playerId || '').split('@')[0]}`;
}

function parseJson(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;

    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function serializeJson(value) {
    return JSON.stringify(value || {});
}

function hashSnapshot(snapshot) {
    return crypto.createHash('sha1').update(serializeJson(snapshot)).digest('hex');
}

function getStatusLabel(value, labels, fallback = '-') {
    const normalized = normalizeText(value || '');
    return labels[normalized] || fallback;
}

function getFichaLabel(value) {
    return getStatusLabel(value, {
        aprovada: 'Aprovada',
        confirmada: 'Confirmada',
        incompleta: 'Incompleta',
        pendente: 'Pendente',
        negada: 'Negada',
    });
}

function getAppearanceLabel(value) {
    return getStatusLabel(value, {
        approved: 'Aprovada',
        aprovada: 'Aprovada',
        pending: 'Pendente',
        rejeitada: 'Negada',
        rejected: 'Negada',
        negada: 'Negada',
    });
}

function getHistoryLabel(value) {
    return getStatusLabel(value, {
        aprovada: 'Aprovada',
        approved: 'Aprovada',
        aguardando_historia: 'Pendente',
        pendente: 'Pendente',
        negada: 'Negada',
        rejeitada: 'Negada',
        rejected: 'Negada',
    });
}

function getGameLabel(value) {
    return getStatusLabel(value, {
        liberado: 'Liberado',
        bloqueado: 'Bloqueado',
        aguardando_historia: 'Aguardando historia',
        historia_aprovada: 'Historia aprovada',
    });
}

function getArchiveStateLabel(status) {
    return status === ARCHIVE_STATUS.DELETED ? 'Arquivado' : 'Ativo';
}

function pickRollDetails(roll) {
    if (!roll) return null;
    return {
        roll_number: roll.roll_number,
        kingdom: roll.kingdom,
        social_class: roll.social_class,
        race: roll.race,
        grimoire: roll.grimoire,
        magic_rarity: roll.magic_rarity,
        kingdom_key: roll.kingdom_key || null,
        social_class_key: roll.social_class_key || null,
        race_key: roll.race_key || null,
        grimoire_key: roll.grimoire_key || null,
        magic_rarity_key: roll.magic_rarity_key || null,
    };
}

function pickPlayerDetails(player) {
    if (!player) return null;

    return {
        id: player.id,
        nome: player.nome || '-',
        display_name: player.display_name || '-',
        nome_real: player.nome_real || '-',
        idade_real: player.idade_real ?? null,
        gosta_de_fazer: player.gosta_de_fazer || '-',
        disponibilidade_detalhada: player.disponibilidade_detalhada || '-',
        personagem_nome: player.personagem_nome || '-',
        personagem_idade: player.personagem_idade ?? null,
        personagem_aparencia: player.personagem_aparencia || '-',
        personagem_aparencia_status: player.personagem_aparencia_status || 'pending',
        personagem_genero: player.personagem_genero || '-',
        numero_roll_escolhido: player.numero_roll_escolhido ?? null,
        ficha_status: player.ficha_status || 'incompleta',
        historia_status: player.historia_status || 'pendente',
        jogo_status: player.jogo_status || 'bloqueado',
        reino: player.reino || '-',
        classe: player.classe || '-',
        raca: player.raca || '-',
        grimorio: player.grimorio || '-',
        magia: player.magia || '-',
        familia: player.familia || '-',
        aptidao_comum: player.aptidao_comum || '-',
        aptidao_rara: player.aptidao_rara || '-',
        marca_comum: player.marca_comum || '-',
        marca_rara: player.marca_rara || '-',
        anomalia: player.anomalia || '-',
        gancho_narrativo: player.gancho_narrativo || '-',
        historias_extras: player.historias_extras || '[]',
        mana: player.mana ?? 0,
    };
}

function buildSnapshotPayload(snapshot) {
    return {
        playerId: snapshot.playerId || snapshot.player?.id || '',
        status: snapshot.status || ARCHIVE_STATUS.ACTIVE,
        player: pickPlayerDetails(snapshot.player),
        roll: pickRollDetails(snapshot.roll),
        bonusSummary: snapshot.bonusSummary || null,
        phaseInfo: snapshot.phaseInfo || null,
    };
}

function renderArchiveSummary(snapshot) {
    const player = snapshot.player || {};
    const bonusSummary = snapshot.bonusSummary || {};
    const identity = bonusSummary.identity || {};
    const roll = snapshot.roll || bonusSummary.selectedRoll || null;

    const lines = [
        '♧ ARQUIVO CLOVER',
        '     --  clover rpg · resumo e ficha --',
        '',
        `${formatPlayerTag(snapshot.playerId)} ${formatMention(snapshot.playerId)}`,
        `*Número:* ${display(resolvePlayerPhoneDigits(snapshot.playerId))}`,
        '',
        '──  STATUS  ──',
        `*Arquivo:* ${getArchiveStateLabel(snapshot.status)}`,
        `*Ficha:* ${getFichaLabel(player.ficha_status)}`,
        `*Aparência:* ${getAppearanceLabel(player.personagem_aparencia_status)}`,
        `*História:* ${getHistoryLabel(player.historia_status)}`,
        `*Jogo:* ${getGameLabel(player.jogo_status)}`,
        '',
        '──  RESUMO  ──',
        `> *Jogador:* ${display(player.nome_real || player.display_name || player.nome)}`,
        `> *Personagem:* ${display(player.personagem_nome || player.nome)}`,
        `> *Idade pessoal:* ${display(player.idade_real)}`,
        `> *Idade do personagem:* ${display(player.personagem_idade)}`,
        `> *Reino:* ${display(identity.kingdom || player.reino)}`,
        `> *Classe:* ${display(identity.socialClass || player.classe)}`,
        `> *Raça:* ${display(identity.race || player.raca)}`,
        `> *Grimório:* ${display(identity.grimoire || player.grimorio)}`,
        `> *Magia:* ${display(identity.magic || player.magia)}`,
        `> *Família:* ${display(identity.family || player.familia)}`,
        `> *Aptidão:* ${display(bonusSummary.traits?.aptitude?.label || player.aptidao_rara || player.aptidao_comum)}`,
        `> *Marca:* ${display(bonusSummary.traits?.mark?.label || player.marca_rara || player.marca_comum)}`,
        `> *Anomalia:* ${display(bonusSummary.traits?.anomaly?.label || player.anomalia)}`,
        `> *Gancho:* ${display(bonusSummary.traits?.hook || player.gancho_narrativo)}`,
        `> *Mana total:* ${formatNumber(bonusSummary.mana?.total || player.mana || 0)}`,
        `> *Reserva:* ${display(bonusSummary.reserve?.label)}`,
    ];

    if (roll) {
        lines.push(
            `> *Roll:* #${String(roll.roll_number || '-')} · ${display(roll.kingdom)} · ${display(roll.social_class)} · ${display(roll.race)} · ${display(roll.grimoire)} · ${display(roll.magic_rarity)}`
        );
    }

    lines.push(
        '',
        '──  FICHA COMPLETA  ──',
        '',
        renderConfirmedFicha(player, roll),
    );

    return lines.join('\n');
}

function isArchiveEligible(player) {
    return Boolean(player) && ['confirmada', 'aprovada'].includes(normalizeText(player.ficha_status || ''));
}

async function getArchiveGroupId(db, fallback = null) {
    const configured = await getCloverGroup(db, 'archive');
    return configured || fallback || null;
}

async function captureArchiveSnapshotForPlayer(db, playerId) {
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!player) return null;

    const bonusSummary = await getCharacterBonusSummary(db, playerId).catch(() => null);
    const roll = player.numero_roll_escolhido
        ? await getPlayerRollByNumber(db, playerId, player.numero_roll_escolhido)
        : null;
    const selectedRoll = roll || (await listPlayerRolls(db, playerId)).find(Boolean) || null;
    const phaseInfo = await getPlayerPhase(db, playerId).catch(() => null);

    if (!isArchiveEligible(player)) {
        return null;
    }

    return {
        playerId,
        status: ARCHIVE_STATUS.ACTIVE,
        player,
        roll: selectedRoll,
        bonusSummary,
        phaseInfo,
    };
}

function restoreSnapshotFromRecord(record) {
    const snapshot = parseJson(record?.snapshot_json, null);
    if (!snapshot) return null;

    return {
        ...snapshot,
        playerId: record.player_id,
        status: ARCHIVE_STATUS.DELETED,
    };
}

async function readArchiveRecord(db, playerId) {
    return db.get(
        'SELECT * FROM clover_archive_cards WHERE player_id = ?',
        [playerId]
    );
}

async function persistArchiveRecord(db, { playerId, groupId, messageKey, snapshot, status, hash }) {
    await db.run(
        `INSERT INTO clover_archive_cards
         (player_id, group_id, message_key_json, snapshot_hash, snapshot_json, status, last_sent_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(player_id) DO UPDATE SET
             group_id = excluded.group_id,
             message_key_json = excluded.message_key_json,
             snapshot_hash = excluded.snapshot_hash,
             snapshot_json = excluded.snapshot_json,
             status = excluded.status,
             last_sent_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP`,
        [
            playerId,
            groupId,
            serializeJson(messageKey),
            hash,
            serializeJson(snapshot),
            status,
        ]
    );
}

async function syncArchiveSnapshot({ sock, db, snapshot, groupId = null }) {
    if (!snapshot?.playerId) {
        return { ok: false, skipped: true, reason: 'missing_snapshot' };
    }

    const archiveGroupId = await getArchiveGroupId(db, groupId);
    if (!archiveGroupId) {
        return { ok: false, skipped: true, reason: 'missing_group' };
    }

    const record = await readArchiveRecord(db, snapshot.playerId);
    const currentGroupId = record?.group_id || null;
    const renderSnapshot = {
        ...snapshot,
        player: pickPlayerDetails(snapshot.player),
        roll: pickRollDetails(snapshot.roll),
        status: snapshot.status || ARCHIVE_STATUS.ACTIVE,
    };
    const snapshotHash = hashSnapshot(buildSnapshotPayload(renderSnapshot));
    const messageText = renderArchiveSummary(renderSnapshot);
    const messageKey = parseJson(record?.message_key_json, null);
    const sameGroup = Boolean(currentGroupId) && normalizeJid(currentGroupId) === normalizeJid(archiveGroupId);

    let action = 'noop';
    let sentKey = messageKey;

    try {
        if (record && messageKey && sameGroup && record.snapshot_hash !== snapshotHash) {
            const edited = await sock.sendMessage(archiveGroupId, {
                text: messageText,
                edit: messageKey,
                mentions: [snapshot.playerId],
            });
            sentKey = edited?.key || messageKey;
            action = 'edited';
        } else if (!record || !messageKey || !sameGroup) {
            const sent = await sock.sendMessage(archiveGroupId, {
                text: messageText,
                mentions: [snapshot.playerId],
            });
            sentKey = sent?.key || messageKey;
            action = 'sent';
        } else if (record.snapshot_hash === snapshotHash) {
            action = 'unchanged';
        }
    } catch (error) {
        if (record && messageKey && sameGroup) {
            const sent = await sock.sendMessage(archiveGroupId, {
                text: messageText,
                mentions: [snapshot.playerId],
            });
            sentKey = sent?.key || messageKey;
            action = 'resent';
        } else {
            throw error;
        }
    }

    const desiredStatus = snapshot.status || ARCHIVE_STATUS.ACTIVE;
    const desiredReaction = ARCHIVE_REACTIONS[desiredStatus] || ARCHIVE_REACTIONS.active;
    if (sentKey) {
        await sendReaction({
            sock,
            idChat: archiveGroupId,
            m: { key: sentKey },
            emoji: desiredReaction,
        }).catch((error) => {
            console.log('[archive] nao consegui reagir ao card:', error?.message || error);
        });
    }

    await persistArchiveRecord(db, {
        playerId: snapshot.playerId,
        groupId: archiveGroupId,
        messageKey: sentKey || messageKey || {},
        snapshot: renderSnapshot,
        status: desiredStatus,
        hash: snapshotHash,
    });

    return {
        ok: true,
        action,
        playerId: snapshot.playerId,
        groupId: archiveGroupId,
        status: desiredStatus,
    };
}

async function syncArchiveCardForPlayer({ sock, db, playerId, groupId = null }) {
    const currentSnapshot = await captureArchiveSnapshotForPlayer(db, playerId);
    const record = await readArchiveRecord(db, playerId);

    if (!currentSnapshot && !record) {
        return { ok: true, skipped: true, reason: 'missing_player' };
    }

    if (currentSnapshot) {
        return syncArchiveSnapshot({ sock, db, snapshot: currentSnapshot, groupId });
    }

    const deletedSnapshot = restoreSnapshotFromRecord(record);
    if (!deletedSnapshot) {
        return { ok: true, skipped: true, reason: 'missing_snapshot' };
    }

    return syncArchiveSnapshot({
        sock,
        db,
        snapshot: deletedSnapshot,
        groupId,
    });
}

async function syncArchiveCardAsDeleted({ sock, db, snapshot, groupId = null }) {
    if (!snapshot?.playerId) {
        return { ok: false, skipped: true, reason: 'missing_snapshot' };
    }

    return syncArchiveSnapshot({
        sock,
        db,
        snapshot: {
            ...snapshot,
            status: ARCHIVE_STATUS.DELETED,
        },
        groupId,
    });
}

async function syncArchiveCardsForGroup({ sock, db, groupId = null }) {
    const archiveGroupId = await getArchiveGroupId(db, groupId);
    if (!archiveGroupId) {
        return { ok: false, skipped: true, reason: 'missing_group' };
    }

    const players = await db.all(
        `SELECT id
         FROM jogadores
         WHERE ficha_status IN ('confirmada', 'aprovada')
         ORDER BY id ASC`
    );

    const result = {
        ok: true,
        archiveGroupId,
        total: players.length,
        sent: 0,
        edited: 0,
        unchanged: 0,
        deleted: 0,
        skipped: 0,
        failed: 0,
        items: [],
    };

    for (const player of players) {
        try {
            const item = await syncArchiveCardForPlayer({ sock, db, playerId: player.id, groupId: archiveGroupId });
            result.items.push(item);
            if (item?.skipped) {
                result.skipped += 1;
            } else if (item?.action === 'sent' || item?.action === 'resent') {
                result.sent += 1;
            } else if (item?.action === 'edited') {
                result.edited += 1;
            } else {
                result.unchanged += 1;
            }
        } catch (error) {
            result.failed += 1;
            result.items.push({ ok: false, playerId: player.id, error });
        }

        await wait(250);
    }

    return result;
}

module.exports = {
    ARCHIVE_STATUS,
    captureArchiveSnapshotForPlayer,
    formatPlayerTag,
    formatMention,
    resolvePlayerPhoneDigits,
    getArchiveGroupId,
    getArchiveStateLabel,
    renderArchiveSummary,
    syncArchiveCardAsDeleted,
    syncArchiveCardForPlayer,
    syncArchiveCardsForGroup,
    syncArchiveSnapshot,
};
