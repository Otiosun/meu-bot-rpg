'use strict';

const {
    cleanText,
    normalizedKey,
    numberValue,
    record,
    textList,
    uniqueBy,
} = require('./characterPresentationCore');

function presentProgression(capacityInput, bonusInput) {
    const capacity = record(capacityInput);
    const bonus = record(bonusInput);
    const ph = record(capacity.ph);
    const stats = record(capacity.stats);
    const attributes = record(capacity.attributes);
    const hexagon = record(capacity.hexagon);
    const limits = record(capacity.limits);
    const reserve = record(bonus.reserve ?? bonus.reserva);
    const mana = record(bonus.mana);

    return {
        stage: cleanText(capacity.stageName ?? capacity.stage ?? stats.stageName),
        ph: {
            available: numberValue(ph.phAvailable, ph.ph_available, ph.disponivel, ph.available) ?? 0,
            accumulated: numberValue(ph.phAccumulated, ph.ph_accumulated, ph.acumulado, ph.total) ?? 0,
        },
        mana: {
            total: numberValue(capacity.manaTotal, mana.total),
            reserveAmount: numberValue(reserve.amount, reserve.valor),
            reservePercent: numberValue(reserve.percent, reserve.porcentagem),
        },
        attributes: {
            strength: numberValue(attributes.forca, attributes.strength) ?? 0,
            speed: numberValue(attributes.velocidade, attributes.speed) ?? 0,
            agility: numberValue(attributes.agilidade, attributes.agility) ?? 0,
            resistance: numberValue(attributes.resistencia, attributes.resistance, attributes.endurance) ?? 0,
            magicPower: numberValue(
                capacity.poderMagico,
                attributes.poder_magico,
                attributes.poderMagico,
                attributes.magic_power
            ) ?? 0,
            pbTotal: numberValue(stats.pb_total, stats.pbTotal) ?? 0,
            pbFree: numberValue(stats.pb_free, stats.pbFree, stats.pontos_livres) ?? 0,
        },
        hexagon: {
            perception: numberValue(hexagon.percepcao, hexagon.perception) ?? 1,
            retention: numberValue(hexagon.retencao, hexagon.retention) ?? 1,
            emission: numberValue(hexagon.emissao, hexagon.emission) ?? 1,
            control: numberValue(hexagon.controle, hexagon.control) ?? 1,
            pressure: numberValue(hexagon.pressao, hexagon.pressure) ?? 1,
            range: numberValue(hexagon.alcance, hexagon.range) ?? 1,
            labels: {
                perception: cleanText(limits.percepcaoLabel),
                retention: cleanText(limits.duracaoLabel),
                emission: cleanText(limits.emissaoLabel),
                control: cleanText(limits.controleLabel),
                pressure: cleanText(limits.pressaoBonus),
                range: cleanText(limits.alcanceLabel),
                area: cleanText(limits.areaLabel),
            },
        },
    };
}

function sectionEntries(sectionInput, key) {
    return textList(record(sectionInput)[key]);
}

function presentCapabilities(capacityInput) {
    const capacity = record(capacityInput);
    const summary = record(capacity.summary);
    const sections = [
        ['criacao', 'Criação', capacity.creation],
        ['reforco', 'Reforço', capacity.reinforcement],
        ['mana', 'Mana', capacity.mana],
        ['fisico', 'Físico', capacity.physical],
        ['suporte', 'Suporte', capacity.support],
    ];

    const practicalAbilities = [];
    const currentLimits = [];
    for (const [, label, section] of sections) {
        sectionEntries(section, 'can').forEach((text) => practicalAbilities.push(`${label}: ${text}`));
        sectionEntries(section, 'buffs').forEach((text) => practicalAbilities.push(`${label}: ${text}`));
        sectionEntries(section, 'cannot').forEach((text) => currentLimits.push(`${label}: ${text}`));
    }

    const limits = record(capacity.limits);
    const explicitLimits = [
        cleanText(limits.alcanceLabel) ? `Alcance comum: ${cleanText(limits.alcanceLabel)}.` : null,
        cleanText(limits.areaLabel) ? `Área comum: ${cleanText(limits.areaLabel)}.` : null,
        cleanText(limits.duracaoLabel) ? `Duração comum: ${cleanText(limits.duracaoLabel)}.` : null,
        cleanText(limits.controleLabel) ? `Controle: ${cleanText(limits.controleLabel)}.` : null,
        cleanText(limits.emissaoLabel) ? `Emissão: ${cleanText(limits.emissaoLabel)}.` : null,
        cleanText(limits.percepcaoLabel) ? `Percepção: ${cleanText(limits.percepcaoLabel)}.` : null,
    ].filter(Boolean);

    const trees = sections.map(([key, label, section]) => {
        const treeSummary = record(record(capacity.treeSummaries)[key]);
        return {
            key,
            label,
            summary: cleanText(summary[key] ?? record(section).summary ?? record(section).warning),
            ownedCount: numberValue(treeSummary.count) ?? textList(treeSummary.names).length,
            ownedNames: textList(treeSummary.names ?? record(section).ownedNames),
        };
    });

    return {
        headline: cleanText(summary.geral ?? summary.resumo ?? summary.summary ?? capacity.headline),
        practicalAbilities: uniqueBy(
            practicalAbilities.map((text) => ({ text })),
            (item) => normalizedKey(item.text)
        ).map((item) => item.text),
        currentLimits: uniqueBy(
            [...explicitLimits, ...currentLimits].map((text) => ({ text })),
            (item) => normalizedKey(item.text)
        ).map((item) => item.text),
        supervisionWarnings: uniqueBy([
            ...textList(capacity.approvalNodes).map((text) => `Exige aprovação narrativa: ${text}`),
            ...textList(capacity.highRiskNodes).map((text) => `Risco alto ou extremo: ${text}`),
        ].map((text) => ({ text })), (item) => normalizedKey(item.text)).map((item) => item.text),
        trees,
    };
}

module.exports = {
    presentCapabilities,
    presentProgression,
};
