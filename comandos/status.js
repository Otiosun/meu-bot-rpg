const {isPreResetLifecycle}=require('../helpers/clover/lifecyclePolicy');
const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getPendingMagicConfirmation } = require('../helpers/magicManager');
const { getPendingConfirmation } = require('../helpers/profileForms');
const { ensurePlayerRecord } = require('../helpers/playerRegistry');
const { getPlayerRollByNumber } = require('../helpers/rollManager');
const { getFutureRollByNumber } = require('../helpers/clover/preResetFutureRollService');
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

function parseFutureDraft(row) {
    if (!row?.draft_json) return {};
    try { return JSON.parse(row.draft_json) || {}; } catch { return {}; }
}

function futureFichaLabel(row) {
    if (!row) return 'não iniciada';
    const labels = {
        draft: 'rascunho',
        submitted: 'enviada · aguardando revisão',
        approved: 'aprovada',
        locked: 'fechada para lançamento',
    };
    return labels[row.status] || row.status || 'rascunho';
}

function renderPreResetStatus({ playerId, phaseInfo, selectedFutureRoll, finalFutureRoll }) {
    if (phaseInfo.phase === PHASES.PRE_RESET_WAIT) {
        return [
            '♧┃𝐏𝐑𝐄_𝐑𝐄𝐒𝐄𝐓 · 𝐒𝐓𝐀𝐓𝐔𝐒',
            '',
            formatMention(playerId),
            '',
            '*Destino:* MANTER',
            '*Personagem atual:* preservado',
            '*Novos sorteios:* bloqueados para KEEP',
            '',
            'A administração já definiu seu personagem como MANTER. Você não precisa refazer ficha nem sortear novamente.',
            `Use *${COMMAND_PREFIX}retorno* para consultar essa situação quando quiser.`,
        ].join('\n');
    }

    if (phaseInfo.phase === PHASES.PRE_RESET_DECISION) {
        return [
            '♧┃𝐏𝐑𝐄_𝐑𝐄𝐒𝐄𝐓 · 𝐒𝐓𝐀𝐓𝐔𝐒',
            '',
            formatMention(playerId),
            '',
            '*Destino:* não resolvido',
            '',
            'Seu cadastro não possui uma atribuição válida no roster finalizado. O fluxo de criação está bloqueado de forma segura.',
        ].join('\n');
    }

    const draft = parseFutureDraft(phaseInfo.futureCharacter);
    const selectedNumber = Number(draft.rollNumber || 0) || null;
    const effectiveRoll = finalFutureRoll || selectedFutureRoll || null;
    const isFinal = Boolean(finalFutureRoll);
    const futureStatus = phaseInfo.futureCharacter?.status || null;

    let nextStep;
    if (futureStatus === 'submitted') {
        nextStep = 'Sua ficha futura foi enviada. Aguarde a revisão da administração.';
    } else if (futureStatus === 'approved') {
        nextStep = 'Sua ficha futura foi aprovada. Aguarde o fechamento para lançamento.';
    } else if (futureStatus === 'locked') {
        nextStep = 'Seu personagem futuro está fechado e preservado para o lançamento.';
    } else if (isFinal) {
        nextStep = `Seu sacrifício já gerou o roll final *#${finalFutureRoll.roll_number}*. Consulte magia/família/traços livremente e use *${COMMAND_PREFIX}ficha ${finalFutureRoll.roll_number}* quando quiser enviar.`;
    } else if (!phaseInfo.rollCount) {
        nextStep = `Use *${COMMAND_PREFIX}sortear* para gerar seu primeiro roll da nova fase.`;
    } else if (!selectedNumber) {
        nextStep = phaseInfo.rollCount < MAX_PLAYER_ROLLS
            ? `Você pode sortear mais, consultar *${COMMAND_PREFIX}magias*, *${COMMAND_PREFIX}familias* e *${COMMAND_PREFIX}tracos*, e só depois escolher *${COMMAND_PREFIX}ficha <número>*.`
            : `Você tem ${MAX_PLAYER_ROLLS}/${MAX_PLAYER_ROLLS}. Pode escolher *${COMMAND_PREFIX}ficha <número>* ou consultar *${COMMAND_PREFIX}sacrificar*; magia/família/traços continuam livres.`;
    } else {
        nextStep = `Rascunho no roll *#${selectedNumber}*. Você ainda pode ajustar magia/família/traços e, enquanto a Ficha Nova não for enviada, trocar o roll ou completar os sorteios disponíveis.`;
    }

    const rollLine = isFinal
        ? `*Rolls da nova fase:* sacrifício concluído · final #${finalFutureRoll.roll_number}`
        : `*Rolls da nova fase:* ${phaseInfo.rollCount}/${MAX_PLAYER_ROLLS}`;

    const traitDraft = draft.traits || {};
    const traitNames = [traitDraft.aptitude?.name, traitDraft.mark?.name, traitDraft.anomaly?.name].filter(Boolean);

    return [
        '♧┃𝐏𝐑𝐄_𝐑𝐄𝐒𝐄𝐓 · 𝐂𝐑𝐈𝐀𝐂̧𝐀̃𝐎',
        '',
        formatMention(playerId),
        '',
        '*Destino:* RESET AUTOMÁTICO',
        rollLine,
        `*Roll da ficha:* ${formatSelectedRoll(effectiveRoll)}`,
        `*Magia futura:* ${draft.magicKey ? 'escolhida' : 'a escolher'}`,
        `*Traços salvos na ficha:* ${traitNames.length ? traitNames.join(' · ') : 'a definir/enviar'}`,
        `*Ficha futura:* ${futureFichaLabel(phaseInfo.futureCharacter)}`,
        '*Personagem antigo:* permanece intacto até o lançamento',
        '',
        '_`─( ■ )───── Próximo passo`_',
        '',
        nextStep,
    ].join('\n');
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
    if (pendingProfile || phase === PHASES.FICHA_PENDENTE_CONFIRMACAO) return `Use *${COMMAND_PREFIX}confirmarFicha* para finalizar ou corrija a ficha.`;
    if (pendingMagic || phase === PHASES.MAGIA_PENDENTE) return 'Responda a mensagem de magia para confirmar ou cancelar a escolha.';
    switch (phase) {
        case PHASES.NOVO: return `Use *${COMMAND_PREFIX}start* e depois *${COMMAND_PREFIX}sortear*.`;
        case PHASES.PRE_ROLL: return `Use *${COMMAND_PREFIX}sortear* para gerar seu primeiro roll.`;
        case PHASES.ROLLS_EM_ANDAMENTO: return `Você tem ${rollCount}/${MAX_PLAYER_ROLLS} roll(s). Pode sortear mais ou usar *${COMMAND_PREFIX}ficha <número>*.`;
        case PHASES.ROLLS_CONCLUIDOS: return `Use *${COMMAND_PREFIX}rolls* e depois *${COMMAND_PREFIX}ficha <número>*.`;
        case PHASES.ROLL_ESCOLHIDO:
        case PHASES.MAGIA_ESCOLHIDA: return `Use *${COMMAND_PREFIX}ficha ${selectedRoll?.roll_number || '<número>'}* e envie a ficha preenchida.`;
        case PHASES.APARENCIA_PENDENTE: return 'Aguardando a administração aprovar a aparência.';
        case PHASES.APARENCIA_REJEITADA: return `Envie uma nova aparência com *${COMMAND_PREFIX}aparencia Personagem — Obra*.`;
        case PHASES.HISTORIA_PENDENTE: return 'Envie ou aguarde a avaliação de história e personalidade.';
        case PHASES.HISTORIA_APROVADA: return 'História/persona aprovada. Aguarde a liberação final da administração.';
        case PHASES.JOGO_LIBERADO:
            if (stats?.distribution_status !== 'confirmed') return `Personagem liberado. Falta distribuir atributos com *${COMMAND_PREFIX}atributos*.`;
            return `Personagem liberado. Use *${COMMAND_PREFIX}perfil* para ver o resumo.`;
        default: return `Use *${COMMAND_PREFIX}continuar* para ver o próximo passo.`;
    }
}

function renderStatusMessage({ playerId, player, phaseInfo, selectedRoll, pendingProfile, pendingMagic, stats }) {
    const nextStep = resolveNextStep({ phase:phaseInfo.phase, rollCount:phaseInfo.rollCount, selectedRoll, pendingProfile, pendingMagic, stats });
    return [
        '♧┃𝐒𝐓𝐀𝐓𝐔𝐒 𝐃𝐎 𝐂𝐀𝐃𝐀𝐒𝐓𝐑𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '', formatMention(playerId), '',
        `*𝐅𝐚𝐬𝐞:* ${formatPhaseLabel(phaseInfo.phase)}`,
        `*𝐑𝐨𝐥𝐥𝐬:* ${phaseInfo.rollCount}/${MAX_PLAYER_ROLLS}`,
        `*𝐑𝐨𝐥𝐥 𝐞𝐬𝐜𝐨𝐥𝐡𝐢𝐝𝐨:* ${formatSelectedRoll(selectedRoll)}`,
        `*𝐅𝐢𝐜𝐡𝐚:* ${formatProfileStatus(player, pendingProfile)}`,
        `*𝐌𝐚𝐠𝐢𝐚:* ${formatMagicStatus(player, pendingMagic, pendingProfile)}`,
        `*𝐀𝐩𝐚𝐫𝐞̂𝐧𝐜𝐢𝐚:* ${formatAppearanceStatus(player)}`,
        `*𝐇𝐢𝐬𝐭𝐨́𝐫𝐢𝐚/𝐩𝐞𝐫𝐬𝐨𝐧𝐚:* ${formatHistoryStatus(player)}`,
        `*𝐉𝐨𝐠𝐨:* ${formatGameStatus(player)}`,
        stats ? `*𝐀𝐭𝐫𝐢𝐛𝐮𝐭𝐨𝐬:* ${formatDistributionStatus(stats.distribution_status)}` : null,
        '', '_`─( ■ )───── Próximo Passo`_', '', nextStep,
    ].filter((line) => line !== null).join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}status`,
    descricao: 'Mostra seu progresso na recepção Clover.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        const phaseInfo = await getPlayerPhase(db, idJogador);

        if ([PHASES.PRE_RESET_BUILD, PHASES.PRE_RESET_WAIT, PHASES.PRE_RESET_DECISION].includes(phaseInfo.phase)) {
            const draft = parseFutureDraft(phaseInfo.futureCharacter);
            const finalFutureRoll = phaseInfo.phase === PHASES.PRE_RESET_BUILD
                ? await getFutureRollByNumber(db, idJogador, MAX_PLAYER_ROLLS + 1)
                : null;
            const selectedFutureRoll = draft.rollNumber
                ? await getFutureRollByNumber(db, idJogador, draft.rollNumber)
                : finalFutureRoll;
            await sendReply({
                sock,
                idChat,
                m,
                mentions:[idJogador],
                text:renderPreResetStatus({
                    playerId:idJogador,
                    phaseInfo,
                    selectedFutureRoll,
                    finalFutureRoll,
                }),
            });
            return;
        }

        const player = isPreResetLifecycle() ? (phaseInfo.player || {}) : await ensurePlayerRecord(db,idJogador,nomeUsuario);
        const selectedRoll = player.numero_roll_escolhido ? await getPlayerRollByNumber(db, idJogador, player.numero_roll_escolhido) : null;
        const pendingProfile = await getPendingConfirmation(db, idJogador);
        const pendingMagic = await getPendingMagicConfirmation(db, idJogador);
        const stats = phaseInfo.canPlay && !isPreResetLifecycle() ? await getCharacterStats(db, idJogador) : null;
        if (phaseInfo.canPlay) {
            await sendReply({ sock, idChat, m, mentions:[idJogador], text:renderPostFichaStatusMessage(player) });
            return;
        }
        await sendReply({ sock, idChat, m, mentions:[idJogador], text:renderStatusMessage({ playerId:idJogador, player, phaseInfo, selectedRoll, pendingProfile, pendingMagic, stats }) });
    },
};