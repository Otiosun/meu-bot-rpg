const { listApprovedSpells } = require('./spellbookService');

function cleanText(value, fallback = '-') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function serializeSpellForSite(spell = {}) {
    return {
        id: Number(spell.id || 0),
        name: cleanText(spell.name, 'Feitiço sem nome'),
        version: Math.max(1, Number(spell.version || 1)),
        type: cleanText(spell.type),
        cost: cleanText(spell.cost),
        reach: cleanText(spell.reach),
        duration: cleanText(spell.duration),
        effect: cleanText(spell.effect),
        limits: cleanText(spell.limits),
        admNotes: cleanText(spell.adm_notes),
        updatedAt: spell.updated_at || null,
    };
}

async function getSiteSpellbook(db, playerId) {
    const spells = await listApprovedSpells(db, playerId);
    return {
        playerId,
        total: spells.length,
        spells: spells.map(serializeSpellForSite),
    };
}

module.exports = {
    getSiteSpellbook,
    serializeSpellForSite,
};
