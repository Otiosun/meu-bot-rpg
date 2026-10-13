'use strict';

const { normalizeText } = require('../textUtils');
const { ensureCharacterStats } = require('./characterStats');
const { parsePrototypeEvaluationSheet } = require('./evaluationFormSchemas');
const {
    UniversalEvaluationError,
    createEvaluationSubmission,
    getEvaluationSubmission,
    resolveEvaluationSubmissionAtomic,
} = require('./universalEvaluationService');

class PrototypeUniversalEvaluationError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PrototypeUniversalEvaluationError';
        this.code = code;
        this.details = details;
    }
}

const PROTOTYPE_LIMITS = Object.freeze({
    '9': 1,
    '8': 1,
    '7': 1,
    '6': 1,
    '5': 2,
    '4': 2,
    '3': 2,
    '2': 2,
    '1': 3,
    '0': 3,
});

function prototypeLimitForStage(stageKey) {
    const key = String(stageKey ?? '').trim();
    return Object.prototype.hasOwnProperty.call(PROTOTYPE_LIMITS, key)
        ? PROTOTYPE_LIMITS[key]
        : null;
}

function block(value) {
    const text = String(value ?? '').trim() || '-';
    return text.split('\n').map((line) => `> ${line.trim() || '-'}`).join('\n');
}

function renderPrototypeTemplate(data = {}) {
    return [
        '*♧┃𝐅𝐈𝐂𝐇𝐀 · 𝐏𝐑𝐎𝐓𝐎́𝐓𝐈𝐏𝐎 𖥔 𝐇𝐮𝐦𝐚𝐧𝐨*',
        '     ──  técnica em desenvolvimento  ──',
        '',
        '_`─( ✦ )───── 𝗣𝗿𝗼𝗽𝗼𝘀𝘁𝗮`_',
        '',
        '*𝐍𝐨𝐦𝐞:*',
        block(data.name || ''),
        '',
        '*𝐈𝐝𝐞𝐢𝐚:*',
        block(data.idea || ''),
        '',
        '*𝐃𝐞𝐟𝐞𝐢𝐭𝐨:*',
        block(data.defect && data.defect !== '-' ? data.defect : '🔒 ADM'),
    ].join('\n');
}

function parserFailure(code, parsed) {
    return { ok: false, code, errors: parsed?.errors || [] };
}

async function submitPrototypeEvaluation(db, input = {}) {
    const rawSheet = String(input.rawSheet || '');
    const parsed = parsePrototypeEvaluationSheet(rawSheet, { phase: 'intake' });
    if (!parsed.ok) return parserFailure('invalid_prototype_intake_sheet', parsed);
    if (parsed.data.defect && parsed.data.defect !== '-') {
        return {
            ok: false,
            code: 'prototype_player_filled_adm_field',
            fields: ['defect'],
        };
    }

    const result = await createEvaluationSubmission(db, {
        category: 'prototype',
        playerId: input.playerId,
        whatsappJid: input.whatsappJid || input.playerId,
        characterId: input.characterId || null,
        characterName: input.characterName || null,
        originalPayload: rawSheet,
        submissionKey: input.submissionKey,
        sourceChatId: input.sourceChatId || null,
        sourceMessageId: input.sourceMessageId || null,
        sourceQuotedMessageId: input.sourceQuotedMessageId || null,
        metadata: {
            ...(input.metadata || {}),
            parsed_intake: {
                name: parsed.data.name,
                normalizedName: parsed.data.normalizedName,
                idea: parsed.data.idea,
            },
        },
    });
    return { ...result, parsed: parsed.data };
}

async function getPrototypeEvaluationReviewSheet(db, protocol) {
    const submission = await getEvaluationSubmission(db, protocol);
    if (!submission) return { ok: false, code: 'evaluation_submission_not_found' };
    if (submission.category !== 'prototype') {
        return { ok: false, code: 'evaluation_category_mismatch', submission };
    }
    const parsed = parsePrototypeEvaluationSheet(submission.original_payload, { phase: 'intake' });
    if (!parsed.ok) {
        return {
            ok: false,
            code: 'stored_prototype_payload_invalid',
            submission,
            errors: parsed.errors,
        };
    }
    return {
        ok: true,
        submission,
        parsed: parsed.data,
        sheet: renderPrototypeTemplate(parsed.data),
    };
}

function domainError(code, message, details = {}) {
    throw new PrototypeUniversalEvaluationError(code, message, details);
}

async function inspectPrototypeCapacity(db, playerId, normalizedName = null) {
    const player = await db.get('SELECT id, raca FROM jogadores WHERE id = ?', [playerId]);
    if (!player) domainError('prototype_player_not_found', 'Player não encontrado.');
    if (normalizeText(player.raca) !== 'humano') {
        domainError('prototype_requires_human', 'Protótipo é um sistema racial de Humano.', {
            race: player.raca || '-',
        });
    }

    const stats = await ensureCharacterStats(db, playerId);
    const stageKey = String(stats.stage_key || '').trim();
    const limit = prototypeLimitForStage(stageKey);
    if (limit === null) {
        domainError(
            'prototype_stage_unsupported',
            'O estágio atual não possui limite de Protótipo definido no cânone.',
            { stageKey }
        );
    }

    const active = await db.all(
        `SELECT * FROM clover_human_prototypes
         WHERE player_id = ? AND status = 'testing'
         ORDER BY created_at ASC, id ASC`,
        [playerId]
    );
    if (normalizedName && active.some((row) => row.normalized_name === normalizedName)) {
        domainError(
            'prototype_name_already_testing',
            'Já existe um Protótipo em teste com esse nome.',
            { normalizedName }
        );
    }

    return {
        stageKey,
        limit,
        activeCount: active.length,
        free: Math.max(0, limit - active.length),
        canCreate: active.length < limit,
    };
}

async function approvePrototypeEvaluation(db, input = {}) {
    const finalPayload = String(input.finalPayload || '');
    const parsed = parsePrototypeEvaluationSheet(finalPayload, { phase: 'final' });
    if (!parsed.ok) return parserFailure('invalid_prototype_final_sheet', parsed);

    try {
        return await resolveEvaluationSubmissionAtomic(db, {
            selector: input.selector,
            reviewerId: input.reviewerId,
            outcome: 'approved',
            finalPayload,
            domainMutator: async ({ db: txDb, submission, reviewerId }) => {
                if (submission.category !== 'prototype') {
                    domainError('evaluation_category_mismatch', 'A submissão não é de Protótipo.');
                }
                const capacity = await inspectPrototypeCapacity(
                    txDb,
                    submission.player_id,
                    parsed.data.normalizedName
                );
                if (!capacity.canCreate) {
                    domainError(
                        'prototype_capacity_full',
                        'O personagem atingiu o limite de Protótipos em teste.',
                        { capacity }
                    );
                }

                const inserted = await txDb.run(
                    `INSERT INTO clover_human_prototypes
                     (player_id, name, normalized_name, idea, defect, status,
                      approved_submission_id, created_by, metadata_json)
                     VALUES (?, ?, ?, ?, ?, 'testing', ?, ?, '{}')`,
                    [
                        submission.player_id,
                        parsed.data.name,
                        parsed.data.normalizedName,
                        parsed.data.idea,
                        parsed.data.defect,
                        submission.id,
                        reviewerId,
                    ]
                );
                const prototype = await txDb.get(
                    'SELECT * FROM clover_human_prototypes WHERE id = ?',
                    [inserted.lastID]
                );
                return { prototype, capacityBefore: capacity };
            },
        });
    } catch (error) {
        if (
            error instanceof PrototypeUniversalEvaluationError
            || error instanceof UniversalEvaluationError
        ) {
            return {
                ok: false,
                code: error.code,
                error: error.message,
                details: error.details || {},
            };
        }
        throw error;
    }
}

async function listHumanPrototypes(db, playerId, options = {}) {
    const statuses = options.includeClosed
        ? ['testing', 'completed', 'abandoned']
        : ['testing'];
    const placeholders = statuses.map(() => '?').join(',');
    return db.all(
        `SELECT * FROM clover_human_prototypes
         WHERE player_id = ? AND status IN (${placeholders})
         ORDER BY CASE status WHEN 'testing' THEN 0 ELSE 1 END, created_at ASC, id ASC`,
        [playerId, ...statuses]
    );
}

function renderPrototypeCard(prototype) {
    return [
        '*♧┃𝐏𝐑𝐎𝐓𝐎́𝐓𝐈𝐏𝐎 𖥔 𝐇𝐮𝐦𝐚𝐧𝐨*',
        '     ──  técnica em desenvolvimento  ──',
        '',
        `*𝐍𝐨𝐦𝐞:* ${prototype.name}`,
        '',
        '*𝐈𝐝𝐞𝐢𝐚:*',
        block(prototype.idea),
        '',
        '*𝐃𝐞𝐟𝐞𝐢𝐭𝐨:*',
        block(prototype.defect),
    ].join('\n');
}

module.exports = {
    PROTOTYPE_LIMITS,
    PrototypeUniversalEvaluationError,
    approvePrototypeEvaluation,
    getPrototypeEvaluationReviewSheet,
    inspectPrototypeCapacity,
    listHumanPrototypes,
    prototypeLimitForStage,
    renderPrototypeCard,
    renderPrototypeTemplate,
    submitPrototypeEvaluation,
};
