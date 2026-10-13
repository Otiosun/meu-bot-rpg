'use strict';

const { normalizeText } = require('../textUtils');

function normalizeFormLabel(value) {
    return normalizeText(String(value || '').replace(/[*_`~]/g, ' '))
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripQuotePrefix(value) {
    return String(value || '').replace(/^\s*(?:>\s*)+/, '').trimEnd();
}

function isQuotedValueLine(value) {
    return /^\s*>/.test(String(value || ''));
}

function isDecorativeLine(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    return text.startsWith('♧┃')
        || text.startsWith('──')
        || text.startsWith('_`─(')
        || text.includes('─────');
}

function splitPotentialFieldLine(value) {
    const line = stripQuotePrefix(value).trim();
    if (!line) return null;

    const colon = line.match(/^(.{1,80}?)[：:]\s*(.*)$/);
    if (colon) {
        return { label: colon[1], value: colon[2] };
    }

    const dash = line.match(/^([A-Za-zÀ-ÿ0-9 *_`~]{2,80}?)\s+-\s+(.*)$/);
    if (dash) {
        return { label: dash[1], value: dash[2] };
    }

    return null;
}

function normalizeSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        throw new TypeError('Schema de formulário inválido.');
    }

    const fields = schema.fields || {};
    const labelToField = new Map();

    for (const [fieldName, definition] of Object.entries(fields)) {
        const aliases = [definition.label || fieldName, ...(definition.aliases || [])];
        for (const alias of aliases) {
            const normalized = normalizeFormLabel(alias);
            if (!normalized) continue;
            const existing = labelToField.get(normalized);
            if (existing && existing !== fieldName) {
                throw new Error(`Alias de campo colidente no schema: ${alias}`);
            }
            labelToField.set(normalized, fieldName);
        }
    }

    return { ...schema, fields, labelToField };
}

function defaultIsPresent(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return Boolean(value.trim());
    return true;
}

function sameCanonicalValue(left, right) {
    if (typeof left === 'string' && typeof right === 'string') {
        return left.trim() === right.trim();
    }
    return JSON.stringify(left) === JSON.stringify(right);
}

function fieldLabel(schema, fieldName) {
    return schema.fields[fieldName]?.label || fieldName;
}

function requiredFieldsForPhase(schema, phase) {
    if (Array.isArray(schema.required)) return schema.required;
    return schema.required?.[phase] || [];
}

function detectMultipleForms(schema, events, requiredFields) {
    const anchor = schema.anchorField;
    if (!anchor) return false;

    const anchorIndexes = events
        .map((event, index) => event.field === anchor ? index : -1)
        .filter((index) => index >= 0);
    if (anchorIndexes.length < 2) return false;

    const threshold = Number(schema.repeatedFormMinFields)
        || Math.max(2, Math.ceil(Math.max(requiredFields.length, 2) / 2));
    let substantialSegments = 0;

    for (let i = 0; i < anchorIndexes.length; i += 1) {
        const start = anchorIndexes[i];
        const end = i + 1 < anchorIndexes.length ? anchorIndexes[i + 1] : events.length;
        const distinct = new Set(events.slice(start, end).map((event) => event.field));
        if (distinct.size >= threshold) substantialSegments += 1;
    }

    return substantialSegments >= 2;
}

function parseStructuredForm(rawInput, rawSchema, options = {}) {
    const schema = normalizeSchema(rawSchema);
    const phase = options.phase || schema.defaultPhase || 'intake';
    const raw = String(rawInput ?? '').replace(/\r\n?/g, '\n').trim();
    const warnings = [];
    const errors = [];
    const occurrences = new Map();
    const events = [];
    let current = null;

    function finishCurrent() {
        if (!current) return;
        while (current.lines.length && !String(current.lines[0]).trim()) current.lines.shift();
        while (current.lines.length && !String(current.lines[current.lines.length - 1]).trim()) current.lines.pop();
        const value = current.lines.join('\n').trim();
        const item = { field: current.field, value, line: current.line };
        if (!occurrences.has(current.field)) occurrences.set(current.field, []);
        occurrences.get(current.field).push(item);
        events.push(item);
        current = null;
    }

    const lines = raw ? raw.split('\n') : [];
    lines.forEach((line, zeroIndex) => {
        const lineNumber = zeroIndex + 1;

        if (current && isQuotedValueLine(line)) {
            current.lines.push(stripQuotePrefix(line));
            return;
        }

        if (isDecorativeLine(line)) {
            finishCurrent();
            return;
        }

        const parsed = splitPotentialFieldLine(line);
        if (parsed) {
            const normalizedLabel = normalizeFormLabel(parsed.label);
            const field = schema.labelToField.get(normalizedLabel);
            if (field) {
                finishCurrent();
                current = {
                    field,
                    line: lineNumber,
                    lines: parsed.value ? [stripQuotePrefix(parsed.value)] : [],
                };
                return;
            }

            // Um trecho desconhecido com ':' ou ' - ' não ganha semântica de
            // campo. Se já estamos dentro de um campo, ele é texto literal.
            if (current) {
                current.lines.push(stripQuotePrefix(line));
                return;
            }

            warnings.push({
                code: 'UNKNOWN_LABEL',
                label: parsed.label.replace(/[*_`~]/g, '').trim(),
                line: lineNumber,
            });
            return;
        }

        if (!current) return;
        current.lines.push(stripQuotePrefix(line));
    });
    finishCurrent();

    const values = {};
    for (const [fieldName, definition] of Object.entries(schema.fields)) {
        const items = occurrences.get(fieldName) || [];
        if (!items.length) continue;

        const transformed = [];
        for (const item of items) {
            try {
                const value = definition.transform
                    ? definition.transform(item.value, { phase, field: fieldName, schema })
                    : item.value;
                transformed.push({ ...item, value });
            } catch (error) {
                errors.push({
                    code: error?.code || 'INVALID_FIELD',
                    field: fieldName,
                    label: fieldLabel(schema, fieldName),
                    line: item.line,
                    message: error?.message || `${fieldLabel(schema, fieldName)} inválido.`,
                });
            }
        }

        if (!transformed.length) continue;
        const first = transformed[0].value;
        const conflicting = transformed.some((item) => !sameCanonicalValue(first, item.value));
        if (conflicting) {
            errors.push({
                code: 'CONFLICTING_DUPLICATE',
                field: fieldName,
                label: fieldLabel(schema, fieldName),
                message: `${fieldLabel(schema, fieldName)} aparece mais de uma vez com valores diferentes.`,
            });
            continue;
        }

        values[fieldName] = first;
    }

    const required = requiredFieldsForPhase(schema, phase);
    for (const fieldName of required) {
        const definition = schema.fields[fieldName] || {};
        const present = (definition.isPresent || defaultIsPresent)(values[fieldName]);
        if (present) continue;
        if (errors.some((error) => error.field === fieldName)) continue;
        errors.push({
            code: 'MISSING_FIELD',
            field: fieldName,
            label: fieldLabel(schema, fieldName),
            message: `${fieldLabel(schema, fieldName)} precisa ser preenchido.`,
        });
    }

    if (detectMultipleForms(schema, events, required)) {
        errors.push({
            code: 'MULTIPLE_FORMS',
            field: null,
            label: null,
            message: 'Envie apenas uma ficha por submissão.',
        });
    }

    let data = values;
    if (schema.postprocess) {
        try {
            data = schema.postprocess({ ...values }, { phase, raw, warnings, errors });
        } catch (error) {
            errors.push({
                code: error?.code || 'FORM_POSTPROCESS_ERROR',
                field: null,
                label: null,
                message: error?.message || 'Não consegui normalizar a ficha.',
            });
        }
    }

    return {
        ok: errors.length === 0,
        phase,
        raw,
        data,
        errors,
        warnings,
        recognizedFields: events.length,
        fieldOccurrences: Object.fromEntries(
            [...occurrences.entries()].map(([key, items]) => [key, items.map((item) => ({ ...item }))])
        ),
    };
}

module.exports = {
    normalizeFormLabel,
    parseStructuredForm,
    splitPotentialFieldLine,
};
