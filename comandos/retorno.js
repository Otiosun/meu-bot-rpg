'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    PreResetTransitionError,
    assertTransitionLaunchEnabled,
    decideTransition,
    getTransitionState,
    hash,
} = require('../helpers/clover/preResetTransitionService');

const PUBLIC_RETURN_COMMAND = '#retorno';

function normalized(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function renderMenu() {
    return [
        '♧┃𝐑𝐄𝐓𝐎𝐑𝐍𝐎 ᛯ 𝐂𝐥𝐨𝐯𝐞𝐫',
        '',
        'A nova fase exige uma decisão sobre seu personagem atual.',
        '',
        `*${PUBLIC_RETURN_COMMAND} manter*`,
        'Preserva o personagem aprovado na configuração inicial: roll, ficha e aparência aprovada. Progresso e inventário não são preservados.',
        '',
        `*${PUBLIC_RETURN_COMMAND} resetar*`,
        'Abre mão do personagem atual para criar o personagem da nova fase.',
        '',
        '*A decisão final é irreversível.*',
    ].join('\n');
}

function renderKeepWarning() {
    return [
        '♧┃𝐂𝐎𝐍𝐅𝐈𝐑𝐌𝐀𝐑 𝐌𝐀𝐍𝐓𝐄𝐑',
        '',
        'Você manterá o personagem aprovado como base da nova fase.',
        'O sistema congela o roll original comprovado, o nome atual e a aparência atual aprovada.',
        'Progresso, inventário e ganhos posteriores não entram nesse pacote.',
        '',
        '*Depois de confirmar, não será possível trocar para RESETAR.*',
        '',
        `Para concluir: *${PUBLIC_RETURN_COMMAND} confirmar manter*`,
    ].join('\n');
}

function renderResetWarning() {
    return [
        '♧┃𝐂𝐎𝐍𝐅𝐈𝐑𝐌𝐀𝐑 𝐑𝐄𝐒𝐄𝐓',
        '',
        'Você abrirá mão do personagem atual para entrar na criação da nova fase.',
        'Essa decisão não executa um reset destrutivo agora; ela apenas registra sua escolha para o reset final controlado.',
        '',
        '*Depois de confirmar, não será possível voltar para MANTER.*',
        '',
        `Para concluir: *${PUBLIC_RETURN_COMMAND} confirmar resetar*`,
    ].join('\n');
}

function renderDecided(decision) {
    const labels = {
        keep: 'MANTER',
        reset: 'RESETAR',
        auto_reset: 'AUTO-RESET',
    };
    return [
        '♧┃𝐑𝐄𝐓𝐎𝐑𝐍𝐎 𝐑𝐄𝐆𝐈𝐒𝐓𝐑𝐀𝐃𝐎',
        '',
        `Decisão: *${labels[decision?.status] || decision?.status || '-'}*`,
        '',
        'Essa decisão está congelada e não pode ser alterada pelo jogador.',
        'O jogo continua bloqueado durante o PRE_RESET.',
    ].join('\n');
}

function buildOperationKey(idJogador, m, decision) {
    const messageId = m?.key?.id || m?.messageTimestamp || 'no-message-id';
    return `retorno:${hash({ idJogador, messageId, decision }).slice(0, 48)}`;
}

function renderError(error) {
    if (error?.code === 'keep_baseline_roll_ambiguous') {
        return [
            '♧┃𝐌𝐀𝐍𝐓𝐄𝐑 𝐁𝐋𝐎𝐐𝐔𝐄𝐀𝐃𝐎 𝐏𝐎𝐑 𝐒𝐄𝐆𝐔𝐑𝐀𝐍𝐂̧𝐀',
            '',
            'O bot não conseguiu provar qual roll histórico originou sua ficha aprovada.',
            'Nenhuma decisão foi gravada e nada foi resetado.',
            '',
            'A administração precisa revisar esse caso antes de MANTER.',
        ].join('\n');
    }
    if (error?.code === 'keep_baseline_appearance_not_approved') {
        return 'Sua aparência atual ainda não possui aprovação válida. Nenhuma decisão foi gravada.';
    }
    if (error?.code === 'transition_decision_irreversible') {
        return 'Sua decisão de retorno já foi registrada e é irreversível.';
    }
    if (error?.code === 'prereset_transition_disabled') {
        return 'O fluxo de PRE_RESET ainda não está liberado.';
    }
    return error?.message || 'Não consegui registrar a decisão de retorno.';
}

module.exports = {
    nome: `${COMMAND_PREFIX}retorno`,
    aliases: [`${COMMAND_PREFIX}return`],
    descricao: 'Registra a decisão irreversível de manter ou resetar o personagem para a nova fase.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        try {
            assertTransitionLaunchEnabled(process.env);
            const state = await getTransitionState(db, idJogador);
            if (state.kind === 'new_player') {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        '♧┃𝐍𝐎𝐕𝐀 𝐆𝐄𝐑𝐀𝐂̧𝐀̃𝐎',
                        '',
                        'Você não possui personagem antigo aprovado para decidir.',
                        'Seu fluxo é direto para a pré-criação da nova fase.',
                    ].join('\n'),
                });
                return;
            }
            if (state.kind === 'decided') {
                await sendReply({ sock, idChat, m, text: renderDecided(state.decision) });
                return;
            }

            const action = normalized(body);
            if (!action) {
                await sendReply({ sock, idChat, m, text: renderMenu() });
                return;
            }
            if (action === 'manter') {
                await sendReply({ sock, idChat, m, text: renderKeepWarning() });
                return;
            }
            if (['reset', 'resetar'].includes(action)) {
                await sendReply({ sock, idChat, m, text: renderResetWarning() });
                return;
            }

            const decision = action === 'confirmar manter'
                ? 'keep'
                : (['confirmar reset', 'confirmar resetar'].includes(action) ? 'reset' : null);
            if (!decision) {
                await sendReply({ sock, idChat, m, text: renderMenu() });
                return;
            }

            const result = await decideTransition(db, idJogador, idJogador, {
                decision,
                source: 'player',
                operationKey: buildOperationKey(idJogador, m, decision),
            });
            await sendReply({ sock, idChat, m, text: renderDecided(result.decision) });
        } catch (error) {
            if (!(error instanceof PreResetTransitionError)) throw error;
            await sendReply({ sock, idChat, m, text: renderError(error) });
        }
    },
};
