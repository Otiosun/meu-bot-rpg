'use strict';

const CATALOG_VERSION = 1;

function template(key, itemName, category, kind, basePrice, description, options = {}) {
    return Object.freeze({
        key,
        catalogVersion: CATALOG_VERSION,
        itemName,
        category,
        kind,
        basePrice,
        description,
        origin: options.origin || 'Clover',
        defaultQuality: options.defaultQuality || 'comum',
        defaultDurability: options.defaultDurability ?? null,
        stackable: Boolean(options.stackable),
        transferable: options.transferable !== false,
        properties: options.properties || {},
        effects: options.effects || {},
        metadata: options.metadata || {},
    });
}

const ITEM_TEMPLATES = Object.freeze([
    template('kit_campo', 'Kit de Campo', 'kit', 'kit', 850, 'Tocha, cantil, corda e ferramentas comuns para uma missão.', { stackable: true }),
    template('kit_viagem', 'Kit de Viagem', 'kit', 'kit', 1500, 'Preparo básico para missão que anuncie jornada ou pernoite.', { stackable: true }),
    template('kit_investigacao', 'Kit de Investigação', 'kit', 'kit', 2000, 'Materiais para registrar, preservar e organizar pistas físicas.', { stackable: true }),
    template('kit_primeiros_socorros', 'Kit de Primeiros Socorros', 'kit', 'consumivel_comum', 300, 'Estanca sangramento simples e impede piora imediata de lesão leve; um uso.', { stackable: true }),
    template('kit_escalada', 'Kit de Escalada', 'kit', 'kit', 1200, 'Corda reforçada, ancoragem e ferramentas para travessia vertical.', { stackable: true }),

    template('pocao_antidoto', 'Antídoto', 'consumivel', 'consumivel_comum', 5000, 'Remove veneno comum recente; um uso.', { origin: 'Heart', stackable: true, effects: { effectKey: 'antidoto', category: 'tratamento', removes: ['veneno_comum'] } }),
    template('pocao_cura_basica', 'Poção de Cura Básica', 'consumivel', 'consumivel_comum', 5000, 'Trata uma lesão leve e sangramento simples; uma por cena.', { origin: 'Heart', stackable: true, effects: { effectKey: 'cura_basica', category: 'tratamento', treats: ['lesao_leve', 'sangramento_simples'], limit: 'uma_por_cena' } }),
    template('pocao_cura_avancada', 'Poção de Cura Avançada', 'consumivel', 'consumivel_comum', 8800, 'Trata uma lesão moderada ou duas leves; uma por missão.', { origin: 'Heart', stackable: true, effects: { effectKey: 'cura_avancada', category: 'tratamento', treats: ['lesao_moderada', 'duas_lesoes_leves'], limit: 'uma_por_missao' } }),
    template('pocao_cura_extraordinaria', 'Poção de Cura Extraordinária', 'consumivel', 'consumivel_comum', 18500, 'Estabiliza lesão grave; não apaga sequela ou consequência de trama.', { origin: 'Heart', stackable: true, effects: { effectKey: 'cura_extraordinaria', category: 'tratamento', treats: ['estabilizacao_grave'] } }),
    template('pocao_mana', 'Poção de Mana', 'consumivel', 'consumivel_comum', 5000, 'Remove Cansado por esforço mágico ou reduz Exausto; uma por missão.', { origin: 'Heart', stackable: true, effects: { effectKey: 'recuperacao_mana', category: 'tratamento', removes: ['cansado_magico'], reduces: ['exausto'], limit: 'uma_por_missao' } }),
    template('pocao_forca', 'Poção de Força', 'consumivel', 'consumivel_comum', 5000, '+10% de Força por um turno; respeita o limite alquímico.', { origin: 'Heart', stackable: true, effects: { effectKey: 'forca_10', category: 'aprimoramento_fisico', attribute: 'forca', percent: 10, durationTurns: 1, missionLimit: 2 } }),
    template('pocao_resistencia', 'Poção de Resistência', 'consumivel', 'consumivel_comum', 5000, '+10% de Resistência por um turno; respeita o limite alquímico.', { origin: 'Heart', stackable: true, effects: { effectKey: 'resistencia_10', category: 'aprimoramento_fisico', attribute: 'resistencia', percent: 10, durationTurns: 1, missionLimit: 2 } }),
    template('pocao_agilidade', 'Poção de Agilidade', 'consumivel', 'consumivel_comum', 6000, '+10% de Agilidade por um turno; respeita o limite alquímico.', { origin: 'Heart', stackable: true, effects: { effectKey: 'agilidade_10', category: 'aprimoramento_fisico', attribute: 'agilidade', percent: 10, durationTurns: 1, missionLimit: 2 } }),
    template('pocao_velocidade', 'Poção de Velocidade', 'consumivel', 'consumivel_comum', 6100, '+10% de Velocidade por um turno; respeita o limite alquímico.', { origin: 'Heart', stackable: true, effects: { effectKey: 'velocidade_10', category: 'aprimoramento_fisico', attribute: 'velocidade', percent: 10, durationTurns: 1, missionLimit: 2 } }),

    template('armadura_couro', 'Armadura de Couro', 'equipamento', 'equipamento', 3000, 'Armadura leve de defesa física básica.', { defaultDurability: 5 }),
    template('armadura_malha', 'Armadura de Malha', 'equipamento', 'equipamento', 8000, 'Armadura média contra corte e perfuração.', { origin: 'Diamond', defaultDurability: 5 }),
    template('armadura_half_plate', 'Half Plate', 'equipamento', 'equipamento', 18000, 'Armadura média de proteção ampla.', { origin: 'Diamond', defaultDurability: 5 }),
    template('armadura_full_plate', 'Full Plate', 'equipamento', 'equipamento', 30000, 'Armadura pesada de proteção mundana máxima.', { origin: 'Diamond', defaultDurability: 5 }),
    template('escudo_mao', 'Escudo de Mão', 'equipamento', 'equipamento', 3500, 'Escudo leve de cobertura pequena.', { defaultDurability: 5 }),
    template('escudo_guerra', 'Escudo de Guerra', 'equipamento', 'equipamento', 8500, 'Escudo médio de cobertura consistente.', { defaultDurability: 5 }),
    template('escudo_torre', 'Escudo Torre', 'equipamento', 'equipamento', 20000, 'Escudo pesado de cobertura ampla.', { origin: 'Diamond', defaultDurability: 5 }),
    template('bastao', 'Bastão', 'equipamento', 'equipamento', 800, 'Bastão físico de duas mãos.', { origin: 'Comum', defaultDurability: 5 }),
    template('adaga', 'Adaga', 'equipamento', 'equipamento', 1200, 'Arma mundana leve.', { defaultDurability: 5 }),
    template('machado_mao', 'Machado de Mão', 'equipamento', 'equipamento', 1500, 'Arma mundana de uma mão.', { origin: 'Diamond', defaultDurability: 5 }),
    template('azagaia', 'Azagaia', 'equipamento', 'equipamento', 1800, 'Arma mundana de arremesso.', { defaultDurability: 5 }),
    template('lanca_caca', 'Lança de Caça', 'equipamento', 'equipamento', 2000, 'Lança mundana para caça.', { defaultDurability: 5 }),
    template('arco_caca', 'Arco de Caça', 'equipamento', 'equipamento', 2500, 'Arco mundano de caça.', { defaultDurability: 5 }),
    template('espada_curta', 'Espada Curta', 'equipamento', 'equipamento', 2500, 'Espada mundana curta.', { defaultDurability: 5 }),
    template('rapieira', 'Rapieira', 'equipamento', 'equipamento', 3500, 'Arma mundana de precisão.', { defaultDurability: 5 }),
    template('sabre', 'Sabre', 'equipamento', 'equipamento', 3500, 'Sabre mundano.', { defaultDurability: 5 }),
    template('espada_longa', 'Espada Longa', 'equipamento', 'equipamento', 4000, 'Espada mundana longa.', { defaultDurability: 5 }),
    template('maca', 'Maça', 'equipamento', 'equipamento', 4000, 'Arma mundana de impacto.', { origin: 'Diamond', defaultDurability: 5 }),
    template('besta', 'Besta', 'equipamento', 'equipamento', 4500, 'Besta mundana.', { origin: 'Diamond', defaultDurability: 5 }),
    template('estrela_manha', 'Estrela da Manhã', 'equipamento', 'equipamento', 5000, 'Arma mundana de impacto.', { origin: 'Diamond', defaultDurability: 5 }),
    template('arco_guerra', 'Arco de Guerra', 'equipamento', 'equipamento', 5000, 'Arco mundano de guerra.', { defaultDurability: 5 }),
    template('lanca_guerra', 'Lança de Guerra', 'equipamento', 'equipamento', 5500, 'Lança mundana de guerra.', { defaultDurability: 5 }),
    template('alabarda', 'Alabarda', 'equipamento', 'equipamento', 6000, 'Arma pesada de haste.', { defaultDurability: 5 }),
    template('machado_guerra', 'Machado de Guerra', 'equipamento', 'equipamento', 6000, 'Machado pesado de guerra.', { origin: 'Diamond', defaultDurability: 5 }),
    template('martelo_guerra', 'Martelo de Guerra', 'equipamento', 'equipamento', 6500, 'Martelo pesado de guerra.', { origin: 'Diamond', defaultDurability: 5 }),
    template('espada_grande', 'Espada Grande', 'equipamento', 'equipamento', 7000, 'Espada mundana de duas mãos.', { defaultDurability: 5 }),
    template('varinha_basica', 'Varinha Básica', 'equipamento', 'equipamento', 2000, 'Catalisador mágico leve com +5% de Poder Mágico.', { defaultDurability: 5, effects: { category: 'catalisador', attribute: 'poder_magico', percent: 5 } }),
    template('cajado_basico', 'Cajado Básico', 'equipamento', 'equipamento', 4500, 'Catalisador de duas mãos com +5% de alcance mágico.', { defaultDurability: 5, effects: { category: 'catalisador', attribute: 'alcance_magico', percent: 5 } }),
    template('varinha_magica', 'Varinha Mágica', 'equipamento', 'equipamento', 10000, 'Catalisador mágico leve com +10% de Poder Mágico.', { defaultDurability: 5, effects: { category: 'catalisador', attribute: 'poder_magico', percent: 10 } }),
    template('bastao_magico', 'Bastão Mágico', 'equipamento', 'equipamento', 15000, 'Catalisador de duas mãos com +10% de alcance mágico.', { defaultDurability: 5, effects: { category: 'catalisador', attribute: 'alcance_magico', percent: 10 } }),
    template('vassoura_simples', 'Vassoura Simples', 'equipamento', 'equipamento', 5000, 'Voo pessoal e deslocamento aéreo; +10% de Velocidade em voo.', { defaultDurability: 5, effects: { category: 'mobilidade_aerea', velocidadePercent: 10 } }),
    template('vassoura_luxuosa', 'Vassoura Luxuosa', 'equipamento', 'equipamento', 15000, 'Passageiro, carga leve e estabilidade; +20% de Velocidade em voo.', { defaultDurability: 5, effects: { category: 'mobilidade_aerea', velocidadePercent: 20, passenger: true } }),
    template('vassoura_corrida', 'Vassoura de Corrida', 'equipamento', 'equipamento', 30000, 'Perseguição e velocidade aérea; +30% de Velocidade em voo.', { defaultDurability: 5, effects: { category: 'mobilidade_aerea', velocidadePercent: 30, racing: true } }),

    template('roupas_comuns', 'Roupas Comuns', 'vestimenta', 'vestimenta', 200, 'Uso cotidiano.'),
    template('roupas_aventureiro', 'Roupas de Aventureiro', 'vestimenta', 'vestimenta', 500, 'Bolsos e reforços para campo; sem bônus de combate.'),
    template('roupas_inverno', 'Roupas de Inverno', 'vestimenta', 'vestimenta', 800, 'Atendem exigência comum de frio quando anunciada.'),
    template('traje_formal', 'Traje Formal', 'vestimenta', 'vestimenta', 1500, 'Adequado para solenidade, audiência ou infiltração social.'),
    template('roupas_nobres', 'Roupas Nobres', 'vestimenta', 'vestimenta', 5000, 'Artigo de luxo; não concede título ou acesso automático.'),

    template('tratamento_leve_npc', 'Tratamento Leve', 'servico', 'servico_npc', 2000, 'Cuida de lesão leve e complicação comum; aplicação narrativa registrada.', { transferable: false, effects: { category: 'tratamento_npc', treats: ['lesao_leve', 'complicacao_comum'], narratorApplies: true } }),
    template('tratamento_moderado_npc', 'Tratamento Moderado', 'servico', 'servico_npc', 5800, 'Cuida de lesão moderada e acompanhamento; aplicação narrativa registrada.', { transferable: false, effects: { category: 'tratamento_npc', treats: ['lesao_moderada'], narratorApplies: true } }),
    template('estabilizacao_grave_npc', 'Estabilização Grave', 'servico', 'servico_npc', 14500, 'Impede piora imediata; não remove consequência de trama.', { transferable: false, effects: { category: 'tratamento_npc', treats: ['estabilizacao_grave'], narratorApplies: true } }),

    template('ticket_feitico', 'Ticket de Feitiço', 'consumivel', 'ticket_feitico', 0, 'Ticket vinculado para o fluxo de feitiços.', { stackable: true, transferable: false }),
    template('cupom_prioridade', 'Cupom de Prioridade', 'consumivel', 'cupom_pa', 0, 'Concede prioridade permitida no fluxo de feitiços; não garante aprovação.', { stackable: true, transferable: false }),
    template('vale_compra_2000', 'Vale de Compra — 2.000¥', 'consumivel', 'vale_compra', 2000, 'Abate até 2.000¥ de uma compra válida; sem troco.', { stackable: true, transferable: false }),
    template('vale_reparo_5000', 'Vale-Reparo — até 5.000¥', 'consumivel', 'vale_reparo', 5000, 'Abate até 5.000¥ de um reparo; sem troco.', { stackable: true, transferable: false }),
    template('acesso_missao_especial', 'Acesso a Missão Especial', 'missao', 'acesso_missao', 0, 'Abre uma oportunidade de missão especial; não garante vitória ou recompensa máxima.', { stackable: true, transferable: false }),
    template('titulo_temporada_comum', 'Título Comum da Temporada', 'titulo', 'titulo', 0, 'Desbloqueio visual comum da temporada.', { transferable: false }),
    template('titulo_temporada_especial', 'Título Especial da Temporada', 'titulo', 'titulo', 0, 'Desbloqueio visual especial da temporada.', { transferable: false }),
    template('item_exclusivo_temporada', 'Relíquia Exclusiva da Temporada', 'reliquia', 'item_temporada', 0, 'Item colecionável exclusivo da temporada atual. Não concede vantagem automática de combate.', { transferable: false }),
    template('box_simple_v1', 'Caixa Simples', 'caixa', 'caixa_economia', 0, 'Caixa da Economia V1 com probabilidades públicas e independentes.', { stackable: true, transferable: false }),
    template('box_royal_v1', 'Caixa Real', 'caixa', 'caixa_retorno_pending', 0, 'Caixa Real fechada. Abertura pendente da loot table canonica.', { stackable: true, transferable: false }),
    template('box_rare_v1', 'Caixa Rara', 'caixa', 'caixa_economia', 0, 'Caixa rara da Economia V1 com probabilidades públicas e independentes.', { stackable: true, transferable: false }),
]);

const ITEM_TEMPLATE_MAP = new Map(ITEM_TEMPLATES.map((item) => [item.key, item]));

const POTION_POOL = Object.freeze([
    'pocao_antidoto', 'pocao_cura_basica', 'pocao_mana', 'pocao_forca',
    'pocao_resistencia', 'pocao_agilidade', 'pocao_velocidade',
]);
const KIT_POOL = Object.freeze([
    'kit_campo', 'kit_viagem', 'kit_investigacao', 'kit_primeiros_socorros', 'kit_escalada',
]);
const EQUIPMENT_UNDER_5000_POOL = Object.freeze(ITEM_TEMPLATES
    .filter((item) => item.category === 'equipamento' && item.basePrice <= 5000)
    .map((item) => item.key));
const SIMPLE_ITEM_UNDER_5000_POOL = Object.freeze(ITEM_TEMPLATES
    .filter((item) => item.basePrice > 0
        && item.basePrice <= 5000
        && ['kit', 'consumivel_comum', 'equipamento', 'vestimenta'].includes(item.kind))
    .map((item) => item.key));

function reward(key, label, chance, type, options = {}) {
    return Object.freeze({ key, label, chance, type, ...options });
}

const BOX_CATALOGS = Object.freeze({
    simples: Object.freeze({
        key: 'simples',
        templateKey: 'box_simple_v1',
        name: 'Caixa Simples',
        version: CATALOG_VERSION,
        rewards: Object.freeze([
            reward('yulls_1000_2000', '1.000¥ a 2.000¥', 20, 'yulls', { min: 1000, max: 2000, step: 100 }),
            reward('yulls_2000_3000', '2.000¥ a 3.000¥', 10, 'yulls', { min: 2000, max: 3000, step: 100 }),
            reward('pocao_comum', 'Poção comum aleatória', 15, 'item_pool', { pool: POTION_POOL }),
            reward('kit_comum', 'Kit comum aleatório', 10, 'item_pool', { pool: KIT_POOL }),
            reward('item_ate_5000', 'Item aleatório de até 5.000¥', 8.8, 'item_pool', { pool: SIMPLE_ITEM_UNDER_5000_POOL }),
            reward('ph_5_10', '5 a 10 PH fora do teto', 10, 'ph', { min: 5, max: 10 }),
            reward('ph_10_20', '10 a 20 PH fora do teto', 5, 'ph', { min: 10, max: 20 }),
            reward('ticket_feitico', 'Ticket de Feitiço', 1, 'item', { templateKey: 'ticket_feitico' }),
            reward('caixa_simples_extra', 'Caixa Simples adicional', 8, 'item', { templateKey: 'box_simple_v1' }),
            reward('vale_compra_2000', 'Vale de Compra de 2.000¥', 7, 'item', { templateKey: 'vale_compra_2000', expiresInDays: 30 }),
            reward('titulo_comum', 'Título Comum da Temporada', 5, 'title', { templateKey: 'titulo_temporada_comum' }),
            reward('item_exclusivo_temporada', 'Relíquia Exclusiva da Temporada', 0.2, 'item', { templateKey: 'item_exclusivo_temporada' }),
        ]),
    }),
    rara: Object.freeze({
        key: 'rara',
        templateKey: 'box_rare_v1',
        name: 'Caixa Rara',
        version: CATALOG_VERSION,
        rewards: Object.freeze([
            reward('yulls_3000_5000', '3.000¥ a 5.000¥', 22, 'yulls', { min: 3000, max: 5000, step: 100 }),
            reward('yulls_5000_8000', '5.000¥ a 8.000¥', 10, 'yulls', { min: 5000, max: 8000, step: 100 }),
            reward('ph_10_15', '10 a 15 PH fora do teto', 20, 'ph', { min: 10, max: 15 }),
            reward('ph_15_30', '15 a 30 PH fora do teto', 8, 'ph', { min: 15, max: 30 }),
            reward('equipamento_ate_5000', 'Equipamento de até 5.000¥', 13, 'item_pool', { pool: EQUIPMENT_UNDER_5000_POOL }),
            reward('vale_reparo_5000', 'Vale-Reparo de até 5.000¥', 10, 'item', { templateKey: 'vale_reparo_5000', expiresInDays: 30 }),
            reward('pocao_comum', 'Poção comum aleatória', 11, 'item_pool', { pool: POTION_POOL }),
            reward('ticket_feitico', 'Ticket de Feitiço', 4, 'item', { templateKey: 'ticket_feitico' }),
            reward('titulo_especial', 'Título Especial da Temporada', 1.3, 'title', { templateKey: 'titulo_temporada_especial' }),
            reward('item_exclusivo_temporada', 'Relíquia Exclusiva da Temporada', 0.7, 'item', { templateKey: 'item_exclusivo_temporada' }),
        ]),
    }),
});

function getTemplate(templateKey) {
    return ITEM_TEMPLATE_MAP.get(String(templateKey || '').trim()) || null;
}

function getBoxCatalog(boxKey) {
    return BOX_CATALOGS[String(boxKey || '').trim().toLowerCase()] || null;
}

function validateBoxCatalogs() {
    return Object.values(BOX_CATALOGS).map((box) => ({
        key: box.key,
        totalChance: box.rewards.reduce((sum, item) => sum + Number(item.chance || 0), 0),
        rewardCount: box.rewards.length,
    }));
}

module.exports = {
    BOX_CATALOGS,
    CATALOG_VERSION,
    ITEM_TEMPLATES,
    getBoxCatalog,
    getTemplate,
    validateBoxCatalogs,
};
