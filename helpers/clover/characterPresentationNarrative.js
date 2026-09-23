'use strict';

const {
    cleanText,
    isAbsenceText,
    list,
    normalizedKey,
    presentFamily,
    record,
    sourceLabel,
    uniqueBy,
} = require('./characterPresentationCore');

const FIXED_SLOT_LABELS = Object.freeze({
    aptidao_comum: 'Aptidão Comum',
    marca_comum: 'Marca Comum',
    aptidao_rara: 'Aptidão Rara',
    marca_rara: 'Marca Rara',
    anomalia: 'Anomalia',
});

function traitRarity(slotKey) {
    if (slotKey === 'aptidao_rara' || slotKey === 'marca_rara') return 'rara';
    if (slotKey === 'aptidao_comum' || slotKey === 'marca_comum') return 'comum';
    return null;
}

function presentTrait(rawEntry, fallbackSlotKey = null) {
    const entry = record(rawEntry);
    const trait = record(entry.trait);
    const slotKey = cleanText(entry.slotKey ?? entry.slot_key ?? trait.slotKey ?? trait.slot_key ?? fallbackSlotKey);
    const name = cleanText(
        trait.name
        ?? trait.nome
        ?? entry.value
        ?? entry.valueText
        ?? entry.value_text
        ?? entry.name
        ?? entry.title
    );
    if (!name || isAbsenceText(name, 'trait')) return null;

    const metadata = record(trait.metadata);
    return {
        slotKey,
        label: slotKey
            ? (FIXED_SLOT_LABELS[slotKey] || (slotKey === 'extra_anomaly' ? 'Anomalia Extra' : 'Traço Extra'))
            : null,
        name,
        description: cleanText(trait.description ?? entry.description ?? entry.body),
        effect: cleanText(trait.effectText ?? trait.effect_text ?? entry.effect ?? entry.effectText),
        restrictions: cleanText(
            trait.restrictionsText
            ?? trait.restrictions_text
            ?? entry.restrictions
            ?? entry.restrictionsText
        ),
        rarity: traitRarity(slotKey),
        kind: cleanText(trait.traitKind ?? trait.trait_kind ?? entry.kind),
        image: cleanText(metadata.imageUrl ?? metadata.image_url ?? trait.imageUrl ?? entry.imageUrl),
        source: sourceLabel(entry.source ?? trait.source, entry.assignment ? 'catalog' : 'legacy'),
        hasDescription: Boolean(cleanText(trait.description ?? entry.description ?? entry.body)),
    };
}

function presentHook(rawEntry) {
    const entry = record(rawEntry);
    const title = cleanText(entry.title ?? entry.name ?? entry.nome ?? entry.label);
    if (!title || isAbsenceText(title, 'hook')) return null;
    return {
        title,
        body: cleanText(entry.body ?? entry.description ?? entry.descricao ?? entry.text),
        source: sourceLabel(entry.source, 'legacy'),
    };
}

function presentIdentity(playerInput, bonusInput) {
    const player = record(playerInput);
    const bonus = record(bonusInput);
    const identity = record(bonus.identity);
    const family = presentFamily(bonus.family ?? bonus.familia ?? player.family ?? player.familia);

    return {
        name: cleanText(
            player.personagem_nome
            ?? player.characterName
            ?? player.display_name
            ?? player.nome
            ?? identity.name
        ) || 'Personagem',
        image: cleanText(
            player.site_profile_image_data
            ?? player.personagem_aparencia_image_path
            ?? player.profileImage
        ),
        kingdom: cleanText(identity.kingdom ?? player.reino ?? player.kingdom),
        race: cleanText(identity.race ?? player.raca ?? player.race),
        socialClass: cleanText(identity.socialClass ?? player.classe ?? player.className),
        family,
        magic: cleanText(identity.magic ?? player.magia ?? player.magic),
        grimoire: cleanText(identity.grimoire ?? player.grimorio ?? player.grimoire),
        rank: cleanText(player.patente ?? player.rank),
    };
}

function presentNarrative(traitOverviewInput, bonusInput) {
    const overview = record(traitOverviewInput);
    const bonusTraits = record(record(bonusInput).traits);

    const fixedTraits = list(overview.slots).map((entry) => presentTrait(entry)).filter(Boolean);
    if (!fixedTraits.length) {
        const fallbacks = [
            ['aptidao_comum', bonusTraits.aptitude ?? bonusTraits.aptidao],
            ['marca_comum', bonusTraits.mark ?? bonusTraits.marca],
            ['anomalia', bonusTraits.anomaly ?? bonusTraits.anomalia],
        ];
        for (const [slotKey, value] of fallbacks) {
            const trait = presentTrait({ value: record(value).label ?? value, trait: value }, slotKey);
            if (trait) fixedTraits.push(trait);
        }
    }

    const extraTraits = [
        ...list(overview.extraTraits),
        ...list(overview.customTraits),
        ...list(overview.systemTraitReferences),
    ].map((entry) => presentTrait(entry, 'extra_trait')).filter(Boolean);

    const extraAnomalies = list(overview.extraAnomalies)
        .map((entry) => presentTrait(entry, 'extra_anomaly'))
        .filter(Boolean);

    const hooks = [
        ...list(overview.hooks),
        ...list(overview.narrativeHooks),
    ].map(presentHook).filter(Boolean);

    const bonusHook = cleanText(bonusTraits.hook ?? bonusTraits.gancho ?? bonusTraits.narrativeHook);
    if (bonusHook && !isAbsenceText(bonusHook, 'hook')) {
        hooks.push({ title: bonusHook, body: null, source: 'bonus_summary' });
    }

    return {
        fixedTraits: uniqueBy(fixedTraits, (item) => `${item.slotKey || ''}:${normalizedKey(item.name)}`),
        extraTraits: uniqueBy(extraTraits, (item) => normalizedKey(item.name)),
        extraAnomalies: uniqueBy(extraAnomalies, (item) => normalizedKey(item.name)),
        hooks: uniqueBy(hooks, (item) => normalizedKey(item.title)),
        narrativeItems: list(overview.narrativeItems)
            .map((entry) => {
                const item = record(entry);
                const title = cleanText(item.title ?? item.name);
                return title && !isAbsenceText(title, 'narrative_item') ? {
                    title,
                    body: cleanText(item.body ?? item.description),
                    source: sourceLabel(item.source, 'content'),
                } : null;
            })
            .filter(Boolean),
    };
}

module.exports = {
    presentHook,
    presentIdentity,
    presentNarrative,
    presentTrait,
};
