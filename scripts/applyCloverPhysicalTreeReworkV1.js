const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { ensureCloverSkillTreeSchema } = require('../database');
const { getPhSummary } = require('../helpers/clover/phService');

const ROOT = process.cwd();
const TREE_PATH = path.join(ROOT, 'data', 'clover', 'trees', 'fisico.json');
const HTML_PATH = path.join(ROOT, 'helpers', 'clover', 'approvedVisuals', 'fisico_tree_v8.html');
const DB_PATH = path.join(ROOT, 'banco.sqlite');
const CACHE_DIR = path.join(ROOT, 'cache', 'clover', 'trees');
const MIGRATION_SOURCE = 'skill_tree_migration:fisico_rework_v1';
const MIGRATION_RELATED_ID = 'fisico_rework_v1_refund';

function nowStamp() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join('');
}

function copyIfExists(source, target) {
    if (!fs.existsSync(source)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
}

function backupFiles() {
    const dir = path.join(ROOT, 'backups', `clover-fisico-rework-v1-${nowStamp()}`);
    fs.mkdirSync(dir, { recursive: true });
    copyIfExists(TREE_PATH, path.join(dir, 'fisico.before.json'));
    copyIfExists(HTML_PATH, path.join(dir, 'fisico_tree_v8.before.html'));
    copyIfExists(DB_PATH, path.join(dir, 'banco.before.sqlite'));
    return dir;
}

function node({
    id,
    name,
    route,
    tier,
    cost,
    shortEffect,
    effect,
    requires = [],
    requiresAny = [],
    unlocks = [],
    requiresApproval = false,
    aliases = [],
    tags = [],
    metadata = {},
}) {
    return {
        id,
        name,
        route,
        tier,
        cost,
        shortEffect,
        effect,
        requires,
        ...(requiresAny.length ? { requiresAny } : {}),
        unlocks,
        requiresApproval,
        aliases,
        tags,
        metadata: {
            type: metadata.type || 'tecnica',
            risk: metadata.risk || (requiresApproval ? 'alto' : 'baixo'),
            function: metadata.function || shortEffect,
            technicalWeight: metadata.technicalWeight ?? Math.max(1, Number(tier || 1)),
            rankLabel: metadata.rankLabel || 'físico',
            limits: metadata.limits || 'Depende de atributo, Estágio, cena, posição e narração.',
            notDoes: metadata.notDoes || 'Não substitui Estilo de Luta, arma específica, magia, antimagia ou aprovação narrativa.',
            narrativeRequirement: metadata.narrativeRequirement || (requiresApproval ? 'aprovação narrativa' : 'livre'),
            playerSummary: metadata.playerSummary || shortEffect,
            technicalSummary: metadata.technicalSummary || effect,
            notes: metadata.notes || 'Árvore física pura. Estilo de Luta permanece separado.',
            ...(metadata.extra || {}),
        },
    };
}

function levelNode({
    baseId,
    baseName,
    route,
    level,
    cost,
    requires,
    unlocks,
    attribute,
    use,
    description,
    aliases = [],
}) {
    const roman = ['I', 'II', 'III', 'IV'][level - 1];
    const percent = level * 10;
    const id = `${baseId}_${roman.toLowerCase()}`;
    return node({
        id,
        name: `${baseName} ${roman}`,
        route,
        tier: 2 + level,
        cost,
        shortEffect: `+${percent}% em ${use}.`,
        effect: `${description} Bônus: +${percent}% em ${use}.`,
        requires,
        unlocks,
        aliases: [
            baseName,
            `${baseName} ${level}`,
            `${baseId.replace(/_/g, ' ')} ${roman}`,
            `${baseId.replace(/_/g, ' ')} ${level}`,
            ...aliases,
        ],
        tags: ['linha', 'fisico', `nivel_${roman.toLowerCase()}`],
        metadata: {
            type: 'linha_fisica',
            risk: 'baixo',
            rankLabel: `nível ${roman}`,
            technicalWeight: level,
            technicalSummary: `Aplica +${percent}% quando a ação narrada realmente usar ${baseName}.`,
            limits: 'Níveis da mesma linha não somam; vale apenas o maior nível comprado.',
        },
    });
}

function senseNode({
    baseId,
    baseName,
    level,
    cost,
    requires,
    unlocks,
    reading,
    range,
    limit,
    aliases = [],
}) {
    const roman = ['I', 'II', 'III', 'IV', 'V'][level - 1];
    const id = `${baseId}_${roman.toLowerCase()}`;
    return node({
        id,
        name: `${baseName} ${roman}`,
        route: 'percepcao',
        tier: 2 + level,
        cost,
        shortEffect: reading,
        effect: `${reading} Alcance: ${range}. Limite: ${limit}`,
        requires,
        unlocks,
        aliases: [
            baseName,
            `${baseName} ${level}`,
            `${baseId.replace(/_/g, ' ')} ${roman}`,
            `${baseId.replace(/_/g, ' ')} ${level}`,
            ...aliases,
        ],
        tags: ['sentido', 'percepcao_fisica', `nivel_${roman.toLowerCase()}`],
        metadata: {
            type: 'sentido_narrativo',
            risk: 'baixo',
            rankLabel: `nível ${roman}`,
            technicalWeight: level,
            technicalSummary: `${reading} Alcance: ${range}.`,
            limits: limit,
            notDoes: 'Não dá bônus numérico. Não é sensor mágico, radar perfeito, leitura mental ou Percepção de Mana.',
        },
    });
}

const COMMON_COSTS = [25, 50, 80, 110];
const SENSE_COSTS = [35, 55, 80, 110, 140];

const treeNodes = [];
const push = (item) => treeNodes.push(item);

push(node({
    id: 'fisico',
    name: 'Físico',
    route: 'base',
    tier: 1,
    cost: 15,
    shortEffect: 'Raiz da progressão física pura.',
    effect: 'Abre Vigor, Controle Corporal e Percepção Física.',
    unlocks: ['vigor', 'controle_corporal', 'percepcao_fisica'],
    aliases: ['fisico base', 'base fisica', 'base física'],
    tags: ['base'],
    metadata: {
        type: 'base',
        technicalWeight: 1,
        limits: 'Não dá bônus universal. Não concede Estilo de Luta, arma, golpe personalizado, Ki, Zetten ou antimagia.',
        notDoes: 'Não substitui atributo, PB, Estágio, magia ou treino narrativo.',
    },
}));

push(node({
    id: 'vigor',
    name: 'Vigor',
    route: 'vigor',
    tier: 2,
    cost: 15,
    shortEffect: 'Abre força aplicada, resistência corporal e condicionamento físico.',
    effect: 'Rota do corpo que aguenta, empurra, bate, continua e sustenta pressão.',
    requires: ['fisico'],
    unlocks: ['forca_aplicada_i', 'resistencia_corporal_i', 'condicionamento_fisico_i'],
    aliases: ['vigor fisico', 'vigor físico'],
    tags: ['rota'],
    metadata: { type: 'porta_de_rota', technicalWeight: 1 },
}));

push(node({
    id: 'controle_corporal',
    name: 'Controle Corporal',
    route: 'controle',
    tier: 2,
    cost: 15,
    shortEffect: 'Abre mobilidade, reflexos corporais e precisão técnica.',
    effect: 'Rota do corpo que se move, reage, mira e executa com controle.',
    requires: ['fisico'],
    unlocks: ['mobilidade_i', 'reflexos_corporais_i', 'precisao_tecnica_i'],
    aliases: ['controle', 'controle do corpo'],
    tags: ['rota'],
    metadata: { type: 'porta_de_rota', technicalWeight: 1 },
}));

push(node({
    id: 'percepcao_fisica',
    name: 'Percepção Física',
    route: 'percepcao',
    tier: 2,
    cost: 15,
    shortEffect: 'Abre visão, audição, olfato, tato, paladar e intuição corporal.',
    effect: 'Rota de leitura física por sentidos, presença corporal e intuição. Não dá bônus numérico.',
    requires: ['fisico'],
    unlocks: ['visao_i', 'audicao_i', 'olfato_i', 'tato_i', 'paladar_i', 'intuicao_corporal_i'],
    aliases: ['percepcao', 'percepção', 'sentidos', 'percepcao fisica', 'percepção física'],
    tags: ['rota', 'sentidos'],
    metadata: {
        type: 'porta_sensorial',
        technicalWeight: 1,
        notDoes: 'Não é sensor mágico, radar perfeito, leitura mental ou Percepção de Mana.',
    },
}));

const physicalLines = [
    {
        baseId: 'forca_aplicada',
        baseName: 'Força Aplicada',
        route: 'vigor',
        routeReq: 'vigor',
        attribute: 'Força',
        use: 'ações físicas de Força aplicada',
        description: 'Transforma Força em ação útil: impacto, alavanca, pressão, puxar, empurrar, travar, quebrar e arremessar.',
        aliases: ['forca', 'força', 'impacto', 'explosao muscular', 'explosão muscular'],
    },
    {
        baseId: 'resistencia_corporal',
        baseName: 'Resistência Corporal',
        route: 'vigor',
        routeReq: 'vigor',
        attribute: 'Resistência',
        use: 'ações de Resistência física',
        description: 'Junta firmeza corporal, tolerância à dor, postura, durabilidade física e sustentação sob pressão.',
        aliases: ['resistencia', 'resistência', 'corpo firme', 'tolerancia a dor', 'tolerância à dor'],
    },
    {
        baseId: 'condicionamento_fisico',
        baseName: 'Condicionamento Físico',
        route: 'vigor',
        routeReq: 'vigor',
        attribute: 'Resistência',
        use: 'ações narrativas de continuidade física',
        description: 'Junta fôlego, ritmo, recuperação de eixo, fadiga e esforço prolongado em uma competência de continuidade.',
        aliases: ['condicionamento', 'recuperacao', 'recuperação', 'folego', 'fôlego', 'ritmo', 'retomada'],
    },
    {
        baseId: 'mobilidade',
        baseName: 'Mobilidade',
        route: 'controle',
        routeReq: 'controle_corporal',
        attribute: 'Velocidade',
        use: 'ações de Velocidade ligadas a deslocamento físico',
        description: 'Junta arranque e deslocamento: avançar, recuar, perseguir, fugir, reposicionar e cobrir distância.',
        aliases: ['velocidade', 'arranque', 'deslocamento'],
    },
    {
        baseId: 'reflexos_corporais',
        baseName: 'Reflexos Corporais',
        route: 'controle',
        routeReq: 'controle_corporal',
        attribute: 'Agilidade',
        use: 'ações de Agilidade ligadas a reação e ajuste corporal',
        description: 'Junta reação, esquiva, troca de direção, ajuste de postura e resposta física a estímulo percebido.',
        aliases: ['agilidade', 'reflexos', 'reacao corporal', 'reação corporal', 'mudanca de direcao', 'mudança de direção'],
    },
    {
        baseId: 'precisao_tecnica',
        baseName: 'Precisão Técnica',
        route: 'controle',
        routeReq: 'controle_corporal',
        attribute: 'Agilidade',
        use: 'ações físicas precisas',
        description: 'Junta precisão e ponto fraco: colocar força, mão, pé, arma empunhada ou corpo no lugar certo.',
        aliases: ['precisao', 'precisão', 'ponto fraco'],
    },
];

for (const line of physicalLines) {
    let previous = line.routeReq;
    for (let index = 0; index < 4; index += 1) {
        const level = index + 1;
        const currentId = `${line.baseId}_${['i', 'ii', 'iii', 'iv'][index]}`;
        const nextId = level < 4 ? `${line.baseId}_${['i', 'ii', 'iii', 'iv'][index + 1]}` : null;
        push(levelNode({
            ...line,
            level,
            cost: COMMON_COSTS[index],
            requires: [previous],
            unlocks: nextId ? [nextId] : [],
            aliases: line.aliases,
        }));
        previous = currentId;
    }
}

const senseLines = [
    {
        baseId: 'visao',
        baseName: 'Visão',
        aliases: ['visao', 'visão'],
        readings: [
            ['Percebe postura, direção do olhar, movimento visível e abertura simples.', 'próximo, com linha de visão curta', 'Precisa de luz, linha de visão e algo visível.'],
            ['Acompanha trajetória, deslocamento, guarda, mira e postura sob movimento moderado.', 'curto a médio, em campo visual claro', 'Escuridão, cobertura, fumaça, distração e velocidade superior podem atrapalhar.'],
            ['Lê movimento fino, tensão corporal, abertura pequena, intenção visível e troca de peso.', 'cena ampla com linha de visão', 'Não vê através de parede, invisibilidade perfeita ou ocultação total.'],
            ['Acompanha múltiplos detalhes visuais em pressão: microaberturas, trajetória rápida e intenção sutil.', 'amplo dentro da cena visível', 'Ambiente caótico, magia visual, cegueira ou barreira opaca ainda podem cortar.'],
            ['Domínio visual para extrair postura, ritmo, intenção e abertura do que os olhos alcançam.', 'linha de visão real da cena', 'Não é visão através de parede, visão noturna absoluta, clarividência ou leitura de mana.'],
        ],
    },
    {
        baseId: 'audicao',
        baseName: 'Audição',
        aliases: ['audicao', 'audição'],
        readings: [
            ['Percebe passos próximos, respiração, impacto, voz, metal e aproximação simples.', 'próximo, no mesmo cômodo ou combate curto', 'Barulho alto, silêncio, abafamento e distância podem negar.'],
            ['Distingue direção aproximada, ritmo de passos, respiração alterada e cobertura leve.', 'curto a médio em ambiente favorável', 'Multidão, chuva, vento, explosões e eco podem confundir.'],
            ['Separa sons importantes em ruído moderado e acompanha deslocamento físico por som.', 'cena ampla se o ambiente propagar som', 'Não ouve no vácuo, não atravessa isolamento perfeito e não detecta o que não produz som.'],
            ['Reconhece padrão, peso, ritmo, intenção corporal e quantidade aproximada de movimentos pelo som.', 'amplo em ambiente acusticamente favorável', 'Magia de silêncio, ruído extremo ou confusão deliberada podem anular.'],
            ['Domínio auditivo para montar leitura espacial quando existe som suficiente.', 'som real da cena e ambiente por onde ele viaja', 'Não é radar perfeito nem audição impossível.'],
        ],
    },
    {
        baseId: 'olfato',
        baseName: 'Olfato',
        aliases: ['olfato'],
        readings: [
            ['Percebe cheiro forte, sangue, fumaça, suor, veneno evidente ou presença muito próxima.', 'próximo', 'Vento, chuva, cheiro forte e máscara podem atrapalhar.'],
            ['Reconhece rastro recente, cheiro conhecido, suor, sangue ou alteração simples no ambiente.', 'curto a médio em ambiente favorável', 'Não rastreia sem pista real.'],
            ['Segue rastro recente, separa cheiros sobrepostos e identifica presença conhecida com mais segurança.', 'cena ampla se vento, tempo e ambiente ajudarem', 'Tempo demais, água, fumaça pesada ou cheiro dominante podem cortar.'],
            ['Lê mudanças ambientais, substâncias evidentes, rastros misturados e presença por cheiro refinado.', 'amplo em ambiente favorável', 'Não identifica composição química perfeita nem magia invisível.'],
            ['Domínio olfativo para interpretar presença, rastro, ambiente e alteração física por cheiro real.', 'caminho real do cheiro', 'Não rastreia o impossível.'],
        ],
    },
    {
        baseId: 'tato',
        baseName: 'Tato',
        aliases: ['tato'],
        readings: [
            ['Percebe pressão, contato, tensão muscular, base e vibração simples.', 'toque direto ou superfície imediatamente conectada', 'Precisa de contato ou meio físico.'],
            ['Lê mudança de peso, tremor próximo, pressão no chão, agarrão e deslocamento por contato.', 'próximo por superfície conectada', 'Superfície ruim, isolamento ou vibração confusa podem cortar.'],
            ['Interpreta postura, intenção física e movimento pelo contato, pela base ou por vibração.', 'cena próxima por meio físico conectado', 'Não detecta alvo sem contato, vibração ou superfície útil.'],
            ['Usa pressão, vibração e contato para entender ritmo, deslocamento e força de corpos próximos.', 'médio se o meio físico transmitir bem', 'Não substitui visão em ambiente sem contato real.'],
            ['Domínio tátil para ler o campo físico por contato e vibrações reais do ambiente.', 'meio físico conectado ao personagem', 'Não é sonar mágico nem radar universal.'],
        ],
    },
    {
        baseId: 'paladar',
        baseName: 'Paladar',
        aliases: ['paladar'],
        readings: [
            ['Percebe gosto estranho, sangue, veneno evidente, substância forte ou contaminação simples.', 'contato direto com boca, língua ou ingestão mínima', 'É arriscado. Não é análise química e não dá imunidade.'],
            ['Distingue substâncias comuns, remédios simples, comida alterada e veneno evidente.', 'contato direto', 'Precisa provar e pode sofrer efeito se a substância for perigosa.'],
            ['Reconhece padrões de substância, sangue, medicamento, toxina evidente ou alteração física.', 'contato direto', 'Não identifica magia, fórmula complexa ou veneno raro sem base narrativa.'],
            ['Lê substâncias por gosto com refinamento e percebe variações pequenas em comida, líquido ou resíduo.', 'contato direto', 'Não substitui alquimia, medicina ou magia.'],
            ['Domínio de paladar para extrair informação física de substâncias provadas quando há base real.', 'contato direto', 'Não é imunidade, antídoto ou identificação absoluta.'],
        ],
    },
    {
        baseId: 'intuicao_corporal',
        baseName: 'Intuição Corporal',
        aliases: ['intuicao', 'intuição', 'intuicao corporal', 'intuição corporal'],
        readings: [
            ['Percebe melhor o próprio corpo, tensão, desequilíbrio e ameaça no espaço pessoal.', 'espaço pessoal e combate muito próximo', 'Não é previsão; precisa de sinal físico real.'],
            ['Lê ritmo corporal próximo, intenção física simples e mudança de pressão ao redor.', 'curto, ligado ao corpo e ao ambiente imediato', 'Não detecta mente, magia invisível ou ameaça sem sinal físico.'],
            ['Conecta sentidos e corpo para perceber perigo físico, intenção corporal e abertura de movimento.', 'curto a médio, se houver pressão física ou sinais claros', 'Não substitui Ki.'],
            ['O corpo começa a responder antes da mente organizar tudo, desde que os sinais físicos existam.', 'cena próxima ou combate em que esteja envolvido', 'Não é Instinto completo nem previsão perfeita.'],
            ['Domínio de intuição física sobre pressão, corpo, espaço e ameaça física.', 'cena em que o corpo esteja realmente inserido', 'Não é Ki, radar mágico ou leitura do impossível.'],
        ],
    },
];

for (const sense of senseLines) {
    let previous = 'percepcao_fisica';
    for (let index = 0; index < 5; index += 1) {
        const level = index + 1;
        const currentId = `${sense.baseId}_${['i', 'ii', 'iii', 'iv', 'v'][index]}`;
        const nextId = level < 5 ? `${sense.baseId}_${['i', 'ii', 'iii', 'iv', 'v'][index + 1]}` : null;
        const [reading, range, limit] = sense.readings[index];
        push(senseNode({
            ...sense,
            level,
            cost: SENSE_COSTS[index],
            requires: [previous],
            unlocks: nextId ? [nextId] : [],
            reading,
            range,
            limit,
            aliases: sense.aliases,
        }));
        previous = currentId;
    }
}

function identityNode(config) {
    push(node({
        route: 'identidade',
        tier: config.tier || 7,
        requiresApproval: false,
        tags: ['marco', 'identidade_fisica', ...(config.tags || [])],
        metadata: {
            type: config.type || 'marco_de_identidade',
            risk: config.risk || 'medio',
            rankLabel: config.rankLabel,
            technicalWeight: config.weight || 5,
            limits: config.limits,
            notDoes: config.notDoes,
            technicalSummary: config.effect,
        },
        ...config,
    }));
}

identityNode({
    id: 'barbaro_i',
    name: 'Bárbaro I',
    cost: 100,
    shortEffect: '+10% em Força ou Resistência em confronto físico direto.',
    effect: 'Identidade de corpo dominante: pressão, brutalidade, pancada, avanço e resistência. +10% em Força ou Resistência quando a ação for confronto corporal direto ou pressão física clara.',
    requires: ['forca_aplicada_ii', 'resistencia_corporal_ii', 'condicionamento_fisico_ii'],
    requiresAny: [['forca_aplicada_iii', 'resistencia_corporal_iii', 'condicionamento_fisico_iii']],
    unlocks: ['barbaro_ii', 'tirano_i', 'benevolente_i'],
    aliases: ['barbaro', 'bárbaro'],
    rankLabel: 'marco I',
});

identityNode({
    id: 'barbaro_ii',
    name: 'Bárbaro II',
    cost: 140,
    shortEffect: '+15% em Força ou Resistência e reduz penalidade leve de dor/fadiga.',
    effect: 'A presença corporal vira marca real. +15% em Força ou Resistência em confronto físico direto; reduz penalidades leves de dor ou fadiga em pressão física.',
    requires: ['barbaro_i'],
    unlocks: ['ki'],
    aliases: ['barbaro 2', 'bárbaro 2'],
    rankLabel: 'marco II',
});

identityNode({
    id: 'tirano_i',
    name: 'Tirano I',
    cost: 80,
    shortEffect: '+10% no bônus de Força Aplicada para domínio físico ofensivo.',
    effect: 'Expressão ofensiva do Bárbaro: marrento, bruto e opressor. Aumenta em +10% o bônus de Força Aplicada ao dominar espaço, quebrar postura, pressionar guarda ou forçar recuo.',
    requires: ['barbaro_i'],
    unlocks: ['tirano_ii'],
    aliases: ['tirano'],
    type: 'expressao_de_identidade',
    rankLabel: 'expressão I',
});

identityNode({
    id: 'tirano_ii',
    name: 'Tirano II',
    cost: 120,
    shortEffect: '+20% no bônus de Força Aplicada para domínio físico ofensivo.',
    effect: 'Presença ofensiva esmagadora. Aumenta em +20% o bônus de Força Aplicada em domínio físico ofensivo e pode converter vantagem clara em recuo, desequilíbrio ou guarda abalada.',
    requires: ['tirano_i'],
    aliases: ['tirano 2'],
    type: 'expressao_de_identidade',
    rankLabel: 'expressão II',
});

identityNode({
    id: 'benevolente_i',
    name: 'Benevolente I',
    cost: 80,
    shortEffect: 'Reduz em 10% consequência física ao defender, proteger ou segurar linha.',
    effect: 'Expressão defensiva do Bárbaro. Reduz em 10% a consequência física recebida ao defender, proteger, cobrir aliado ou segurar linha.',
    requires: ['barbaro_i'],
    unlocks: ['benevolente_ii'],
    aliases: ['benevolente'],
    type: 'expressao_de_identidade',
    rankLabel: 'expressão I',
});

identityNode({
    id: 'benevolente_ii',
    name: 'Benevolente II',
    cost: 120,
    shortEffect: 'Reduz em 20% consequência física e aumenta Resistência Corporal em proteção.',
    effect: 'Escudo vivo. Reduz em 20% a consequência física ao defender/proteger/cobrir/segurar linha; aumenta em +10% o bônus de Resistência Corporal em proteção física.',
    requires: ['benevolente_i'],
    aliases: ['benevolente 2'],
    type: 'expressao_de_identidade',
    rankLabel: 'expressão II',
});

identityNode({
    id: 'culto_i',
    name: 'Culto I',
    cost: 100,
    shortEffect: 'Identifica 1 ponto fraco físico; exploração recebe +10%.',
    effect: 'Lutador técnico. Após observar a cena, pode identificar 1 ponto fraco físico ou padrão corporal; a primeira ação que explorar essa leitura recebe +10% em Precisão Técnica ou no atributo físico adequado.',
    requires: ['precisao_tecnica_ii'],
    requiresAny: [
        ['mobilidade_ii', 'reflexos_corporais_ii'],
        ['visao_ii', 'audicao_ii', 'olfato_ii', 'tato_ii', 'paladar_ii', 'intuicao_corporal_ii'],
    ],
    unlocks: ['culto_ii', 'justo_i', 'injusto_i'],
    aliases: ['culto'],
    rankLabel: 'marco I',
});

identityNode({
    id: 'culto_ii',
    name: 'Culto II',
    cost: 140,
    shortEffect: 'Identifica até 2 informações físicas úteis; exploração recebe +15%.',
    effect: 'Técnica refinada consolidada. Pode identificar até 2 informações físicas úteis; explorar uma leitura correta dá +15% em Precisão Técnica ou no atributo físico adequado. Pode orientar 1 aliado em ação imediata e clara.',
    requires: ['culto_i'],
    requiresAny: [['precisao_tecnica_iii', 'visao_iii', 'audicao_iii', 'olfato_iii', 'tato_iii', 'paladar_iii', 'intuicao_corporal_iii']],
    unlocks: ['contra_magos', 'ki'],
    aliases: ['culto 2'],
    rankLabel: 'marco II',
});

identityNode({
    id: 'justo_i',
    name: 'Justo I',
    cost: 80,
    shortEffect: '+10% em Reflexos Corporais ou Resistência Corporal em ação limpa/protetora.',
    effect: 'Figura de cavaleiro honrado. Aumenta em +10% o bônus de Reflexos Corporais ou Resistência Corporal quando agir de forma limpa, defensiva, frontal ou protetora.',
    requires: ['culto_i'],
    unlocks: ['justo_ii'],
    aliases: ['justo'],
    type: 'expressao_de_identidade',
    rankLabel: 'expressão I',
});

identityNode({
    id: 'justo_ii',
    name: 'Justo II',
    cost: 120,
    shortEffect: '+20% em Reflexos/Resistência em ação limpa e pode abrir contra-ataque.',
    effect: 'Honra como pressão técnica. Aumenta em +20% o bônus de Reflexos Corporais ou Resistência Corporal em ação limpa, defensiva, frontal ou protetora; defesa limpa pode gerar abertura honrada para contra-ataque direto.',
    requires: ['justo_i'],
    aliases: ['justo 2'],
    type: 'expressao_de_identidade',
    rankLabel: 'expressão II',
});

identityNode({
    id: 'injusto_i',
    name: 'Injusto I',
    cost: 80,
    shortEffect: '+10% em Precisão Técnica ou Agilidade ao explorar brecha, finta ou ângulo ruim.',
    effect: 'Figura do bandido sem honra. Aumenta em +10% o bônus de Precisão Técnica ou trata Agilidade como +10% quando explorar brecha, finta, ângulo ruim, distração ou golpe fora do tempo.',
    requires: ['culto_i'],
    unlocks: ['injusto_ii'],
    aliases: ['injusto'],
    type: 'expressao_de_identidade',
    rankLabel: 'expressão I',
});

identityNode({
    id: 'injusto_ii',
    name: 'Injusto II',
    cost: 120,
    shortEffect: '+20% em Precisão Técnica ou Agilidade e 1x/cena cria desvantagem leve de brecha.',
    effect: 'Oportunismo consistente. Aumenta em +20% o bônus de Precisão Técnica ou trata Agilidade como +20% ao explorar brecha/finta/ângulo ruim; 1x por cena, pode transformar brecha mínima plausível em desvantagem narrativa leve para o alvo.',
    requires: ['injusto_i'],
    aliases: ['injusto 2'],
    type: 'expressao_de_identidade',
    rankLabel: 'expressão II',
});

identityNode({
    id: 'instinto_i',
    name: 'Instinto I',
    cost: 100,
    shortEffect: '+10% em Reflexos Corporais contra surpresa física percebível.',
    effect: 'Corpo que responde antes da mente terminar. Pode reagir parcialmente a ameaça física com sinal real e aumenta em +10% o bônus de Reflexos Corporais contra surpresa física percebível.',
    requires: ['intuicao_corporal_iii', 'reflexos_corporais_ii'],
    unlocks: ['instinto_ii'],
    aliases: ['instinto'],
    rankLabel: 'marco I',
});

identityNode({
    id: 'instinto_ii',
    name: 'Instinto II',
    cost: 140,
    shortEffect: '+20% em Reflexos contra ameaça percebível; surpresa total vira resposta parcial.',
    effect: 'Resposta instintiva confiável. +20% em Reflexos Corporais contra ameaça física percebível; evita ser pego totalmente desprevenido se houver sinal físico real, transformando surpresa total em resposta parcial.',
    requires: ['instinto_i', 'intuicao_corporal_iv', 'reflexos_corporais_iii'],
    unlocks: ['ki'],
    aliases: ['instinto 2'],
    rankLabel: 'marco II',
});

function topNode(config) {
    push(node({
        route: 'topo',
        tier: config.tier || 9,
        requiresApproval: config.requiresApproval ?? true,
        tags: ['topo', 'futuro', ...(config.tags || [])],
        metadata: {
            type: config.type || 'topo_fisico',
            risk: config.risk || 'alto',
            rankLabel: config.rankLabel || 'topo',
            technicalWeight: config.weight || 7,
            limits: config.limits || 'Uso amplo depende de aprovação narrativa, cena e escala.',
            notDoes: config.notDoes || 'Não concede antimagia, vitória automática ou técnica personalizada sem aprovação.',
            technicalSummary: config.effect,
        },
        ...config,
    }));
}

topNode({
    id: 'contra_magos',
    name: 'Contra Magos',
    cost: 140,
    requiresApproval: false,
    shortEffect: 'Leitura e punição física de janelas de conjuração. Não é antimagia.',
    effect: 'Permite ler preparo físico de conjuração, deslocar para ângulo ruim e punir abertura física real. Não cancela magia sozinho e não é antimagia.',
    requires: ['culto_ii', 'percepcao_fisica'],
    requiresAny: [
        ['precisao_tecnica_iii', 'mobilidade_iii', 'reflexos_corporais_iii'],
        ['visao_iii', 'audicao_iii', 'intuicao_corporal_iii'],
    ],
    unlocks: ['ki'],
    aliases: ['contra magos', 'anti magos', 'anti-magos'],
    risk: 'medio',
});

topNode({
    id: 'ki',
    name: 'Ki',
    cost: 180,
    shortEffect: 'Leitura avançada de presença, intenção, corpo e timing.',
    effect: 'Convergência maior da árvore física. Ki exige corpo treinado, leitura, instinto e aprovação narrativa para usos complexos.',
    requires: ['barbaro_ii', 'culto_ii', 'instinto_ii', 'contra_magos'],
    unlocks: ['zetten'],
    aliases: ['ki fisico', 'ki físico'],
});

topNode({
    id: 'zetten',
    name: 'Zetten',
    cost: 220,
    shortEffect: 'Execução física ofensiva extrema em 1 ação decisiva.',
    effect: 'Zetten concentra leitura, timing e execução física em uma ação ofensiva decisiva. Duração: 1 ação. Exige Ki, Força Aplicada alta, Precisão Técnica alta e aprovação narrativa.',
    requires: ['ki', 'forca_aplicada_iii', 'precisao_tecnica_iii'],
    unlocks: ['apice_fisico'],
    aliases: ['zetten fisico', 'zetten físico'],
    risk: 'extremo',
    weight: 8,
});

topNode({
    id: 'apice_fisico',
    name: 'Ápice Físico',
    cost: 260,
    shortEffect: 'Marco final simbólico e mecânico da rota física pura.',
    effect: 'Representa o topo da Árvore Física: corpo, leitura, Ki e Zetten integrados sob aprovação narrativa direta.',
    requires: ['ki', 'zetten'],
    aliases: ['apice fisico', 'ápice físico', 'apice'],
    risk: 'extremo',
    weight: 9,
});

function buildEdges(nodes) {
    const edges = [];
    const seen = new Set();
    const add = (from, to, type = 'requires') => {
        const key = `${from}->${to}:${type}`;
        if (!from || !to || seen.has(key)) return;
        seen.add(key);
        edges.push({ from, to, type });
    };
    for (const item of nodes) {
        for (const required of item.requires || []) add(required, item.id);
        for (const group of item.requiresAny || []) {
            for (const required of group) add(required, item.id, 'requires_any');
        }
        for (const unlocked of item.unlocks || []) add(item.id, unlocked, 'unlocks');
    }
    return edges;
}

function buildTree() {
    return {
        id: 'fisico',
        name: 'Árvore Física',
        subtitle: 'Corpo, vigor, controle, percepção, identidade, Ki e Zetten',
        description: 'Árvore física pura do Clover RPG. Reorganizada para RPG textual: linhas comuns em 4 níveis, sentidos em 5 níveis, marcos de identidade em 2 níveis e topo narrativo separado.',
        aliases: ['fisico', 'fisica', 'físico', 'física', 'arvore fisica', 'árvore física', 'arvore de fisico', 'arvore de físico'],
        routes: [
            { id: 'base', name: 'Físico', symbol: '•', shortDescription: 'Raiz da progressão física pura.', description: 'Base física geral.', leadsTo: ['Vigor', 'Controle Corporal', 'Percepção Física'] },
            { id: 'vigor', name: 'Vigor', symbol: '◆', shortDescription: 'Força, resistência e continuidade física.', description: 'Rota do corpo que aguenta, empurra, bate, continua e sustenta pressão.', leadsTo: ['Força Aplicada', 'Resistência Corporal', 'Condicionamento Físico'] },
            { id: 'controle', name: 'Controle Corporal', symbol: '◇', shortDescription: 'Mobilidade, reflexos e precisão.', description: 'Rota do corpo que se move, reage, mira e executa com controle.', leadsTo: ['Mobilidade', 'Reflexos Corporais', 'Precisão Técnica'] },
            { id: 'percepcao', name: 'Percepção Física', symbol: '◌', shortDescription: 'Sentidos e intuição física.', description: 'Rota sensorial sem bônus numérico.', leadsTo: ['Visão', 'Audição', 'Olfato', 'Tato', 'Paladar', 'Intuição Corporal'] },
            { id: 'identidade', name: 'Identidade Física', symbol: '✦', shortDescription: 'Bárbaro, Culto, Instinto e expressões.', description: 'Marcos que definem postura física em combate textual.', leadsTo: ['Bárbaro', 'Culto', 'Instinto', 'Tirano', 'Benevolente', 'Justo', 'Injusto'] },
            { id: 'topo', name: 'Topo Físico', symbol: '♢', shortDescription: 'Contra Magos, Ki, Zetten e Ápice.', description: 'Convergências altas e usos de aprovação narrativa.', leadsTo: ['Contra Magos', 'Ki', 'Zetten', 'Ápice Físico'] },
        ],
        nodes: treeNodes,
        edges: buildEdges(treeNodes),
        goals: [
            { id: 'base_fisica', name: 'Base Física', description: 'Começar a progressão física pura.', requires: ['fisico'] },
            { id: 'corpo_treinado', name: 'Corpo Treinado', description: 'Abrir Vigor e Controle Corporal.', requires: ['vigor', 'controle_corporal'] },
            { id: 'leitura_fisica', name: 'Leitura Física', description: 'Abrir a rota sensorial.', requires: ['percepcao_fisica'] },
            { id: 'marco_identidade', name: 'Marco de Identidade', description: 'Abrir pelo menos um marco físico relevante.', requires: ['barbaro_i', 'culto_i', 'instinto_i'] },
            { id: 'topo_fisico', name: 'Topo Físico', description: 'Alcançar Ki, Zetten ou Ápice Físico.', requires: ['ki', 'zetten', 'apice_fisico'] },
        ],
    };
}

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function nodeBox(id, label, sub, x, y, w, h, klass = 'normal') {
    return `<g class="node ${klass}" data-node-id="${esc(id)}" transform="translate(${x} ${y})">
<rect width="${w}" height="${h}" rx="22" ry="22"/>
<text class="label" x="${w / 2}" y="${Math.round(h * 0.42)}" text-anchor="middle">${esc(label)}</text>
${sub ? `<text class="tag" x="${w / 2}" y="${Math.round(h * 0.78)}" text-anchor="middle">${esc(sub)}</text>` : ''}
</g>`;
}

function rowNode(id, title, meta, x, y, w, h) {
    return `<g class="node rownode" data-node-id="${esc(id)}" transform="translate(${x} ${y})">
<rect width="${w}" height="${h}" rx="14" ry="14"/>
<text class="rowText" x="28" y="${Math.round(h * 0.40)}">${esc(title)}</text>
<text class="rowMeta" x="28" y="${Math.round(h * 0.72)}">${esc(meta)}</text>
</g>`;
}

function lineCard(line, x, y, theme) {
    const ids = ['iv', 'iii', 'ii', 'i'].map((suffix) => `${line.baseId}_${suffix}`);
    const levels = [
        ['IV · +40%', '110 PH · domínio'],
        ['III · +30%', '80 PH · avançado'],
        ['II · +20%', '50 PH · confiável'],
        ['I · +10%', '25 PH · inicial'],
    ];
    return `<g class="card ${theme}" transform="translate(${x} ${y})">
<rect class="outer" width="560" height="850" rx="26" ry="26"/>
<text class="cardTitle" x="280" y="54" text-anchor="middle">${esc(line.baseName.toUpperCase())}</text>
<text class="cardAttr" x="280" y="88" text-anchor="middle">${esc(line.attribute)} · ${esc(line.use.replace(/^ações de |^ações físicas de |^ações narrativas de /, ''))}</text>
${ids.map((id, index) => rowNode(id, levels[index][0], levels[index][1], 28, 125 + index * 175, 504, 150)).join('\n')}
</g>`;
}

function senseCard(sense, x, y) {
    const ids = ['v', 'iv', 'iii', 'ii', 'i'].map((suffix) => `${sense.baseId}_${suffix}`);
    const costs = [140, 110, 80, 55, 35];
    return `<g class="card sense" transform="translate(${x} ${y})">
<rect class="outer" width="250" height="1000" rx="22" ry="22"/>
<text class="cardTitle" x="125" y="52" text-anchor="middle">${esc(sense.baseName.toUpperCase().replace('INTUIÇÃO CORPORAL', 'INTUIÇÃO'))}</text>
<text class="cardAttr" x="125" y="84" text-anchor="middle">sem bônus numérico</text>
${ids.map((id, index) => rowNode(id, ['V', 'IV', 'III', 'II', 'I'][index], `${costs[index]} PH`, 22, 120 + index * 170, 206, 145)).join('\n')}
</g>`;
}

function buildHtml() {
    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Árvore Física - Clover Multicolor - Rework v1</title>
<style>
html, body { margin:0; padding:0; background:#e7e3d7; font-family:Arial, Helvetica, sans-serif; }
.wrap { width:100vw; height:100vh; overflow:auto; -webkit-overflow-scrolling:touch; }
.canvas { width:6400px; height:4100px; }
</style>
</head>
<body><div class="wrap"><div class="canvas">
<svg xmlns="http://www.w3.org/2000/svg" width="6400" height="4100" viewBox="0 0 6400 4100">
<defs><style>
.bg { fill:#f7f5ef; }
.frame { fill:none; stroke:#d4cec2; stroke-width:4; }
.title { font-family:Arial, Helvetica, sans-serif; font-size:66px; font-weight:900; letter-spacing:2px; fill:#151515; }
.subtitle { font-family:Arial, Helvetica, sans-serif; font-size:25px; font-weight:800; letter-spacing:1px; fill:#625d55; }
.edge { fill:none; stroke:#7b756c; stroke-width:4.2; stroke-linecap:round; stroke-linejoin:round; opacity:.64; }
.edge.strong { stroke:#1d1c19; stroke-width:5.8; opacity:.72; }
.edge.req { stroke:#7f796f; stroke-width:3.2; stroke-dasharray:15 13; opacity:.46; }
.section { fill:#fffdf8; stroke:#d7d0c4; stroke-width:3; opacity:.72; }
.sectionTitle { font-family:Arial, Helvetica, sans-serif; font-size:27px; font-weight:900; letter-spacing:2px; fill:#4d4740; }
.node rect, .card rect.outer { fill:#fffdf8; stroke:#171717; stroke-width:3.8; }
.node.root rect { fill:#fff3d8; stroke-width:5; }
.node.route rect { fill:#f7ecd9; stroke-width:4.4; }
.node.identity rect { fill:#f8f1ff; stroke-width:4.2; }
.node.future rect { fill:#eadcbf; stroke-width:4.8; }
.label { font-family:Arial, Helvetica, sans-serif; font-size:30px; font-weight:900; fill:#171717; dominant-baseline:middle; }
.node.root .label { font-size:49px; letter-spacing:1.4px; }
.node.route .label, .node.future .label { font-size:36px; }
.node.identity .label { font-size:30px; }
.tag { font-family:Arial, Helvetica, sans-serif; font-size:18px; font-weight:850; letter-spacing:.8px; fill:#6a635a; }
.badge { fill:#fffdf8; stroke:#d0c8bb; stroke-width:3; }
.badgeTitle { font-family:Arial, Helvetica, sans-serif; font-size:24px; font-weight:900; fill:#171717; }
.badgeText { font-family:Arial, Helvetica, sans-serif; font-size:21px; font-weight:800; fill:#4e4942; }
.card.vigor .outer { fill:#fff7ee; stroke:#7a3f32; }
.card.control .outer { fill:#f1fbff; stroke:#315d7a; }
.card.sense .outer { fill:#f5fff1; stroke:#4f7240; }
.cardTitle { font-family:Arial, Helvetica, sans-serif; font-size:27px; font-weight:900; letter-spacing:.7px; fill:#171717; }
.cardAttr { font-family:Arial, Helvetica, sans-serif; font-size:18px; font-weight:850; fill:#6a635a; }
.rownode rect { fill:rgba(255,255,255,.76); stroke:rgba(23,23,23,.18); stroke-width:2; }
.rowText { font-family:Arial, Helvetica, sans-serif; font-size:21px; font-weight:900; fill:#171717; }
.rowMeta { font-family:Arial, Helvetica, sans-serif; font-size:18px; font-weight:800; fill:#615b52; }
.sense .cardTitle { font-size:22px; }
.sense .rowText { font-size:19px; }
.sense .rowMeta { font-size:16px; }
</style></defs>
<rect class="bg" width="6400" height="4100"/>
<rect class="frame" x="100" y="100" width="6200" height="3900" rx="42" ry="42"/>
<text class="title" x="150" y="180">ÁRVORE FÍSICA</text>
<text class="subtitle" x="155" y="228">CLOVER MULTICOLOR · REWORK TEXTUAL · BAIXO PARA CIMA</text>
<g transform="translate(3860 125)">
  <rect class="badge" width="2260" height="154" rx="24" ry="24"/>
  <text class="badgeTitle" x="38" y="50">LEITURA DO MAPA</text>
  <text class="badgeText" x="38" y="91">Linhas físicas comuns: I/II/III/IV = +10/+20/+30/+40%.</text>
  <text class="badgeText" x="38" y="126">Sentidos e Intuição: I a V, sem bônus numérico; começam em 35 PH.</text>
</g>
<g id="sections">
  <rect class="section" x="210" y="2230" width="2010" height="1260" rx="34" ry="34"/><text class="sectionTitle" x="270" y="2300">VIGOR</text>
  <rect class="section" x="2260" y="2230" width="2010" height="1260" rx="34" ry="34"/><text class="sectionTitle" x="2320" y="2300">CONTROLE CORPORAL</text>
  <rect class="section" x="4310" y="2115" width="1870" height="1375" rx="34" ry="34"/><text class="sectionTitle" x="4370" y="2185">PERCEPÇÃO FÍSICA</text>
  <rect class="section" x="210" y="1320" width="5970" height="745" rx="34" ry="34"/><text class="sectionTitle" x="270" y="1390">MARCOS DE IDENTIDADE</text>
</g>
<g id="edges">
  <path class="edge strong" d="M 3200 3745 C 3200 3680, 3200 3658, 3200 3605"/>
  <path class="edge strong" d="M 3200 3605 C 2450 3605, 2085 3515, 1330 3515"/>
  <path class="edge strong" d="M 3200 3605 C 3200 3570, 3200 3548, 3200 3515"/>
  <path class="edge strong" d="M 3200 3605 C 3920 3605, 4375 3515, 5070 3515"/>
  <path class="edge req" d="M 540 2380 C 690 2180, 1020 2100, 1330 1990"/>
  <path class="edge req" d="M 1210 2380 C 1230 2200, 1290 2100, 1330 1990"/>
  <path class="edge req" d="M 1880 2380 C 1660 2200, 1460 2110, 1330 1990"/>
  <path class="edge req" d="M 2540 2380 C 2730 2185, 3000 2105, 3200 1990"/>
  <path class="edge req" d="M 3210 2380 C 3210 2195, 3200 2110, 3200 1990"/>
  <path class="edge req" d="M 3880 2380 C 3625 2185, 3390 2105, 3200 1990"/>
  <path class="edge req" d="M 5940 2115 C 5660 2050, 5350 2020, 5070 1990"/>
  <path class="edge strong" d="M 1330 1775 C 1100 1735, 920 1705, 800 1665"/>
  <path class="edge strong" d="M 1330 1775 C 1555 1735, 1745 1705, 1860 1665"/>
  <path class="edge strong" d="M 3200 1775 C 3015 1735, 2845 1705, 2740 1665"/>
  <path class="edge strong" d="M 3200 1775 C 3395 1735, 3580 1705, 3710 1665"/>
  <path class="edge strong" d="M 1330 1775 C 1910 1580, 2590 1480, 3200 1480"/>
  <path class="edge strong" d="M 3200 1775 C 3200 1660, 3200 1580, 3200 1480"/>
  <path class="edge strong" d="M 5070 1775 C 4520 1580, 3820 1480, 3200 1480"/>
  <path class="edge strong" d="M 3200 1420 C 3200 1325, 3200 1288, 3200 1195"/>
  <path class="edge strong" d="M 3200 1135 C 3200 1030, 3200 990, 3200 890"/>
  <path class="edge strong" d="M 3200 830 C 3200 720, 3200 680, 3200 575"/>
</g>
${nodeBox('apice_fisico', 'ÁPICE FÍSICO', 'domínio narrativo extremo', 2920, 455, 560, 120, 'future')}
${nodeBox('zetten', 'ZETTEN', '1 ação decisiva', 2980, 830, 440, 120, 'future')}
${nodeBox('ki', 'KI', 'convergência maior', 2980, 1135, 440, 120, 'future')}
${nodeBox('contra_magos', 'CONTRA MAGOS', 'leitura + precisão', 4650, 1420, 560, 120, 'future')}
${nodeBox('barbaro_i', 'BÁRBARO I', '100 PH · Força/Resistência', 1050, 1775, 560, 120, 'identity')}
${nodeBox('barbaro_ii', 'BÁRBARO II', '140 PH · presença corporal', 1050, 1905, 560, 105, 'identity')}
${nodeBox('tirano_i', 'TIRANO I', '80 PH · Força Aplicada +10%', 520, 1545, 560, 120, 'identity')}
${nodeBox('tirano_ii', 'TIRANO II', '120 PH · Força Aplicada +20%', 520, 1680, 560, 105, 'identity')}
${nodeBox('benevolente_i', 'BENEVOLENTE I', '80 PH · redução 10%', 1580, 1545, 560, 120, 'identity')}
${nodeBox('benevolente_ii', 'BENEVOLENTE II', '120 PH · redução 20%', 1580, 1680, 560, 105, 'identity')}
${nodeBox('culto_i', 'CULTO I', '100 PH · leitura técnica', 2920, 1775, 560, 120, 'identity')}
${nodeBox('culto_ii', 'CULTO II', '140 PH · leitura refinada', 2920, 1905, 560, 105, 'identity')}
${nodeBox('justo_i', 'JUSTO I', '80 PH · defesa limpa +10%', 2460, 1545, 560, 120, 'identity')}
${nodeBox('justo_ii', 'JUSTO II', '120 PH · defesa limpa +20%', 2460, 1680, 560, 105, 'identity')}
${nodeBox('injusto_i', 'INJUSTO I', '80 PH · brecha/finta +10%', 3440, 1545, 560, 120, 'identity')}
${nodeBox('injusto_ii', 'INJUSTO II', '120 PH · brecha/finta +20%', 3440, 1680, 560, 105, 'identity')}
${nodeBox('instinto_i', 'INSTINTO I', '100 PH · Reflexos +10%', 4790, 1775, 560, 120, 'identity')}
${nodeBox('instinto_ii', 'INSTINTO II', '140 PH · Reflexos +20%', 4790, 1905, 560, 105, 'identity')}
${lineCard(physicalLines[0], 260, 2380, 'vigor')}
${lineCard(physicalLines[1], 930, 2380, 'vigor')}
${lineCard(physicalLines[2], 1600, 2380, 'vigor')}
${lineCard(physicalLines[3], 2260, 2380, 'control')}
${lineCard(physicalLines[4], 2930, 2380, 'control')}
${lineCard(physicalLines[5], 3600, 2380, 'control')}
${senseCard(senseLines[0], 4365, 2230)}
${senseCard(senseLines[1], 4655, 2230)}
${senseCard(senseLines[2], 4945, 2230)}
${senseCard(senseLines[3], 5235, 2230)}
${senseCard(senseLines[4], 5525, 2230)}
${senseCard(senseLines[5], 5815, 2230)}
${nodeBox('vigor', 'VIGOR', 'força · resistência · continuidade', 1050, 3430, 560, 118, 'route')}
${nodeBox('controle_corporal', 'CONTROLE', 'movimento · reação · precisão', 2920, 3430, 560, 118, 'route')}
${nodeBox('percepcao_fisica', 'PERCEPÇÃO', 'sentidos · intuição · leitura', 4790, 3430, 560, 118, 'route')}
${nodeBox('fisico', 'FÍSICO', 'base · 15 PH', 2920, 3745, 560, 118, 'root')}
</svg></div></div></body></html>`;
}

function writeTreeAndHtml() {
    const tree = buildTree();
    fs.writeFileSync(TREE_PATH, `${JSON.stringify(tree, null, 2)}\n`, 'utf8');
    fs.writeFileSync(HTML_PATH, buildHtml(), 'utf8');
    return tree;
}

async function migrateDatabase() {
    const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    await db.exec('PRAGMA busy_timeout = 30000');
    await ensureCloverSkillTreeSchema(db);
    const already = await db.get(
        'SELECT COUNT(*) AS count FROM clover_ph_ledger WHERE source = ? OR related_id = ?',
        [MIGRATION_SOURCE, MIGRATION_RELATED_ID]
    );

    if (Number(already?.count || 0) > 0) {
        await db.close();
        return { skipped: true, reason: 'migration_already_recorded' };
    }

    const purchases = await db.all(
        `SELECT id, player_id, node_id, metadata_json
         FROM clover_skill_nodes
         WHERE tree_id = 'fisico'
         ORDER BY player_id, id`
    );

    const spends = await db.all(
        `SELECT id, player_id, amount, related_id, metadata_json
         FROM clover_ph_ledger
         WHERE kind = 'gasto' AND source = 'skill_tree:fisico'
         ORDER BY player_id, id`
    );

    const players = [...new Set([...purchases, ...spends].map((row) => row.player_id))];
    const byPlayer = new Map(players.map((playerId) => [playerId, {
        playerId,
        purchaseIds: [],
        nodeIds: [],
        ledgerIds: [],
        refund: 0,
    }]));

    for (const purchase of purchases) {
        const item = byPlayer.get(purchase.player_id);
        item.purchaseIds.push(purchase.id);
        item.nodeIds.push(purchase.node_id);
    }

    for (const spend of spends) {
        const item = byPlayer.get(spend.player_id);
        item.ledgerIds.push(spend.id);
        item.refund += Math.abs(Number(spend.amount || 0));
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        for (const item of byPlayer.values()) {
            if (item.refund > 0) {
                await db.run(
                    `INSERT INTO clover_ph_ledger
                     (player_id, amount, kind, source, reason, related_id, created_by, created_at, metadata_json)
                     VALUES (?, ?, 'estorno', ?, ?, ?, 'system', CURRENT_TIMESTAMP, ?)`,
                    [
                        item.playerId,
                        item.refund,
                        MIGRATION_SOURCE,
                        'Reembolso automático da Árvore Física antiga para o rework textual v1.',
                        MIGRATION_RELATED_ID,
                        JSON.stringify({
                            migration: 'fisico_rework_v1',
                            accumulated_delta: 0,
                            available_delta: item.refund,
                            refunded_purchase_ids: item.purchaseIds,
                            refunded_ledger_ids: item.ledgerIds,
                            refunded_node_ids: item.nodeIds,
                        }),
                    ]
                );
            }
        }

        await db.run("DELETE FROM clover_pending_skill_purchases WHERE tree_id = 'fisico'");
        await db.run("DELETE FROM clover_skill_nodes WHERE tree_id = 'fisico'");
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        await db.close();
        throw error;
    }

    async function retryBusy(fn) {
        let lastError = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                if (error?.code !== 'SQLITE_BUSY') throw error;
                await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
            }
        }
        throw lastError;
    }

    for (const playerId of players) {
        await retryBusy(() => getPhSummary(db, playerId));
    }

    await db.close();
    return {
        skipped: false,
        players: [...byPlayer.values()].map((item) => ({
            playerId: item.playerId,
            refund: item.refund,
            nodes: item.nodeIds.length,
        })),
    };
}

function clearFisicoCache() {
    if (!fs.existsSync(CACHE_DIR)) return 0;
    let removed = 0;
    for (const file of fs.readdirSync(CACHE_DIR)) {
        if (!/fisico/i.test(file)) continue;
        fs.unlinkSync(path.join(CACHE_DIR, file));
        removed += 1;
    }
    return removed;
}

(async () => {
    const backupDir = backupFiles();
    const tree = writeTreeAndHtml();
    const migration = await migrateDatabase();
    const cacheRemoved = clearFisicoCache();

    console.log(JSON.stringify({
        ok: true,
        backupDir,
        treeNodes: tree.nodes.length,
        treeEdges: tree.edges.length,
        migration,
        cacheRemoved,
    }, null, 2));
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
