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

function publicUnavailableText(label, text, key) {
    if (key.includes('formas criadas') && key.includes('precisa comprar criacao')) {
        return `${label}: comprar a base da Árvore de Criação`;
    }
    if (key.includes('reforco corporal') && key.includes('precisa comprar reforco')) {
        return `${label}: comprar a base da Árvore de Reforço`;
    }
    if (key.includes('progressao fisica comprada') && key.includes('precisa comprar fisico')) {
        return `${label}: comprar a base da Árvore Física`;
    }
    if (key.includes('tecnicas de mana compradas')) return null;
    if (key.includes('ki livre')) {
        return `${label}: o uso de Ki exige requisitos, treino e aprovação narrativa`;
    }
    if (key.includes('zetten livre')) {
        return `${label}: o uso de Zetten exige Ki, Força Aplicada III, Precisão Técnica III e aprovação narrativa`;
    }
    if (key.includes('bonus fisico em magia criada')) {
        return `${label}: bônus físicos não se aplicam a magia criada, projéteis mágicos, mana pura, Reforço mágico, cura ou antimagia`;
    }
    if (key.includes('efeitos especiais que pertencem ao tipo de magia')) {
        return `${label}: efeitos especiais continuam vinculados ao tipo de magia, Criação ou Reforço`;
    }
    return `${label}: ${text}`;
}

function classifyUnavailable(label, value) {
    const text = cleanText(value);
    if (!text) return null;
    const key = normalizedKey(text);
    if (key.includes('isso sera sistema separado')) return null;

    const presented = publicUnavailableText(label, text, key);
    if (!presented) return null;
    if (
        key.includes('bonus fisico em magia criada')
        || key.includes('efeitos especiais que pertencem ao tipo de magia')
    ) {
        return { bucket: 'limit', text: presented };
    }
    if (
        key.includes('aprovar tecnica automaticamente')
        || key.includes('adm ainda decide')
    ) {
        return { bucket: 'supervision', text: presented };
    }
    return { bucket: 'unlock', text: presented };
}

function uniqueTexts(values) {
    return uniqueBy(
        values.map((text) => ({ text })),
        (item) => normalizedKey(item.text)
    ).map((item) => item.text);
}

function cleanSupervisionNode(value) {
    const text = cleanText(value);
    if (!text) return null;
    return text
        .replace(/^Árvore de\s+/i, '')
        .replace(/\s*\([^)]*\)\s*$/, '')
        .trim() || null;
}

function supervisionIdentity(value) {
    return normalizedKey(cleanSupervisionNode(value));
}

function isSupervisedName(name, capacity) {
    const key = normalizedKey(name);
    if (!key) return false;
    return [
        ...textList(capacity.approvalNodes),
        ...textList(capacity.highRiskNodes),
    ].some((entry) => supervisionIdentity(entry).includes(key));
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
    const unlockRequirements = [];
    const currentLimits = [];
    const supervisionWarnings = [];

    for (const [sectionKey, label, section] of sections) {
        sectionEntries(section, 'can').forEach((text) => practicalAbilities.push(`${label}: ${text}`));
        sectionEntries(section, 'buffs').forEach((text) => practicalAbilities.push(`${label}: ${text}`));

        if (sectionKey === 'suporte') {
            sectionEntries(section, 'ownedNames')
                .filter((name) => normalizedKey(name) !== normalizedKey(label))
                .filter((name) => !isSupervisedName(name, capacity))
                .forEach((name) => practicalAbilities.push(`${label}: ${name}`));
        }

        sectionEntries(section, 'cannot').forEach((value) => {
            const classified = classifyUnavailable(label, value);
            if (!classified) return;
            if (classified.bucket === 'limit') currentLimits.push(classified.text);
            if (classified.bucket === 'supervision') supervisionWarnings.push(classified.text);
            if (classified.bucket === 'unlock') unlockRequirements.push(classified.text);
        });
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

    const approvalNodes = textList(capacity.approvalNodes);
    const highRiskNodes = textList(capacity.highRiskNodes);
    const highRiskIdentities = new Set(highRiskNodes.map(supervisionIdentity).filter(Boolean));
    const publicHighRisk = highRiskNodes
        .map(cleanSupervisionNode)
        .filter(Boolean)
        .map((text) => `${text}: uso de alto risco e sujeito à decisão narrativa.`);
    const publicApproval = approvalNodes
        .filter((value) => !highRiskIdentities.has(supervisionIdentity(value)))
        .map(cleanSupervisionNode)
        .filter(Boolean)
        .map((text) => `${text}: exige aprovação narrativa.`);

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
        practicalAbilities: uniqueTexts(practicalAbilities),
        unlockRequirements: uniqueTexts(unlockRequirements),
        currentLimits: uniqueTexts([...explicitLimits, ...currentLimits]),
        supervisionWarnings: uniqueTexts([
            ...supervisionWarnings,
            ...publicHighRisk,
            ...publicApproval,
        ]),
        trees,
    };
}

module.exports = {
    presentCapabilities,
    presentProgression,
};
