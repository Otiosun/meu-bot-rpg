'use strict';

const CLOVER_TIME_ZONE = 'America/Maceio';

function toValidDate(value) {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new TypeError('Data inválida.');
    }
    return date;
}

function getZonedDateParts(value = new Date(), timeZone = CLOVER_TIME_ZONE) {
    const date = toValidDate(value);
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });
    const parts = Object.fromEntries(
        formatter.formatToParts(date)
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value])
    );

    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
        timeZone,
    };
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function formatDateKey(parts) {
    return `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function getCloverDateKey(value = new Date()) {
    return formatDateKey(getZonedDateParts(value, CLOVER_TIME_ZONE));
}

function isRealCalendarDate(year, month, day) {
    if (![year, month, day].every(Number.isInteger)) return false;
    if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;

    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

function parseStrictDateOnly(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return {
            ok: false,
            error: 'Use a data no formato AAAA-MM-DD.',
            value: null,
        };
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!isRealCalendarDate(year, month, day)) {
        return {
            ok: false,
            error: 'A data informada não existe no calendário.',
            value: null,
        };
    }

    return {
        ok: true,
        value: `${match[1]}-${match[2]}-${match[3]}`,
        parts: { year, month, day },
    };
}

module.exports = {
    CLOVER_TIME_ZONE,
    formatDateKey,
    getCloverDateKey,
    getZonedDateParts,
    isRealCalendarDate,
    parseStrictDateOnly,
};