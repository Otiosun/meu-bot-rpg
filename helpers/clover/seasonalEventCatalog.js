'use strict';

const { ensureCloverInventorySchema } = require('../../database');
const { ITEM_TEMPLATES: BASE_ITEM_TEMPLATES, getTemplate: getBaseTemplate } = require('./economyItemCatalog');

const SEASONAL_CATALOG_VERSION = 3;

function template(key, itemName, category, kind, description, options = {}) {
    return Object.freeze({
        key,
        catalogVersion: SEASONAL_CATALOG_VERSION,
        itemName,
        category,
        kind,
        basePrice: Number(options.basePrice || 0),
        description,
        origin: options.origin || 'Evento de Divulgação',
        defaultQuality: options.defaultQuality || 'comum',
        defaultDurability: options.defaultDurability ?? null,
        stackable: Boolean(options.stackable),
        transferable: options.transferable === true,
        properties: options.properties || {},
        effects: options.effects || {},
        metadata: options.metadata || {},
    });
}

const RELIC_TEMPLATES = Object.freeze([
    template('reliquia_susanoo', 'Susanoo', 'reliquia', 'reliquia_temporada', 'Relíquia exclusiva da temporada. Só pode existir um portador global.', { metadata: { uniqueGlobal: true, seasonalRelic: true } }),
    template('reliquia_egide_espelho_esmeralda', 'Égide do Espelho Esmeralda', 'reliquia', 'reliquia_temporada', 'Relíquia exclusiva da temporada. Só pode existir um portador global.', { metadata: { uniqueGlobal: true, seasonalRelic: true } }),
    template('reliquia_solem_lament', 'Solem & Lament', 'reliquia', 'reliquia_temporada', 'Relíquia exclusiva da temporada. Só pode existir um portador global.', { metadata: { uniqueGlobal: true, seasonalRelic: true } }),
    template('reliquia_rei_tesouros', 'Rei dos Tesouros', 'reliquia', 'reliquia_temporada', 'Relíquia exclusiva da temporada. Só pode existir um portador global.', { metadata: { uniqueGlobal: true, seasonalRelic: true } }),
    template('reliquia_falcao_ceus', 'Falcão dos Céus', 'reliquia', 'reliquia_temporada', 'Relíquia exclusiva da temporada. Só pode existir um portador global.', { metadata: { uniqueGlobal: true, seasonalRelic: true } }),
    template('reliquia_capa_itens_inuteis', 'Capa dos Itens (in)úteis', 'reliquia', 'reliquia_temporada', 'Relíquia exclusiva da temporada. Só pode existir um portador global.', { metadata: { uniqueGlobal: true, seasonalRelic: true } }),
]);

const EVENT_ITEM_TEMPLATES = Object.freeze([
    template('vale_compra_5000', 'Vale de Compra — até 5.000¥', 'consumivel', 'vale_compra', 'Abate até 5.000¥ de uma compra válida; sem troco.', { stackable: true, metadata: { expiresInDays: 30 } }),
    template('vale_reparo_7000', 'Vale-Reparo — até 7.000¥', 'consumivel', 'vale_reparo', 'Abate até 7.000¥ de um reparo válido; sem troco.', { stackable: true, metadata: { expiresInDays: 30 } }),
    template('titulo_recrutador', 'Título de Recrutador', 'titulo', 'titulo', 'Título permanente da campanha de recrutamento. Compra única por player.'),
    template(
        'acesso_dungeon_exclusiva',
        'Passe da Dungeon Exclusiva',
        'missao',
        'acesso_dungeon',
        'Passe pessoal guardado no inventário. Garante uma vaga na Dungeon Exclusiva do evento e não pode ser vendido, anunciado, trocado ou transferido.',
        {
            stackable: false,
            transferable: false,
            properties: {
                eventAccess: 'dungeon_exclusiva',
                bound: true,
                sellable: false,
                tradable: false,
            },
            metadata: {
                eventAccess: true,
                bound: true,
                nonSellable: true,
                nonTransferable: true,
                eventGlobalStock: 8,
            },
        }
    ),
    ...RELIC_TEMPLATES,
]);

const EVENT_TEMPLATE_MAP = new Map(EVENT_ITEM_TEMPLATES.map((item) => [item.key, item]));
const RELIC_POOL = Object.freeze(RELIC_TEMPLATES.map((item) => item.key));

const POTION_POOL = Object.freeze([
    'pocao_antidoto', 'pocao_cura_basica', 'pocao_mana', 'pocao_forca',
    'pocao_resistencia', 'pocao_agilidade', 'pocao_velocidade',
]);
const KIT_POOL = Object.freeze([
    'kit_campo', 'kit_viagem', 'kit_investigacao', 'kit_primeiros_socorros', 'kit_escalada',
]);
const SIMPLE_ITEM_UNDER_5000_POOL = Object.freeze(BASE_ITEM_TEMPLATES
    .filter((item) => item.basePrice > 0
        && item.basePrice <= 5000
        && ['kit', 'consumivel_comum', 'equipamento', 'vestimenta'].includes(item.kind))
    .map((item) => item.key));
const EQUIPMENT_UNDER_7000_POOL = Object.freeze(BASE_ITEM_TEMPLATES
    .filter((item) => item.category === 'equipamento' && item.basePrice <= 7000)
    .map((item) => item.key));

function reward(key, label, chance, type, options = {}) {
    return Object.freeze({ key, label, chance, type, ...options });
}

const COMMON = Object.freeze({ pityTier: 'common', qualitySuccess: false });
const MID = Object.freeze({ pityTier: 'mid', qualitySuccess: false });
const HIGH = Object.freeze({ pityTier: 'high_non_relic', qualitySuccess: true });
const RELIC = Object.freeze({ pityTier: 'ultra_relic', qualitySuccess: true });

const BOX_CATALOGS = Object.freeze({
    simples: Object.freeze({
        key: 'simples',
        templateKey: 'box_simple_v1',
        name: 'Caixa Simples',
        version: SEASONAL_CATALOG_VERSION,
        rewards: Object.freeze([
            reward('yulls_1000_3000', '1.000¥ a 3.000¥', 25, 'yulls', { ...COMMON, min: 1000, max: 3000, step: 100 }),
            reward('yulls_3000_5000', '3.000¥ a 5.000¥', 10, 'yulls', { ...MID, min: 3000, max: 5000, step: 100 }),
            reward('pocao_comum', 'Poção comum aleatória', 7, 'item_pool', { ...COMMON, pool: POTION_POOL }),
            reward('kit_comum', 'Kit comum aleatório', 12, 'item_pool', { ...COMMON, pool: KIT_POOL }),
            reward('item_ate_5000', 'Item aleatório de até 5.000¥', 8.9, 'item_pool', { ...MID, pool: SIMPLE_ITEM_UNDER_5000_POOL }),
            reward('ph_5_10', '5 a 10 PH fora do teto', 10, 'ph', { ...MID, min: 5, max: 10 }),
            reward('ph_10_20', '10 a 20 PH fora do teto', 5, 'ph', { ...HIGH, min: 10, max: 20 }),
            reward('ticket_feitico', 'Ticket de Feitiço', 1, 'item', { ...HIGH, templateKey: 'ticket_feitico' }),
            reward('caixa_simples_extra', 'Outra Caixa Simples', 8, 'item', { ...MID, templateKey: 'box_simple_v1' }),
            reward('caixa_rara', 'Caixa Rara', 1, 'item', { ...HIGH, templateKey: 'box_rare_v1' }),
            reward('vale_compra_5000', 'Vale de Compra de até 5.000¥', 7, 'item', { ...MID, templateKey: 'vale_compra_5000', expiresInDays: 30 }),
            reward('titulo_comum', 'Título Comum da Temporada', 5, 'title', { ...HIGH, templateKey: 'titulo_temporada_comum' }),
            reward('reliquia_exclusiva', 'Relíquia Exclusiva da Temporada', 0.1, 'unique_relic_pool', { ...RELIC, pool: RELIC_POOL }),
        ]),
    }),
    rara: Object.freeze({
        key: 'rara',
        templateKey: 'box_rare_v1',
        name: 'Caixa Rara',
        version: SEASONAL_CATALOG_VERSION,
        rewards: Object.freeze([
            reward('yulls_3000_5000', '3.000¥ a 5.000¥', 24.8, 'yulls', { ...COMMON, min: 3000, max: 5000, step: 100 }),
            reward('yulls_5000_10000', '5.000¥ a 10.000¥', 10, 'yulls', { ...MID, min: 5000, max: 10000, step: 100 }),
            reward('ph_10_15', '10 a 15 PH fora do teto', 20, 'ph', { ...MID, min: 10, max: 15 }),
            reward('ph_15_30', '15 a 30 PH fora do teto', 8, 'ph', { ...HIGH, min: 15, max: 30 }),
            reward('equipamento_ate_7000', 'Equipamento de até 7.000¥', 13, 'item_pool', { ...MID, pool: EQUIPMENT_UNDER_7000_POOL }),
            reward('vale_reparo_7000', 'Vale-Reparo de até 7.000¥', 10, 'item', { ...MID, templateKey: 'vale_reparo_7000', expiresInDays: 30 }),
            reward('pocao_comum', 'Poção comum aleatória', 9, 'item_pool', { ...COMMON, pool: POTION_POOL }),
            reward('ticket_feitico', 'Ticket de Feitiço', 2, 'item', { ...HIGH, templateKey: 'ticket_feitico' }),
            reward('titulo_especial', 'Título Especial da Temporada', 1, 'title', { ...HIGH, templateKey: 'titulo_temporada_especial' }),
            reward('reliquia_exclusiva', 'Relíquia Exclusiva da Temporada', 0.2, 'unique_relic_pool', { ...RELIC, pool: RELIC_POOL }),
            reward('caixa_rara_extra', 'Outra Caixa Rara', 2, 'item', { ...HIGH, templateKey: 'box_rare_v1' }),
        ]),
    }),
});

function getSeasonalTemplate(templateKey) {
    return EVENT_TEMPLATE_MAP.get(String(templateKey || '').trim()) || null;
}

function getAnyTemplate(templateKey) {
    return getSeasonalTemplate(templateKey) || getBaseTemplate(templateKey);
}

function getBoxCatalog(boxKey) {
    return BOX_CATALOGS[String(boxKey || '').trim().toLowerCase()] || null;
}

function validateBoxCatalogs() {
    return Object.values(BOX_CATALOGS).map((box) => ({
        key: box.key,
        totalChance: Math.round(box.rewards.reduce((sum, item) => sum + Number(item.chance || 0), 0) * 10) / 10,
        rewardCount: box.rewards.length,
        tierTotals: box.rewards.reduce((totals, item) => {
            totals[item.pityTier] = Math.round(((totals[item.pityTier] || 0) + Number(item.chance || 0)) * 10) / 10;
            return totals;
        }, {}),
    }));
}

async function seedSeasonalEventTemplates(db) {
    await ensureCloverInventorySchema(db);
    for (const item of EVENT_ITEM_TEMPLATES) {
        const unique = Boolean(item.metadata?.uniqueGlobal);
        await db.run(
            `INSERT INTO clover_item_templates (
                template_key, catalog_version, item_name, description, category, kind, origin,
                base_price, default_quality, default_durability, stackable, transferable,
                properties_json, effects_json, metadata_json, active, is_custom, requestable,
                marketable, duplicable, created_by, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, ?, 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(template_key) DO UPDATE SET
                catalog_version = excluded.catalog_version,
                item_name = excluded.item_name,
                description = excluded.description,
                category = excluded.category,
                kind = excluded.kind,
                origin = excluded.origin,
                default_quality = excluded.default_quality,
                stackable = excluded.stackable,
                transferable = excluded.transferable,
                properties_json = excluded.properties_json,
                effects_json = excluded.effects_json,
                metadata_json = excluded.metadata_json,
                active = 1,
                marketable = 0,
                duplicable = excluded.duplicable,
                updated_at = CURRENT_TIMESTAMP`,
            [
                item.key, item.catalogVersion, item.itemName, item.description, item.category,
                item.kind, item.origin, item.basePrice, item.defaultQuality, item.defaultDurability,
                item.stackable ? 1 : 0, item.transferable ? 1 : 0,
                JSON.stringify(item.properties), JSON.stringify(item.effects), JSON.stringify(item.metadata),
                unique ? 0 : 1,
            ]
        );
    }

    await db.run(
        `UPDATE clover_inventory_items
         SET bound = 1, transferable = 0, updated_at = CURRENT_TIMESTAMP
         WHERE template_key = 'acesso_dungeon_exclusiva'`
    );
}

module.exports = {
    BOX_CATALOGS,
    EVENT_ITEM_TEMPLATES,
    RELIC_POOL,
    SEASONAL_CATALOG_VERSION,
    getAnyTemplate,
    getBoxCatalog,
    getSeasonalTemplate,
    seedSeasonalEventTemplates,
    validateBoxCatalogs,
};
