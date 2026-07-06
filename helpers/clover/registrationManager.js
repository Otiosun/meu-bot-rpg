const { COMMAND_PREFIX } = require('../../config/bot');
const { sendPrivateText } = require('../chatReply');
const { countUsedSlots, getCapacity } = require('./slotManager');
const { getOffGroupInviteLink } = require('./groupManager');
const {
    isAppearanceApproved,
    isFichaApproved,
    isHistoriaApproved,
} = require('./playerPhase');
const { getCharacterBonusSummary } = require('./characterBonusService');
const { ensureCharacterStats } = require('./characterStats');
const { ensurePhState } = require('./phService');

const REGISTRATION_GROUP_KEY = 'registration_group_jid';

async function setCloverRegistrationGroup(db, groupId) {
    await db.run(
        `INSERT INTO clover_settings (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = CURRENT_TIMESTAMP`,
        [REGISTRATION_GROUP_KEY, String(groupId || '').trim()]
    );
}

async function getCloverRegistrationGroup(db) {
    const row = await db.get(
        `SELECT value
         FROM clover_settings
         WHERE key = ?`,
        [REGISTRATION_GROUP_KEY]
    );
    return row?.value || null;
}

function renderPostFichaPrivateInstructions(options = {}) {
    const offGroupLink = options.offGroupLink || null;
    const lines = [
        '♧ 𝐏𝐑𝐎́𝐗𝐈𝐌𝐀 𝐄𝐓𝐀𝐏𝐀',
        '     ──  clovᥱr multicolor · lorᥱ pᥱssoαl  ──',
        '',
        'Sᥱu rᥱgıstro jά foı αprovαdo.',
        '',
        'Agorα fαltα ᥱnvıαr suα hıstórıα ᥱ pᥱrsonαlıdαdᥱ no grupo ON ou no PV dᥱ um ADM.',
        'Porᥱ́m, vocᥱ̂ jά podᥱ jogαr normαlmᥱntᥱ. Nα̃o sᥱ prᥱocupᥱ.',
        '',
        'Entrᥱ no grupo ᥱ sᥱ dıvırtα com o nosso RPG:',
        '',
    ];

    if (offGroupLink) {
        lines.push(offGroupLink);
    } else {
        lines.push('O link do grupo OFF αındα nα̃o foı confıgurαdo.');
    }

    lines.push(
        '',
        'Usᥱ *̣.#ajuda* αquı mᥱsmo pαrα vᥱr sᥱus comαndos.'
    );

    return lines.join('\n');
}

async function sendPostFichaPrivateInstructions(sock, dbOrPlayerId, maybePlayerId = null) {
    const hasDb = dbOrPlayerId && typeof dbOrPlayerId.get === 'function';
    const db = hasDb ? dbOrPlayerId : null;
    const playerId = hasDb ? maybePlayerId : dbOrPlayerId;
    const offGroupLink = db ? await getOffGroupInviteLink(sock, db) : null;

    try {
        await sendPrivateText({
            sock,
            playerId,
            text: renderPostFichaPrivateInstructions({ offGroupLink }),
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, error };
    }
}

async function updateStoryWaitingState(db, playerId) {
    await db.run(
        `UPDATE jogadores
         SET historia_status = CASE
                 WHEN historia_status IS NULL OR historia_status = '' OR historia_status = '-' THEN 'pendente'
                 ELSE historia_status
             END,
             historia_status_updated_at = COALESCE(historia_status_updated_at, CURRENT_TIMESTAMP),
             jogo_status = 'liberado',
             jogo_liberado_at = COALESCE(jogo_liberado_at, CURRENT_TIMESTAMP),
             jogo_liberado_by = COALESCE(jogo_liberado_by, 'bot'),
             jogo_bloqueio_motivo = NULL
         WHERE id = ?`,
        [playerId]
    );
}

async function markStoryPrivateInstructionsSent(db, playerId) {
    await db.run(
        `UPDATE jogadores
         SET historia_pv_sent_at = COALESCE(historia_pv_sent_at, CURRENT_TIMESTAMP),
             historia_status_updated_at = COALESCE(historia_status_updated_at, CURRENT_TIMESTAMP)
         WHERE id = ?`,
        [playerId]
    );

    await db.run(
        `INSERT INTO player_onboarding
         (player_id, current_step, step_payload, started_at, welcome_sent_at, last_seen_at)
         VALUES (?, 'jogo_liberado', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(player_id) DO UPDATE SET
             current_step = 'jogo_liberado',
             step_payload = ?,
             last_seen_at = CURRENT_TIMESTAMP`,
        [playerId, JSON.stringify({ last_message: 'jogo_liberado_historia_pendente' })]
    );
}

function isStoryRejected(player) {
    return ['negada', 'rejeitada', 'reprovada', 'rejected'].includes(String(player?.historia_status || '').trim().toLowerCase());
}

async function maybeSendPostFichaPrivateInstructions(sock, db, playerId) {
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!player) return { ok: true, skipped: true, reason: 'missing_player' };
    if (!isFichaApproved(player)) return { ok: true, skipped: true, reason: 'ficha_not_approved' };
    if (!player.magia || player.magia === '-') return { ok: true, skipped: true, reason: 'missing_magic' };
    if (!isAppearanceApproved(player)) return { ok: true, skipped: true, reason: 'appearance_not_approved' };
    if (isStoryRejected(player)) return { ok: true, skipped: true, reason: 'history_rejected' };

    await updateStoryWaitingState(db, playerId);
    await ensureCharacterStats(db, playerId);
    await ensurePhState(db, playerId);

    if (isHistoriaApproved(player)) return { ok: true, skipped: true, reason: 'history_already_approved' };
    if (player.historia_pv_sent_at) return { ok: true, skipped: true, reason: 'already_sent' };

    const sent = await sendPostFichaPrivateInstructions(sock, db, playerId);
    if (!sent.ok) {
        return { ok: false, skipped: false, reason: 'private_send_failed', error: sent.error };
    }

    await markStoryPrivateInstructionsSent(db, playerId);
    return { ok: true, skipped: false };
}

function tryGetCapacity(category, optionKey) {
    if (!optionKey) return null;
    try {
        return getCapacity(category, optionKey);
    } catch {
        return null;
    }
}

async function formatOccupiedSlotLine(db, category, optionKey, label) {
    const capacity = tryGetCapacity(category, optionKey);
    if (capacity === null) return null;

    const used = await countUsedSlots(db, category, optionKey);
    return `- ${label}: ${used}/${capacity}`;
}

async function buildOccupiedSlots(db, payload, player) {
    const roll = payload.roll || {};
    const traits = payload.traits || {};
    const lines = [];

    const raceLine = await formatOccupiedSlotLine(db, 'race', roll.race_key, roll.race);
    if (raceLine) lines.push(raceLine);

    const grimoireLine = await formatOccupiedSlotLine(db, 'grimoire', roll.grimoire_key, roll.grimoire);
    if (grimoireLine) lines.push(grimoireLine);

    if (payload.family?.key) {
        const familyLine = await formatOccupiedSlotLine(db, 'family', payload.family.key, payload.family.name);
        if (familyLine) lines.push(familyLine);
    }

    if (traits.anomaly?.key) {
        const anomalyLine = await formatOccupiedSlotLine(db, 'anomaly', traits.anomaly.key, traits.anomaly.name);
        if (anomalyLine) lines.push(anomalyLine);
    }

    const magicLine = await formatOccupiedSlotLine(db, 'magic', player.magia_key, player.magia);
    if (magicLine) lines.push(magicLine);

    return lines;
}

async function renderCloverRegistrationSummary(db, playerId, result) {
    const player = result.player || {};
    const payload = result.payload || {};
    const roll = payload.roll || {};
    const traits = payload.traits || {};
    const occupiedSlots = await buildOccupiedSlots(db, payload, player);
    const bonusSummary = await getCharacterBonusSummary(db, playerId).catch(() => null);
    const calculatedManaTotal = Number(bonusSummary?.mana?.total || 0);
    const manaTotal = calculatedManaTotal > 0
        ? calculatedManaTotal
        : (Number.isFinite(Number(player.mana)) ? Number(player.mana) : null);
    const appearanceStatus = player.personagem_aparencia_status === 'approved'
        ? 'Aprovada'
        : player.personagem_aparencia_status === 'rejected'
        ? 'Negada'
        : 'Pendente';

    return [
        '𝐑𝐄𝐆𝐈𝐒𝐓𝐑𝐎 𝐂𝐋𝐎𝐕𝐄𝐑',
        '     ──  clover rpg · ficha confirmada  ──',
        '',
        `@${String(playerId).split('@')[0]}`,
        '',
        '     *──  𝐏𝐋𝐀𝐘𝐄𝐑  ──*',
        '',
        `> ⤷ *Nome:* ${player.nome_real || payload.nomeReal || '-'}`,
        `> ⤷ *Idade pessoal:* ${player.idade_real || payload.idadeReal || '-'}`,
        `> ⤷ *Gosta de fazer:* ${player.gosta_de_fazer || payload.gostaDeFazer || '-'}`,
        `> ⤷ *Disponibilidade:* ${player.disponibilidade_detalhada || payload.disponibilidadeDetalhada || '-'}`,
        '',
        '     *──  𝐏𝐄𝐑𝐒𝐎𝐍𝐀𝐆𝐄𝐌  ──*',
        '',
        `> ⤷ *Nome:* ${player.personagem_nome || payload.personagemNome || '-'}`,
        `> ⤷ *Idade:* ${player.personagem_idade || payload.personagemIdade || '-'}`,
        `> ⤷ *Gênero:* ${player.personagem_genero || payload.personagemGenero || '-'}`,
        `> ⤷ *Aparência:* ${player.personagem_aparencia || payload.personagemAparencia || '-'}`,
        `> ⤷ *Status da aparência:* ${appearanceStatus}`,
        `> ⤷ *Imagem:* ${player.personagem_aparencia_image_path ? 'SIM' : 'NAO'}`,
        '',
        '     *──  𝐑𝐎𝐋𝐋 𝐂𝐎𝐍𝐅𝐈𝐑𝐌𝐀𝐃𝐎  ──*',
        '',
        `> ⤷ *Roll:* #${payload.numeroRoll || player.numero_roll_escolhido || '-'}`,
        `> ⤷ *Reino:* ${roll.kingdom || player.reino || '-'}`,
        `> ⤷ *Raça:* ${roll.race || player.raca || '-'}`,
        `> ⤷ *Classe Social:* ${roll.social_class || player.classe || '-'}`,
        `> ⤷ *Grimório:* ${roll.grimoire || player.grimorio || '-'}`,
        `> ⤷ *Raridade Mágica:* ${roll.magic_rarity || '-'}`,
        '',
        '     *──  𝐄𝐒𝐂𝐎𝐋𝐇𝐀𝐒 𝐃𝐀 𝐅𝐈𝐂𝐇𝐀  ──*',
        '',
        `> ⤷ *Magia:* ${player.magia || '-'}`,
        `> ⤷ *Família:* ${player.familia || payload.family?.name || '-'}`,
        `> ⤷ *Aptidão:* ${traits.rareAptitude?.name || traits.commonAptitude?.name || player.aptidao_rara || player.aptidao_comum || '-'}`,
        `> ⤷ *Marca:* ${traits.rareMark?.name || traits.commonMark?.name || player.marca_rara || player.marca_comum || '-'}`,
        `> ⤷ *Anomalia:* ${traits.anomaly?.name || player.anomalia || '-'}`,
        `> ⤷ *Mana total:* ${manaTotal === null ? '-' : manaTotal}`,
        '',
        '     *──  𝐕𝐀𝐆𝐀𝐒 𝐎𝐂𝐔𝐏𝐀𝐃𝐀𝐒  ──*',
        '',
        ...(occupiedSlots.length ? occupiedSlots.map((line) => `> ⤷ ${line.replace(/^- /, '')}`) : ['> ⤷ Nenhuma limitada.']),
        '',
        '     *──  𝐒𝐈𝐓𝐔𝐀𝐂̧𝐀̃𝐎  ──*',
        '',
        '> ⤷ Recepção base concluída.',
        '> ⤷ PV pós-ficha enviado após a confirmação.',
        '> ⤷ Aparência pode seguir pendente para avaliação humana.',
    ].join('\n');
}

async function sendCloverRegistrationSummary(sock, db, playerId, result) {
    const groupId = await getCloverRegistrationGroup(db);
    if (!groupId) {
        return { ok: true, skipped: true, reason: 'missing_registration_group' };
    }

    try {
        await sock.sendMessage(groupId, {
            text: await renderCloverRegistrationSummary(db, playerId, result),
            mentions: [playerId],
        });
        return { ok: true, skipped: false, groupId };
    } catch (error) {
        return { ok: false, skipped: false, groupId, error };
    }
}

function renderRegistrationGroupMissingNotice() {
    return `Nenhum grupo de registro Clover foi configurado. Use *${COMMAND_PREFIX}setregistroclover* no grupo correto.`;
}

module.exports = {
    getCloverRegistrationGroup,
    renderCloverRegistrationSummary,
    renderPostFichaPrivateInstructions,
    renderRegistrationGroupMissingNotice,
    sendCloverRegistrationSummary,
    maybeSendPostFichaPrivateInstructions,
    sendPostFichaPrivateInstructions,
    setCloverRegistrationGroup,
};
