'use strict';

const { parseSpellEvaluationSheet } = require('./evaluationFormSchemas');
const { getSpellCapacity } = require('./spellCapacityService');
const {
    ensureSpellbookSchema,
    listApprovedSpells,
    saveSpell,
} = require('./spellbookService');
const {
    UniversalEvaluationError,
    createEvaluationSubmission,
    getEvaluationSubmission,
    resolveEvaluationSubmissionAtomic,
} = require('./universalEvaluationService');

class SpellUniversalEvaluationError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'SpellUniversalEvaluationError';
        this.code = code;
        this.details = details;
    }
}

const PLAYER_OWNED_FIELDS = new Set(['name', 'type', 'version', 'effect']);
const ADM_OWNED_FIELDS = Object.freeze(['cost', 'reach', 'duration', 'limits', 'admNotes']);

function block(value) {
    const text = String(value ?? '').trim() || '-';
    return text.split('\n').map((line) => `> ${line.trim() || '-'}`).join('\n');
}

function renderSpellReviewSheet(data = {}) {
    return [
        '♧┃FICHA DE FEITIÇO 𖥔 CLOVER MULTICOLOR',
        '     ── avaliação rápida do grimório ──',
        '',
        '_`─( ✓ )───── Identificação`_',
        '',
        '*Nome do feitiço:*',
        block(data.name),
        '*Tipo:*',
        block(data.type),
        '*Versão:*',
        `> v${Number(data.version || 1)}`,
        '',
        '_`─( ✦ )───── Uso`_',
        '',
        '*Custo:*',
        block(data.cost && data.cost !== '-' ? data.cost : '🔒'),
        '*Alcance:*',
        block(data.reach && data.reach !== '-' ? data.reach : '🔒'),
        '*Duração:*',
        block(data.duration && data.duration !== '-' ? data.duration : '🔒'),
        '',
        '_`─( ◆ )───── Efeito`_',
        '',
        '*Descrição:*',
        block(data.effect),
        '',
        '_`─( ◇ )───── Travas`_',
        '',
        '*Limites:*',
        block(data.limits && data.limits !== '-' ? data.limits : '🔒'),
        '*Notas ADM:*',
        block(data.admNotes && data.admNotes !== '-' ? data.admNotes : '🔒'),
    ].join('\n');
}

function parserFailure(code, parsed) {
    return {
        ok: false,
        code,
        errors: parsed?.errors || [],
    };
}

function adminOwnedFieldsFilled(data = {}) {
    return ADM_OWNED_FIELDS.filter((field) => {
        const value = data[field];
        return value !== undefined
            && value !== null
            && String(value).trim()
            && String(value).trim() !== '-';
    });
}

async function submitSpellEvaluation(db, input = {}) {
    const rawSheet = String(input.rawSheet || '');
    const parsed = parseSpellEvaluationSheet(rawSheet, { phase: 'intake' });
    if (!parsed.ok) return parserFailure('invalid_spell_intake_sheet', parsed);

    const forbidden = adminOwnedFieldsFilled(parsed.data);
    if (forbidden.length) {
        return {
            ok: false,
            code: 'spell_player_filled_adm_fields',
            fields: forbidden,
        };
    }

    const [capacity, spells] = await Promise.all([
        getSpellCapacity(db, input.playerId),
        listApprovedSpells(db, input.playerId),
    ]);
    const existing = spells.find(
        (spell) => spell.normalized_name === parsed.data.normalizedName
    ) || null;

    if (!existing && !capacity.canApproveNewSpell) {
        return {
            ok: false,
            code: 'spell_capacity_full',
            error: 'Você não possui slot disponível para um novo Feitiço. Use um Ticket de Feitiço para liberar +1 slot.',
            details: { capacity },
        };
    }

    const result = await createEvaluationSubmission(db, {
        category: 'spell',
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
            parsed_intake: Object.fromEntries(
                Object.entries(parsed.data).filter(([key]) => (
                    PLAYER_OWNED_FIELDS.has(key) || key === 'normalizedName'
                ))
            ),
        },
    });

    return {
        ...result,
        parsed: parsed.data,
    };
}

async function getSpellEvaluationReviewSheet(db, protocol) {
    const submission = await getEvaluationSubmission(db, protocol);
    if (!submission) return { ok: false, code: 'evaluation_submission_not_found' };
    if (submission.category !== 'spell') {
        return { ok: false, code: 'evaluation_category_mismatch', submission };
    }
    const parsed = parseSpellEvaluationSheet(submission.original_payload, { phase: 'intake' });
    if (!parsed.ok) {
        return {
            ok: false,
            code: 'stored_spell_payload_invalid',
            submission,
            errors: parsed.errors,
        };
    }
    return {
        ok: true,
        submission,
        parsed: parsed.data,
        sheet: renderSpellReviewSheet(parsed.data),
    };
}

function spellDomainError(code, message, details = {}) {
    throw new SpellUniversalEvaluationError(code, message, details);
}

async function prepareSpellDomain(db, submission, sheet) {
    if (submission.category !== 'spell') {
        spellDomainError('evaluation_category_mismatch', 'A submissão não é de Feitiço.');
    }

    const [capacity, spells] = await Promise.all([
        getSpellCapacity(db, submission.player_id),
        listApprovedSpells(db, submission.player_id),
    ]);
    const existing = spells.find((spell) => spell.normalized_name === sheet.normalizedName) || null;

    if (!existing) {
        if (Number(sheet.version) !== 1) {
            spellDomainError(
                'new_spell_must_start_v1',
                'Um Feitiço novo precisa começar na versão v1.',
                { receivedVersion: sheet.version }
            );
        }
        if (!capacity.canApproveNewSpell) {
            spellDomainError(
                'spell_capacity_full',
                'O personagem não possui slot disponível para um novo Feitiço.',
                { capacity }
            );
        }
    } else {
        const expectedVersion = Number(existing.version) + 1;
        if (Number(sheet.version) !== expectedVersion) {
            spellDomainError(
                'spell_version_must_follow_latest',
                `A próxima versão precisa ser v${expectedVersion}.`,
                {
                    latestVersion: Number(existing.version),
                    expectedVersion,
                    receivedVersion: Number(sheet.version),
                }
            );
        }
    }

    return { capacity, existing };
}

async function approveSpellEvaluation(db, input = {}) {
    const finalPayload = String(input.finalPayload || '');
    const parsed = parseSpellEvaluationSheet(finalPayload, { phase: 'final' });
    if (!parsed.ok) return parserFailure('invalid_spell_final_sheet', parsed);

    // O schema do grimório é preparado fora do lock da fila universal.
    await ensureSpellbookSchema(db);

    try {
        return await resolveEvaluationSubmissionAtomic(db, {
            selector: input.selector,
            reviewerId: input.reviewerId,
            outcome: 'approved',
            finalPayload,
            domainMutator: async ({ db: txDb, submission, reviewerId }) => {
                const prepared = await prepareSpellDomain(txDb, submission, parsed.data);
                const saved = await saveSpell(
                    txDb,
                    submission.player_id,
                    parsed.data,
                    reviewerId,
                    { nextVersion: false }
                );
                if (!saved.ok) {
                    spellDomainError('spell_save_failed', 'Não foi possível salvar o Feitiço.', {
                        saveResult: saved,
                    });
                }
                return {
                    spell: saved.spell,
                    mode: prepared.existing ? 'updated' : 'created',
                    capacityBefore: prepared.capacity,
                    createsNewSpellSlot: !prepared.existing,
                };
            },
        });
    } catch (error) {
        if (error instanceof SpellUniversalEvaluationError || error instanceof UniversalEvaluationError) {
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

async function denySpellEvaluation(db, input = {}) {
    try {
        return await resolveEvaluationSubmissionAtomic(db, {
            selector: input.selector || input.protocol,
            reviewerId: input.reviewerId,
            outcome: 'denied',
            reason: input.reason,
            domainMutator: async ({ submission }) => {
                if (submission.category !== 'spell') {
                    spellDomainError('evaluation_category_mismatch', 'A submissão não é de Feitiço.');
                }
                return null;
            },
        });
    } catch (error) {
        if (error instanceof SpellUniversalEvaluationError || error instanceof UniversalEvaluationError) {
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

module.exports = {
    ADM_OWNED_FIELDS,
    SpellUniversalEvaluationError,
    approveSpellEvaluation,
    denySpellEvaluation,
    getSpellEvaluationReviewSheet,
    renderSpellReviewSheet,
    submitSpellEvaluation,
};