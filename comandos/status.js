const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getPlayerRollByNumber } = require('../helpers/rollManager');
const {
    PHASES,
    getPlayerPhase,
    isAppearanceApproved,
    isAppearanceRejected,
    isHistoriaApproved,
} = require('../helpers/clover/playerPhase');
const { formatDistributionStatus, getCharacterStats } = require('../helpers/clover/characterStats');
const { renderPostFichaStatusMessage } = require('../helpers/clover/playerMenuMessages');

function formatMention(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

function formatSelectedRoll(roll) {
    if (!roll) return 'não escolhido';
    return `#${String(roll.roll_number).padStart(2, '0')} · ${roll.kingdom} · ${roll.magic_rarity}`;
}

function formatProfileStatus(player, pendingProfile) {
    if (pendingProfile) return 'validada, aguardando confirmação';
    if (player?.ficha_status === 'aprovada') return 'recepção base aprovada';
    if (player?.ficha_status === 'confirmada') return 'confirmada';
    return 'não enviada';
}

function formatMagicStatus(player, pendingMagic, pendingProfile) {
    if (pendingProfile?.magic?.label) return pendingProfile.magic.label;
    if (player?.magia && player.magia !== '-') return player.magia;
    if (pendingMagic?.magic_label) return `${pendingMagic.magic_label} (pendente)`;
    return 'não escolhida';
}

function formatAppearanceStatus(player) {
    if (!player?.personagem_aparencia || player.personagem_aparencia === '-') return 'não enviada';
    if (isAppearanceApproved(player)) return 'aprovada';
    if (isAppearanceRejected(player)) return 'negada';
    return 'pendente';
}

function formatHistoryStatus(player) {
    if (isHistoriaApproved(player)) return 'aprovada';
    if (player?.historia_status === 'negada') return 'precisa de ajuste';
    return player?.historia_status || 'pendente';
}

function formatGameStatus(player) {
    if (player?.jogo_status === 'liberado') return 'liberado';
    if (player?.jogo_status === 'historia_aprovada') return 'aguardando liberação final';
    if (player?.jogo_status === 'aguardando_historia') return 'aguardando história/persona';
    return 'bloqueado';
}

function formatPhaseLabel(phase) {
    const labels = {
        [PHASES.NOVO]: 'novo cadastro',
        [PHASES.PRE_ROLL]: 'antes dos rolls',
        [PHASES.ROLLS_EM_ANDAMENTO]: 'fazendo rolls',
        [PHASES.ROLLS_CONCLUIDOS]: 'rolls concluídos',
        [PHASES.ROLL_ESCOLHIDO]: 'roll escolhido',
        [PHASES.MAGIA_PENDENTE]: 'magia aguardando confirmação',
        [PHASES.MAGIA_ESCOLHIDA]: 'magia escolhida',
        [PHASES.FICHA_PENDENTE_CONFIRMACAO]: 'ficha aguardando confirmação',
        [PHASES.FICHA_CONFIRMADA]: 'ficha confirmada',
        [PHASES.APARENCIA_PENDENTE]: 'aparência em avaliação',
        [PHASES.APARENCIA_REJEITADA]: 'aparência precisa de ajuste',
        [PHASES.APARENCIA_APROVADA]: 'aparência aprovada',
        [PHASES.HISTORIA_PENDENTE]: 'história pendente',
        [PHASES.HISTORIA_APROVADA]: 'história aprovada',
        [PHASES.JOGO_LIBERADO]: 'jogo liberado',
    };
    return labels[phase] || phase || 'em andamento';
}

function resolveNextStep({ phase, rollCount, selectedRoll, pendingProfile, pendingMagic, stats }) {
    if (pendingProfile || phase === PHASES.FICHA_PENDENTE_CONFIRMACAO) {
        return `Use *${COMMAND_PREFIX}confirmarFicha* para finalizar ou corrija a ficha.`;
    }

    if (pendingMagic || phase === PHASES.MAGIA_PENDENTE) {
        return 'Responda a mensagem de magia para confirmar ou cancelar a escolha.';
    }

    switch (phase) {
        case PHASES.NOVO:
            return `Use *${COMMAND_PREFIX}start* e depois *${COMMAND_PREFIX}sortear*.`;
        case PHASES.PRE_ROLL:
            return `Use *${COMMAND_PREFIX}sortear* para gerar seu primeiro roll.`;
        case PHASES.ROLLS_EM_ANDAMENTO:
            return `Você tem ${rollCount}/${MAX_PLAYER_ROLLS} roll(s). Pode sortear mais ou usar *${COMMAND_PREFIX}ficha <número>*.`;
        case PHASES.ROLLS_CONCLUIDOS:
            return `Use *${COMMAND_PREFIX}rolls* e depois *${COMMAND_PREFIX}ficha <número>*.`;
        case PHASES.ROLL_ESCOLHIDO:
        case PHASES.MAGIA_ESCOLHIDA:
            return `Use *${COMMAND_PREFIX}ficha ${selectedRoll?.roll_number || '<número>'}* e envie a ficha preenchida.`;
        case PHASES.APARENCIA_PENDENTE:
            return 'Aguardando a administração aprovar a aparência.';
        case PHASES.APARENCIA_REJEITADA:
            return `Envie uma nova aparência com *${COMMAND_PREFIX}aparencia Personagem — Obra*.`;
        case PHASES.HISTORIA_PENDENTE:
            return 'Envie ou aguarde a avaliação de história e personalidade.';
        case PHASES.HISTORIA_APROVADA:
            return 'História/persona aprovada. Aguarde a liberação final da administração.';
        case PHASES.JOGO_LIBERADO:
            if (stats?.distribution_status !== 'confirmed') {
                return `Personagem liberado. Falta distribuir atributos com *${COMMAND_PREFIX}atributos*.`;
            }
            return `Personagem liberado. Use *${COMMAND_PREFIX}perfil* para ver o resumo.`;
        default:
            return `Use *${COMMAND_PREFIX}continuar* para ver o próximo passo.`;
    }
}

function renderStatusMessage({ playerId, player, phaseInfo, selectedRoll, pendingProfile, pendingMagic, stats }) {
    const nextStep = resolveNextStep({
        phase: phaseInfo.phase,
        rollCount: phaseInfo.rollCount,
        selectedRoll,
        pendingProfile,
        pendingMagic,
        stats,
    });

    return [
        '♧┃𝐒𝐓𝐀𝐓𝐔𝐒 𝐃𝐎 𝐂𝐀𝐃𝐀𝐒𝐓𝐑𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  fase atual ᥱ próximo passo  ──',
        '',
        formatMention(playerId),
        '',
        '_`─( ✓ )───── 𝗘𝘀𝘁𝗮𝗱𝗼`_',
        '',
        `*𝐅𝐚𝐬𝐞:* ${formatPhaseLabel(phaseInfo.phase)}`,
        `*𝐑𝐨𝐥𝐥𝐬:* ${Number(player.roll_sacrifice_used || 0) ? 'roll final (sacrifício concluído)' : `${phaseInfo.rollCount}/${MAX_PLAYER_ROLLS}`}`,
        `*𝐑𝐨𝐥𝐥 𝐞𝐬𝐜𝐨𝐥𝐡𝐢𝐝𝐨:* ${formatSelectedRoll(selectedRoll)}`,
        `*𝐅𝐢𝐜𝐡𝐚:* ${formatProfileStatus(player, pendingProfile)}`,
        `*𝐌𝐚𝐠𝐢𝐚:* ${formatMagicStatus(player, pendingMagic, pendingProfile)}`,
        `*𝐀𝐩𝐚𝐫𝐞̂𝐧𝐜𝐢𝐚:* ${formatAppearanceStatus(player)}`,
        `*𝐇𝐢𝐬𝐭𝐨́𝐫𝐢𝐚/𝐩𝐞𝐫𝐬𝐨𝐧𝐚:* ${formatHistoryStatus(player)}`,
        `*𝐉𝐨𝐠𝐨:* ${formatGameStatus(player)}`,
        stats ? `*𝐀𝐭𝐫𝐢𝐛𝐮𝐭𝐨𝐬:* ${formatDistributionStatus(stats.distribution_status)}` : null,
        '',
        '_`─( ■ )───── 𝗣𝗿𝗼́𝘅𝗶𝗺𝗼 𝗣𝗮𝘀𝘀𝗼`_',
        '',
        nextStep,
    ].filter((line) => line !== null).join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}status`,
    descricao: 'Mostra seu progresso na recepção Clover.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        const phaseInfo = await getPlayerPhase(db,idJogador);
        const player = phaseInfo.player || {};
        const canonicalId = player.id || idJogador;
        const selectedRoll = player.numero_roll_escolhido
            ? await getPlayerRollByNumber(db,canonicalId,player.numero_roll_escolhido)
            : null;
        const pendingProfile = phaseInfo.pendingProfileData;
        const pendingMagic = phaseInfo.pendingMagicData;
        const stats = phaseInfo.canPlay ? await getCharacterStats(db,canonicalId) : null;

        if (phaseInfo.canPlay) {
            await sendReply({
                sock,
                idChat,
                m,
                mentions: [idJogador],
                text: renderPostFichaStatusMessage(player),
            });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            mentions: [idJogador],
            text: renderStatusMessage({
                playerId: idJogador,
                player,
                phaseInfo,
                selectedRoll,
                pendingProfile,
                pendingMagic,
                stats,
            }),
        });
    },
};
