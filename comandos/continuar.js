const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getPendingMagicConfirmation } = require('../helpers/magicManager');
const { getPendingConfirmation } = require('../helpers/profileForms');
const {
    ensurePlayerRecord,
    getExistingOnboardingState,
    getOnboardingState,
    updateOnboardingStep,
} = require('../helpers/playerRegistry');
const { getPlayerRollCount } = require('../helpers/rollManager');
const { PHASES, getPlayerPhase } = require('../helpers/clover/playerPhase');
const { getCharacterStats, getPbUsage } = require('../helpers/clover/characterStats');
const { getTreeState } = require('../helpers/clover/skillTreeService');

function renderContinueGps(stage, actions, note = null) {
    return [
        '♧┃𝐂𝐎𝐍𝐓𝐈𝐍𝐔𝐀𝐑 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  fase atual ᥱ próximo passo  ──',
        '',
        '_`─( ✓ )───── Etapa`_',
        '',
        `*Fase:* ${stage}`,
        '',
        '_`─( ■ )───── Agora`_',
        '',
        ...actions.map((action) => `> ${action}`),
        '',
        '_`─( ! )───── Aviso`_',
        '',
        `ⓘ ${note || `Se quiser entender melhor as opções, use ${COMMAND_PREFIX}reinos, ${COMMAND_PREFIX}racas, ${COMMAND_PREFIX}classes, ${COMMAND_PREFIX}grimorios, ${COMMAND_PREFIX}familias e ${COMMAND_PREFIX}tracos.`}`,
    ].join('\n');
}

function parseFutureDraft(row) {
    if (!row?.draft_json) return {};
    try { return JSON.parse(row.draft_json) || {}; } catch { return {}; }
}

function renderPreResetContinue(phaseInfo) {
    if (phaseInfo.phase === PHASES.PRE_RESET_WAIT) {
        return renderContinueGps('PRE_RESET · MANTER', [
            'Seu personagem atual está na whitelist de MANTER.',
            'Não faça novos rolls: sua ficha atual será preservada.',
            `Use *${COMMAND_PREFIX}retorno* ou *${COMMAND_PREFIX}status* para consultar o estado.`,
        ], 'Nenhuma escolha do jogador é necessária.');
    }
    if (phaseInfo.phase === PHASES.PRE_RESET_DECISION) {
        return renderContinueGps('PRE_RESET · bloqueio seguro', [
            'Seu cadastro não possui atribuição válida no roster finalizado.',
            'A criação futura permanece bloqueada até a inconsistência ser corrigida pela administração.',
        ], 'O sistema não vai assumir MANTER ou RESET sozinho para um cadastro sem atribuição válida.');
    }

    const draft = parseFutureDraft(phaseInfo.futureCharacter);
    const selectedRoll = Number(draft.rollNumber || 0) || null;
    if (!phaseInfo.rollCount) {
        return renderContinueGps('PRE_RESET · novos rolls', [
            `Use *${COMMAND_PREFIX}sortear* para gerar seu primeiro roll da nova fase.`,
            `Depois use *${COMMAND_PREFIX}rolls* para revisar.`,
        ], 'Os rolls são gravados no espaço futuro e não alteram seu personagem antigo.');
    }
    if (!selectedRoll) {
        return renderContinueGps('PRE_RESET · escolher roll', [
            `Você tem *${phaseInfo.rollCount}/${MAX_PLAYER_ROLLS}* roll(s) futuros.`,
            `Use *${COMMAND_PREFIX}rolls* para revisar.`,
            `Depois use *${COMMAND_PREFIX}ficha <número>* para escolher.`,
        ], 'O personagem antigo continua intacto.');
    }
    if (!phaseInfo.futureCharacter || phaseInfo.futureCharacter.status === 'draft') {
        return renderContinueGps('PRE_RESET · ficha futura', [
            `Roll escolhido: *#${selectedRoll}*.`,
            `Use *${COMMAND_PREFIX}ficha ${selectedRoll}* se precisar receber o modelo novamente.`,
            `Preencha e envie mantendo o cabeçalho *${COMMAND_PREFIX}Ficha Nova*.`,
        ], 'A Ficha Nova é separada da ficha antiga e não escreve no cadastro legado.');
    }
    if (phaseInfo.futureCharacter.status === 'submitted') {
        return renderContinueGps('PRE_RESET · ficha em revisão', [
            'Sua ficha futura já foi enviada.',
            'Aguarde a revisão da administração.',
        ], 'Os rolls e o rascunho futuro permanecem preservados.');
    }
    if (phaseInfo.futureCharacter.status === 'approved') {
        return renderContinueGps('PRE_RESET · ficha aprovada', [
            'Sua ficha futura foi aprovada.',
            'Aguarde o fechamento da preparação para lançamento.',
        ], 'O reset do personagem antigo ainda é uma etapa separada.');
    }
    return renderContinueGps('PRE_RESET · pronto para lançamento', [
        'Seu personagem futuro está fechado e preservado.',
        'Aguarde a execução oficial do lançamento.',
    ], 'Nenhuma ação adicional do jogador é necessária agora.');
}

function hasConfirmedMagic(player) {
    return Boolean(player?.magia && player.magia !== '-');
}

function renderApprovedBaseStep(phase, stats = null, treeState = null) {
    if (phase === PHASES.APARENCIA_PENDENTE) {
        return renderContinueGps('aparência pendente', [
            'A ficha base já foi aprovada.',
            'Agora falta a administração aprovar a aparência.',
            'O PV de história/persona só será enviado depois disso.',
        ], `Se a aparência precisar mudar, use *${COMMAND_PREFIX}aparencia Personagem - Obra*.`);
    }
    if (phase === PHASES.APARENCIA_REJEITADA) {
        return renderContinueGps('aparência negada', [
            `Envie uma nova aparência com *${COMMAND_PREFIX}aparencia Personagem - Obra*.`,
            'Depois aguarde a avaliação da administração.',
        ], 'Não precisa refazer a ficha base.');
    }
    if (phase === PHASES.HISTORIA_PENDENTE) {
        return renderContinueGps('história/persona pendente', [
            'Envie ou aguarde a avaliação da história e personalidade.',
            'Enquanto isso, os comandos de jogo continuam bloqueados.',
        ], 'Quando tudo for aprovado, a administração libera o jogo.');
    }
    if (phase === PHASES.HISTORIA_APROVADA) {
        return renderContinueGps('aguardando liberação final', [
            'História/persona já foi aprovada.',
            'Agora falta a administração usar a liberação final de jogo.',
        ], 'Os comandos de jogo ainda ficam bloqueados até essa liberação.');
    }
    if (phase === PHASES.JOGO_LIBERADO) {
        const pb = stats ? getPbUsage(stats) : null;
        if (stats?.distribution_status !== 'confirmed') {
            return renderContinueGps('jogo liberado', [
                `Use *${COMMAND_PREFIX}atributos* para distribuir seus PB iniciais.`,
                'Depois confirme com *.#confirmaratributos*.',
            ], `Use *${COMMAND_PREFIX}ph* para ver seus Pontos de Habilidade quando precisar.`);
        }
        if (pb?.free > 0) {
            const actions = [
                `Você possui *${pb.free} PB livre*.`,
                `Use *${COMMAND_PREFIX}atributos* para somar esses pontos aos atributos atuais.`,
                `Use *${COMMAND_PREFIX}ph* para acompanhar PH e estágio.`,
            ];
            if (treeState?.ph?.phAvailable > 0) {
                actions.push(`Use *${COMMAND_PREFIX}arvores* para ver árvores disponíveis.`);
                if (treeState.availableNodes.length) actions.push(`Use *${COMMAND_PREFIX}arvore mana* para ver nós de Mana disponíveis.`);
            }
            return renderContinueGps('jogo liberado', actions, 'Use valores totais finais nos atributos; redução/reset ainda não está liberado.');
        }
        if (treeState?.ph?.phAvailable > 0) {
            const actions = [
                `Use *${COMMAND_PREFIX}perfil* para ver seu personagem.`,
                `Use *${COMMAND_PREFIX}ph* para ver PH acumulado, disponível e histórico.`,
                `Use *${COMMAND_PREFIX}arvores* para ver as árvores disponíveis.`,
            ];
            if (treeState.availableNodes.length) actions.push(`Use *${COMMAND_PREFIX}arvore mana* para escolher próximos nós de Mana.`);
            return renderContinueGps('jogo liberado', actions, 'Árvores, UP e missões ainda serão expandidos em etapas futuras.');
        }
        return renderContinueGps('jogo liberado', [
            `Use *${COMMAND_PREFIX}perfil* para ver seu personagem.`,
            `Use *${COMMAND_PREFIX}ph* para ver PH acumulado, disponível e histórico.`,
            `Use *${COMMAND_PREFIX}arvores* para ver o core inicial das árvores.`,
        ], 'UP e missões entram em etapa futura.');
    }
    return renderContinueGps('recepção base concluída', ['A ficha base foi aprovada.', 'Aguarde a próxima avaliação da administração.'], 'Comandos de jogo ainda não são liberados só pela ficha.');
}

module.exports = {
    nome: `${COMMAND_PREFIX}continuar`,
    descricao: 'Retoma exatamente da etapa onde o seu cadastro parou.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        const player = await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const phaseInfo = await getPlayerPhase(db, idJogador);

        if ([PHASES.PRE_RESET_BUILD, PHASES.PRE_RESET_WAIT, PHASES.PRE_RESET_DECISION].includes(phaseInfo.phase)) {
            await sendReply({ sock, idChat, m, text:renderPreResetContinue(phaseInfo) });
            return;
        }

        const existingOnboarding = await getExistingOnboardingState(db, idJogador);
        const onboarding = existingOnboarding || await getOnboardingState(db, idJogador);
        const rollCount = await getPlayerRollCount(db, idJogador);
        const pending = await getPendingConfirmation(db, idJogador);
        const pendingMagic = await getPendingMagicConfirmation(db, idJogador);
        const magicChosen = hasConfirmedMagic(player);
        const stats = phaseInfo.canPlay ? await getCharacterStats(db, idJogador) : null;
        const treeState = phaseInfo.canPlay ? await getTreeState(db, idJogador, 'mana') : null;

        if (player.ficha_status === 'aprovada') {
            await sendReply({ sock, idChat, m, text:renderApprovedBaseStep(phaseInfo.phase, stats, treeState) });
            return;
        }
        if (!existingOnboarding && !rollCount) {
            await sendReply({ sock, idChat, m, text:renderContinueGps('recepção não iniciada', [`Use *${COMMAND_PREFIX}start* para iniciar a recepção.`, `Depois use *${COMMAND_PREFIX}sortear* para gerar o primeiro roll.`], 'Comece pelo start para receber a orientação completa.') });
            return;
        }
        if (onboarding.current_step === 'corrigir_ficha') {
            const errors = onboarding.step_payload?.errors || ['Sua ficha ainda precisa de ajustes.'];
            await sendReply({ sock, idChat, m, text:renderContinueGps('ficha com pendências', [...errors.map((error) => `Corrija: ${error}`), 'Depois envie a ficha preenchida novamente.', `Se precisar do modelo, use *${COMMAND_PREFIX}ficha <número>* novamente.`], 'A confirmação só libera depois que essas pendências forem corrigidas.') });
            return;
        }
        if (pending) {
            if (!pendingMagic && !magicChosen) {
                await updateOnboardingStep(db, idJogador, 'escolha_magia', { last_message:'magia_escolha_expirada' });
                await sendReply({ sock, idChat, m, text:renderContinueGps('magia não escolhida', ['Preencha o campo *Magia* na ficha com uma magia compatível com o roll.', `Ou use *${COMMAND_PREFIX}magias* se quiser consultar/escolher antes.`, `Então volte em *${COMMAND_PREFIX}confirmarFicha*.`], 'Se havia uma escolha pendente, ela expirou; a ficha pode trazer outra magia.') });
                return;
            }
            await sendReply({ sock, idChat, m, text:renderContinueGps('ficha pronta', [`Use *${COMMAND_PREFIX}confirmarFicha* para finalizar.`, `Se quiser desistir dessa ficha, use *${COMMAND_PREFIX}cancelarFicha*.`], 'A ficha já foi validada; falta confirmar.') });
            return;
        }
        if (onboarding.current_step === 'confirmar_magia') {
            if (pendingMagic) {
                await sendReply({ sock, idChat, m, text:renderContinueGps('confirmar magia', ['Responda a mensagem de magia com *confirmar*.', `Ou use *${COMMAND_PREFIX}magias* para rever a escolha.`], `Magia pendente: ${pendingMagic.magic_label}.`) });
                return;
            }
            await updateOnboardingStep(db, idJogador, 'escolha_magia', { last_message:'magia_escolha_expirada' });
            await sendReply({ sock, idChat, m, text:renderContinueGps('magia expirada', [`Use *${COMMAND_PREFIX}magias* para escolher de novo.`, 'Depois confirme a magia quando o bot pedir.'], 'Escolha expirada não ocupa vaga.') });
            return;
        }
        if (!rollCount) {
            await sendReply({ sock, idChat, m, text:renderContinueGps('recepção iniciada', [`Use *${COMMAND_PREFIX}sortear* para gerar seu primeiro roll.`, `Depois use *${COMMAND_PREFIX}rolls* para revisar.`], 'O cadastro ainda não tem roll salvo.') });
            return;
        }
        if (!player.numero_roll_escolhido) {
            if (rollCount < MAX_PLAYER_ROLLS) {
                await sendReply({ sock, idChat, m, text:renderContinueGps('rolls em aberto', [`Você tem *${rollCount}/${MAX_PLAYER_ROLLS}* roll(s).`, `Use *${COMMAND_PREFIX}sortear* se quiser mais rolls.`, `Use *${COMMAND_PREFIX}rolls* para revisar os rolls salvos.`], 'Quando decidir, use .#ficha <número>.') });
                return;
            }
            await sendReply({ sock, idChat, m, text:renderContinueGps('escolher roll', [`Você já tem *${rollCount}/${MAX_PLAYER_ROLLS}* rolls.`, `Use *${COMMAND_PREFIX}rolls* para revisar.`, `Depois use *${COMMAND_PREFIX}ficha <número>* para escolher.`], 'Exemplo: .#ficha 2.') });
            return;
        }
        if (!pendingMagic && !magicChosen) {
            await sendReply({ sock, idChat, m, text:renderContinueGps('magia não escolhida', ['Preencha o campo *Magia* na ficha com uma magia compatível com o roll.', `Ou use *${COMMAND_PREFIX}magias* se quiser escolher antes.`, `Use *${COMMAND_PREFIX}familias* para ver famílias compatíveis.`, `Use *${COMMAND_PREFIX}tracos* para ver traços e tentativas especiais.`], 'A ficha final precisa ter uma magia compatível.') });
            return;
        }
        await sendReply({ sock, idChat, m, text:renderContinueGps('preencher ficha', [`Use *${COMMAND_PREFIX}familias* para conferir a família.`, `Use *${COMMAND_PREFIX}tracos* para conferir aptidão, marca e anomalia.`, 'Envie a ficha preenchida no grupo quando estiver pronta.'], `Roll escolhido: #${player.numero_roll_escolhido}.`) });
    },
};