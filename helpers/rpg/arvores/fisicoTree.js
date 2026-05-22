const path = require('path');

const ROMAN = {
    1: 'I',
    2: 'II',
    3: 'III',
    4: 'IV',
    5: 'V',
    6: 'VI',
    7: 'VII',
    8: 'VIII',
    9: 'IX',
};

const trackFlavors = {
    forca: 'Amplia a potência física e o peso dos golpes.',
    impacto: 'Transforma força bruta em colisão devastadora.',
    resistencia: 'Fortalece o corpo para suportar pressão contínua.',
    adrenalina: 'Libera surtos de rendimento quando o combate aperta.',
    resistencia_venenos: 'Treina o corpo para filtrar e suportar toxinas.',
    resistencia_ambiental: 'Adapta o corpo a extremos de clima e terreno.',
    recuperacao: 'Acelera o retorno físico entre esforços e ferimentos.',
    recuperacao_vigor: 'Recupera fôlego e reserva corporal em combate.',
    agilidade: 'Refina mobilidade, esquiva e leveza corporal.',
    fluxo: 'Conecta movimentos em cadeias mais fluidas.',
    adaptacao: 'Ensina o corpo a responder a mudanças bruscas.',
    velocidade: 'Eleva aceleração, ritmo e explosão de deslocamento.',
    deslocamento: 'Converte velocidade em alcance prático e reposicionamento.',
    precisao: 'Melhora o controle fino, o timing e o acerto.',
    ponto_fraco: 'Permite ler brechas e atingir alvos críticos.',
    percepcao: 'Amplia leitura corporal, espacial e de ameaça.',
    sentidos: 'Expande o alcance e a nitidez dos sentidos.',
    visao: 'Foca a leitura visual de detalhes e movimento.',
    audicao: 'Aprofunda percepção sonora e direção de ruídos.',
    olfato: 'Treina rastreio e leitura química do ambiente.',
    tato: 'Eleva sensibilidade de contato, vibração e pressão.',
    intuicao_corporal: 'Cria leitura instintiva de perigo e intenção.',
    instinto: 'Permite reagir antes do pensamento consciente terminar.',
    barbaro: 'Canaliza brutalidade, fúria e presença esmagadora.',
    tirano: 'Impõe domínio ofensivo e autoridade opressiva.',
    benevolente: 'Usa o físico para proteger, sustentar e persistir.',
    culto: 'Lapida técnica, refinamento e leitura avançada.',
    justo: 'Disciplina a técnica em decisões limpas e precisas.',
    injusto: 'Explora falhas e manipula o ritmo do adversário.',
    ki: 'Dá forma física à energia vital através de treino profundo.',
    zetten: 'Condensa corpo e energia em domínio absoluto.',
};

function normalizeText(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function makeAliases(...values) {
    const raw = unique(values.flat().map((value) => String(value).trim()).filter(Boolean));
    return unique([...raw, ...raw.map(normalizeText)]);
}

function basicCost(level) {
    if (level <= 3) return 1;
    if (level <= 6) return 2;
    return 3;
}

function milestoneCost(rank) {
    return [0, 3, 4, 5][rank];
}

function routeCost(rank) {
    return [0, 4, 5, 6][rank];
}

function specialCost(rank) {
    return [0, 3, 4, 5][rank];
}

function kiCost(rank) {
    return [0, 6, 7, 8][rank];
}

function zettenCost(rank) {
    return [0, 8, 9, 10][rank];
}

function getFlavor(branch) {
    return trackFlavors[branch] || 'Aprofunda domínio físico neste caminho.';
}

const tree = {
    key: 'fisico',
    label: 'Árvore Física',
    icon: '🏋️',
    currencyLabel: 'PH',
    autoUnlockNodeIds: ['fisico_root', 'vigor_base', 'controle_corporal_base'],
    legacyPhSource: {
        table: 'jogadores',
        column: 'pontos',
    },
    images: {
        full: path.join(process.cwd(), 'assets', 'arvores', 'fisico_full.png'),
        regions: path.join(process.cwd(), 'assets', 'arvores', 'fisico_regions.json'),
        cacheDir: path.join(process.cwd(), 'temp', 'tree-cache'),
    },
    routeStatusOrder: ['barbaro', 'culto', 'instinto', 'ki', 'zetten'],
    branchAliases: {},
    purchaseTracks: {},
    views: {},
    customRequirements: {
        controle_corporal_avancado: {
            label: 'Controle Corporal avançado',
            hint: 'invista pelo menos 18 PH nos ramos de Controle Corporal',
            check: ({ getSectionSpentPh }) => getSectionSpentPh('controle_corporal') >= 18,
        },
    },
    nodes: [],
};

function addBranchAliases(key, aliases) {
    tree.branchAliases[key] = makeAliases(key, aliases);
}

function registerTrack(key, config) {
    tree.purchaseTracks[key] = {
        key,
        label: config.label,
        section: config.section,
        priority: config.priority,
        imageRegion: config.imageRegion,
        milestoneTrack: config.milestoneTrack || null,
        coreTrack: config.coreTrack || null,
        aliases: makeAliases(key, config.label, config.aliases || []),
        ids: [],
    };
    addBranchAliases(key, tree.purchaseTracks[key].aliases);
}

function addView(key, config) {
    tree.views[key] = {
        key,
        label: config.label,
        aliases: makeAliases(key, config.label, config.aliases || []),
        description: config.description,
        imageRegion: config.imageRegion || key,
        heroTracks: config.heroTracks || [],
        tracks: config.tracks || [],
    };
    addBranchAliases(key, tree.views[key].aliases);
}

function makeNode(config) {
    return {
        id: config.id,
        tree: tree.key,
        name: config.name,
        aliases: makeAliases(config.name, config.aliases || []),
        branch: config.branch,
        section: config.section,
        tier: config.tier || config.level || 1,
        stage: config.stage || config.tier || config.level || 1,
        level: config.level || null,
        cost_ph: config.cost_ph ?? 0,
        requires: config.requires || [],
        requires_any: config.requires_any || [],
        narrative_requires: config.narrative_requires || [],
        custom_requires: config.custom_requires || [],
        type: config.type || 'atributo',
        description: config.description || getFlavor(config.branch),
        short_effect: config.short_effect || getFlavor(config.branch),
        next_ids: [],
        image_region: config.image_region || tree.purchaseTracks[config.branch]?.imageRegion || config.branch,
    };
}

function addNode(trackKey, nodeConfig) {
    const node = makeNode(nodeConfig);
    tree.nodes.push(node);
    if (trackKey && tree.purchaseTracks[trackKey]) {
        tree.purchaseTracks[trackKey].ids.push(node.id);
    }
    return node;
}

function buildInterleavedTrack(config) {
    registerTrack(config.coreKey, {
        label: config.coreLabel,
        section: config.section,
        priority: config.corePriority,
        imageRegion: config.imageRegion,
        aliases: config.coreAliases || [],
        milestoneTrack: config.milestoneKey,
    });

    registerTrack(config.milestoneKey, {
        label: config.milestoneLabel,
        section: config.section,
        priority: config.milestonePriority,
        imageRegion: config.imageRegion,
        aliases: config.milestoneAliases || [],
        coreTrack: config.coreKey,
    });

    for (let level = 1; level <= 9; level += 1) {
        let requires = [];
        if (level === 1) requires = [config.baseRequirement];
        else if (level === 4) requires = [`${config.milestoneKey}_1`];
        else if (level === 7) requires = [`${config.milestoneKey}_2`];
        else requires = [`${config.coreKey}_${level - 1}`];

        addNode(config.coreKey, {
            id: `${config.coreKey}_${level}`,
            name: `${config.coreLabel} ${ROMAN[level]}`,
            branch: config.coreKey,
            section: config.section,
            level,
            tier: level,
            stage: level + Math.floor((level - 1) / 3),
            cost_ph: basicCost(level),
            requires,
            type: 'atributo',
            aliases: [`${config.coreKey} ${ROMAN[level]}`],
            image_region: config.imageRegion,
        });
    }

    for (let rank = 1; rank <= 3; rank += 1) {
        const requires = rank === 1
            ? [`${config.coreKey}_3`]
            : [`${config.coreKey}_${rank === 2 ? 6 : 9}`, `${config.milestoneKey}_${rank - 1}`];

        addNode(config.milestoneKey, {
            id: `${config.milestoneKey}_${rank}`,
            name: config.milestoneNames[rank - 1],
            branch: config.milestoneKey,
            section: config.section,
            level: rank,
            tier: rank,
            stage: rank * 4,
            cost_ph: milestoneCost(rank),
            requires,
            type: config.milestoneType || 'marco',
            aliases: [
                `${config.milestoneLabel} ${ROMAN[rank]}`,
                ...(config.milestoneAliasesByRank?.[rank] || []),
            ],
            image_region: config.imageRegion,
        });
    }
}

function buildSimpleTrack(config) {
    registerTrack(config.key, {
        label: config.label,
        section: config.section,
        priority: config.priority,
        imageRegion: config.imageRegion,
        aliases: config.aliases || [],
    });

    config.steps.forEach((step, index) => {
        const level = index + 1;
        addNode(config.key, {
            id: step.id || `${config.key}_${level}`,
            name: step.name || `${config.label} ${ROMAN[level]}`,
            branch: config.key,
            section: config.section,
            level,
            tier: step.tier || level,
            stage: step.stage || level,
            cost_ph: step.cost_ph ?? config.costResolver(level),
            requires: step.requires || [],
            requires_any: step.requires_any || [],
            narrative_requires: step.narrative_requires || [],
            custom_requires: step.custom_requires || [],
            type: step.type || config.type || 'especial',
            aliases: step.aliases || [`${config.key} ${ROMAN[level]}`],
            image_region: step.image_region || config.imageRegion,
        });
    });
}

addNode(null, {
    id: 'fisico_root',
    name: 'Físico',
    branch: 'fisico',
    section: 'fisico',
    cost_ph: 0,
    type: 'base',
    aliases: ['fisico', 'físico'],
    image_region: 'completo',
});

addNode(null, {
    id: 'vigor_base',
    name: 'Vigor',
    branch: 'vigor',
    section: 'vigor',
    cost_ph: 0,
    requires: ['fisico_root'],
    type: 'base',
    aliases: ['vigor', 'vigor i'],
    image_region: 'vigor',
});

addNode(null, {
    id: 'controle_corporal_base',
    name: 'Controle Corporal',
    branch: 'controle_corporal',
    section: 'controle_corporal',
    cost_ph: 0,
    requires: ['fisico_root'],
    type: 'base',
    aliases: ['controle', 'controle corporal', 'controle corporal i'],
    image_region: 'controle',
});

buildInterleavedTrack({
    section: 'vigor',
    baseRequirement: 'vigor_base',
    coreKey: 'forca',
    coreLabel: 'Força',
    coreAliases: ['forca', 'força'],
    corePriority: 10,
    milestoneKey: 'impacto',
    milestoneLabel: 'Impacto',
    milestoneAliases: ['impacto'],
    milestonePriority: 15,
    milestoneNames: ['Impacto I', 'Impacto II', 'Impacto III'],
    imageRegion: 'forca',
});

buildInterleavedTrack({
    section: 'vigor',
    baseRequirement: 'vigor_base',
    coreKey: 'resistencia',
    coreLabel: 'Resistência',
    coreAliases: ['resistencia', 'resistência'],
    corePriority: 20,
    milestoneKey: 'adrenalina',
    milestoneLabel: 'Adrenalina',
    milestoneAliases: ['adrenalina'],
    milestonePriority: 25,
    milestoneNames: ['Adrenalina I', 'Adrenalina II', 'Adrenalina III'],
    imageRegion: 'resistencia',
});

buildSimpleTrack({
    key: 'resistencia_venenos',
    label: 'Resistência a Venenos',
    aliases: ['venenos', 'resistencia a venenos', 'resistência a venenos'],
    section: 'vigor',
    imageRegion: 'resistencia',
    priority: 80,
    type: 'especial',
    costResolver: specialCost,
    steps: [
        { name: 'Resistência a Venenos I', requires: ['adrenalina_1'] },
        { name: 'Resistência a Venenos II', requires: ['resistencia_venenos_1', 'resistencia_6'] },
        { name: 'Resistência a Venenos III', requires: ['resistencia_venenos_2', 'resistencia_9'] },
    ],
});

buildSimpleTrack({
    key: 'resistencia_ambiental',
    label: 'Resistência Ambiental',
    aliases: ['resistencia ambiental', 'resistência ambiental', 'ambiental'],
    section: 'vigor',
    imageRegion: 'resistencia',
    priority: 81,
    type: 'especial',
    costResolver: specialCost,
    steps: [
        { name: 'Resistência Ambiental I', requires: ['adrenalina_1'] },
        { name: 'Resistência Ambiental II', requires: ['resistencia_ambiental_1', 'resistencia_6'] },
        { name: 'Resistência Ambiental III', requires: ['resistencia_ambiental_2', 'resistencia_9'] },
    ],
});

buildInterleavedTrack({
    section: 'vigor',
    baseRequirement: 'vigor_base',
    coreKey: 'recuperacao',
    coreLabel: 'Recuperação',
    coreAliases: ['recuperacao', 'recuperação'],
    corePriority: 30,
    milestoneKey: 'recuperacao_vigor',
    milestoneLabel: 'Recuperação de Vigor',
    milestoneAliases: ['recuperacao de vigor', 'recuperação de vigor'],
    milestonePriority: 35,
    milestoneNames: ['Recuperação de Vigor I', 'Recuperação de Vigor II', 'Recuperação de Vigor III'],
    imageRegion: 'recuperacao',
});

buildInterleavedTrack({
    section: 'controle_corporal',
    baseRequirement: 'controle_corporal_base',
    coreKey: 'agilidade',
    coreLabel: 'Agilidade',
    coreAliases: ['agilidade'],
    corePriority: 40,
    milestoneKey: 'fluxo',
    milestoneLabel: 'Fluxo',
    milestoneAliases: ['fluxo'],
    milestonePriority: 45,
    milestoneNames: ['Fluxo I', 'Fluxo II', 'Fluxo III'],
    imageRegion: 'agilidade',
});

buildSimpleTrack({
    key: 'adaptacao',
    label: 'Adaptação',
    aliases: ['adaptacao', 'adaptação'],
    section: 'controle_corporal',
    imageRegion: 'agilidade',
    priority: 85,
    type: 'especial',
    costResolver: specialCost,
    steps: [
        { name: 'Adaptação I', requires: ['agilidade_3', 'percepcao_3'] },
        { name: 'Adaptação II', requires: ['adaptacao_1', 'fluxo_1'] },
        { name: 'Adaptação III', requires: ['adaptacao_2', 'fluxo_2'] },
    ],
});

buildInterleavedTrack({
    section: 'controle_corporal',
    baseRequirement: 'controle_corporal_base',
    coreKey: 'velocidade',
    coreLabel: 'Velocidade',
    coreAliases: ['velocidade'],
    corePriority: 50,
    milestoneKey: 'deslocamento',
    milestoneLabel: 'Deslocamento',
    milestoneAliases: ['deslocamento'],
    milestonePriority: 55,
    milestoneNames: ['Deslocamento I', 'Deslocamento II', 'Deslocamento III'],
    imageRegion: 'velocidade',
});

buildInterleavedTrack({
    section: 'controle_corporal',
    baseRequirement: 'controle_corporal_base',
    coreKey: 'precisao',
    coreLabel: 'Precisão',
    coreAliases: ['precisao', 'precisão'],
    corePriority: 60,
    milestoneKey: 'ponto_fraco',
    milestoneLabel: 'Ponto Fraco',
    milestoneAliases: ['ponto fraco'],
    milestonePriority: 65,
    milestoneNames: ['Ponto Fraco I', 'Ponto Fraco II', 'Ponto Fraco III'],
    imageRegion: 'precisao',
});

buildInterleavedTrack({
    section: 'controle_corporal',
    baseRequirement: 'controle_corporal_base',
    coreKey: 'percepcao',
    coreLabel: 'Percepção',
    coreAliases: ['percepcao', 'percepção'],
    corePriority: 70,
    milestoneKey: 'sentidos',
    milestoneLabel: 'Sentidos',
    milestoneAliases: ['sentidos', 'sentidos aguçados', 'sentidos aguacados'],
    milestonePriority: 75,
    milestoneNames: ['Sentidos Aguçados I', 'Sentidos II', 'Sentidos III'],
    milestoneAliasesByRank: {
        1: ['Sentidos I', 'Sentidos Aguçados I'],
        2: ['Sentidos Aguçados II'],
        3: ['Sentidos Aguçados III'],
    },
    imageRegion: 'percepcao',
});

buildSimpleTrack({
    key: 'visao',
    label: 'Visão',
    aliases: ['visao', 'visão'],
    section: 'controle_corporal',
    imageRegion: 'sentidos',
    priority: 86,
    type: 'especial',
    costResolver: specialCost,
    steps: [
        { name: 'Visão I', requires: ['sentidos_1'] },
        { name: 'Visão II', requires: ['visao_1', 'sentidos_2'] },
        { name: 'Visão III', requires: ['visao_2', 'sentidos_3'] },
    ],
});

buildSimpleTrack({
    key: 'audicao',
    label: 'Audição',
    aliases: ['audicao', 'audição'],
    section: 'controle_corporal',
    imageRegion: 'sentidos',
    priority: 87,
    type: 'especial',
    costResolver: specialCost,
    steps: [
        { name: 'Audição I', requires: ['sentidos_1'] },
        { name: 'Audição II', requires: ['audicao_1', 'sentidos_2'] },
        { name: 'Audição III', requires: ['audicao_2', 'sentidos_3'] },
    ],
});

buildSimpleTrack({
    key: 'olfato',
    label: 'Olfato',
    aliases: ['olfato'],
    section: 'controle_corporal',
    imageRegion: 'sentidos',
    priority: 88,
    type: 'especial',
    costResolver: specialCost,
    steps: [
        { name: 'Olfato I', requires: ['sentidos_1'] },
        { name: 'Olfato II', requires: ['olfato_1', 'sentidos_2'] },
        { name: 'Olfato III', requires: ['olfato_2', 'sentidos_3'] },
    ],
});

buildSimpleTrack({
    key: 'tato',
    label: 'Tato',
    aliases: ['tato'],
    section: 'controle_corporal',
    imageRegion: 'sentidos',
    priority: 89,
    type: 'especial',
    costResolver: specialCost,
    steps: [
        { name: 'Tato I', requires: ['sentidos_1'] },
        { name: 'Tato II', requires: ['tato_1', 'sentidos_2'] },
        { name: 'Tato III', requires: ['tato_2', 'sentidos_3'] },
    ],
});

buildSimpleTrack({
    key: 'intuicao_corporal',
    label: 'Intuição Corporal',
    aliases: ['intuicao', 'intuição', 'intuicao corporal', 'intuição corporal'],
    section: 'controle_corporal',
    imageRegion: 'sentidos',
    priority: 90,
    type: 'especial',
    costResolver: specialCost,
    steps: [
        { name: 'Intuição Corporal I', requires: ['sentidos_1', 'percepcao_6'] },
        { name: 'Intuição Corporal II', requires: ['intuicao_corporal_1', 'sentidos_2'] },
        { name: 'Intuição Corporal III', requires: ['intuicao_corporal_2', 'sentidos_3'] },
    ],
});

buildSimpleTrack({
    key: 'instinto',
    label: 'Instinto',
    aliases: ['instinto'],
    section: 'instinto',
    imageRegion: 'ki',
    priority: 95,
    type: 'especial',
    costResolver: specialCost,
    steps: [
        { name: 'Instinto I', requires: ['percepcao_6', 'agilidade_6', 'intuicao_corporal_1', 'fluxo_1'] },
        { name: 'Instinto II', requires: ['instinto_1', 'percepcao_8', 'intuicao_corporal_2'] },
        { name: 'Instinto III', requires: ['instinto_2', 'percepcao_9', 'intuicao_corporal_3', 'fluxo_2'] },
    ],
});

buildSimpleTrack({
    key: 'barbaro',
    label: 'Bárbaro',
    aliases: ['barbaro', 'bárbaro'],
    section: 'barbaro',
    imageRegion: 'barbaro',
    priority: 100,
    type: 'rota',
    costResolver: routeCost,
    steps: [
        {
            name: 'Bárbaro I',
            requires: ['forca_6', 'resistencia_6', 'impacto_1', 'adrenalina_1', 'recuperacao_vigor_1'],
        },
        {
            name: 'Bárbaro II',
            requires: ['barbaro_1'],
            requires_any: [['impacto_2', 'adrenalina_2']],
        },
        {
            name: 'Bárbaro III',
            requires: ['barbaro_2'],
            requires_any: [['impacto_3', 'adrenalina_3']],
        },
    ],
});

buildSimpleTrack({
    key: 'tirano',
    label: 'Tirano',
    aliases: ['tirano'],
    section: 'barbaro',
    imageRegion: 'barbaro',
    priority: 120,
    type: 'rota',
    costResolver: routeCost,
    steps: [
        { name: 'Tirano I', requires: ['barbaro_2', 'impacto_2', 'adrenalina_2'] },
        { name: 'Tirano II', requires: ['tirano_1', 'barbaro_3'] },
        { name: 'Tirano III', requires: ['tirano_2', 'impacto_3'] },
    ],
});

buildSimpleTrack({
    key: 'benevolente',
    label: 'Benevolente',
    aliases: ['benevolente'],
    section: 'barbaro',
    imageRegion: 'barbaro',
    priority: 121,
    type: 'rota',
    costResolver: routeCost,
    steps: [
        { name: 'Benevolente I', requires: ['barbaro_2', 'recuperacao_vigor_2'] },
        {
            name: 'Benevolente II',
            requires: ['benevolente_1'],
            requires_any: [['resistencia_ambiental_2', 'resistencia_venenos_2']],
        },
        { name: 'Benevolente III', requires: ['benevolente_2', 'recuperacao_vigor_3'] },
    ],
});

buildSimpleTrack({
    key: 'culto',
    label: 'Culto',
    aliases: ['culto'],
    section: 'culto',
    imageRegion: 'culto',
    priority: 110,
    type: 'rota',
    costResolver: routeCost,
    steps: [
        {
            name: 'Culto I',
            requires: ['agilidade_6', 'precisao_6', 'percepcao_6', 'fluxo_1', 'ponto_fraco_1', 'sentidos_1'],
        },
        {
            name: 'Culto II',
            requires: ['culto_1'],
            requires_any: [['fluxo_2', 'ponto_fraco_2']],
        },
        {
            name: 'Culto III',
            requires: ['culto_2'],
            requires_any: [['fluxo_3', 'ponto_fraco_3', 'sentidos_3']],
        },
    ],
});

buildSimpleTrack({
    key: 'justo',
    label: 'Justo',
    aliases: ['justo'],
    section: 'culto',
    imageRegion: 'culto',
    priority: 122,
    type: 'rota',
    costResolver: routeCost,
    steps: [
        { name: 'Justo I', requires: ['culto_2', 'fluxo_2', 'ponto_fraco_2'] },
        { name: 'Justo II', requires: ['justo_1', 'culto_3'] },
        { name: 'Justo III', requires: ['justo_2', 'fluxo_3'] },
    ],
});

buildSimpleTrack({
    key: 'injusto',
    label: 'Injusto',
    aliases: ['injusto'],
    section: 'culto',
    imageRegion: 'culto',
    priority: 123,
    type: 'rota',
    costResolver: routeCost,
    steps: [
        { name: 'Injusto I', requires: ['culto_2', 'ponto_fraco_2', 'sentidos_2'] },
        { name: 'Injusto II', requires: ['injusto_1', 'culto_3'] },
        { name: 'Injusto III', requires: ['injusto_2', 'ponto_fraco_3'] },
    ],
});

buildSimpleTrack({
    key: 'ki',
    label: 'Ki',
    aliases: ['ki'],
    section: 'ki',
    imageRegion: 'ki',
    priority: 130,
    type: 'especial',
    costResolver: kiCost,
    steps: [
        {
            name: 'Ki I',
            requires: ['instinto_2', 'percepcao_8', 'fluxo_2'],
            custom_requires: ['controle_corporal_avancado'],
            narrative_requires: ['treino_ki'],
        },
        {
            name: 'Ki II',
            requires: ['ki_1', 'instinto_3', 'sentidos_3'],
        },
        {
            name: 'Ki III',
            requires: ['ki_2', 'percepcao_9', 'intuicao_corporal_3'],
        },
    ],
});

buildSimpleTrack({
    key: 'zetten',
    label: 'Zetten',
    aliases: ['zetten'],
    section: 'zetten',
    imageRegion: 'ki',
    priority: 140,
    type: 'especial',
    costResolver: zettenCost,
    steps: [
        {
            name: 'Zetten I',
            requires: ['ki_3', 'precisao_9'],
            requires_any: [['forca_6', 'velocidade_6']],
            narrative_requires: ['treino_zetten'],
        },
        {
            name: 'Zetten II',
            requires: ['zetten_1'],
            requires_any: [['fluxo_3', 'impacto_3']],
        },
        {
            name: 'Zetten III',
            requires: ['zetten_2'],
            narrative_requires: ['dominio_zetten'],
        },
    ],
});

addView('vigor', {
    label: 'Vigor',
    aliases: ['vigor'],
    imageRegion: 'vigor',
    description: 'Base de potência, resistência e recuperação.',
    heroTracks: ['forca', 'resistencia', 'recuperacao'],
    tracks: ['forca', 'impacto', 'resistencia', 'adrenalina', 'resistencia_venenos', 'resistencia_ambiental', 'recuperacao', 'recuperacao_vigor'],
});

addView('controle_corporal', {
    label: 'Controle Corporal',
    aliases: ['controle', 'controle corporal'],
    imageRegion: 'controle',
    description: 'Base de coordenação, técnica, leitura e movimento.',
    heroTracks: ['agilidade', 'velocidade', 'precisao', 'percepcao'],
    tracks: ['agilidade', 'fluxo', 'adaptacao', 'velocidade', 'deslocamento', 'precisao', 'ponto_fraco', 'percepcao', 'sentidos', 'visao', 'audicao', 'olfato', 'tato', 'intuicao_corporal'],
});

addView('forca', {
    label: 'Força',
    aliases: ['forca', 'força', 'impacto'],
    imageRegion: 'forca',
    description: 'Ramo de força bruta e marcos de impacto.',
    heroTracks: ['forca', 'impacto'],
    tracks: ['forca', 'impacto'],
});

addView('resistencia', {
    label: 'Resistência',
    aliases: ['resistencia', 'resistência', 'adrenalina', 'venenos', 'ambiental'],
    imageRegion: 'resistencia',
    description: 'Ramo de resistência contínua, adaptação e adrenalina.',
    heroTracks: ['resistencia', 'adrenalina'],
    tracks: ['resistencia', 'adrenalina', 'resistencia_venenos', 'resistencia_ambiental'],
});

addView('recuperacao', {
    label: 'Recuperação',
    aliases: ['recuperacao', 'recuperação', 'recuperacao de vigor', 'recuperação de vigor'],
    imageRegion: 'recuperacao',
    description: 'Ramo de recuperação corporal e reserva de vigor.',
    heroTracks: ['recuperacao', 'recuperacao_vigor'],
    tracks: ['recuperacao', 'recuperacao_vigor'],
});

addView('agilidade', {
    label: 'Agilidade',
    aliases: ['agilidade', 'fluxo', 'adaptacao', 'adaptação'],
    imageRegion: 'agilidade',
    description: 'Ramo de mobilidade, fluidez e ajuste instantâneo.',
    heroTracks: ['agilidade', 'fluxo'],
    tracks: ['agilidade', 'fluxo', 'adaptacao'],
});

addView('velocidade', {
    label: 'Velocidade',
    aliases: ['velocidade', 'deslocamento'],
    imageRegion: 'velocidade',
    description: 'Ramo de aceleração e reposicionamento prático.',
    heroTracks: ['velocidade', 'deslocamento'],
    tracks: ['velocidade', 'deslocamento'],
});

addView('precisao', {
    label: 'Precisão',
    aliases: ['precisao', 'precisão', 'ponto fraco'],
    imageRegion: 'precisao',
    description: 'Ramo de controle fino, leitura de brechas e finalização.',
    heroTracks: ['precisao', 'ponto_fraco'],
    tracks: ['precisao', 'ponto_fraco'],
});

addView('percepcao', {
    label: 'Percepção',
    aliases: ['percepcao', 'percepção'],
    imageRegion: 'percepcao',
    description: 'Ramo de sentidos, leitura de ameaça e intuição corporal.',
    heroTracks: ['percepcao', 'sentidos'],
    tracks: ['percepcao', 'sentidos', 'visao', 'audicao', 'olfato', 'tato', 'intuicao_corporal'],
});

addView('sentidos', {
    label: 'Sentidos',
    aliases: ['sentidos', 'sentidos aguçados', 'sentidos aguacados', 'visao', 'visão', 'audicao', 'audição', 'olfato', 'tato', 'intuicao', 'intuição'],
    imageRegion: 'sentidos',
    description: 'Subárvore sensorial e de percepção refinada.',
    heroTracks: ['sentidos', 'intuicao_corporal'],
    tracks: ['sentidos', 'visao', 'audicao', 'olfato', 'tato', 'intuicao_corporal'],
});

addView('instinto', {
    label: 'Instinto',
    aliases: ['instinto'],
    imageRegion: 'ki',
    description: 'Domínio reativo do corpo antes do raciocínio.',
    heroTracks: ['instinto'],
    tracks: ['instinto'],
});

addView('barbaro', {
    label: 'Bárbaro',
    aliases: ['barbaro', 'bárbaro', 'tirano', 'benevolente'],
    imageRegion: 'barbaro',
    description: 'Rota avançada de brutalidade, presença e resistência.',
    heroTracks: ['barbaro'],
    tracks: ['barbaro', 'tirano', 'benevolente'],
});

addView('culto', {
    label: 'Culto',
    aliases: ['culto', 'justo', 'injusto'],
    imageRegion: 'culto',
    description: 'Rota avançada de técnica, refinamento e leitura.',
    heroTracks: ['culto'],
    tracks: ['culto', 'justo', 'injusto'],
});

addView('ki', {
    label: 'Ki',
    aliases: ['ki'],
    imageRegion: 'ki',
    description: 'Domínio avançado da energia vital através do corpo.',
    heroTracks: ['ki'],
    tracks: ['ki'],
});

addView('zetten', {
    label: 'Zetten',
    aliases: ['zetten'],
    imageRegion: 'ki',
    description: 'Refinamento extremo de corpo, precisão e energia.',
    heroTracks: ['zetten'],
    tracks: ['zetten'],
});

for (const track of Object.values(tree.purchaseTracks)) {
    track.ids.forEach((nodeId, index) => {
        const node = tree.nodes.find((item) => item.id === nodeId);
        if (!node) return;
        const nextNode = track.ids[index + 1];
        node.next_ids = nextNode ? [nextNode] : [];
    });
}

tree.nodesById = Object.fromEntries(tree.nodes.map((node) => [node.id, node]));

module.exports = tree;
