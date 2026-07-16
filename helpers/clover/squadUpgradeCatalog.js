'use strict';

const GRADE_MIN_STARS = Object.freeze({
    0: 0,
    1: 10,
    2: 25,
    3: 50,
    4: 85,
    5: 130,
    6: 200,
});

const CATEGORY_DEFINITIONS = Object.freeze({
    base_defesa: Object.freeze({ key: 'base_defesa', label: 'Base e Defesa', symbol: '♠' }),
    treino_preparo: Object.freeze({ key: 'treino_preparo', label: 'Treino e Preparo', symbol: '♣' }),
    pesquisa_magia: Object.freeze({ key: 'pesquisa_magia', label: 'Pesquisa e Magia', symbol: '♦' }),
    cura_recuperacao: Object.freeze({ key: 'cura_recuperacao', label: 'Cura e Recuperação', symbol: '♥' }),
    estrategia_logistica: Object.freeze({ key: 'estrategia_logistica', label: 'Estratégia e Logística', symbol: '♠' }),
    memoria_convivio: Object.freeze({ key: 'memoria_convivio', label: 'Memória e Convívio', symbol: '♥' }),
    autoridade_administracao: Object.freeze({ key: 'autoridade_administracao', label: 'Autoridade e Administração', symbol: '♦' }),
});

function upgrade(key, name, categoryKey, cost, requiredGrade, effect, options = {}) {
    return Object.freeze({
        key,
        name,
        categoryKey,
        categoryLabel: CATEGORY_DEFINITIONS[categoryKey].label,
        cost,
        requiredGrade,
        requiredHistoricalStars: GRADE_MIN_STARS[requiredGrade],
        prerequisites: Object.freeze([...(options.prerequisites || [])]),
        activation: options.activation || 'contextual',
        requiresApproval: options.requiresApproval === true,
        effect,
    });
}

const SQUAD_UPGRADES = Object.freeze([
    upgrade('mural_meritos', 'Mural de Méritos do Esquadrão', 'base_defesa', 0, 0, 'Registra feitos, membros, honras, Estrelas, Estrelas Negras e memórias.', { activation: 'passive_narrative' }),
    upgrade('posto_vigilancia', 'Posto de Vigilância do QG', 'base_defesa', 4, 1, 'Detecta movimentações suspeitas perto do QG; aviso antes de emboscadas.'),
    upgrade('barreira_defensiva', 'Barreira Defensiva do QG', 'base_defesa', 6, 1, 'Fortalece a defesa mágica: selos, alarmes e dificuldade de acesso.'),
    upgrade('selo_alarme_territorial', 'Selo de Alarme Territorial', 'base_defesa', 10, 2, 'Rede de alerta em pontos próximos. Revela presença hostil — não identifica tudo.', { prerequisites: ['posto_vigilancia'] }),
    upgrade('arsenal_contencao', 'Arsenal de Contenção', 'base_defesa', 12, 2, 'Correntes, talismãs, algemas e lacres. Não prende inimigo forte sem cena.'),
    upgrade('cela_contencao_magica', 'Cela de Contenção Mágica', 'base_defesa', 24, 4, 'Cela mágica para ameaças, prisioneiros ou entidades. Exige aprovação.', { requiresApproval: true }),

    upgrade('patio_treinamento', 'Pátio de Treinamento', 'treino_preparo', 4, 1, 'Cenas de treino mais organizadas; justifica UPs, testes físicos e duelos.'),
    upgrade('arena_duelo_controlado', 'Arena de Duelo Controlado', 'treino_preparo', 10, 2, 'Duelos internos com barreiras. Reduz ferimento grave em treinos.', { prerequisites: ['patio_treinamento'] }),
    upgrade('campo_treinamento_avancado', 'Campo de Treinamento Avançado', 'treino_preparo', 12, 2, 'Treinos complexos em grupo. 1×/semana com avaliação favorecida.', { activation: 'weekly_review' }),
    upgrade('sala_condicionamento_mana', 'Sala de Condicionamento de Mana', 'treino_preparo', 16, 3, 'Ambiente próprio para controle, emissão, retenção e resistência de mana.'),
    upgrade('simulador_combate_magico', 'Simulador de Combate Mágico', 'treino_preparo', 18, 3, 'Simula inimigos e padrões. Não dá vitória automática.', { prerequisites: ['campo_treinamento_avancado'] }),
    upgrade('observatorio_combate', 'Observatório de Combate', 'treino_preparo', 22, 4, 'Registra duelos, analisa erros e estuda técnicas em equipe.'),

    upgrade('arquivo_missoes', 'Arquivo de Missões', 'pesquisa_magia', 3, 1, 'Guarda relatórios, pistas, monstros vistos e feitiços conhecidos.'),
    upgrade('biblioteca_tatica', 'Biblioteca Tática', 'pesquisa_magia', 6, 1, 'Livros, relatórios e guias mágicos. Ajuda em pesquisas.'),
    upgrade('arquivo_reservado', 'Arquivo Reservado', 'pesquisa_magia', 14, 3, 'Textos raros. 1×/semana ajusta feitiço já aprovado. Não cria feitiço novo.', { prerequisites: ['biblioteca_tatica'], activation: 'weekly_review' }),
    upgrade('sala_runas_formulas', 'Sala de Runas e Fórmulas', 'pesquisa_magia', 16, 3, 'Estuda matrizes, círculos, selos e padrões de feitiço.', { prerequisites: ['biblioteca_tatica'] }),
    upgrade('laboratorio_pesquisa_magica', 'Laboratório de Pesquisa Mágica', 'pesquisa_magia', 18, 4, 'Analisa selos, maldições, grimórios estranhos e magias instáveis.'),
    upgrade('camara_grimorios_artefatos', 'Câmara de Grimórios e Artefatos', 'pesquisa_magia', 20, 4, 'Sala protegida para objetos mágicos sensíveis e livros raros.', { prerequisites: ['arquivo_reservado'] }),
    upgrade('observatorio_fenomenos_magicos', 'Observatório de Fenômenos Mágicos', 'pesquisa_magia', 20, 4, 'Monitora anomalias, dungeons e padrões climáticos mágicos.'),

    upgrade('enfermaria_qg', 'Enfermaria do QG', 'cura_recuperacao', 5, 1, 'Recupera ferimentos, cansaço e desastres. Não anula consequências graves.'),
    upgrade('estufa_ingredientes_magicos', 'Estufa de Ingredientes Mágicos', 'cura_recuperacao', 8, 2, 'Cultiva ingredientes para alquimia, poções e medicações.'),
    upgrade('banhos_termais_qg', 'Banhos Termais do QG', 'cura_recuperacao', 8, 2, 'Recuperação e descanso. Pode reduzir tempo OFF de ferimentos leves.'),
    upgrade('sala_triagem_pos_missao', 'Sala de Triagem Pós-Missão', 'cura_recuperacao', 10, 2, 'Avalia ferimentos, intoxicação, exaustão e maldições simples.', { prerequisites: ['enfermaria_qg'] }),
    upgrade('ala_recuperacao_magica', 'Ala de Recuperação Mágica', 'cura_recuperacao', 14, 3, 'Repouso prolongado, curandeiros e controle de mana instável.', { prerequisites: ['enfermaria_qg'] }),
    upgrade('jardim_ervas_raras', 'Jardim de Ervas Raras', 'cura_recuperacao', 18, 4, 'Plantas especiais e recursos de cura delicados. Receitas raras exigem missão.', { prerequisites: ['estufa_ingredientes_magicos'] }),

    upgrade('sala_mapas', 'Sala de Mapas', 'estrategia_logistica', 5, 1, 'Estuda rotas, vilas, fronteiras, dungeons e zonas de risco.'),
    upgrade('correio_missoes', 'Correio de Missões', 'estrategia_logistica', 6, 1, 'Organiza mensagens, relatórios, pedidos de vilas e avisos de campo.'),
    upgrade('deposito_suprimentos', 'Depósito de Suprimentos', 'estrategia_logistica', 8, 2, 'Guarda alimentos, ferramentas, mantos extras, mapas e itens de patrulha.'),
    upgrade('hangar_vassouras_transporte', 'Hangar de Vassouras e Transporte', 'estrategia_logistica', 10, 2, 'Organiza vassouras, carruagens e montarias. Facilita deslocamentos.'),
    upgrade('sala_estrategia', 'Sala de Estratégia', 'estrategia_logistica', 18, 3, 'Declarar plano antes da missão pode dar vantagem na primeira complicação.', { prerequisites: ['sala_mapas'] }),
    upgrade('circulo_transporte_espacial', 'Círculo de Transporte Espacial Selado', 'estrategia_logistica', 20, 4, 'Transporte entre pontos marcados. Exige recarga, limite e aprovação.', { requiresApproval: true }),

    upgrade('refeitorio_qg', 'Refeitório do QG', 'memoria_convivio', 6, 1, 'Convívio, cozinha e preparo. Bônus narrativos leves e temporários.'),
    upgrade('sala_reunioes_esquadrao', 'Sala de Reuniões do Esquadrão', 'memoria_convivio', 6, 1, 'Convocatórias, decisões internas, conselhos e planejamento de cenas.'),
    upgrade('alojamentos_ajustados', 'Alojamentos Ajustados', 'memoria_convivio', 8, 2, 'Melhora descanso, privacidade e rotina dos membros.'),
    upgrade('oficina_mantos_insignias', 'Oficina de Mantôs e Insígnias', 'memoria_convivio', 8, 2, 'Mantos, brasões, broches e identificações oficiais do esquadrão.'),
    upgrade('salao_honras_memorial', 'Salão de Honras / Memorial', 'memoria_convivio', 10, 2, 'Guarda memórias, troféus e nomes. Cenas de vínculo, trauma e segredos.'),

    upgrade('escritorio_capitao', 'Escritório do Capitão', 'autoridade_administracao', 8, 2, 'Organiza ordens, relatórios, convocações e decisões internas.'),
    upgrade('gabinete_relatorios', 'Gabinete de Relatórios', 'autoridade_administracao', 10, 2, 'Melhora registro de missões, Estrelas, falhas, gastos e testemunhos.', { prerequisites: ['arquivo_missoes'] }),
    upgrade('sala_audiencias_esquadrao', 'Sala de Audiências do Esquadrão', 'autoridade_administracao', 12, 3, 'Recebe vilões capturados, nobres, autoridades, civis e testemunhas.'),
    upgrade('posto_ligacao_capital', 'Posto de Ligação com a Capital', 'autoridade_administracao', 16, 3, 'Contato direto com a Ordem dos Cavaleiros, Capitães e Reino.'),
    upgrade('camara_julgamento_interno', 'Câmara de Julgamento Interno', 'autoridade_administracao', 22, 4, 'Apura abuso, falhas graves e conflitos internos antes do Parlamento.', { prerequisites: ['gabinete_relatorios'] }),
]);

const UPGRADE_BY_KEY = new Map(SQUAD_UPGRADES.map((item) => [item.key, item]));

function normalizeLookup(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getSquadUpgrade(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (UPGRADE_BY_KEY.has(raw)) return UPGRADE_BY_KEY.get(raw);
    if (/^\d{1,3}$/.test(raw)) return SQUAD_UPGRADES[Number(raw) - 1] || null;
    const normalized = normalizeLookup(raw);
    const exact = SQUAD_UPGRADES.find((item) => normalizeLookup(item.name) === normalized);
    if (exact) return exact;
    const matches = SQUAD_UPGRADES.filter((item) => normalizeLookup(item.name).includes(normalized));
    return matches.length === 1 ? matches[0] : null;
}

function getRenownGradeFromHistory(historicalStars) {
    const stars = Math.max(0, Number(historicalStars || 0));
    return [6, 5, 4, 3, 2, 1, 0].find((grade) => stars >= GRADE_MIN_STARS[grade]) || 0;
}

function listUpgradeCategories() {
    return Object.values(CATEGORY_DEFINITIONS);
}

function listUpgradesByCategory(categoryKey) {
    return SQUAD_UPGRADES.filter((item) => item.categoryKey === categoryKey);
}

module.exports = {
    CATEGORY_DEFINITIONS,
    GRADE_MIN_STARS,
    SQUAD_UPGRADES,
    getRenownGradeFromHistory,
    getSquadUpgrade,
    listUpgradeCategories,
    listUpgradesByCategory,
    normalizeLookup,
};
