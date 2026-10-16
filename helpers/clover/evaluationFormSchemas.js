'use strict';

const { normalizeText } = require('../textUtils');
const { parseStructuredForm } = require('./structuredFormParser');

const SPELL_TYPES = Object.freeze(['Criação', 'Reforço', 'Suporte', 'Misto']);

function normalizeKey(value) {
    return normalizeText(String(value || '').replace(/[*_`~]/g, ' '))
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeEntityName(value) {
    return normalizeKey(value)
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function normalizeSpellName(value) {
    return normalizeEntityName(value);
}

function normalizePrototypeName(value) {
    return normalizeEntityName(value);
}

function tidyText(value) {
    const text = String(value || '').trim();
    if (text === '🔒' || normalizeKey(text) === 'adm') return '-';
    return text;
}

function parsePositiveVersion(value) {
    const raw = normalizeKey(value);
    const matches = raw.match(/\d+/g) || [];
    if (matches.length !== 1) {
        const error = new Error('Versão precisa conter um único número positivo, como v1.');
        error.code = 'INVALID_VERSION';
        throw error;
    }

    const version = Number(matches[0]);
    if (!Number.isInteger(version) || version <= 0) {
        const error = new Error('Versão precisa ser um número positivo.');
        error.code = 'INVALID_VERSION';
        throw error;
    }
    return version;
}

function normalizeSpellType(value) {
    const key = normalizeKey(value);
    if (!key) {
        const error = new Error(`Tipo precisa ser ${SPELL_TYPES.join(' / ')}.`);
        error.code = 'INVALID_SPELL_TYPE';
        throw error;
    }

    const candidates = [];
    if (/(^|\s)criacao(\s|$)/.test(key)) candidates.push('Criação');
    if (/(^|\s)reforco(\s|$)/.test(key)) candidates.push('Reforço');
    if (/(^|\s)suporte(\s|$)/.test(key)) candidates.push('Suporte');
    if (/(^|\s)(misto|hibrido)(\s|$)/.test(key)) candidates.push('Misto');

    const unique = [...new Set(candidates)];
    if (unique.length !== 1) {
        const error = new Error(unique.length > 1
            ? `Escolha apenas um Tipo: ${SPELL_TYPES.join(' / ')}.`
            : `Tipo precisa ser ${SPELL_TYPES.join(' / ')}.`);
        error.code = unique.length > 1 ? 'AMBIGUOUS_SPELL_TYPE' : 'INVALID_SPELL_TYPE';
        throw error;
    }

    return unique[0];
}

function nonLocked(value) {
    return typeof value === 'string'
        ? Boolean(value.trim()) && value.trim() !== '-'
        : value !== null && value !== undefined;
}

const spellEvaluationSchema = Object.freeze({
    key: 'spell',
    anchorField: 'name',
    repeatedFormMinFields: 4,
    defaultPhase: 'intake',
    required: Object.freeze({
        intake: Object.freeze(['name', 'type', 'version', 'effect']),
        final: Object.freeze(['name', 'type', 'version', 'cost', 'reach', 'duration', 'effect', 'limits']),
    }),
    fields: Object.freeze({
        name: Object.freeze({
            label: 'Nome do feitiço',
            aliases: Object.freeze(['Nome', 'Feitiço', 'Feitico', 'Nome do feitico']),
            transform: tidyText,
            isPresent: nonLocked,
        }),
        type: Object.freeze({
            label: 'Tipo',
            aliases: Object.freeze(['Categoria']),
            transform: normalizeSpellType,
            isPresent: nonLocked,
        }),
        version: Object.freeze({
            label: 'Versão',
            aliases: Object.freeze(['Versao', 'Versão atual', 'Versao atual']),
            transform: parsePositiveVersion,
        }),
        cost: Object.freeze({
            label: 'Custo',
            aliases: Object.freeze(['Gasto']),
            transform: tidyText,
            isPresent: nonLocked,
        }),
        reach: Object.freeze({
            label: 'Alcance',
            aliases: Object.freeze(['Distância', 'Distancia']),
            transform: tidyText,
            isPresent: nonLocked,
        }),
        duration: Object.freeze({
            label: 'Duração',
            aliases: Object.freeze(['Duracao']),
            transform: tidyText,
            isPresent: nonLocked,
        }),
        effect: Object.freeze({
            label: 'Descrição',
            aliases: Object.freeze(['Efeito', 'Descricao', 'Descrição do efeito', 'Descricao do efeito']),
            transform: tidyText,
            isPresent: nonLocked,
        }),
        limits: Object.freeze({
            label: 'Limites',
            aliases: Object.freeze(['Limite', 'Fraqueza', 'Fraquezas']),
            transform: tidyText,
            isPresent: nonLocked,
        }),
        admNotes: Object.freeze({
            label: 'Notas ADM',
            aliases: Object.freeze(['Nota ADM', 'Notas', 'Observação', 'Observacao', 'Observações', 'Observacoes']),
            transform: tidyText,
        }),
    }),
    postprocess(values) {
        return {
            ...values,
            normalizedName: normalizeSpellName(values.name),
        };
    },
});

const prototypeEvaluationSchema = Object.freeze({
    key: 'prototype',
    anchorField: 'name',
    repeatedFormMinFields: 2,
    defaultPhase: 'intake',
    required: Object.freeze({
        intake: Object.freeze(['name', 'idea']),
        final: Object.freeze(['name', 'idea', 'defect']),
    }),
    fields: Object.freeze({
        name: Object.freeze({
            label: 'Nome',
            aliases: Object.freeze(['Nome do protótipo', 'Nome do prototipo', 'Protótipo', 'Prototipo']),
            transform: tidyText,
            isPresent: nonLocked,
        }),
        idea: Object.freeze({
            label: 'Ideia',
            aliases: Object.freeze(['Proposta', 'Técnica', 'Tecnica']),
            transform: tidyText,
            isPresent: nonLocked,
        }),
        defect: Object.freeze({
            label: 'Defeito',
            aliases: Object.freeze(['Falha', 'Limitação', 'Limitacao']),
            transform: tidyText,
            isPresent: nonLocked,
        }),
    }),
    postprocess(values) {
        return {
            ...values,
            normalizedName: normalizePrototypeName(values.name),
        };
    },
});

function parseSpellEvaluationSheet(raw, options = {}) {
    return parseStructuredForm(raw, spellEvaluationSchema, options);
}

function parsePrototypeEvaluationSheet(raw, options = {}) {
    return parseStructuredForm(raw, prototypeEvaluationSchema, options);
}

module.exports = {
    SPELL_TYPES,
    normalizePrototypeName,
    normalizeSpellName,
    normalizeSpellType,
    parsePositiveVersion,
    parsePrototypeEvaluationSheet,
    parseSpellEvaluationSheet,
    prototypeEvaluationSchema,
    spellEvaluationSchema,
};
