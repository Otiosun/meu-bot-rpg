const { MAINTENANCE_TIERS, calculateRankCost } = require('./balanceGuide');

function clean(value) {
    return String(value ?? '').trim();
}

function n(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function roman(level) {
    return ['', 'I', 'II', 'III', 'IV', 'V'][n(level)] || String(level || '');
}

function percent(level) {
    return [0, 10, 20, 30, 40, 50][n(level)] || 0;
}

function mentionName(capacity) {
    return clean(capacity?.displayName) || 'Personagem';
}

function header(title, subtitle) {
    return [
        `*♧┃${title} 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*`,
        `     ── ${subtitle} ──`,
    ];
}

function section(symbol, title) {
    return `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;
}

function field(label, value) {
    const display = value === null || value === undefined || value === '' ? '-' : value;
    return `*${label}:* ${display}`;
}

function list(lines, fallback = 'nada registrado') {
    const cleanLines = (lines || []).map(clean).filter(Boolean);
    if (!cleanLines.length) return `> ${fallback}`;
    return cleanLines.map((line) => `> ${line}`).join('\n');
}

function compact(lines, fallback = 'nenhum', limit = 6) {
    const cleanLines = (lines || []).map(clean).filter(Boolean);
    if (!cleanLines.length) return fallback;
    const visible = cleanLines.slice(0, limit);
    const extra = cleanLines.length - visible.length;
    return `${visible.join(', ')}${extra > 0 ? ` +${extra}` : ''}`;
}

function basicPb(capacity) {
    const total = n(capacity?.stats?.pb_total, 10);
    return Math.max(10, Math.floor(total * 0.25));
}

function rankCost(weight) {
    const safeWeight = Math.max(1, n(weight, 1));
    const cost = calculateRankCost(safeWeight);
    return {
        weight: safeWeight,
        rank: cost.rank,
        mana: cost.special ? 'especial' : `${cost.totalMana} mana`,
    };
}

function costLine(label, weight, note = '') {
    const cost = rankCost(weight);
    const suffix = note ? ` | ${note}` : '';
    return `${label}: Peso ${cost.weight} → Rank ${cost.rank} → ${cost.mana}${suffix}`;
}

function maintenanceLines() {
    return MAINTENANCE_TIERS.map((tier) => (
        tier.percent
            ? `${tier.label} ${tier.percent}%: ${tier.description}`
            : `${tier.label}: ${tier.description}`
    ));
}

function ladder(label, currentLevel, maxLevel = 3, valueFn = percentValue, context = '') {
    const current = n(currentLevel);
    const lastVisible = Math.min(maxLevel, Math.max(1, current + 1));
    const lines = [];

    for (let level = 1; level <= lastVisible; level += 1) {
        const status = level < current ? 'comprado' : level === current ? 'atual' : 'não comprado';
        const value = valueFn(level);
        lines.push(`${label} ${roman(level)}: ${value}${context ? ` — ${context}` : ''} — ${status}.`);
    }

    return lines;
}

function percentValue(level) {
    return `+${percent(level)}%`;
}

function levelValue(level) {
    return `nível ${roman(level)}`;
}

function currentLine(label, level, text) {
    if (!level) return null;
    return `${label} ${roman(level)}: ${text}`;
}

function creationFlags(capacity) {
    return capacity?.creation?.flags || {};
}

function reinforcementFlags(capacity) {
    return capacity?.reinforcement?.flags || {};
}

function manaFlags(capacity) {
    return capacity?.mana?.flags || {};
}

function physicalData(capacity) {
    return capacity?.physical || {};
}

function creationPlayerLines(capacity) {
    const flags = creationFlags(capacity);
    if (!flags.base) return ['Ainda não tem Criação comprada.'];

    return [
        'Cria formas simples fora do corpo: esfera, lâmina simples, fio, bloco, névoa pequena, projétil curto ou barreira simples.',
        flags.control ? 'Controle: pode mover, guiar, ajustar e segurar a forma criada.' : null,
        flags.structure ? 'Estrutura: a criação pode ter mais corpo, encaixe e firmeza.' : null,
        currentLine('Força Mágica', flags.forceLevel, `quando a criação causa dano ou impacto, entra com +${percent(flags.forceLevel)}%.`),
        currentLine('Velocidade Mágica', flags.speedLevel, `quando a criação se desloca, avança ou dispara, entra com +${percent(flags.speedLevel)}%.`),
        currentLine('Defesa Mágica', flags.defenseLevel, `quando a criação bloqueia, cobre ou protege, entra com +${percent(flags.defenseLevel)}%.`),
        currentLine('Densidade', flags.densityLevel, 'a forma fica mais compacta, firme e difícil de quebrar.'),
        currentLine('Precisão', flags.precisionLevel, 'melhora mira, encaixe e detalhe fino. Não garante acerto.'),
        flags.junction ? 'Junção de Forma: pode juntar forma e função quando o feitiço tiver base para isso.' : null,
        currentLine('Armas', flags.weaponsLevel, 'melhora criação de armas mágicas.'),
        currentLine('Formas Humanoides', flags.humanoidsLevel, 'melhora criação de construtos, corpos mágicos ou formas humanoides.'),
        currentLine('Ambiente', flags.environmentLevel, 'melhora criação em área, campo ou cenário.'),
    ].filter(Boolean);
}

function creationTechnicalLines(capacity) {
    const flags = creationFlags(capacity);
    if (!flags.base) return ['Sem Criação comprada.'];

    return [
        '*Base:*',
        list(creationPlayerLines(capacity)),
        '',
        '*Escada comprada:*',
        list([
            ...ladder('Força Mágica', flags.forceLevel, 3, percentValue, 'dano/impacto da criação'),
            ...ladder('Velocidade Mágica', flags.speedLevel, 3, percentValue, 'movimento/disparo da criação'),
            ...ladder('Defesa Mágica', flags.defenseLevel, 3, percentValue, 'bloqueio/defesa da criação'),
            ...ladder('Densidade', flags.densityLevel, 3, levelValue, 'firmeza/resistência da forma'),
            ...ladder('Precisão', flags.precisionLevel, 3, levelValue, 'mira/encaixe/detalhe fino'),
            ...ladder('Armas', flags.weaponsLevel, 3, levelValue, 'armas mágicas'),
            ...ladder('Formas Humanoides', flags.humanoidsLevel, 3, levelValue, 'construtos/corpos mágicos'),
            ...ladder('Ambiente', flags.environmentLevel, 3, levelValue, 'área/campo/cenário'),
        ]),
        '',
        '*Pesos sugeridos:*',
        list(creationCostLines(flags)),
        '',
        '*Onde não entra:*',
        list(creationNonUseLines(flags)),
    ];
}

function creationCostLines(flags) {
    const lines = [];
    if (!flags.base) return lines;
    lines.push(costLine('Forma simples', 2));
    if (flags.control) lines.push(costLine('Forma com Controle', 2));
    if (flags.structure) lines.push(costLine('Forma com Estrutura', 3));
    if (flags.forceLevel) lines.push(costLine(`Forma ofensiva + Força Mágica ${roman(flags.forceLevel)}`, 2 + flags.forceLevel));
    if (flags.speedLevel) lines.push(costLine(`Forma móvel + Velocidade Mágica ${roman(flags.speedLevel)}`, 2 + flags.speedLevel));
    if (flags.defenseLevel) lines.push(costLine(`Forma defensiva + Defesa Mágica ${roman(flags.defenseLevel)}`, 2 + flags.defenseLevel));
    if (flags.forceLevel && flags.precisionLevel) lines.push(costLine(`Ofensiva + Força ${roman(flags.forceLevel)} + Precisão ${roman(flags.precisionLevel)}`, 2 + flags.forceLevel + flags.precisionLevel));
    if (flags.forceLevel && flags.densityLevel) lines.push(costLine(`Ofensiva + Força ${roman(flags.forceLevel)} + Densidade ${roman(flags.densityLevel)}`, 2 + flags.forceLevel + flags.densityLevel));
    if (flags.weaponsLevel) lines.push(costLine(`Manifestação armada ${roman(flags.weaponsLevel)}`, 3 + flags.weaponsLevel));
    if (flags.humanoidsLevel) lines.push(costLine(`Construto/Forma humanoide ${roman(flags.humanoidsLevel)}`, 4 + flags.humanoidsLevel, 'normalmente exige manutenção'));
    if (flags.environmentLevel) lines.push(costLine(`Área/Campo com Ambiente ${roman(flags.environmentLevel)}`, 4 + flags.environmentLevel, 'normalmente exige manutenção média ou pesada'));
    return lines;
}

function creationNonUseLines(flags) {
    return [
        flags.forceLevel ? 'Força Mágica não melhora mira, alcance, velocidade, duração ou defesa.' : null,
        flags.speedLevel ? 'Velocidade Mágica não aumenta dano, defesa, duração ou mira sozinha.' : null,
        flags.defenseLevel ? 'Defesa Mágica não aumenta dano, velocidade, mira ou alcance.' : null,
        flags.precisionLevel ? 'Precisão não garante acerto, não ignora defesa e não remove reação.' : null,
        flags.densityLevel ? 'Densidade não transforma a criação em técnica automática ou indestrutível.' : null,
        !flags.junction ? 'Sem Junção de Forma, não junta várias funções complexas no mesmo feitiço.' : null,
        !flags.environmentLevel ? 'Sem Ambiente, não vira campo grande, criação persistente ou área automática.' : null,
        !flags.weaponsLevel ? 'Sem Armas, não vira arma mágica avançada.' : null,
        !flags.humanoidsLevel ? 'Sem Formas Humanoides, não vira construto vivo/autônomo.' : null,
        'Nada disso libera acerto automático, dano inevitável ou perseguição perfeita.',
    ].filter(Boolean);
}

function reinforcementPlayerLines(capacity) {
    const flags = reinforcementFlags(capacity);
    if (!flags.base) return ['Ainda não tem Reforço comprado.'];

    return [
        'Consegue fortalecer o corpo com magia em ações simples.',
        flags.intensityLevel ? `Intensidade ${roman(flags.intensityLevel)}: +${percent(flags.intensityLevel)}% quando o reforço usa potência.` : 'Sem Intensidade comprada, o reforço fica no uso inicial/pequeno.',
        flags.stabilityLevel ? `Estabilidade ${roman(flags.stabilityLevel)}: o reforço oscila menos e sustenta melhor.` : null,
        flags.focusCount ? `Foco: pode manter ${flags.focusCount} atributo${flags.focusCount > 1 ? 's' : ''} como foco do mesmo reforço.` : null,
        flags.attributes?.length ? `Atributos liberados: ${flags.attributes.join(', ')}.` : null,
        flags.selfBuff ? 'Invencível: reforço em si mesmo.' : null,
        flags.otherBuff ? 'Invicto: caminho para reforçar outro alvo.' : null,
        flags.touchBuff ? 'Reforço por toque: pode aplicar reforço externo por contato.' : null,
        flags.distanceBuff ? 'Reforço à distância: aplica reforço externo respeitando Alcance, Emissão e Controle.' : null,
        flags.collectiveBuff ? 'Reforço coletivo: pode alcançar mais de um alvo quando custo e cena sustentarem.' : null,
        flags.advanced ? 'Reforço Avançado: libera usos mais complexos.' : null,
        flags.advancedWeapons ? 'Reforço Avançado — Armas: pode ligar reforço a arma.' : null,
        flags.advancedHumanoids ? 'Reforço Avançado — Formas Humanoides: pode ligar reforço a armadura, exoesqueleto, avatar ou corpo mágico.' : null,
        flags.advancedEnvironment ? 'Reforço Avançado — Ambiente: pode levar reforço para área/campo.' : null,
    ].filter(Boolean);
}

function reinforcementTechnicalLines(capacity) {
    const flags = reinforcementFlags(capacity);
    if (!flags.base) return ['Sem Reforço comprado.'];

    return [
        '*Base:*',
        list(reinforcementPlayerLines(capacity)),
        '',
        '*Escada comprada:*',
        list([
            ...ladder('Intensidade', flags.intensityLevel, 3, percentValue, 'potência do reforço'),
            ...ladder('Estabilidade', flags.stabilityLevel, 3, levelValue, 'duração/segurança do reforço'),
        ]),
        '',
        '*Pesos sugeridos:*',
        list(reinforcementCostLines(flags)),
        '',
        '*Onde não entra:*',
        list(reinforcementNonUseLines(flags)),
    ];
}

function reinforcementCostLines(flags) {
    const lines = [];
    if (!flags.base) return lines;
    lines.push(costLine('Reforço básico de 1 ação', 2, 'leitura inicial/pequena'));
    if (flags.intensityLevel) lines.push(costLine(`Reforço + Intensidade ${roman(flags.intensityLevel)}`, 2 + flags.intensityLevel));
    if (flags.intensityLevel && flags.stabilityLevel) lines.push(costLine(`Reforço + Intensidade ${roman(flags.intensityLevel)} + Estabilidade ${roman(flags.stabilityLevel)}`, 2 + flags.intensityLevel + flags.stabilityLevel, 'normalmente tem manutenção'));
    if (flags.attributes?.length && flags.selfBuff) lines.push(costLine(`Autobuff de ${Math.min(flags.focusCount || 1, flags.attributes.length)} atributo(s)`, 3 + Math.max(1, flags.intensityLevel || 1), 'manutenção leve/média'));
    if (flags.distanceBuff) lines.push(costLine('Reforço externo à distância', 6, 'depende de Alcance/Emissão/Controle'));
    if (flags.collectiveBuff) lines.push(costLine('Reforço coletivo simples', 8, 'manutenção muito pesada'));
    if (flags.advancedEnvironment) lines.push(costLine('Reforço avançado em área/campo', 9, 'manutenção pesada ou muito pesada'));
    return lines;
}

function reinforcementNonUseLines(flags) {
    return [
        flags.intensityLevel ? 'Intensidade não aumenta alcance, número de alvos, duração ou atributo não liberado.' : null,
        flags.stabilityLevel ? 'Estabilidade não aumenta potência; só ajuda duração/segurança.' : null,
        !flags.attributes?.length ? 'Sem atributo reforçado, o reforço fica genérico.' : null,
        !flags.selfBuff ? 'Sem Invencível, não trata autobuff como rota completa.' : null,
        !flags.otherBuff ? 'Sem Invicto, não trata buff em aliados como livre.' : null,
        !flags.collectiveBuff ? 'Sem Reforço Coletivo, não pega vários alvos.' : null,
        !flags.advanced ? 'Sem Reforço Avançado, não reforça arma, armadura, avatar ou campo de forma complexa.' : null,
    ].filter(Boolean);
}

function manaPlayerLines(capacity) {
    const flags = manaFlags(capacity);
    if (!flags.base && !flags.flow && !flags.bulletLevel && !flags.pulseLevel && !flags.manaSkin) {
        return ['Ainda não tem avanço relevante em Mana registrado.'];
    }

    return [
        flags.base ? 'Base de Mana: leitura e manipulação inicial.' : null,
        flags.perception || flags.sensing ? `Percepção de Mana${flags.sensingLevel ? ` ${roman(flags.sensingLevel)}` : ''}: percebe mana evidente e fluxo básico.` : null,
        flags.signature ? 'Assinatura Mágica: reconhece assinatura quando existe pista real.' : null,
        flags.flow ? 'Fluxo de Mana: melhora circulação, estabilidade e execução.' : null,
        flags.circulation ? 'Circulação: o corpo lida melhor com mana interna.' : null,
        flags.stability ? 'Estabilidade: reduz oscilação e desperdício em usos compatíveis.' : null,
        flags.channeling ? 'Canalização: direciona mana para corpo, objeto, técnica ou ponto de uso.' : null,
        flags.emission ? 'Emissão: joga mana para fora do corpo dentro do Hexágono.' : null,
        flags.retention ? 'Retenção: ajuda a manter efeitos e segurar mana.' : null,
        flags.bulletLevel ? `Bala de Mana ${roman(flags.bulletLevel)}: disparo simples de mana pura.` : null,
        flags.pulseLevel ? `Pulso de Mana ${roman(flags.pulseLevel)}: onda curta de mana pura.` : null,
        flags.manaSkin ? `Pele de Mana ${roman(flags.manaSkinLevel)}: revestimento corporal de mana.` : null,
        flags.manaMantle ? 'Manto de Mana: cobertura mais pesada e custosa.' : null,
        flags.field ? `Campo de Mana ${roman(flags.fieldLevel)}: presença de mana em área próxima.` : null,
        flags.economy ? `Economia de Mana ${roman(flags.economyLevel)}: reduz gasto real quando o uso combina.` : null,
        flags.recoveryLevel ? `Recuperação ${roman(flags.recoveryLevel)}: melhora retomada de mana conforme regra da cena.` : null,
        flags.environment ? `Ambiente de Mana ${roman(flags.environmentLevel)}: usa mana do entorno quando houver base de cena.` : null,
        flags.zone ? `Mana Zone ${roman(flags.zoneLevel)}: domínio de zona dentro dos limites do sistema.` : null,
        flags.fineControl ? `Controle Fino ${roman(flags.fineControlLevel)}: curvas, ajustes e manipulação delicada.` : null,
        flags.compression ? 'Compressão de Mana: concentra mana para usos mais densos.' : null,
        flags.objectCoating ? 'Revestimento de Objeto: cobre objeto com mana.' : null,
        flags.simultaneousMaintenance ? 'Manutenção Simultânea: ajuda a manter mais de um efeito.' : null,
        flags.pressure ? 'Pressão de Mana: conversa com PRE do Hexágono.' : null,
        flags.domain ? 'Domínio de Mana: topo manual.' : null,
    ].filter(Boolean);
}

function manaTechnicalLines(capacity) {
    const flags = manaFlags(capacity);
    return [
        '*Base:*',
        list(manaPlayerLines(capacity)),
        '',
        '*Escada comprada:*',
        list([
            ...ladder('Bala de Mana', flags.bulletLevel, 3, levelValue, 'mana pura ofensiva'),
            ...ladder('Pulso de Mana', flags.pulseLevel, 3, levelValue, 'onda curta de mana'),
            ...ladder('Pele de Mana', flags.manaSkinLevel, 3, levelValue, 'revestimento corporal'),
            ...ladder('Campo de Mana', flags.fieldLevel, 3, levelValue, 'área próxima'),
            ...ladder('Economia de Mana', flags.economyLevel, 3, levelValue, 'redução de gasto real'),
            ...ladder('Recuperação', flags.recoveryLevel, 3, levelValue, 'retomada de mana'),
            ...ladder('Ambiente de Mana', flags.environmentLevel, 3, levelValue, 'mana do entorno'),
            ...ladder('Mana Zone', flags.zoneLevel, 3, levelValue, 'zona/campo'),
            ...ladder('Controle Fino', flags.fineControlLevel, 3, levelValue, 'curvas e manipulação fina'),
        ]),
        '',
        '*Pesos sugeridos:*',
        list(manaCostLines(flags)),
        '',
        '*Onde não entra:*',
        list(manaNonUseLines(flags)),
    ];
}

function manaCostLines(flags) {
    const lines = [];
    if (flags.bulletLevel) lines.push(costLine(`Bala de Mana ${roman(flags.bulletLevel)}`, flags.bulletLevel * 2));
    if (flags.pulseLevel) lines.push(costLine(`Pulso de Mana ${roman(flags.pulseLevel)}`, flags.pulseLevel * 2));
    if (flags.manaSkin) lines.push(costLine(`Pele de Mana ${roman(flags.manaSkinLevel || 1)}`, Math.max(2, (flags.manaSkinLevel || 1) * 2), 'manutenção leve'));
    if (flags.manaMantle) lines.push(costLine('Manto de Mana', 5, 'manutenção média; pode virar pesada'));
    if (flags.field) lines.push(costLine(`Campo de Mana ${roman(flags.fieldLevel)}`, 4 + flags.fieldLevel, 'manutenção média/pesada'));
    if (flags.zone) lines.push(costLine(`Mana Zone ${roman(flags.zoneLevel)}`, 7 + flags.zoneLevel, 'manutenção pesada'));
    if (flags.compression) lines.push(costLine('Compressão de Mana', 5, 'pode aumentar risco/custo conforme efeito'));
    if (flags.objectCoating) lines.push(costLine('Revestimento de Objeto', 4, 'depende do objeto e duração'));
    return lines;
}

function manaNonUseLines(flags) {
    return [
        flags.bulletLevel ? 'Bala de Mana não vira magia elemental, debuff ou técnica especial sozinha.' : null,
        flags.pulseLevel ? 'Pulso de Mana não prende, paralisa ou remove turno sozinho.' : null,
        flags.economy ? 'Economia reduz gasto real quando couber; não muda o peso bruto usado pelo ADM.' : null,
        flags.recoveryLevel ? 'Recuperação não cura ferimento e não devolve mana infinita.' : null,
        !flags.zone ? 'Sem Mana Zone, não vira domínio amplo de área.' : null,
        !flags.simultaneousMaintenance ? 'Sem Manutenção Simultânea, não mantém vários efeitos fortes ao mesmo tempo.' : null,
        'Mana pura não copia efeito do tipo de magia, Criação, Reforço ou Suporte.',
    ].filter(Boolean);
}

function physicalPlayerLines(capacity) {
    const physical = physicalData(capacity);
    const flags = physical.flags || {};
    const levels = physical.levels || {};
    if (!flags.base) return ['Ainda não tem Físico comprado.'];

    const add = (label, level, text) => (level ? `${label} ${roman(level)}: +${percent(level)}% ${text}` : null);
    const senses = Object.entries(levels.senses || {})
        .filter(([, level]) => level > 0)
        .map(([key, level]) => `${key} ${roman(level)}`);
    const identities = Object.entries(levels.identities || {})
        .filter(([, level]) => level > 0)
        .map(([key, level]) => `${key} ${roman(level)}`);

    return [
        'Base física: corpo, postura, esforço e leitura corporal inicial.',
        flags.vigor ? 'Vigor: abre força aplicada, resistência corporal e condicionamento.' : null,
        flags.control ? 'Controle Corporal: abre mobilidade, reflexos e precisão técnica.' : null,
        flags.perception ? 'Percepção Física: abre sentidos e intuição corporal.' : null,
        add('Força Aplicada', levels.strength, 'em golpe, puxar, empurrar, travar, quebrar e força útil.'),
        add('Resistência Corporal', levels.resistance, 'em dor, tranco, postura e continuar sob pressão.'),
        add('Condicionamento Físico', levels.conditioning, 'em fôlego, ritmo e esforço prolongado.'),
        add('Mobilidade', levels.mobility, 'em avanço, recuo, fuga, perseguição e reposicionamento.'),
        add('Reflexos Corporais', levels.reflexes, 'em reação, esquiva, troca de direção e resposta física.'),
        add('Precisão Técnica', levels.precision, 'em brecha real, ponto certo, desarme e entrada limpa.'),
        senses.length ? `Sentidos treinados: ${senses.join(', ')}.` : null,
        identities.length ? `Identidades físicas: ${identities.join(', ')}.` : null,
        flags.antiMage ? 'Contra Magos: lê e pune janela física de conjuração; não é antimagia.' : null,
        flags.ki ? 'Ki registrado: uso complexo ainda depende de aprovação.' : null,
        flags.zetten ? 'Zetten registrado: uso decisivo ainda depende de aprovação.' : null,
        flags.apex ? 'Ápice Físico: topo da rota física.' : null,
    ].filter(Boolean);
}

function physicalTechnicalLines(capacity) {
    const physical = physicalData(capacity);
    const flags = physical.flags || {};
    const levels = physical.levels || {};
    if (!flags.base) return ['Sem Físico comprado.'];

    return [
        '*Base:*',
        list(physicalPlayerLines(capacity)),
        '',
        '*Escada comprada:*',
        list([
            ...ladder('Força Aplicada', levels.strength, 4, percentValue, 'força útil'),
            ...ladder('Resistência Corporal', levels.resistance, 4, percentValue, 'resistência física'),
            ...ladder('Condicionamento Físico', levels.conditioning, 4, percentValue, 'fôlego/ritmo'),
            ...ladder('Mobilidade', levels.mobility, 4, percentValue, 'deslocamento físico'),
            ...ladder('Reflexos Corporais', levels.reflexes, 4, percentValue, 'reação/esquiva'),
            ...ladder('Precisão Técnica', levels.precision, 4, percentValue, 'ação física precisa'),
        ]),
        '',
        '*Onde não entra:*',
        list([
            'Físico usa PH dos nós e contexto da cena; não usa custo comum de Mana.',
            'Não substitui Estilo de Luta, arma específica ou golpe personalizado.',
            'Não aumenta magia criada, projétil mágico, mana pura, cura ou antimagia.',
        ]),
    ];
}

function supportLines(capacity) {
    const names = capacity?.support?.ownedNames || [];
    if (!names.length) {
        return [
            'Suporte parcialmente liberado.',
            'Usos básicos podem entrar como capacidade comum.',
            'Magigramática, debuff forte, selo, cura alta e efeito sensível ainda pedem aprovação.',
        ];
    }

    return [
        `${names.length} nó(s) registrados: ${compact(names)}.`,
        'Básicos entram como capacidade comum; usos avançados continuam dependendo de aprovação.',
    ];
}

function generalReading(capacity) {
    const c = creationFlags(capacity);
    const r = reinforcementFlags(capacity);
    const m = manaFlags(capacity);
    const p = physicalData(capacity).flags || {};

    if (c.environmentLevel || r.collectiveBuff || m.zone || p.apex) {
        return 'Já tem ferramenta para cena grande, mas custo, área, duração e aprovação ainda mandam.';
    }
    if (c.junction || r.advanced || m.field || p.ki || p.zetten) {
        return 'Já monta uso mais composto, desde que a ficha tenha nó, custo e limite claro.';
    }
    if (c.base || r.base || m.bulletLevel || m.pulseLevel || p.base) {
        return 'Funciona melhor com ações curtas, diretas e de baixo/médio peso.';
    }
    return 'Ainda é leitura de base. Evitar campo grande, efeito automático e técnica com muitas funções.';
}

function treeOverview(capacity) {
    const summaries = capacity?.treeSummaries || {};
    const supportCount = n(summaries.suporte?.count || capacity?.support?.ownedNames?.length);
    return [
        field('𝑴𝒂𝒏𝒂', `${n(summaries.mana?.count)} nó(s) · ${compact(summaries.mana?.names)}`),
        field('𝑪𝒓𝒊𝒂𝒄̧𝒂̃𝒐', `${n(summaries.criacao?.count)} nó(s) · ${compact(summaries.criacao?.names)}`),
        field('𝑹𝒆𝒇𝒐𝒓𝒄̧𝒐', `${n(summaries.reforco?.count)} nó(s) · ${compact(summaries.reforco?.names)}`),
        field('𝑭𝒊́𝒔𝒊𝒄𝒐', `${n(summaries.fisico?.count)} nó(s) · ${compact(summaries.fisico?.names)}`),
        field('𝑺𝒖𝒑𝒐𝒓𝒕𝒆', supportCount ? `${supportCount} nó(s) · ${compact(capacity?.support?.ownedNames)}` : 'parcialmente liberado'),
    ];
}

function frontBasicLine(pbBasic, pbTotal) {
    return `PB básico: ${pbBasic} de ${pbTotal} PB total.`;
}

function basicCapacityBlock(capacity, technical = false) {
    const pbBasic = basicPb(capacity);
    const pbTotal = n(capacity?.stats?.pb_total, 10);
    const lines = [
        frontBasicLine(pbBasic, pbTotal),
        'Uso básico é magia sem feitiço aprovado: ação pequena, direta e simples.',
        'Não copia feitiço, não cria efeito complexo e não usa todo o poder da ficha.',
    ];
    if (technical) {
        lines.push('Em avaliação, use isso como teto de improviso. Técnica forte, marcada ou composta pede feitiço aprovado.');
    }
    return [
        section('✦', '𝑪𝒂𝒑𝒂𝒄𝒊𝒅𝒂𝒅𝒆 𝑩𝒂́𝒔𝒊𝒄𝒂'),
        '',
        list(lines),
    ].join('\n');
}

function nextNodesBlock(capacity) {
    const next = capacity?.nextNodes || {};
    return [
        '*𝑴𝒂𝒏𝒂:*',
        list(next.mana || [], 'nenhum próximo passo calculado agora'),
        '*𝑪𝒓𝒊𝒂𝒄̧𝒂̃𝒐:*',
        list(next.criacao || [], 'nenhum próximo passo calculado agora'),
        '*𝑹𝒆𝒇𝒐𝒓𝒄̧𝒐:*',
        list(next.reforco || [], 'nenhum próximo passo calculado agora'),
        '*𝑭𝒊́𝒔𝒊𝒄𝒐:*',
        list(next.fisico || [], 'nenhum próximo passo calculado agora'),
    ].join('\n');
}

function formatPlayerCapacity(capacity) {
    if (!capacity?.ok) return 'Não encontrei esse personagem no banco.';

    return [
        ...header('CAPACIDADE ATUAL', 'o que seu personagem consegue fazer agora'),
        '',
        section('✓', '𝑹𝒆𝒔𝒖𝒎𝒐'),
        '',
        field('𝑷𝒆𝒓𝒔𝒐𝒏𝒂𝒈𝒆𝒎', mentionName(capacity)),
        field('𝑬𝒔𝒕𝒂́𝒈𝒊𝒐', capacity.stageName || '-'),
        field('𝑷𝑩', n(capacity.stats?.pb_total)),
        field('𝑷𝑩 𝒃𝒂́𝒔𝒊𝒄𝒐', basicPb(capacity)),
        field('𝑷𝑯', `${n(capacity.ph?.phAvailable)} disponível / ${n(capacity.ph?.phAccumulated)} acumulado`),
        field('𝑯𝒆𝒙𝒂́𝒈𝒐𝒏𝒐', capacity.hexagonLine || '-'),
        '',
        section('✦', '𝑳𝒆𝒊𝒕𝒖𝒓𝒂 𝑮𝒆𝒓𝒂𝒍'),
        '',
        `> ${generalReading(capacity)}`,
        '',
        basicCapacityBlock(capacity),
        '',
        section('◆', '𝑴𝒂𝒏𝒂'),
        '',
        list(manaPlayerLines(capacity)),
        '',
        section('◇', '𝑪𝒓𝒊𝒂𝒄̧𝒂̃𝒐'),
        '',
        list(creationPlayerLines(capacity)),
        '',
        section('⬡', '𝑹𝒆𝒇𝒐𝒓𝒄̧𝒐'),
        '',
        list(reinforcementPlayerLines(capacity)),
        '',
        section('■', '𝑭𝒊́𝒔𝒊𝒄𝒐'),
        '',
        list(physicalPlayerLines(capacity)),
        '',
        section('✧', '𝑺𝒖𝒑𝒐𝒓𝒕𝒆'),
        '',
        list(supportLines(capacity)),
        '',
        section('!', '𝑳𝒊𝒎𝒊𝒕𝒆𝒔 𝑹𝒂́𝒑𝒊𝒅𝒐𝒔'),
        '',
        `> Alcance comum: ${capacity.limits?.alcanceLabel || '-'}.`,
        `> Área comum: ${capacity.limits?.areaLabel || '-'}.`,
        `> Duração comum: ${capacity.limits?.duracaoLabel || '-'}.`,
        `> Controle: ${capacity.limits?.controleLabel || '-'}.`,
        '> Uma ação deve escolher uma leitura principal.',
        '> Feitiço aprovado não evolui sozinho; se o mago evoluir, precisa pedir atualização.',
    ].join('\n');
}

function formatTechnicalCapacity(capacity, options = {}) {
    if (!capacity?.ok) return 'Não encontrei esse personagem no banco.';

    const full = options.full === true || options.admin === true;
    const admin = options.admin === true;
    const approvalLines = capacity.approvalNodes?.length ? capacity.approvalNodes : ['nenhum nó comprado com aprovação obrigatória'];
    const riskLines = capacity.highRiskNodes?.length ? capacity.highRiskNodes : ['nenhum nó alto/extremo comprado'];

    return [
        ...header(admin ? 'CAPACIDADE TÉCNICA · ADM' : 'CAPACIDADE TÉCNICA', admin ? 'leitura para aprovação manual' : 'limites, custos e árvores'),
        '',
        section('✓', '𝑰𝒅𝒆𝒏𝒕𝒊𝒇𝒊𝒄𝒂𝒄̧𝒂̃𝒐'),
        '',
        field('𝑷𝒆𝒓𝒔𝒐𝒏𝒂𝒈𝒆𝒎', mentionName(capacity)),
        field('𝑬𝒔𝒕𝒂́𝒈𝒊𝒐', capacity.stageName || '-'),
        field('𝑷𝑩', n(capacity.stats?.pb_total)),
        field('𝑷𝑩 𝒃𝒂́𝒔𝒊𝒄𝒐', basicPb(capacity)),
        field('𝑴𝒂𝒏𝒂', capacity.manaTotal === null ? '-' : capacity.manaTotal),
        field('𝑷𝒐𝒅𝒆𝒓 𝑴𝒂́𝒈𝒊𝒄𝒐', capacity.poderMagico),
        field('𝑷𝑯', `${n(capacity.ph?.phAvailable)} disponível / ${n(capacity.ph?.phAccumulated)} acumulado`),
        admin ? field('𝑹𝒆𝒈𝒊𝒔𝒕𝒓𝒐', capacity.playerId) : null,
        '',
        section('✦', '𝑯𝒆𝒙𝒂́𝒈𝒐𝒏𝒐'),
        '',
        `> ${capacity.hexagonLine || '-'}`,
        `> PER ${n(capacity.hexagon?.percepcao, 1)}: ${capacity.limits?.percepcaoLabel || '-'}`,
        `> RET ${n(capacity.hexagon?.retencao, 1)}: ${capacity.limits?.duracaoLabel || '-'}`,
        `> EMI ${n(capacity.hexagon?.emissao, 1)}: ${capacity.limits?.emissaoLabel || '-'}`,
        `> CON ${n(capacity.hexagon?.controle, 1)}: ${capacity.limits?.controleLabel || '-'}`,
        `> PRE ${n(capacity.hexagon?.pressao, 1)}: PM ${capacity.limits?.pressaoBonus || '-'}`,
        `> ALC ${n(capacity.hexagon?.alcance, 1)}: ${capacity.limits?.alcanceLabel || '-'}`,
        `> Área comum: ${capacity.limits?.areaLabel || '-'}`,
        '',
        basicCapacityBlock(capacity, true),
        '',
        section('◆', '𝑨́𝒓𝒗𝒐𝒓𝒆𝒔'),
        '',
        ...treeOverview(capacity),
        '',
        section('◇', '𝑪𝒓𝒊𝒂𝒄̧𝒂̃𝒐'),
        '',
        ...creationTechnicalLines(capacity),
        '',
        section('⬡', '𝑹𝒆𝒇𝒐𝒓𝒄̧𝒐'),
        '',
        ...reinforcementTechnicalLines(capacity),
        '',
        section('✧', '𝑴𝒂𝒏𝒂'),
        '',
        ...manaTechnicalLines(capacity),
        '',
        section('■', '𝑭𝒊́𝒔𝒊𝒄𝒐'),
        '',
        ...physicalTechnicalLines(capacity),
        '',
        section('✩', '𝑺𝒖𝒑𝒐𝒓𝒕𝒆'),
        '',
        list(supportLines(capacity)),
        '',
        section('!', '𝑨𝒕𝒆𝒏𝒄̧𝒐̃𝒆𝒔'),
        '',
        '*𝑨𝒑𝒓𝒐𝒗𝒂𝒄̧𝒂̃𝒐 𝒐𝒃𝒓𝒊𝒈𝒂𝒕𝒐́𝒓𝒊𝒂:*',
        list(approvalLines),
        '*𝑹𝒊𝒔𝒄𝒐 𝒂𝒍𝒕𝒐/𝒆𝒙𝒕𝒓𝒆𝒎𝒐:*',
        list(riskLines),
        '',
        full ? section('⌁', '𝑷𝒓𝒐́𝒙𝒊𝒎𝒐𝒔 𝑵𝒐́𝒔') : null,
        full ? '' : null,
        full ? nextNodesBlock(capacity) : null,
        full ? '' : null,
        section('▣', '𝑴𝒂𝒏𝒖𝒕𝒆𝒏𝒄̧𝒂̃𝒐'),
        '',
        list(maintenanceLines()),
        '',
        section(admin ? '✦' : '✓', admin ? '𝑳𝒆𝒊𝒕𝒖𝒓𝒂 𝒅𝒐 𝑨𝑫𝑴' : '𝑨𝒗𝒊𝒔𝒐'),
        '',
        admin
            ? '> Esta leitura organiza ficha, árvores, buffs, pesos e limites para decisão manual da ADM.'
            : '> Nós com aprovação não significam uso livre automático.',
        '> O bot não aprova técnica automaticamente.',
        '> O ADM ainda decide com ficha, Hexágono, cena e contexto.',
    ].filter((line) => line !== null).join('\n');
}

module.exports = {
    formatPlayerCapacity,
    formatTechnicalCapacity,
};
