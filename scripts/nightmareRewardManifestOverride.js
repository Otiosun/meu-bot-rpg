'use strict';

const { PLAYER_MANIFEST } = require('./applyNightmareEventRewards');

function digits(value) {
    return String(value || '').replace(/\D/g, '');
}

const CANONICAL_NAMES_BY_PHONE = Object.freeze({
    '5521965870936': 'Kame Van Rothtaylor',
    '5521965939731': 'Majin Kenny',
    '5585921560915': 'Fuyumura',
});

const applied = [];
for (const entry of PLAYER_MANIFEST) {
    const phone = digits(entry.phone);
    const canonicalName = CANONICAL_NAMES_BY_PHONE[phone];
    if (!canonicalName) continue;
    entry.characterName = canonicalName;
    applied.push(phone);
}

const expected = Object.keys(CANONICAL_NAMES_BY_PHONE);
const missing = expected.filter((phone) => !applied.includes(phone));
if (missing.length) {
    throw new Error(`Manifesto do Evento Pesadelo não contém os telefones canônicos: ${missing.join(', ')}`);
}

module.exports = {
    CANONICAL_NAMES_BY_PHONE,
};
