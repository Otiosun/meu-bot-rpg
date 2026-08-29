'use strict';

const { loadCloverConfigs } = require('./configLoader');
const {
    FINAL_FUTURE_SACRIFICE_ROLL_NUMBER,
    normalFutureRolls,
} = require('./preResetFutureRollService');
const { getFutureSlotAvailability } = require('./preResetFutureSlotService');

const KINGDOM_ORDER = ['clover', 'heart', 'diamond', 'spade'];

function usableRolls(rows = []) {
    const final = rows.find((row) => Number(row.roll_number) === FINAL_FUTURE_SACRIFICE_ROLL_NUMBER);
    return final ? [final] : normalFutureRolls(rows);
}

function slotText(availability) {
    if (!availability?.limited) return '[livre]';
    return `[${availability.usedCount}/${availability.capacity}${availability.ok ? '' : ' · esgotado'}]`;
}

function remainingText(availability) {
    if (!availability?.limited) return 'livre';
    if (!availability.ok) return 'esgotado';
    return availability.remaining === 1 ? '1 vaga restante' : `${availability.remaining} vagas restantes`;
}

function familyFitsRoll(family, roll) {
    return Boolean(roll)
        && (family.kingdomKeys || []).includes(roll.kingdom_key)
        && (family.socialClassKeys || []).includes(roll.social_class_key);
}

async function availabilityFor(db, category, item) {
    return getFutureSlotAvailability(db, category, item.key);
}

async function renderPreResetFamiliesAvailability(db, rows = []) {
    const config = loadCloverConfigs();
    const rolls = usableRolls(rows);
    const families = config.lists.families;
    const lines = [
        '*♧┃PRE_RESET · FAMÍLIAS E VAGAS*',
        '',
        'As contagens abaixo são do *universo futuro* e incluem personagens MANTER + reservas futuras já válidas.',
        'Consultar não ocupa vaga; a vaga é conferida e segurada no envio válido da Ficha Nova.',
        '',
        `*Seus rolls considerados:* ${rolls.length}.`,
    ];

    const noFamily = families.find((family) => family.key === 'sem_linhagem');
    if (noFamily) {
        lines.push('', `• *${noFamily.name}* [livre] · sempre permitida`);
    }

    for (const kingdomKey of KINGDOM_ORDER) {
        const kingdom = config.maps.kingdoms.get(kingdomKey);
        const group = families.filter((family) =>
            family.key !== 'sem_linhagem' && (family.kingdomKeys || [])[0] === kingdomKey
        );
        if (!group.length) continue;

        lines.push('', `── ${String(kingdom?.name || kingdomKey).toUpperCase()} ──`);
        for (const family of group) {
            const availability = await availabilityFor(db, 'family', family);
            const compatibleCount = rolls.filter((roll) => familyFitsRoll(family, roll)).length;
            const state = rolls.length
                ? compatibleCount
                    ? `compatível com ${compatibleCount} ${compatibleCount === 1 ? 'roll' : 'rolls'}`
                    : 'não compatível com seus rolls'
                : 'sorteie para verificar compatibilidade';
            const classes = (family.socialClassKeys || [])
                .map((key) => config.maps.socialClasses.get(key)?.name || key)
                .join(', ');
            lines.push(`• *${family.name}* ${slotText(availability)} · ${state}`);
            lines.push(`  ↳ ${classes || 'classe livre'} · ${remainingText(availability)}`);
        }
    }

    return lines.join('\n');
}

async function renderPreResetRacesAvailability(db) {
    const config = loadCloverConfigs();
    const lines = [
        '*♧┃PRE_RESET · RAÇAS E VAGAS*',
        '',
        'Raça sai no roll. As vagas abaixo são as vagas reais do universo futuro.',
        '',
    ];

    for (const race of config.lists.races) {
        const availability = await availabilityFor(db, 'race', race);
        const kingdoms = Object.keys(race.weightsByKingdom || {})
            .map((key) => config.maps.kingdoms.get(key)?.name || key)
            .join(', ');
        lines.push(`• *${race.name}* ${slotText(availability)} · ${remainingText(availability)}`);
        lines.push(`  ↳ Pode sair em: ${kingdoms || 'N/A'}`);
    }

    return lines.join('\n');
}

async function renderPreResetGrimoiresAvailability(db) {
    const config = loadCloverConfigs();
    const lines = [
        '*♧┃PRE_RESET · GRIMÓRIOS E VAGAS*',
        '',
        'Grimório sai no roll. As vagas abaixo são as vagas reais do universo futuro.',
    ];

    for (const kingdomKey of KINGDOM_ORDER) {
        const kingdom = config.maps.kingdoms.get(kingdomKey);
        const group = config.lists.grimoires.filter((item) => item.kingdomKey === kingdomKey);
        if (!group.length) continue;
        lines.push('', `── ${String(kingdom?.name || kingdomKey).toUpperCase()} ──`);

        for (const grimoire of group) {
            if (grimoire.rollEnabled === false) {
                lines.push(`• *${grimoire.name}* [não sorteável no roll normal]`);
                continue;
            }
            const availability = await availabilityFor(db, 'grimoire', grimoire);
            const chance = Number.isFinite(Number(grimoire.chance)) ? ` · ${Number(grimoire.chance)}% no pool do reino` : '';
            lines.push(`• *${grimoire.name}* ${slotText(availability)} · ${remainingText(availability)}${chance}`);
        }
    }

    return lines.join('\n');
}

async function renderPreResetAnomaliesAvailability(db) {
    const config = loadCloverConfigs();
    const lines = [
        '*♧┃PRE_RESET · ANOMALIAS E VAGAS*',
        '',
        'Anomalia só pode ser usada após sucesso em tentativa de Anomalia. A vaga é do universo futuro.',
        '',
    ];

    for (const anomaly of config.lists.anomalies) {
        const availability = await availabilityFor(db, 'anomaly', anomaly);
        lines.push(`• *${anomaly.name}* ${slotText(availability)} · ${remainingText(availability)}`);
    }

    return lines.join('\n');
}

function stripLegacySlotCounters(text) {
    return String(text || '')
        .replace(/\s*`\[(?:\d+\/\d+)(?: · esgotado)?\]`/g, '')
        .replace(/\s*\[(?:\d+\/\d+)(?: · esgotado)?\]/g, '')
        .replace(/\s*`\((?:\d+\/\d+)(?: · esgotado)?\)`/g, '')
        .replace(/\s*\((?:\d+\/\d+)(?: · esgotado)?\)/g, '');
}

module.exports = {
    renderPreResetAnomaliesAvailability,
    renderPreResetFamiliesAvailability,
    renderPreResetGrimoiresAvailability,
    renderPreResetRacesAvailability,
    slotText,
    stripLegacySlotCounters,
    usableRolls,
};
