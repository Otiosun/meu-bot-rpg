const crypto = require('crypto');
const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    MIN_CHARACTER_AGE,
    canonicalGender,
    isAppearanceDetailed,
    parseProfileSubmission,
} = require('../helpers/profileForms');
const {
    findMagicOptions,
    getAvailableMagicsForRoll,
    getMagicSlotKey,
} = require('../helpers/magicManager');
const { validateFamilyChoice } = require('../helpers/clover/profileRules');
const { validateTraitSubmission } = require('../helpers/clover/traitManager');
const { getFutureTraitIdentity } = require('../helpers/clover/preResetTraitIdentity');
const { applyReturnPointTraitEntitlements } = require('../helpers/clover/returnPointShopTraitEntitlement');
const { getAssignedPreResetState, isPreResetBuildState } = require('../helpers/clover/preResetRosterStateService');
const { getFutureRollByNumber } = require('../helpers/clover/preResetFutureRollService');
const { applyFutureCharacterMutation, getFutureCharacter } = require('../helpers/clover/preResetCharacterService');
const {
    getFutureSlotAvailability,
    holdFutureSlot,
    releaseFutureSlotCategory,
    releaseUnselectedFutureSlots,
} = require('../helpers/clover/preResetFutureSlotService');

function parsePositiveInteger(value) {
    const match = String(value || '').match(/\d+/);
    return match ? Number(match[0]) : null;
}

function opKey(playerId, messageId, revision, draft) {
    const digest = crypto.createHash('sha256')
        .update(JSON.stringify({ playerId, messageId:messageId || 'no-message', revision, draft }))
        .digest('hex')
        .slice(0, 40);
    return `prereset:fichanova:${digest}`;
}

function clean(value) {
    return String(value || '').trim();
}

function renderErrors(errors) {
    return [
        '*♧┃PRE_RESET · FICHA NOVA COM AJUSTES*',
        '',
        'Sua ficha futura não foi enviada ainda.',
        ...errors.map((error) => `• ${error}`),
        '',
        `Corrija e envie novamente mantendo *${COMMAND_PREFIX}Ficha Nova* no começo.`,
    ].join('\n');
}

function traitChoice(option, rarity) {
    if (!option?.key && !option?.name) return null;
    return {
        key:option.key || null,
        name:option.name || option.key || null,
        rarity,
    };
}

function buildFutureTraits(payload = {}) {
    return {
        aptitude: payload.rareAptitude
            ? traitChoice(payload.rareAptitude, 'rare')
            : traitChoice(payload.commonAptitude, 'common'),
        mark: payload.rareMark
            ? traitChoice(payload.rareMark, 'rare')
            : traitChoice(payload.commonMark, 'common'),
        anomaly: traitChoice(payload.anomaly, 'anomaly'),
    };
}

async function validateFutureSubmission(db, playerId, body, current) {
    const parsed = parseProfileSubmission(body);
    const fields = parsed.fields;
    const errors = [];

    if (!parsed.sawCharacterHeader) errors.push('Mantenha o bloco "dados do personagem" do modelo.');
    if (parsed.duplicates.length) errors.push('Há campos repetidos na ficha.');
    if (parsed.placeholders.length) errors.push('Há campos obrigatórios ainda vazios ou com texto de exemplo.');

    const name = clean(fields.personagem_nome);
    const age = parsePositiveInteger(fields.personagem_idade);
    const gender = canonicalGender(fields.personagem_genero);
    const appearance = clean(fields.personagem_aparencia);
    const rollNumber = parsePositiveInteger(fields.numero_roll);
    const selectedRollNumber = Number(current?.draft?.rollNumber || 0) || null;

    if (!name) errors.push('Informe o nome do personagem.');
    if (!age || age < MIN_CHARACTER_AGE) errors.push(`A idade do personagem precisa ter no mínimo ${MIN_CHARACTER_AGE} anos.`);
    if (!gender) errors.push('Informe um gênero válido.');
    if (!isAppearanceDetailed(appearance)) errors.push('Preencha a aparência do personagem.');
    if (!rollNumber) errors.push('Informe o número do roll escolhido.');
    if (selectedRollNumber && rollNumber && rollNumber !== selectedRollNumber) {
        errors.push(`O modelo está vinculado ao roll #${selectedRollNumber}; não troque o número dentro da ficha.`);
    }

    const roll = rollNumber ? await getFutureRollByNumber(db, playerId, rollNumber) : null;
    if (rollNumber && !roll) errors.push('O roll informado não existe nos seus rolls futuros.');

    let family = null;
    if (roll) {
        const result = validateFamilyChoice(fields.familia, roll);
        errors.push(...result.errors);
        family = result.family || null;
    }

    let magic = null;
    if (roll) {
        const magicInput = clean(fields.magia);
        if (!magicInput || ['-', 'n/a', 'na'].includes(magicInput.toLowerCase())) {
            errors.push('Escolha uma magia compatível com o roll.');
        } else {
            const matches = findMagicOptions(getAvailableMagicsForRoll(roll), magicInput);
            if (matches.length === 1) magic = matches[0];
            else if (matches.length > 1) errors.push(`A magia ficou ambígua: ${matches.slice(0, 6).map((item) => item.label).join(', ')}.`);
            else errors.push('A magia informada não existe ou está acima da raridade do roll.');
        }
    }

    const traitIdentity = getFutureTraitIdentity(playerId);
    const baseTraitValidation = await validateTraitSubmission(db, traitIdentity, fields);
    const traitValidation = roll
        ? await applyReturnPointTraitEntitlements(db, playerId, rollNumber, fields, baseTraitValidation)
        : baseTraitValidation;
    errors.push(...traitValidation.errors);
    const traits = buildFutureTraits(traitValidation.payload);

    if (family?.key && family.key !== 'sem_linhagem') {
        const availability = await getFutureSlotAvailability(db, 'family', family.key);
        if (!availability.ok) errors.push('A família escolhida não possui mais vaga no universo futuro.');
    }
    if (magic?.key || magic?.label) {
        const magicKey = magic.key || getMagicSlotKey(magic.label);
        const availability = await getFutureSlotAvailability(db, 'magic', magicKey);
        if (!availability.ok) errors.push('A magia escolhida não possui mais vaga no universo futuro.');
    }
    if (traits.anomaly?.key) {
        const availability = await getFutureSlotAvailability(db, 'anomaly', traits.anomaly.key);
        if (!availability.ok) errors.push('A anomalia escolhida não possui mais vaga no universo futuro.');
    }

    return {
        ok:errors.length === 0,
        errors,
        roll,
        family,
        magic,
        traits,
        traitValidation,
        draft:{
            ...(current?.draft || {}),
            name,
            age,
            gender,
            appearance,
            rollNumber,
            familyKey:family?.key || 'sem_linhagem',
            magicKey:magic ? (magic.key || getMagicSlotKey(magic.label)) : null,
            traits,
        },
    };
}

async function holdSubmissionSlots(db, playerId, rollNumber, family, magic, traits) {
    const created = [];
    const requests = [];
    if (family?.key && family.key !== 'sem_linhagem') requests.push({ category:'family', optionKey:family.key });
    if (magic) requests.push({ category:'magic', optionKey:magic.key || getMagicSlotKey(magic.label) });
    if (traits?.anomaly?.key) requests.push({ category:'anomaly', optionKey:traits.anomaly.key });

    for (const request of requests) {
        const result = await holdFutureSlot(db, {
            playerId,
            rollNumber,
            category:request.category,
            optionKey:request.optionKey,
            source:'prereset_future_ficha',
        });
        if (!result.ok) {
            for (const item of created.reverse()) {
                await releaseFutureSlotCategory(db, playerId, rollNumber, item).catch(() => null);
            }
            const error = new Error(`Sem vaga futura para ${request.category}.`);
            error.code = 'future_ficha_slot_full';
            throw error;
        }
        if (result.limited && !result.duplicate) created.push(request.category);
    }
    return created;
}

module.exports = {
    nome:`${COMMAND_PREFIX}Ficha Nova`,
    aliases:[`${COMMAND_PREFIX}fichanova`],
    descricao:'Envia a ficha do personagem futuro durante o PRE_RESET.',
    executar:async ({ sock, m, idChat, idJogador, db, body }) => {
        const state = await getAssignedPreResetState(db, idJogador);
        if (!isPreResetBuildState(state)) {
            await sendReply({ sock, idChat, m, text:state?.kind === 'keep'
                ? 'Seu personagem está em MANTER. Você não precisa enviar Ficha Nova.'
                : 'A Ficha Nova não está liberada para este cadastro.' });
            return;
        }

        const current = await getFutureCharacter(db, idJogador);
        if (!current) {
            await sendReply({ sock, idChat, m, text:`Escolha primeiro um roll com *${COMMAND_PREFIX}ficha <número>*.` });
            return;
        }
        if (current.status !== 'draft') {
            await sendReply({ sock, idChat, m, text:current.status === 'submitted'
                ? 'Sua Ficha Nova já foi enviada e está aguardando revisão.'
                : 'Sua Ficha Nova já foi fechada e não pode ser reenviada pelo jogador.' });
            return;
        }

        const validation = await validateFutureSubmission(db, idJogador, body, current);
        if (!validation.ok) {
            await sendReply({ sock, idChat, m, text:renderErrors(validation.errors) });
            return;
        }

        const createdSlots = await holdSubmissionSlots(
            db,
            idJogador,
            validation.draft.rollNumber,
            validation.family,
            validation.magic,
            validation.traits
        );

        try {
            const result = await applyFutureCharacterMutation(db, idJogador, idJogador, {
                operationType:'submit',
                expectedRevision:current.revision,
                operationKey:opKey(idJogador, m?.key?.id, current.revision, validation.draft),
                draft:validation.draft,
            });
            await releaseUnselectedFutureSlots(db, idJogador, validation.draft.rollNumber);
            await sendReply({
                sock,
                idChat,
                m,
                text:[
                    '*♧┃PRE_RESET · FICHA NOVA ENVIADA*',
                    '',
                    `*Personagem:* ${validation.draft.name}`,
                    `*Roll:* #${validation.draft.rollNumber}`,
                    `*Família:* ${validation.family?.name || 'Sem linhagem registrada'}`,
                    `*Magia:* ${validation.magic?.label || '-'}`,
                    `*Aptidão:* ${validation.traits.aptitude?.name || '-'}`,
                    `*Marca:* ${validation.traits.mark?.name || '-'}`,
                    `*Anomalia:* ${validation.traits.anomaly?.name || '-'}`,
                    '',
                    result.duplicate ? 'Envio já registrado anteriormente; nada foi duplicado.' : 'A ficha futura foi salva sem alterar seu personagem antigo.',
                    `Use *${COMMAND_PREFIX}status* para acompanhar.`,
                ].join('\n'),
            });
        } catch (error) {
            for (const category of createdSlots.reverse()) {
                await releaseFutureSlotCategory(db, idJogador, validation.draft.rollNumber, category).catch(() => null);
            }
            throw error;
        }
    },
};

module.exports.buildFutureTraits = buildFutureTraits;
module.exports.validateFutureSubmission = validateFutureSubmission;
