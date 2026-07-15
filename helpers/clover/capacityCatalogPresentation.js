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

function currentOrNextLevels(label, currentLevel, maxLevel, valueForLevel, context = '') {
    const current = n(currentLevel);
    const limit = Math.min(maxLevel, current > 0 ? current + 1 : 1);
    const lines = [];
    for (let level = 1; level <= limit; level += 1) {
        const status = level < current ? 'comprado' : level === current ? 'atual' : 'não comprado';
        const value = valueForLevel(level);
        lines.push(`${label} ${roman(level)}: ${value}${context ? ` ${context}` : ''} — ${status}.`);
    }
    return lines;
}

function currentFamily(label, level, text) {
    if (!level) return null;
    return `${label} ${roman(level)}: ${text}`;
}

function percentValue(level) {
    return `+${percent(level)}%`;
}

function romanValue(level) {
    return `nível ${roman(level)}`;
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
        flags.control ? 'Controle: pode mover, guiar, ajustar e estabilizar a forma criada.' : null,
        flags.structure ? 'Estrutura: a criação pode ter mais corpo, encaixe e firmeza.' : null,
        currentFamily('Força Mágica', flags.forceLevel, `${percentValue(flags.forceLevel)} quando a criação é feita para causar dano.`),
        currentFamily('Velocidade Mágica', flags.speedLevel, `${percentValue(flags.speedLevel)} quando a criação precisa avançar, disparar ou se mover.`),
        currentFamily('Defesa Mágica', flags.defenseLevel, `${percentValue(flags.defenseLevel)} quando a criação é feita para defender ou bloquear.`),
        currentFamily('Densidade', flags.densityLevel, 'a forma fica mais firme, pesada e difícil de quebrar.'),
        currentFamily('Precisão', flags.precisionLevel, 'melhora mira, encaixe e detalhe fino; não garante acerto.'),
        flags.junction ? 'Junção de Forma: pode juntar forma e função quando o feitiço permitir.' : null,
        currentFamily('Armas', flags.weaponsLevel, 'melhora criação de armas mágicas.'),
        currentFamily('Formas Humanoides', flags.humanoidsLevel, 'melhora criação de construtos, corpos mágicos ou formas humanoides.'),
        currentFamily('Ambiente', flags.environmentLevel, 'melhora criação em área, campo ou cenário.'),
    ].filter(Boolean);
}

function creationTechnicalLines(capacity) {
    const flags = creationFlags(capacity);
    if (!flags.base) return ['Sem Criação comprada.'];

    return [
        '*Base:*',
        list(creationPlayerLines(capacity)),
        '',
        '*Escada comprada / próximo nível:*',
        list([
            ...currentOrNextLevels('Força Mágica', flags.forceLevel, 3, percentValue, 'em dano de criação'),
            ...currentOrNextLevels('Velocidade Mágica', flags.speedLevel, 3, percentValue, 'em movimento da criação'),
            ...currentOrNextLevels('Defesa Mágica', flags.defenseLevel, 3, percentValue, 'em defesa da criação'),
            ...currentOrNextLevels('Densidade', flags.densityLevel, 3, romanValue, 'em firmeza e resistência da forma'),
            ...currentOrNextLevels('Precisão', flags.precisionLevel, 3, romanValue, 'em mira e encaixe fino'),
            ...currentOrNextLevels('Armas', flags.weaponsLevel, 3, romanValue, 'em criação de armas mágicas'),
            ...currentOrNextLevels('Formas Humanoides', flags.humanoidsLevel, 3, romanValue, 'em construtos/corpos mágicos'),
            ...currentOrNextLevels('Ambiente', flags.environmentLevel, 3, romanValue, 'em área/campo/cenário'),
        ]),
        '',
        '*Peso dos níveis:*',
        list([
            'Buffs de nível I somam peso +1 quando entram no feitiço.',
            'Buffs de nível II somam peso +2 quando entram no feitiço.',
            'Buffs de nível III somam peso +3 quando entram no feitiço.',
            'O feitiço não é obrigado a usar todo buff comprado; usa só o que a descrição puxar.',
        ]),
        '',
        '*Pesos sugeridos:*',
        list(creationCostLines(flags)),
        '',
        '*Onde entra:*',
        list(creationWhereEnters(flags)),
        '',
        '*Onde não entra:*',
        list(creationWhereNotEnters(flags)),
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
    if (flags.densityLevel) lines.push(costLine(`Forma densa + Densidade ${roman(flags.densityLevel)}`, 2 + flags.densityLevel));
    if (flags.precisionLevel) lines.push(costLine(`Forma precisa + Precisão ${roman(flags.precisionLevel)}`, 2 + flags.precisionLevel));
    if (flags.forceLevel && flags.precisionLevel) lines.push(costLine(`Ofensiva + Força ${roman(flags.forceLevel)} + Precisão ${roman(flags.precisionLevel)}`, 2 + flags.forceLevel + flags.precisionLevel));
    if (flags.forceLevel && flags.densityLevel) lines.push(costLine(`Ofensiva + Força ${roman(flags.forceLevel)} + Densidade ${roman(flags.densityLevel)}`, 2 + flags.forceLevel + flags.densityLevel));
    if (flags.defenseLevel && flags.densityLevel) lines.push(costLine(`Defesa + Defesa ${roman(flags.defenseLevel)} + Densidade ${roman(flags.densityLevel)}`, 2 + flags.defenseLevel + flags.densityLevel));
    if (flags.junction) lines.push(costLine('Forma com Junção de Forma', 5, 'depende da combinação real'));
    if (flags.weaponsLevel) lines.push(costLine(`Manifestação armada ${roman(flags.weaponsLevel)}`, 3 + flags.weaponsLevel));
    if (flags.humanoidsLevel) lines.push(costLine(`Construto/Forma humanoide ${roman(flags.humanoidsLevel)}`, 4 + flags.humanoidsLevel, 'normalmente exige manutenção'));
    if (flags.environmentLevel) lines.push(costLine(`Área/Campo com Ambiente ${roman(flags.environmentLevel)}`, 4 + flags.environmentLevel, 'normalmente exige manutenção média ou pesada'));
    return lines;
}

function creationWhereEnters(flags) {
    const lines = [];
    if (flags.forceLevel) lines.push('Força Mágica entra em dano, quebra, perfuração e impacto da criação.');
    if (flags.speedLevel) lines.push('Velocidade Mágica entra quando a criação se move, dispara, avança ou tenta alcançar algo.');
    if (flags.defenseLevel) lines.push('Defesa Mágica entra quando a criação protege, bloqueia, cobre ou segura dano.');
    if (flags.densityLevel) lines.push('Densidade entra quando a forma precisa ser compacta, firme, pesada ou resistente.');
    if (flags.precisionLevel) lines.push('Precisão entra em mira, encaixe, detalhe fino, agulha, fio, corte limpo ou ponto específico.');
    if (flags.weaponsLevel) lines.push('Armas entra quando a criação se comporta como arma mágica e não só como forma simples.');
    if (flags.humanoidsLevel) lines.push('Formas Humanoides entra em construto, avatar, corpo mágico, boneco ou forma com partes.');
    if (flags.environmentLevel) lines.push('Ambiente entra em área, campo, cenário, chão, parede, terreno ou influência espacial.');
    if (!lines.length) lines.push('No momento, a criação entra como forma simples e direta.');
    return lines;
}

function creationWhereNotEnters(flags) {
    return [
        'Força Mágica não aumenta alcance, mira, velocidade, duração ou defesa.',
        'Velocidade Mágica não aumenta dano, defesa, mira ou duração.',
        'Defesa Mágica não aumenta dano, perseguição, velocidade ou alcance.',
        'Densidade não dá acerto automático nem muda a função do feitiço sozinha.',
        'Precisão não garante acerto e não ignora defesa/reação.',
        !flags.junction ? 'Sem Junção de Forma, não junta várias funções complexas no mesmo feitiço.' : null,
        !flags.environmentLevel ? 'Sem Ambiente, campo grande, área persistente e criação automática devem ser barrados ou reavaliados.' : null,
        !flags.humanoidsLevel ? 'Sem Formas Humanoides, construto vivo/autônomo não fica liberado.' : null,
        'Nenhum nó libera dano inevitável, prisão perfeita ou perseguição sem resposta.',
    ].filter(Boolean);
}

function reinforcementPlayerLines(capacity) {
    const flags = reinforcementFlags(capacity);
    if (!flags.base) return ['Ainda não tem Reforço comprado.'];

    return [
        'Consegue fortalecer o corpo com magia em ações simples.',
        flags.intensityLevel ? `Intensidade ${roman(flags.intensityLevel)}: ${percentValue(flags.intensityLevel)} quando o reforço usa potência.` : 'Sem Intensidade comprada, o reforço fica no uso inicial/pequeno.',
        flags.stabilityLevel ? `Estabilidade ${roman(flags.stabilityLevel)}: o reforço oscila menos e sustenta melhor.` : null,
        flags.focusCount ? `Foco: pode manter ${flags.focusCount} atributo${flags.focusCount > 1 ? 's' : ''} como foco do mesmo reforço.` : null,
        flags.attributes?.length ? `Atributos liberados: ${flags.attributes.join(', ')}.` : null,
        flags.selfBuff ? 'Invencível: reforço em si mesmo.' : null,
        flags.otherBuff ? 'Invicto: caminho para reforçar outro alvo.' : null,
        flags.touchBuff ? 'Reforço por toque: pode aplicar reforço externo por contato.' : null,
        flags.distanceBuff ? 'Reforço à distância: aplica reforço externo respeitando Alcance, Emissão e Controle.' : null,
        flags.collectiveBuff ? 'Reforço coletivo: pode alcançar mais de um alvo quando custo e cena sustentarem.' : null,
        flags.junction ? 'Junção de Forma: pode ligar reforço a forma, aura, armadura ou efeito compatível.' : null,
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
        '*Escada comprada / próximo nível:*',
        list([
            ...currentOrNextLevels('Intensidade', flags.intensityLevel, 3, percentValue, 'em potência do reforço'),
            ...currentOrNextLevels('Estabilidade', flags.stabilityLevel, 3, romanValue, 'em duração/segurança do reforço'),
        ]),
        '',
        '*Peso dos níveis:*',
        list([
            'Intensidade I/II/III soma peso +1/+2/+3 quando entra.',
            'Estabilidade I/II/III soma peso +1/+2/+3 quando entra.',
            'Foco, alvo externo, distância, coletivo e avançado somam peso próprio.',
        ]),
        '',
        '*Pesos sugeridos:*',
        list(reinforcementCostLines(flags)),
        '',
        '*Onde entra:*',
        list(reinforcementWhereEnters(flags)),
        '',
        '*Onde não entra:*',
        list(reinforcementWhereNotEnters(flags)),
    ];
}

function reinforcementCostLines(flags) {
    const lines = [];
    if (!flags.base) return lines;
    lines.push(costLine('Reforço básico de 1 ação', 2, 'leitura inicial/pequena'));
    if (flags.intensityLevel) lines.push(costLine(`Reforço + Intensidade ${roman(flags.intensityLevel)}`, 2 + flags.intensityLevel));
    if (flags.stabilityLevel) lines.push(costLine(`Reforço + Estabilidade ${roman(flags.stabilityLevel)}`, 2 + flags.stabilityLevel, 'normalmente tem manutenção'));
    if (flags.intensityLevel && flags.stabilityLevel) lines.push(costLine(`Reforço + Intensidade ${roman(flags.intensityLevel)} + Estabilidade ${roman(flags.stabilityLevel)}`, 2 + flags.intensityLevel + flags.stabilityLevel, 'normalmente tem manutenção'));
    if (flags.attributes?.length && flags.selfBuff) lines.push(costLine(`Autobuff de ${Math.min(flags.focusCount || 1, flags.attributes.length)} atributo(s)`, 3 + Math.max(1, flags.intensityLevel || 1), 'manutenção leve/média'));
    if (flags.otherBuff || flags.touchBuff) lines.push(costLine('Reforço externo por toque', 5, 'depende do alvo e cena'));
    if (flags.distanceBuff) lines.push(costLine('Reforço externo à distância', 6, 'depende de Alcance/Emissão/Controle'));
    if (flags.collectiveBuff) lines.push(costLine('Reforço coletivo simples', 8, 'manutenção muito pesada'));
    if (flags.advancedWeapons) lines.push(costLine('Reforço avançado em arma', 7, 'depende da arma e duração'));
    if (flags.advancedHumanoids) lines.push(costLine('Reforço avançado em armadura/avatar', 8, 'manutenção pesada'));
    if (flags.advancedEnvironment) lines.push(costLine('Reforço avançado em área/campo', 9, 'manutenção pesada ou muito pesada'));
    return lines;
}

function reinforcementWhereEnters(flags) {
    const lines = [];
    if (flags.intensityLevel) lines.push('Intensidade entra quando o reforço quer mais força, velocidade, resistência ou potência no atributo escolhido.');
    if (flags.stabilityLevel) lines.push('Estabilidade entra quando o reforço precisa durar melhor ou falhar menos.');
    if (flags.attributes?.length) lines.push(`Atributos comprados definem onde o reforço pode focar: ${flags.attributes.join(', ')}.`);
    if (flags.selfBuff) lines.push('Invencível entra em reforço no próprio usuário.');
    if (flags.otherBuff || flags.touchBuff || flags.distanceBuff) lines.push('Invicto/externo entra quando o alvo do reforço é outra pessoa.');
    if (flags.collectiveBuff) lines.push('Coletivo entra quando mais de um alvo recebe reforço.');
    if (!lines.length) lines.push('No momento, entra como reforço curto e simples do corpo.');
    return lines;
}

function reinforcementWhereNotEnters(flags) {
    return [
        'Reforço não aumenta magia criada, mana pura, cura ou antimagia.',
        'Intensidade não melhora duração se Estabilidade não entrar.',
        'Estabilidade não aumenta potência sozinha.',
        !flags.attributes?.length ? 'Sem atributo reforçado, o uso fica genérico e pequeno.' : null,
        !flags.selfBuff ? 'Sem Invencível, autobuff completo não fica liberado.' : null,
        !flags.otherBuff ? 'Sem Invicto, buff em aliados não fica liberado.' : null,
        !flags.collectiveBuff ? 'Sem Reforço Coletivo, não distribui buff em vários alvos.' : null,
        !flags.advanced ? 'Sem Reforço Avançado, não vira armadura, avatar, arma reforçada ou campo.' : null,
    ].filter(Boolean);
}

function manaPlayerLines(capacity) {
    const flags = manaFlags(capacity);
    if (!flags.base && !flags.flow && !flags.bulletLevel && !flags.pulseLevel && !flags.manaSkin) {
        return ['Ainda não tem avanço relevante em Mana registrado.'];
    }

    return [
        flags.base ? 'Base de Mana: leitura e manipulação inicial.' : null,
        flags.perception || flags.sensing ? `Percepção de Mana ${flags.sensingLevel ? roman(flags.sensingLevel) : 'I'}: percebe mana evidente e fluxo básico.` : null,
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
        flags.recoveryLevel ? `Recuperação ${roman(flags.recoveryLevel)}: melhora retomada de mana conforme cena/regra.` : null,
        flags.environmentalReading ? 'Leitura Ambiental: percebe mana do cenário quando ela está relevante.' : null,
        flags.environmentalAdaptation ? 'Adaptação Ambiental: lida melhor com mudança de ambiente mágico.' : null,
        flags.environment ? `Ambiente de Mana ${roman(flags.environmentLevel)}: usa mana do entorno quando houver base narrativa.` : null,
        flags.resonance ? 'Ressonância: conversa melhor com mana do entorno.' : null,
        flags.method ? 'Método de Mana: uso mais organizado e treinado.' : null,
        flags.zone ? `Mana Zone ${roman(flags.zoneLevel)}: domínio de zona dentro dos limites do sistema.` : null,
        flags.fineControl ? `Controle Fino ${roman(flags.fineControlLevel)}: curvas, ajustes e manipulação delicada.` : null,
        flags.compression ? 'Compressão de Mana: concentra mana para usos mais densos.' : null,
        flags.objectCoating ? 'Revestimento de Objeto: cobre objeto com mana.' : null,
        flags.simultaneousMaintenance ? 'Manutenção Simultânea: ajuda a manter mais de um efeito.' : null,
        flags.pressure ? 'Pressão de Mana: conversa com PRE do Hexágono.' : null,
        flags.domain ? 'Domínio de Mana: topo narrativo/manual.' : null,
    ].filter(Boolean);
}

function manaTechnicalLines(capacity) {
    const flags = manaFlags(capacity);
    return [
        '*Base:*',
        list(manaPlayerLines(capacity)),
        '',
        '*Escada comprada / próximo nível:*',
        list([
            ...currentOrNextLevels('Sentir Mana', flags.sensingLevel, 3, romanValue, 'em percepção de mana'),
            ...currentOrNextLevels('Bala de Mana', flags.bulletLevel, 3, romanValue, 'em disparo de mana pura'),
            ...currentOrNextLevels('Pulso de Mana', flags.pulseLevel, 3, romanValue, 'em onda curta de mana'),
            ...currentOrNextLevels('Pele de Mana', flags.manaSkinLevel, 3, romanValue, 'em revestimento corporal'),
            ...currentOrNextLevels('Campo de Mana', flags.fieldLevel, 3, romanValue, 'em área próxima'),
            ...currentOrNextLevels('Economia de Mana', flags.economyLevel, 3, romanValue, 'em redução de gasto real'),
            ...currentOrNextLevels('Recuperação', flags.recoveryLevel, 3, romanValue, 'em retomada de mana'),
            ...currentOrNextLevels('Ambiente de Mana', flags.environmentLevel, 3, romanValue, 'em uso do entorno'),
            ...currentOrNextLevels('Mana Zone', flags.zoneLevel, 3, romanValue, 'em domínio de zona'),
            ...currentOrNextLevels('Controle Fino', flags.fineControlLevel, 3, romanValue, 'em curva/ajuste fino'),
        ]),
        '',
        '*Pesos sugeridos:*',
        list(manaCostLines(flags)),
        '',
        '*Onde entra:*',
        list(manaWhereEnters(flags)),
        '',
        '*Onde não entra:*',
        list(manaWhereNotEnters(flags)),
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
    if (flags.simultaneousMaintenance) lines.push(costLine('Manutenção Simultânea', 6, 'não remove custo dos efeitos mantidos'));
    if (!lines.length) lines.push(costLine('Uso simples de mana', 2, 'quando houver base compatível'));
    return lines;
}

function manaWhereEnters(flags) {
    const lines = [];
    if (flags.sensing) lines.push('Percepção/Sentir Mana entra para notar mana evidente, fluxo, acúmulo ou assinatura visível.');
    if (flags.flow || flags.circulation || flags.stability || flags.channeling) lines.push('Fluxo, circulação, estabilidade e canalização entram em execução limpa e controle interno.');
    if (flags.emission) lines.push('Emissão entra quando a mana sai do corpo.');
    if (flags.retention) lines.push('Retenção entra em duração e manutenção.');
    if (flags.bulletLevel) lines.push('Bala entra em disparo direto de mana pura.');
    if (flags.pulseLevel) lines.push('Pulso entra em onda curta, empurrão ou pressão de mana pura.');
    if (flags.manaSkin || flags.manaMantle) lines.push('Pele/Manto entram em cobertura corporal de mana.');
    if (flags.field || flags.zone) lines.push('Campo/Mana Zone entram em área e domínio espacial.');
    if (flags.economy) lines.push('Economia entra depois do custo bruto, reduzindo gasto real quando aprovado.');
    if (flags.recoveryLevel) lines.push('Recuperação entra na retomada pós-gasto, não como cura instantânea de mana.');
    if (!lines.length) lines.push('No momento, Mana entra em leitura e manipulação básica.');
    return lines;
}

function manaWhereNotEnters(flags) {
    return [
        'Mana pura não copia efeito da magia pessoal sem feitiço próprio.',
        'Percepção de Mana não lê tudo e não revela ação escondida sem pista.',
        'Economia não reduz custo bruto de avaliação; reduz gasto real quando aprovado.',
        'Recuperação não devolve mana instantaneamente sem regra de cena.',
        'Emissão não aumenta alcance além do Hexágono.',
        !flags.zone ? 'Sem Mana Zone, domínio amplo de área não fica liberado.' : null,
        !flags.simultaneousMaintenance ? 'Sem Manutenção Simultânea, vários efeitos mantidos ao mesmo tempo devem ser barrados ou encarecidos.' : null,
        'Mana pura não dá dano inevitável, controle mental, debuff real ou prisão perfeita.',
    ].filter(Boolean);
}

function physicalPlayerLines(capacity) {
    const physical = physicalData(capacity);
    const flags = physical.flags || {};
    const levels = physical.levels || {};
    if (!flags.base) return ['Ainda não tem Físico comprado.'];

    const add = (label, level, text) => (level ? `${label} ${roman(level)}: ${percentValue(level)} ${text}` : null);
    const senseLabels = {
        visao: 'Visão',
        audicao: 'Audição',
        olfato: 'Olfato',
        tato: 'Tato',
        paladar: 'Paladar',
        intuicao: 'Intuição Corporal',
    };
    const identityLabels = {
        barbarian: 'Bárbaro',
        tyrant: 'Tirano',
        benevolent: 'Benevolente',
        cult: 'Culto',
        just: 'Justo',
        unjust: 'Injusto',
        instinct: 'Instinto',
    };
    const senses = Object.entries(levels.senses || {})
        .filter(([, level]) => level > 0)
        .map(([key, level]) => `${senseLabels[key] || key} ${roman(level)}`);
    const identities = Object.entries(levels.identities || {})
        .filter(([, level]) => level > 0)
        .map(([key, level]) => `${identityLabels[key] || key} ${roman(level)}`);

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
        flags.ki ? 'Ki registrado: uso complexo ainda depende de aprovação narrativa.' : null,
        flags.zetten ? 'Zetten registrado: uso decisivo ainda depende de aprovação narrativa.' : null,
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
        '*Escada comprada / próximo nível:*',
        list([
            ...currentOrNextLevels('Força Aplicada', levels.strength, 4, percentValue, 'em força útil'),
            ...currentOrNextLevels('Resistência Corporal', levels.resistance, 4, percentValue, 'em resistência física'),
            ...currentOrNextLevels('Condicionamento Físico', levels.conditioning, 4, percentValue, 'em fôlego/ritmo'),
            ...currentOrNextLevels('Mobilidade', levels.mobility, 4, percentValue, 'em deslocamento físico'),
            ...currentOrNextLevels('Reflexos Corporais', levels.reflexes, 4, percentValue, 'em reação/esquiva'),
            ...currentOrNextLevels('Precisão Técnica', levels.precision, 4, percentValue, 'em ação física precisa'),
        ]),
        '',
        '*Onde entra:*',
        list(physicalWhereEnters(levels, flags)),
        '',
        '*Onde não entra:*',
        list([
            'Físico usa PH dos nós e contexto da cena.',
            'Não usa custo comum de Mana.',
            'Não substitui Estilo de Luta, arma específica ou golpe personalizado.',
            'Não aumenta magia criada, projétil mágico, mana pura, cura ou antimagia.',
            !flags.ki ? 'Sem Ki, leitura espiritual/avançada não fica liberada.' : null,
            !flags.zetten ? 'Sem Zetten, explosão decisiva de técnica física não fica liberada.' : null,
        ].filter(Boolean)),
    ];
}

function physicalWhereEnters(levels, flags) {
    const lines = [];
    if (levels.strength) lines.push('Força Aplicada entra em golpe, puxar, empurrar, segurar, quebrar e travar.');
    if (levels.resistance) lines.push('Resistência Corporal entra em aguentar dor, tranco, dano físico e pressão corporal.');
    if (levels.conditioning) lines.push('Condicionamento entra em fôlego, ritmo, retomada e esforço prolongado.');
    if (levels.mobility) lines.push('Mobilidade entra em avançar, recuar, fugir, perseguir e reposicionar.');
    if (levels.reflexes) lines.push('Reflexos entram em reação, esquiva, troca de direção e resposta física.');
    if (levels.precision) lines.push('Precisão Técnica entra em brecha, ponto certo, desarme e ação física limpa.');
    if (flags.antiMage) lines.push('Contra Magos entra contra janela física de conjuração; não anula magia.');
    if (flags.ki) lines.push('Ki entra apenas com contexto e aprovação narrativa.');
    if (!lines.length) lines.push('No momento, Físico entra como base corporal simples.');
    return lines;
}

function supportLines(capacity) {
    const names = capacity?.support?.ownedNames || [];
    if (!names.length) {
        return [
            'Suporte parcialmente liberado.',
            'Usos básicos podem entrar como capacidade comum.',
            'Magigramática, debuff forte, selo, cura alta e efeito sensível ainda pedem aprovação narrativa.',
        ];
    }

    return [
        `${names.length} nó(s) registrados: ${compact(names)}.`,
        'Básicos entram como capacidade comum; usos avançados continuam dependendo de aprovação narrativa.',
        'Suporte sensível precisa dizer alvo, condição, duração, alcance, chance de falha e limite.',
    ];
}

function supportTechnicalLines(capacity) {
    return [
        '*Base:*',
        list(supportLines(capacity)),
        '',
        '*Onde entra:*',
        list([
            'Bênção simples, cura pequena, condição leve, auxílio narrativo e efeito de suporte básico.',
            'Debuff, maldição, selo, restrição, armadilha, cura alta ou efeito mental precisam de aprovação.',
            'Quanto mais o efeito tira resposta do alvo, mais caro e restrito deve ser.',
        ]),
        '',
        '*Onde não entra:*',
        list([
            'Não dá prisão perfeita.',
            'Não dá cura total fácil.',
            'Não remove turno sem regra explícita.',
            'Não aplica debuff real sem nó, condição e falha possível.',
        ]),
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
        return 'Já consegue montar coisa mais composta, desde que a ficha tenha nó, custo e limite claro.';
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

function basicCapacityBlock(capacity, technical = false) {
    const pbBasicValue = basicPb(capacity);
    const pbTotal = n(capacity?.stats?.pb_total, 10);
    const lines = [
        `PB básico: ${pbBasicValue} de ${pbTotal} PB total.`,
        'Uso básico é magia sem feitiço aprovado: ação pequena, direta e simples.',
        'Não copia feitiço, não cria efeito complexo e não usa todo o poder da ficha.',
    ];
    if (technical) {
        lines.push('Em avaliação, use isso como teto de improviso. Técnica marcada, forte ou composta pede feitiço aprovado.');
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
        ...supportTechnicalLines(capacity),
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
            : '> Nós com aprovação narrativa não significam uso livre automático.',
        '> O bot não aprova técnica automaticamente.',
        '> O ADM ainda decide com ficha, Hexágono, cena e contexto.',
    ].filter((line) => line !== null).join('\n');
}

module.exports = {
    formatPlayerCapacity,
    formatTechnicalCapacity,
};
