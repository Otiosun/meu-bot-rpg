const crypto = require('crypto');
const { sendReply } = require('../helpers/chatReply');
const { COMMAND_PREFIX } = require('../config/bot');
const {
    PROFILE_TEMPLATE_COMMAND,
    buildProfileTemplatePrefill,
    getPendingConfirmation,
    renderConfirmedFicha,
    renderConfirmationSummary,
    renderProfileTemplate,
} = require('../helpers/profileForms');
const { getPendingMagicConfirmation, isMagicFlowCriticalStep, renderMagicFlowLockedMessage } = require('../helpers/magicManager');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');
const { getPlayerRollByNumber, listPlayerRolls } = require('../helpers/rollManager');
const { isPreResetTransitionEnabled } = require('../helpers/clover/preResetTransitionService');
const { getAssignedPreResetState, isPreResetBuildState } = require('../helpers/clover/preResetRosterStateService');
const { getFutureRollByNumber, listFutureRolls } = require('../helpers/clover/preResetFutureRollService');
const { applyFutureCharacterMutation, getFutureCharacter } = require('../helpers/clover/preResetCharacterService');

function parseRollNumber(value) {
    const match = String(value || '').match(/\d+/);
    return match ? Number(match[0]) : null;
}

function renderFichaNextHint() {
    return [
        '',
        `↳ Depois, veja *${COMMAND_PREFIX}magias*, *${COMMAND_PREFIX}familias* e *${COMMAND_PREFIX}tracos*.`,
        `↳ Se travar, use *${COMMAND_PREFIX}continuar*.`,
    ].join('\n');
}

function operationKey(playerId, messageId, rollNumber) {
    const digest = crypto.createHash('sha256')
        .update(`${playerId}|${messageId || 'no-message'}|${rollNumber}`)
        .digest('hex')
        .slice(0, 40);
    return `prereset:ficha-roll:${digest}`;
}

async function selectFutureRoll(db, idJogador, rollNumber, m) {
    const current = await getFutureCharacter(db, idJogador);
    const draft = { ...(current?.draft || {}), rollNumber:Number(rollNumber) };
    if (!current) {
        return applyFutureCharacterMutation(db, idJogador, idJogador, {
            operationType:'create',
            expectedRevision:0,
            operationKey:operationKey(idJogador, m?.key?.id, rollNumber),
            draft,
        });
    }
    if (current.status !== 'draft') {
        if (Number(current.draft?.rollNumber) !== Number(rollNumber)) {
            const error = new Error('A ficha futura já foi enviada/revisada e o roll não pode mais ser trocado.');
            error.code = 'future_character_not_editable';
            throw error;
        }
        return { ok:true, duplicate:true, character:current };
    }
    if (Number(current.draft?.rollNumber) === Number(rollNumber)) {
        return { ok:true, duplicate:true, character:current };
    }
    return applyFutureCharacterMutation(db, idJogador, idJogador, {
        operationType:'update',
        expectedRevision:current.revision,
        operationKey:operationKey(idJogador, m?.key?.id, rollNumber),
        draft,
    });
}

async function executePreResetFicha({ sock, m, idChat, idJogador, db, body }) {
    const state = await getAssignedPreResetState(db, idJogador);
    if (!isPreResetBuildState(state)) {
        await sendReply({
            sock, idChat, m,
            text: state.kind === 'keep'
                ? 'Seu personagem está em MANTER. A ficha antiga é a base preservada da nova fase.'
                : 'Seu PRE_RESET de criação ainda não está disponível.',
        });
        return;
    }

    const rolls = await listFutureRolls(db, idJogador);
    if (!rolls.length) {
        await sendReply({
            sock, idChat, m,
            text: `Você ainda não tem roll da nova fase. Use *${COMMAND_PREFIX}sortear* primeiro.`,
        });
        return;
    }

    const requested = parseRollNumber(body);
    if (!requested && rolls.length > 1) {
        await sendReply({
            sock, idChat, m,
            text: `Você tem ${rolls.length} rolls da nova fase. Use *${COMMAND_PREFIX}ficha <número>*. Ex.: *${COMMAND_PREFIX}ficha 1*.`,
        });
        return;
    }
    const rollNumber = requested || Number(rolls[0].roll_number);
    const roll = await getFutureRollByNumber(db, idJogador, rollNumber);
    if (!roll) {
        await sendReply({
            sock, idChat, m,
            text: `Não encontrei o roll *#${rollNumber}* nos seus sorteios da nova fase. Use *${COMMAND_PREFIX}rolls*.`,
        });
        return;
    }

    const selected = await selectFutureRoll(db, idJogador, rollNumber, m);
    const future = selected.character;
    const activePlayer = await db.get(
        `SELECT nome_real,idade_real,gosta_de_fazer,disponibilidade_detalhada
         FROM jogadores WHERE id=?`,
        [idJogador]
    );
    const futurePlayer = {
        nome_real:activePlayer?.nome_real || '',
        idade_real:activePlayer?.idade_real || '',
        gosta_de_fazer:activePlayer?.gosta_de_fazer || '',
        disponibilidade_detalhada:activePlayer?.disponibilidade_detalhada || '',
        personagem_nome:future?.draft?.name || '',
        personagem_idade:future?.draft?.age || '',
        personagem_aparencia:future?.draft?.appearance || '',
        personagem_genero:future?.draft?.gender || '',
        numero_roll_escolhido:rollNumber,
        familia:'',
        magia:'',
    };

    await sendReply({
        sock,
        idChat,
        m,
        text: [
            '*♧┃PRE_RESET · FICHA DA NOVA FASE*',
            '> Este modelo pertence ao personagem futuro. Sua ficha antiga não será alterada.',
            '',
            renderProfileTemplate(buildProfileTemplatePrefill({
                player:futurePlayer,
                rollNumber,
                roll,
            })),
            '',
            '> O roll escolhido já ficou salvo no espaço futuro do PRE_RESET.',
        ].join('\n'),
    });
}

module.exports = {
    nome: PROFILE_TEMPLATE_COMMAND,
    descricao: 'Envia o modelo da ficha e orienta o proximo passo do cadastro.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db, body }) => {
        if (isPreResetTransitionEnabled(process.env)) {
            await executePreResetFicha({ sock, m, idChat, idJogador, db, body });
            return;
        }

        const player = await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const onboarding = await getOnboardingState(db, idJogador);

        if (isMagicFlowCriticalStep(onboarding.current_step)) {
            await sendReply({ sock, idChat, m, text: renderMagicFlowLockedMessage() });
            return;
        }

        const pending = await getPendingConfirmation(db, idJogador);
        const pendingMagic = await getPendingMagicConfirmation(db, idJogador);
        const rolls = await listPlayerRolls(db, idJogador);
        const requestedRollNumber = parseRollNumber(body);

        if (player.ficha_status === 'confirmada' || player.ficha_status === 'aprovada') {
            const roll = player.numero_roll_escolhido
                ? await getPlayerRollByNumber(db, idJogador, player.numero_roll_escolhido)
                : null;
            await sendReply({ sock, idChat, m, text: renderConfirmedFicha(player, roll) });
            return;
        }

        if (requestedRollNumber) {
            const roll = await getPlayerRollByNumber(db, idJogador, requestedRollNumber);
            if (!roll) {
                await sendReply({
                    sock, idChat, m,
                    text: [`Nao encontrei o roll *#${requestedRollNumber}* nos seus sorteios salvos.`, `Use *${COMMAND_PREFIX}rolls* para rever e depois *${COMMAND_PREFIX}ficha <numero do roll>*.`].join('\n'),
                });
                return;
            }
            await db.run('UPDATE jogadores SET numero_roll_escolhido = ? WHERE id = ?', [requestedRollNumber, idJogador]);
            await updateOnboardingStep(db, idJogador, 'aguardando_ficha_envio', { last_message:'ficha_modelo', roll_number:requestedRollNumber });
            const note = pendingMagic ? `\n\n↳ Magia pendente: *${pendingMagic.magic_label}*.` : '';
            await sendReply({
                sock, idChat, m,
                text: [renderProfileTemplate(buildProfileTemplatePrefill({ player, pending, rollNumber:requestedRollNumber, magicLabel:pendingMagic?.magic_label, roll })), note, renderFichaNextHint()].join(''),
            });
            return;
        }

        if (pending) {
            await updateOnboardingStep(db, idJogador, 'ficha_pendente_confirmacao', { last_message:'ficha_pendente_confirmacao', roll_number:pending.numeroRoll });
            await sendReply({ sock, idChat, m, text:renderConfirmationSummary(pending, player) });
            return;
        }

        if (!rolls.length) {
            await sendReply({ sock, idChat, m, text:[`Voce ainda nao tem roll salvo. Use *${COMMAND_PREFIX}sortear* primeiro.`, `Depois volte com *${COMMAND_PREFIX}ficha <numero do roll>*.`].join('\n') });
            return;
        }

        if (rolls.length > 1) {
            await sendReply({ sock, idChat, m, text:[`Voce tem mais de um roll salvo. Use *${COMMAND_PREFIX}ficha <numero do roll>*.`, `Exemplo: *${COMMAND_PREFIX}ficha 1*.`, `Para rever, use *${COMMAND_PREFIX}rolls*.`].join('\n') });
            return;
        }

        const automaticRollNumber = rolls[0].roll_number;
        await db.run('UPDATE jogadores SET numero_roll_escolhido = ? WHERE id = ?', [automaticRollNumber, idJogador]);
        await updateOnboardingStep(db, idJogador, 'aguardando_ficha_envio', { last_message:'ficha_modelo', roll_number:automaticRollNumber });
        await sendReply({
            sock, idChat, m,
            text:[renderProfileTemplate(buildProfileTemplatePrefill({ player, pending, rollNumber:automaticRollNumber, magicLabel:pendingMagic?.magic_label, roll:rolls[0] })), renderFichaNextHint()].join(''),
        });
    },
};
