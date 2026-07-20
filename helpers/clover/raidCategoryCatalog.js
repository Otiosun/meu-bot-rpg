'use strict';

const { RaidServiceError } = require('./raidServiceBase');

const CATEGORY_DEFINITIONS = Object.freeze([
    Object.freeze({
        key: 'saga_pessoal',
        label: 'Saga pessoal',
        description: 'Arco ou raid centrada no desenvolvimento de um personagem principal.',
        aliases: ['saga pessoal', 'raid pessoal', 'arco pessoal', 'spin off', 'spin-off', 'spin_off'],
        scopeType: 'player',
        requiresPlayer: true,
        requiresSquad: false,
        countsMonthly: true,
        limitEnv: 'CLOVER_RAID_LIMIT_SAGA_PESSOAL',
        defaultMonthlyLimit: 1,
        rewardSource: 'spin_off',
    }),
    Object.freeze({
        key: 'missao_desenvolvimento',
        label: 'Missão de desenvolvimento',
        description: 'Missão individual ou de pequeno grupo ligada ao avanço narrativo de um personagem.',
        aliases: [
            'missao', 'missão', 'missao comum', 'missão comum', 'investigacao', 'investigação',
            'sobrevivencia', 'sobrevivência', 'missao de desenvolvimento',
            'missão de desenvolvimento', 'desenvolvimento',
        ],
        scopeType: 'player',
        requiresPlayer: true,
        requiresSquad: false,
        countsMonthly: true,
        limitEnv: 'CLOVER_RAID_LIMIT_MISSAO_DESENVOLVIMENTO',
        defaultMonthlyLimit: 1,
        rewardSource: 'missao_desenvolvimento',
    }),
    Object.freeze({
        key: 'missao_esquadrao',
        label: 'Missão de esquadrão',
        description: 'Operação oficial vinculada ao histórico e ao limite mensal de um esquadrão.',
        aliases: ['missao de esquadrao', 'missão de esquadrão', 'missao esquadrao', 'missão esquadrão'],
        scopeType: 'squad',
        requiresPlayer: false,
        requiresSquad: true,
        countsMonthly: true,
        limitEnv: 'CLOVER_RAID_LIMIT_MISSAO_ESQUADRAO',
        defaultMonthlyLimit: 1,
        rewardSource: 'missao_esquadrao',
    }),
    Object.freeze({
        key: 'treino_esquadrao',
        label: 'Treino de esquadrão',
        description: 'Treino coletivo oficial que utiliza o limite mensal do esquadrão.',
        aliases: ['treino de esquadrao', 'treino de esquadrão', 'treino esquadrao', 'treino esquadrão'],
        scopeType: 'squad',
        requiresPlayer: false,
        requiresSquad: true,
        countsMonthly: true,
        limitEnv: 'CLOVER_RAID_LIMIT_TREINO_ESQUADRAO',
        defaultMonthlyLimit: 1,
        rewardSource: 'treino_esquadrao',
    }),
    Object.freeze({
        key: 'evento_especial',
        label: 'Evento especial',
        description: 'Calamidade, torneio ou ação geral que não consome modalidade mensal comum.',
        aliases: ['evento', 'evento especial', 'torneio', 'calamidade', 'raid de evento'],
        scopeType: 'global',
        requiresPlayer: false,
        requiresSquad: false,
        countsMonthly: false,
        limitEnv: null,
        defaultMonthlyLimit: null,
        rewardSource: 'evento',
    }),
]);

function normalizeCategoryText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function configuredRaidMonthlyLimit(definition) {
    if (!definition.countsMonthly) return null;
    const configured = Number(process.env[definition.limitEnv]);
    return Number.isInteger(configured) && configured > 0
        ? configured
        : definition.defaultMonthlyLimit;
}

function serializeRaidCategory(definition) {
    return {
        key: definition.key,
        label: definition.label,
        description: definition.description,
        scopeType: definition.scopeType,
        requiresPlayer: definition.requiresPlayer,
        requiresSquad: definition.requiresSquad,
        countsMonthly: definition.countsMonthly,
        monthlyLimit: configuredRaidMonthlyLimit(definition),
        rewardSource: definition.rewardSource,
    };
}

function getRaidCategoryCatalog() {
    return CATEGORY_DEFINITIONS.map(serializeRaidCategory);
}

function resolveDamagedLegacyCategory(compact) {
    if (
        compact.startsWith('investiga')
        || compact.startsWith('sobreviv')
        || compact.startsWith('miss_o')
    ) {
        return CATEGORY_DEFINITIONS[1];
    }
    if (
        compact.startsWith('evento')
        || compact.startsWith('torneio')
        || compact.startsWith('calamidade')
    ) {
        return CATEGORY_DEFINITIONS[4];
    }
    return null;
}

function resolveRaidCategory(value) {
    const normalized = normalizeCategoryText(value || 'missao_desenvolvimento');
    const compact = normalized.replace(/\s+/g, '_');
    const definition = CATEGORY_DEFINITIONS.find((entry) => (
        entry.key === compact
        || entry.aliases.some((alias) => normalizeCategoryText(alias) === normalized)
    )) || resolveDamagedLegacyCategory(compact);
    if (!definition) {
        throw new RaidServiceError(
            'invalid_raid_category',
            'Escolha uma categoria oficial de raid.',
            { categories: getRaidCategoryCatalog() }
        );
    }
    return definition;
}

function raidMonthKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: process.env.CLOVER_RAID_TIMEZONE || 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
    });
    const parts = Object.fromEntries(
        formatter.formatToParts(safeDate)
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}`;
}

module.exports = {
    CATEGORY_DEFINITIONS,
    configuredRaidMonthlyLimit,
    getRaidCategoryCatalog,
    raidMonthKey,
    resolveRaidCategory,
    serializeRaidCategory,
};
