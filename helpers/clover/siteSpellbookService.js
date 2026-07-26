const { listApprovedSpells } = require('./spellbookService');
const { getSpellCapacity } = require('./spellCapacityService');

function cleanText(value, fallback = '-') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function serializeSpellForSite(spell = {}, index = null) {
    return {
        id: Number(spell.id || 0),
        displayNumber: Number.isInteger(index) ? index + 1 : null,
        name: cleanText(spell.name, 'Feitiço sem nome'),
        version: Math.max(1, Number(spell.version || 1)),
        type: cleanText(spell.type),
        cost: cleanText(spell.cost),
        reach: cleanText(spell.reach),
        duration: cleanText(spell.duration),
        effect: cleanText(spell.effect),
        limits: cleanText(spell.limits),
        admNotes: cleanText(spell.adm_notes),
        createdAt: spell.created_at || null,
        updatedAt: spell.updated_at || null,
    };
}

async function getSiteSpellbook(db, playerId) {
    const spells = await listApprovedSpells(db, playerId);
    const capacity = await getSpellCapacity(db, playerId);
    return {
        playerId,
        total: spells.length,
        capacity,
        numberingPolicy: 'display_order_only',
        spells: spells.map(serializeSpellForSite),
    };
}

module.exports = {
    getSiteSpellbook,
    serializeSpellForSite,
};
