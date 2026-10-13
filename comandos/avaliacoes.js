'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getQuotedText } = require('../helpers/messageContext');
const { normalizeText } = require('../helpers/textUtils');
const { canManagePlayer } = require('../helpers/clover/commandTargetUtils');
const { isMigrationFeatureEnabled } = require('../helpers/clover/migrationFeatureFlags');
const {
    approveSpellEvaluation,
    getSpellEvaluationReviewSheet,
} = require('../helpers/clover/spellUniversalEvaluationService');
const { renderSpellCardTechnical } = require('../helpers/clover/spellbookPresentation');
const {
    cancelWaitingEvaluationSubmission,
    categoryLabel,
    claimEvaluationSubmission,
    claimNextEvaluationSubmission,
    listPlayerSubmissions,
    listReviewingSubmissions,
    listWaitingSubmissions,
    normalizeSelector,
    resolveEvaluationSubmissionAtomic,
} = require('../helpers/clover/universalEvaluationService');
const { READ_MORE_BREAK, renderEvaluationTemplate } = require('./modeloAvaliacao');

function compact(value) {
    return normalizeText(String(value || '')).replace(/[^a-z0-9]+/g, '');
}

function actionFromMatchedCommand(value) {
    const command = compact(value);
    if (command === 'avaliacoes') return 'list';
    if (command === 'avaliacao') return 'open';
    if (command === 'aprovar') return 'approve';
    if (command === 'negar') return 'deny';
    if (command === 'proxima') return 'next';
    if (command === 'minhasavaliacoes') return 'mine';
    if (command === 'cancelaravaliacao') return 'cancel';
    return null;
}

function splitLeadingSelector(body) {
    const text = String(body || '').trim();
    const match = text.match(/^(#?A\d+|\d+)(?:(?:[ \t]+|\r?\n+)([\s\S]*))?$/i);
    if (!match) return { selector: null, rest: text };
    return {
        selector: match[1],
        rest: String(match[2] || '').trim(),
    };
}

function looksLikeSpellSheet(value) {
    const text = normalizeText(String(value || ''));
    if (text.includes('ficha de feitico')) return true;
    return ['nome do feitico:', 'tipo:', 'versao:', 'custo:', 'descricao:', 'limites:']
        .filter((label) => text.includes(label)).length >= 3;
}

async function peekSubmissionBySelector(db, selectorInput) {
    const selector = normalizeSelector(selectorInput);
    if (selector.type === 'protocol') {
        const submission = await db.get(
            'SELECT * FROM clover_evaluation_submissions WHERE protocol = ?',
            [selector.value]
        );
        return { selector, submission };
    }
    const submission = await db.get(
        `WITH waiting AS (
            SELECT s.*,
                   ROW_NUMBER() OVER (
                       ORDER BY datetime(s.submitted_at) ASC, s.id ASC
                   ) AS global_position
            FROM clover_evaluation_submissions s
            WHERE s.status = 'waiting'
        )
        SELECT * FROM waiting WHERE global_position = ?`,
        [selector.value]
    );
    return { selector, submission };
}

async function inferReviewerSubmission(db, reviewerId) {
    const rows = await listReviewingSubmissions(db, { reviewerId, limit: 2 });
    if (rows.length === 1) return { ok: true, submission: rows[0] };
    if (!rows.length) return { ok: false, code: 'evaluation_no_current_review' };
    return { ok: false, code: 'evaluation_review_ambiguous', submissions: rows };
}

async function stableSubmissionForAction(db, reviewerId, explicitSelector) {
    if (explicitSelector) {
        const peeked = await peekSubmissionBySelector(db, explicitSelector);
        if (!peeked.submission) return { ok: false, code: 'evaluation_submission_not_found' };
        return { ok: true, submission: peeked.submission, selector: `#${peeked.submission.protocol}` };
    }
    const current = await inferReviewerSubmission(db, reviewerId);
    if (!current.ok) return current;
    return { ok: true, submission: current.submission, selector: `#${current.submission.protocol}` };
}

function renderWaiting(rows, category = null) {
    const title = category ? `AVALIAÇÕES · ${categoryLabel(category).toUpperCase()}` : 'AVALIAÇÕES';
    return [
        `♧┃𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐎̃𝐄𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫`,
        `     ──  ${title.toLowerCase()}  ──`,
        '',
        ...(rows.length ? rows.map((row) => [
            `*${row.global_position}.* #${row.protocol} · ${categoryLabel(row.category)}`,
            `> ${row.character_name_snapshot || row.player_id}`,
        ].join('\n')) : ['Nenhuma submissão aguardando avaliação.']),
        '',
        `> ${COMMAND_PREFIX}avaliacao #A...`,
        `> ${COMMAND_PREFIX}proxima`,
    ].join('\n');
}

function statusLabel(value) {
    const labels = {
        waiting: 'aguardando',
        reviewing: 'em avaliação',
        approved: 'aprovada',
        denied: 'negada',
        cancelled: 'cancelada',
        awaiting_followup: 'aguardando etapa seguinte',
    };
    return labels[value] || value || '-';
}

function renderMine(rows) {
    return [
        '♧┃𝐌𝐈𝐍𝐇𝐀𝐒 𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐎̃𝐄𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '',
        ...(rows.length ? rows.map((row) => [
            `*#${row.protocol} · ${categoryLabel(row.category)}*`,
            `> ${statusLabel(row.status)}${row.global_position ? ` · posição geral ${row.global_position}` : ''}`,
            row.decision_reason ? `> Motivo: ${row.decision_reason}` : null,
        ].filter(Boolean).join('\n')) : ['Você ainda não possui avaliações registradas.']),
    ].join('\n');
}

async function renderClaimedSubmission(db, submission) {
    const header = [
        `♧┃𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐀̃𝐎 · #${submission.protocol} 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫`,
        READ_MORE_BREAK,
        `*𝐂𝐚𝐭𝐞𝐠𝐨𝐫𝐢𝐚:* ${categoryLabel(submission.category)}`,
        `*𝐏𝐞𝐫𝐬𝐨𝐧𝐚𝐠𝐞𝐦:* ${submission.character_name_snapshot || submission.player_id}`,
        '',
    ];

    if (submission.category === 'spell') {
        const review = await getSpellEvaluationReviewSheet(db, `#${submission.protocol}`);
        if (!review.ok) {
            return [...header, 'Não consegui reconstruir a ficha salva com segurança.'].join('\n');
        }
        return [
            ...header,
            review.sheet,
            '',
            `> ${COMMAND_PREFIX}aprovar #${submission.protocol} + ficha final`,
            `> ${COMMAND_PREFIX}negar #${submission.protocol} motivo`,
        ].join('\n');
    }

    return [
        ...header,
        submission.original_payload,
        '',
        '> Esta categoria ainda não possui editor específico nesta tranche.',
    ].join('\n');
}

function renderSelectionError(result) {
    if (result.code === 'evaluation_no_current_review') {
        return 'Você não possui uma única avaliação em andamento. Informe o protocolo, por exemplo `.#aprovar #A104`.';
    }
    if (result.code === 'evaluation_review_ambiguous') {
        return 'Você possui mais de uma avaliação em andamento. Informe o protocolo para não haver ambiguidade.';
    }
    if (result.code === 'evaluation_submission_not_found') return 'Não encontrei essa submissão.';
    return 'Não consegui identificar a submissão com segurança.';
}

function renderApprovalError(result) {
    if (result.code === 'invalid_spell_final_sheet') {
        const fields = [...new Set((result.errors || []).map((error) => error.field).filter(Boolean))];
        return [
            'A aprovação não foi aplicada.',
            fields.length ? `*Revise:* ${fields.join(', ')}` : '*Motivo:* ficha final inválida ou ambígua.',
            '> Nenhum Feitiço ou estado da avaliação foi alterado.',
        ].join('\n');
    }
    if (result.code === 'spell_capacity_full') {
        const capacity = result.details?.capacity || {};
        return [
            'A aprovação não foi aplicada.',
            `*Slots:* ${Number(capacity.occupiedSlots || 0)}/${Number(capacity.totalSlots || 0)}`,
            '> A submissão foi preservada.',
        ].join('\n');
    }
    if (result.code === 'spell_version_must_follow_latest') {
        return `A aprovação não foi aplicada. A próxima versão precisa ser *v${result.details?.expectedVersion || '?'}*.`;
    }
    if (result.code === 'new_spell_must_start_v1') return 'Feitiço novo precisa começar em *v1*.';
    if (result.code === 'evaluation_reviewer_mismatch') return 'Essa avaliação está sendo revisada por outro ADM.';
    if (result.code === 'evaluation_category_mismatch') return 'Essa submissão não é de Feitiço.';
    if (result.code === 'evaluation_already_resolved') return 'Essa submissão já foi resolvida.';
    return result.error || 'Não consegui aplicar a aprovação.';
}

module.exports = {
    nome: `${COMMAND_PREFIX}avaliacoes`,
    aliases: [
        `${COMMAND_PREFIX}avaliações`,
        `${COMMAND_PREFIX}avaliacao`,
        `${COMMAND_PREFIX}avaliação`,
        `${COMMAND_PREFIX}aprovar`,
        `${COMMAND_PREFIX}negar`,
        `${COMMAND_PREFIX}proxima`,
        `${COMMAND_PREFIX}próxima`,
        `${COMMAND_PREFIX}minhasavaliacoes`,
        `${COMMAND_PREFIX}minhasavaliações`,
        `${COMMAND_PREFIX}minhas avaliacoes`,
        `${COMMAND_PREFIX}minhas avaliações`,
        `${COMMAND_PREFIX}cancelaravaliacao`,
        `${COMMAND_PREFIX}cancelaravaliação`,
    ],
    descricao: 'Fila universal de avaliações e ações de revisão.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        const action = actionFromMatchedCommand(matchedCommand);
        const enabled = isMigrationFeatureEnabled('universalEvaluation');

        if (!enabled) {
            if (action === 'open') {
                await sendReply({ sock, idChat, m, text: renderEvaluationTemplate() });
                return;
            }
            await sendReply({ sock, idChat, m, text: 'O novo fluxo de avaliações ainda está desligado neste runtime.' });
            return;
        }

        if (action === 'mine') {
            const rows = await listPlayerSubmissions(db, idJogador, { limit: 30 });
            await sendReply({ sock, idChat, m, text: renderMine(rows) });
            return;
        }

        if (action === 'cancel') {
            const protocol = String(body || '').trim().split(/\s+/)[0];
            if (!protocol) {
                await sendReply({ sock, idChat, m, text: `Use *${COMMAND_PREFIX}cancelaravaliacao #A...*` });
                return;
            }
            const result = await cancelWaitingEvaluationSubmission(db, {
                protocol,
                playerId: idJogador,
                reason: 'cancelada pelo player',
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: result.ok
                    ? `#${result.submission.protocol} foi cancelada.`
                    : 'Essa avaliação não pode ser cancelada agora.',
            });
            return;
        }

        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode administrar avaliações.' });
            return;
        }

        if (action === 'list') {
            const category = String(body || '').trim() || null;
            try {
                const rows = await listWaitingSubmissions(db, { category, limit: 100 });
                await sendReply({ sock, idChat, m, text: renderWaiting(rows, category) });
            } catch (error) {
                await sendReply({ sock, idChat, m, text: error?.message || 'Categoria de avaliação inválida.' });
            }
            return;
        }

        if (action === 'open' || action === 'next') {
            const result = action === 'next'
                ? await claimNextEvaluationSubmission(db, idJogador)
                : await claimEvaluationSubmission(db, {
                    selector: String(body || '').trim(),
                    reviewerId: idJogador,
                });
            if (!result.ok) {
                const text = result.code === 'evaluation_already_claimed'
                    ? 'Essa avaliação já está com outro ADM.'
                    : result.code === 'evaluation_submission_not_found'
                        ? 'Não encontrei essa posição/protocolo na fila.'
                        : 'Não consegui assumir essa avaliação.';
                await sendReply({ sock, idChat, m, text });
                return;
            }
            await sendReply({
                sock,
                idChat,
                m,
                text: await renderClaimedSubmission(db, result.submission),
            });
            return;
        }

        if (action === 'approve') {
            const parsedBody = splitLeadingSelector(body);
            const stable = await stableSubmissionForAction(db, idJogador, parsedBody.selector);
            if (!stable.ok) {
                await sendReply({ sock, idChat, m, text: renderSelectionError(stable) });
                return;
            }
            if (stable.submission.category !== 'spell') {
                await sendReply({ sock, idChat, m, text: 'A aprovação desta categoria ainda não foi ligada nesta tranche.' });
                return;
            }

            const quoted = getQuotedText(m);
            const finalPayload = looksLikeSpellSheet(parsedBody.rest)
                ? parsedBody.rest
                : (looksLikeSpellSheet(quoted) ? quoted : '');
            if (!finalPayload) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: [
                        'Falta a ficha final.',
                        '> Coloque a ficha preenchida depois do comando',
                        '> ou responda à ficha final com o comando de aprovação.',
                    ].join('\n'),
                });
                return;
            }

            const result = await approveSpellEvaluation(db, {
                selector: stable.selector,
                reviewerId: idJogador,
                finalPayload,
            });
            if (!result.ok) {
                await sendReply({ sock, idChat, m, text: renderApprovalError(result) });
                return;
            }

            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    `♧┃𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐀̃𝐎 𝐀𝐏𝐑𝐎𝐕𝐀𝐃𝐀 𖥔 #${result.submission.protocol}`,
                    READ_MORE_BREAK,
                    renderSpellCardTechnical(result.domainResult.spell),
                ].join('\n'),
            });
            return;
        }

        if (action === 'deny') {
            const parsedBody = splitLeadingSelector(body);
            const stable = await stableSubmissionForAction(db, idJogador, parsedBody.selector);
            if (!stable.ok) {
                await sendReply({ sock, idChat, m, text: renderSelectionError(stable) });
                return;
            }
            const reason = parsedBody.selector ? parsedBody.rest : String(body || '').trim();
            if (!reason) {
                await sendReply({ sock, idChat, m, text: `Use *${COMMAND_PREFIX}negar #${stable.submission.protocol} motivo*` });
                return;
            }
            const result = await resolveEvaluationSubmissionAtomic(db, {
                selector: stable.selector,
                reviewerId: idJogador,
                outcome: 'denied',
                reason,
            });
            if (!result.ok) {
                await sendReply({ sock, idChat, m, text: renderApprovalError(result) });
                return;
            }
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    `♧┃𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐀̃𝐎 𝐍𝐄𝐆𝐀𝐃𝐀 𖥔 #${result.submission.protocol}`,
                    READ_MORE_BREAK,
                    `*𝐌𝐨𝐭𝐢𝐯𝐨:* ${reason}`,
                ].join('\n'),
            });
        }
    },
    _test: {
        actionFromMatchedCommand,
        inferReviewerSubmission,
        looksLikeSpellSheet,
        peekSubmissionBySelector,
        splitLeadingSelector,
        stableSubmissionForAction,
    },
};
