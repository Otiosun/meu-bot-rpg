'use strict';

const crypto = require('crypto');
const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isSameUser } = require('../helpers/groupAccess');
const { getMessageContextInfo, getQuotedText } = require('../helpers/messageContext');
const { normalizeText } = require('../helpers/textUtils');
const {
    assertMechanicalTarget,
    getPlayerById,
    playerDisplayName,
} = require('../helpers/clover/commandTargetUtils');
const { isMigrationFeatureEnabled } = require('../helpers/clover/migrationFeatureFlags');
const { submitSpellEvaluation } = require('../helpers/clover/spellUniversalEvaluationService');
const { normalizeEvaluationCategory } = require('../helpers/clover/universalEvaluationService');

function compact(value) {
    return normalizeText(String(value || '')).replace(/[^a-z0-9]+/g, '');
}

function looksLikeSpellSheet(value) {
    const text = normalizeText(String(value || ''));
    if (text.includes('ficha de feitico')) return true;
    const labels = [
        'nome do feitico:',
        'tipo:',
        'versao:',
        'custo:',
        'alcance:',
        'duracao:',
        'descricao:',
        'limites:',
        'notas adm:',
    ];
    return labels.filter((label) => text.includes(label)).length >= 3;
}

function splitGenericCategory(body) {
    const text = String(body || '').trim();
    const match = text.match(/^(\S+)(?:[ \t]+|\r?\n+)?([\s\S]*)$/);
    return {
        category: String(match?.[1] || '').trim(),
        rest: String(match?.[2] || '').trim(),
    };
}

function resolveSubmissionInput({ matchedCommand, body, m, playerId }) {
    const command = compact(matchedCommand);
    const generic = command === 'enviaravaliacao';
    let categoryInput = 'spell';
    let inlineCandidate = String(body || '').trim();

    if (generic) {
        const split = splitGenericCategory(body);
        categoryInput = split.category;
        inlineCandidate = split.rest;
    }

    let category;
    try {
        category = normalizeEvaluationCategory(categoryInput);
    } catch (error) {
        return { ok: false, code: error.code || 'unsupported_evaluation_category' };
    }

    if (category !== 'spell') {
        return { ok: false, code: 'evaluation_category_not_exposed_yet', category };
    }

    const context = getMessageContextInfo(m);
    const quotedText = getQuotedText(m);
    const inlineHasSheet = looksLikeSpellSheet(inlineCandidate);

    if (inlineHasSheet) {
        return {
            ok: true,
            category,
            rawSheet: inlineCandidate,
            source: 'inline',
            sourceMessageId: m?.key?.id || null,
            sourceQuotedMessageId: null,
        };
    }

    if (quotedText && looksLikeSpellSheet(quotedText)) {
        const quotedParticipant = context?.participant || null;
        if (quotedParticipant && playerId && !isSameUser(quotedParticipant, playerId)) {
            return {
                ok: false,
                code: 'evaluation_quoted_sheet_not_owned',
            };
        }
        return {
            ok: true,
            category,
            rawSheet: quotedText,
            source: 'quote',
            sourceMessageId: context?.stanzaId || null,
            sourceQuotedMessageId: context?.stanzaId || null,
        };
    }

    return { ok: false, code: 'evaluation_sheet_missing' };
}

function stableSubmissionKey({ category, playerId, chatId, sourceMessageId, rawSheet, m }) {
    const source = String(
        sourceMessageId
        || m?.key?.id
        || m?.messageTimestamp
        || crypto.createHash('sha256').update(String(rawSheet || '')).digest('hex')
    );
    return `evaluation:${category}:${playerId}:${chatId}:${source}`;
}

function renderSubmitError(result) {
    if (result.code === 'evaluation_category_not_exposed_yet') {
        return 'Essa categoria ainda não foi liberada no fluxo universal.';
    }
    if (result.code === 'evaluation_quoted_sheet_not_owned') {
        return 'A ficha respondida não pertence a você. Envie ou responda a sua própria ficha.';
    }
    if (result.code === 'evaluation_sheet_missing') {
        return [
            'Não encontrei uma Ficha de Feitiço para enviar.',
            '',
            `Preencha *${COMMAND_PREFIX}fichafeitico* e depois:`,
            `> responda a ficha com *${COMMAND_PREFIX}enviarfeitico*`,
            '> ou mande o comando e a ficha preenchida na mesma mensagem.',
        ].join('\n');
    }
    if (result.code === 'spell_player_filled_adm_fields') {
        return [
            'A ficha não foi enviada.',
            '',
            `*Campos reservados à ADM:* ${(result.fields || []).join(', ')}`,
            '> Deixe esses campos como 🔒.',
        ].join('\n');
    }
    if (result.code === 'invalid_spell_intake_sheet') {
        const fields = [...new Set((result.errors || []).map((error) => error.field).filter(Boolean))];
        return [
            'A ficha não pôde ser enviada com segurança.',
            fields.length ? `*Revise:* ${fields.join(', ')}` : '*Motivo:* estrutura ambígua ou incompleta.',
            '',
            '> O bot tolera formatação pequena, mas não adivinha campos ambíguos.',
        ].join('\n');
    }
    return 'Não consegui enviar essa avaliação agora.';
}

module.exports = {
    nome: `${COMMAND_PREFIX}enviaravaliacao`,
    aliases: [
        `${COMMAND_PREFIX}enviar avaliação`,
        `${COMMAND_PREFIX}enviarfeitico`,
        `${COMMAND_PREFIX}enviarfeitiço`,
        `${COMMAND_PREFIX}enviar feitico`,
        `${COMMAND_PREFIX}enviar feitiço`,
    ],
    descricao: 'Envia uma ficha preenchida para a fila universal de avaliação.',
    gameCommand: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        if (!isMigrationFeatureEnabled('universalEvaluation')) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'O novo fluxo de avaliações ainda está desligado neste runtime.',
            });
            return;
        }

        const player = await getPlayerById(db, idJogador);
        const mechanical = assertMechanicalTarget(player, {
            rawTarget: idJogador,
            source: 'self',
        });
        if (!mechanical.ok) {
            await sendReply({ sock, idChat, m, text: mechanical.error });
            return;
        }

        const selected = resolveSubmissionInput({
            matchedCommand,
            body,
            m,
            playerId: idJogador,
        });
        if (!selected.ok) {
            await sendReply({ sock, idChat, m, text: renderSubmitError(selected) });
            return;
        }

        const submissionKey = stableSubmissionKey({
            category: selected.category,
            playerId: player.id,
            chatId: idChat,
            sourceMessageId: selected.sourceMessageId,
            rawSheet: selected.rawSheet,
            m,
        });

        let result;
        if (selected.category === 'spell') {
            result = await submitSpellEvaluation(db, {
                playerId: player.id,
                whatsappJid: idJogador,
                characterId: player.id,
                characterName: playerDisplayName(player, player.id),
                rawSheet: selected.rawSheet,
                submissionKey,
                sourceChatId: idChat,
                sourceMessageId: selected.sourceMessageId || m?.key?.id || null,
                sourceQuotedMessageId: selected.sourceQuotedMessageId,
                metadata: { input_source: selected.source },
            });
        }

        if (!result?.ok) {
            await sendReply({ sock, idChat, m, text: renderSubmitError(result || { code: 'unknown' }) });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                '♧┃𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐀̃𝐎 𝐄𝐍𝐕𝐈𝐀𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
                '     ──  proposta registrada  ──',
                '',
                `*𝐏𝐫𝐨𝐭𝐨𝐜𝐨𝐥𝐨:* #${result.submission.protocol}`,
                '*𝐂𝐚𝐭𝐞𝐠𝐨𝐫𝐢𝐚:* Feitiço',
                result.duplicate ? '*𝐒𝐭𝐚𝐭𝐮𝐬:* já estava enviada' : '*𝐒𝐭𝐚𝐭𝐮𝐬:* aguardando avaliação',
                '',
                `> ${COMMAND_PREFIX}minhasavaliacoes`,
            ].join('\n'),
        });
    },
    _test: {
        looksLikeSpellSheet,
        resolveSubmissionInput,
        splitGenericCategory,
        stableSubmissionKey,
    },
};
