const UNIT_SECONDS = {
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
};

const MAX_LIFE_DURATION_SECONDS = 3650 * UNIT_SECONDS.d;

function parseLifeDuration(input) {
    const raw = String(input || '').trim().toLowerCase();
    const match = raw.match(/^([1-9]\d*)([mhd])$/);
    if (!match) {
        throw new Error('Tempo invalido. Use formatos como 30m, 2h, 1d ou 7d.');
    }

    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error('Tempo invalido. Use um inteiro positivo.');
    }

    const seconds = amount * UNIT_SECONDS[unit];
    if (!Number.isSafeInteger(seconds) || seconds > MAX_LIFE_DURATION_SECONDS) {
        throw new Error('Tempo invalido. Valor alto demais.');
    }

    return seconds;
}

function formatLifeDuration(seconds) {
    let remaining = Math.max(0, Number(seconds || 0));
    if (!Number.isFinite(remaining)) remaining = 0;
    remaining = Math.floor(remaining);

    const days = Math.floor(remaining / UNIT_SECONDS.d);
    remaining %= UNIT_SECONDS.d;
    const hours = Math.floor(remaining / UNIT_SECONDS.h);
    remaining %= UNIT_SECONDS.h;
    const minutes = Math.floor(remaining / UNIT_SECONDS.m);

    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (!parts.length) return '0m';
    return parts.join(' ');
}

module.exports = {
    MAX_LIFE_DURATION_SECONDS,
    formatLifeDuration,
    parseLifeDuration,
};
