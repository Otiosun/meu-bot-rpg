const {
    getAttributeValues,
    getCharacterStats,
    getStageName,
} = require('./characterStats');
const { getHexagonDerivedLimits, getOrCreateHexagon } = require('./hexagonService');
const { getPhSummary } = require('./phService');
const { getTreeState } = require('./skillTreeService');
const { MAINTENANCE_TIERS, calculateRankCost } = require('./balanceGuide');
const { getCharacterBonusSummary } = require('./characterBonusService');

const TECHNICAL_TREE_IDS = ['mana', 'criacao', 'reforco', 'fisico'];
const SUPPORT_TREE_ID = 'suporte';

function firstFilled(...values) {
    return values.find((value) => (
        value !== null
        && value !== undefined
        && String(value).trim()
        && String(value).trim() !== '-'
    )) || '-';
}

function formatMention(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

function formatHexagonLine(hexagon) {
    return [
        `PER ${Number(hexagon?.percepcao || 1)}`,
        `RET ${Number(hexagon?.retencao || 1)}`,
        `EMI ${Number(hexagon?.emissao || 1)}`,
        `CON ${Number(hexagon?.controle || 1)}`,
        `PRE ${Number(hexagon?.pressao || 1)}`,
        `ALC ${Number(hexagon?.alcance || 1)}`,
    ].join(' | ');
}

function getOwnedNodeIds(treeState) {
    return [...(treeState?.ownedIds || [])];
}

function hasNode(treeState, nodeId) {
    return getOwnedNodeIds(treeState).includes(nodeId);
}

function getHighestOwnedLevel(treeState, baseIds) {
    const ids = Array.isArray(baseIds) ? baseIds : [];
    for (let index = ids.length - 1; index >= 0; index -= 1) {
        if (hasNode(treeState, ids[index])) {
            return {
                level: index + 1,
                nodeId: ids[index],
                node: treeState?.tree?.nodesById?.[ids[index]] || null,
            };
        }
    }
    return { level: 0, nodeId: null, node: null };
}

function romanLevel(level) {
    return ['', 'I', 'II', 'III', 'IV', 'V'][Number(level || 0)] || String(level || '');
}

function percentByLevel(level) {
    return [0, 10, 20, 30, 40][Number(level || 0)] || 0;
}

function ownedWeightedNodes(treeState) {
    return getOwnedNodeIds(treeState)
        .map((nodeId) => treeState?.tree?.nodesById?.[nodeId])
        .filter((node) => node && node.metadata?.technicalWeight !== undefined)
        .map((node) => ({
            id: node.id,
            name: node.name,
            weight: Number(node.metadata.technicalWeight || 0),
        }));
}

function getOwnedNodes(treeState) {
    return getOwnedNodeIds(treeState)
        .map((nodeId) => treeState?.tree?.nodesById?.[nodeId])
        .filter(Boolean);
}

function compactList(items, fallback = 'nenhum', limit = 8) {
    const clean = (items || []).filter(Boolean);
    if (!clean.length) return fallback;
    const head = clean.slice(0, limit);
    const suffix = clean.length > limit ? ` (+${clean.length - limit})` : '';
    return `${head.join(', ')}${suffix}`;
}

function bulletList(items, fallback = 'nenhum') {
    const clean = (items || []).filter(Boolean);
    if (!clean.length) return `• ${fallback}`;
    return clean.map((item) => `• ${item}`).join('\n');
}

function metadataRisk(node) {
    return String(node?.metadata?.risk || '').toLowerCase();
}

function isHighRisk(node) {
    return ['alto', 'extremo'].includes(metadataRisk(node));
}

function formatNodeRisk(node, treeState) {
    const risk = node?.metadata?.risk || 'não registrado';
    const approval = node?.requiresApproval ? ' | approval' : '';
    return `${treeState?.tree?.name || 'Arvore'}: ${node.name} (${risk}${approval})`;
}

function getOwnedApprovalNodes(treeStates) {
    return Object.values(treeStates || {})
        .filter(Boolean)
        .flatMap((treeState) => getOwnedNodes(treeState)
            .filter((node) => node.requiresApproval)
            .map((node) => formatNodeRisk(node, treeState)));
}

function getOwnedHighRiskNodes(treeStates) {
    return Object.values(treeStates || {})
        .filter(Boolean)
        .flatMap((treeState) => getOwnedNodes(treeState)
            .filter(isHighRisk)
            .map((node) => formatNodeRisk(node, treeState)));
}

function summarizeOwnedByTree(treeState) {
    const owned = getOwnedNodes(treeState);
    return {
        count: owned.length,
        names: owned.map((node) => node.name),
        approvals: owned.filter((node) => node.requiresApproval).map((node) => node.name),
        highRisk: owned.filter(isHighRisk).map((node) => `${node.name} (${node.metadata?.risk})`),
    };
}

function summarizeNextNodes(treeState, limit = 4) {
    if (!treeState) return [];
    return treeState.nodeStates
        .filter((item) => ['available', 'no_ph', 'approval'].includes(item.status))
        .slice(0, limit)
        .map((item) => `${item.node.name} (${item.status}${item.missingPh ? `, falta ${item.missingPh} PH` : ''})`);
}

function analyzeSupport(treeState) {
    const owned = getOwnedNodes(treeState);
    return {
        status: 'parcialmente_liberado',
        owned,
        ownedNames: owned.map((node) => node.name),
        warning: owned.length
            ? 'Suporte possui nós registrados. Básicos entram como capacidade comum; avançados e sensíveis continuam dependendo de aprovação narrativa.'
            : 'Suporte parcialmente liberado. Nós básicos podem ser comprados; Magigramática e avançados exigem aprovação narrativa.',
    };
}

function analyzePhysical(treeState) {
    const owned = getOwnedNodes(treeState);
    const strengthLine = getHighestOwnedLevel(treeState, ['forca_aplicada_i', 'forca_aplicada_ii', 'forca_aplicada_iii', 'forca_aplicada_iv']);
    const resistanceLine = getHighestOwnedLevel(treeState, ['resistencia_corporal_i', 'resistencia_corporal_ii', 'resistencia_corporal_iii', 'resistencia_corporal_iv']);
    const conditioningLine = getHighestOwnedLevel(treeState, ['condicionamento_fisico_i', 'condicionamento_fisico_ii', 'condicionamento_fisico_iii', 'condicionamento_fisico_iv']);
    const mobilityLine = getHighestOwnedLevel(treeState, ['mobilidade_i', 'mobilidade_ii', 'mobilidade_iii', 'mobilidade_iv']);
    const reflexLine = getHighestOwnedLevel(treeState, ['reflexos_corporais_i', 'reflexos_corporais_ii', 'reflexos_corporais_iii', 'reflexos_corporais_iv']);
    const precisionLine = getHighestOwnedLevel(treeState, ['precisao_tecnica_i', 'precisao_tecnica_ii', 'precisao_tecnica_iii', 'precisao_tecnica_iv']);
    const senseLines = {
        visao: getHighestOwnedLevel(treeState, ['visao_i', 'visao_ii', 'visao_iii', 'visao_iv', 'visao_v']),
        audicao: getHighestOwnedLevel(treeState, ['audicao_i', 'audicao_ii', 'audicao_iii', 'audicao_iv', 'audicao_v']),
        olfato: getHighestOwnedLevel(treeState, ['olfato_i', 'olfato_ii', 'olfato_iii', 'olfato_iv', 'olfato_v']),
        tato: getHighestOwnedLevel(treeState, ['tato_i', 'tato_ii', 'tato_iii', 'tato_iv', 'tato_v']),
        paladar: getHighestOwnedLevel(treeState, ['paladar_i', 'paladar_ii', 'paladar_iii', 'paladar_iv', 'paladar_v']),
        intuicao: getHighestOwnedLevel(treeState, ['intuicao_corporal_i', 'intuicao_corporal_ii', 'intuicao_corporal_iii', 'intuicao_corporal_iv', 'intuicao_corporal_v']),
    };
    const identityLines = {
        barbarian: getHighestOwnedLevel(treeState, ['barbaro_i', 'barbaro_ii']),
        tyrant: getHighestOwnedLevel(treeState, ['tirano_i', 'tirano_ii']),
        benevolent: getHighestOwnedLevel(treeState, ['benevolente_i', 'benevolente_ii']),
        cult: getHighestOwnedLevel(treeState, ['culto_i', 'culto_ii']),
        just: getHighestOwnedLevel(treeState, ['justo_i', 'justo_ii']),
        unjust: getHighestOwnedLevel(treeState, ['injusto_i', 'injusto_ii']),
        instinct: getHighestOwnedLevel(treeState, ['instinto_i', 'instinto_ii']),
    };
    const hasAnySense = Object.values(senseLines).some((line) => line.level > 0);
    const flags = {
        base: hasNode(treeState, 'fisico'),
        vigor: hasNode(treeState, 'vigor'),
        control: hasNode(treeState, 'controle_corporal'),
        perception: hasNode(treeState, 'percepcao_fisica'),
        strength: strengthLine.level > 0,
        resistance: resistanceLine.level > 0,
        conditioning: conditioningLine.level > 0,
        recovery: conditioningLine.level > 0,
        mobility: mobilityLine.level > 0,
        speed: mobilityLine.level > 0,
        reflexes: reflexLine.level > 0,
        agility: reflexLine.level > 0,
        precision: precisionLine.level > 0,
        senses: hasAnySense,
        sharpenedSenses: Object.values(senseLines).some((line) => line.level >= 3),
        barbarian: identityLines.barbarian.level > 0,
        tyrant: identityLines.tyrant.level > 0,
        benevolent: identityLines.benevolent.level > 0,
        cult: identityLines.cult.level > 0,
        just: identityLines.just.level > 0,
        unjust: identityLines.unjust.level > 0,
        antiMage: hasNode(treeState, 'contra_magos'),
        bodyIntuition: senseLines.intuicao.level > 0,
        instinct: identityLines.instinct.level > 0,
        ki: hasNode(treeState, 'ki'),
        zetten: hasNode(treeState, 'zetten'),
        apex: hasNode(treeState, 'apice_fisico'),
    };

    const can = [];
    const cannot = [];
    const buffs = [];

    if (flags.base) can.push('base física pura: corpo, postura, esforço e leitura corporal inicial');
    else cannot.push('progressão física comprada; precisa comprar Físico');

    if (flags.vigor) can.push('abriu Vigor: força aplicada, resistência corporal e condicionamento físico');
    if (flags.control) can.push('abriu Controle Corporal: mobilidade, reflexos corporais e precisão técnica');
    if (flags.perception) can.push('abriu Percepção Física: sentidos e intuição corporal sem bônus numérico');

    if (strengthLine.level > 0) {
        can.push(`Força Aplicada ${romanLevel(strengthLine.level)}: +${percentByLevel(strengthLine.level)}% em golpe, pressão, puxar, empurrar, travar, quebrar e força útil`);
        buffs.push(`Força Aplicada ${romanLevel(strengthLine.level)}: +${percentByLevel(strengthLine.level)}% quando a ação usa Força física aplicada.`);
    }
    if (resistanceLine.level > 0) {
        can.push(`Resistência Corporal ${romanLevel(resistanceLine.level)}: +${percentByLevel(resistanceLine.level)}% em dor, tranco, postura, durabilidade física e continuar sob pressão`);
        buffs.push(`Resistência Corporal ${romanLevel(resistanceLine.level)}: +${percentByLevel(resistanceLine.level)}% em Resistência física contextual.`);
    }
    if (conditioningLine.level > 0) {
        can.push(`Condicionamento Físico ${romanLevel(conditioningLine.level)}: +${percentByLevel(conditioningLine.level)}% em fôlego, ritmo, retomada e esforço prolongado`);
        buffs.push(`Condicionamento Físico ${romanLevel(conditioningLine.level)}: +${percentByLevel(conditioningLine.level)}% em continuidade física, sem curar ferimentos.`);
    }
    if (mobilityLine.level > 0) {
        can.push(`Mobilidade ${romanLevel(mobilityLine.level)}: +${percentByLevel(mobilityLine.level)}% em avançar, recuar, perseguir, fugir, reposicionar e cobrir distância`);
        buffs.push(`Mobilidade ${romanLevel(mobilityLine.level)}: +${percentByLevel(mobilityLine.level)}% quando a ação usa Velocidade de deslocamento físico.`);
    }
    if (reflexLine.level > 0) {
        can.push(`Reflexos Corporais ${romanLevel(reflexLine.level)}: +${percentByLevel(reflexLine.level)}% em esquiva, reação, troca de direção, ajuste corporal e resposta física`);
        buffs.push(`Reflexos Corporais ${romanLevel(reflexLine.level)}: +${percentByLevel(reflexLine.level)}% quando a ação usa Agilidade reativa.`);
    }
    if (precisionLine.level > 0) {
        can.push(`Precisão Técnica ${romanLevel(precisionLine.level)}: +${percentByLevel(precisionLine.level)}% em ação física precisa, normalmente Agilidade, às vezes Força ou leitura narrativa`);
        buffs.push(`Precisão Técnica ${romanLevel(precisionLine.level)}: +${percentByLevel(precisionLine.level)}% em brecha real, ponto certo, desarme, entrada limpa ou punição de abertura.`);
    }

    const senseSummary = Object.entries(senseLines)
        .filter(([, line]) => line.level > 0)
        .map(([key, line]) => `${key === 'intuicao' ? 'intuição' : key} ${romanLevel(line.level)}`);
    if (senseSummary.length) {
        can.push(`sentidos físicos treinados: ${senseSummary.join(', ')}; dão alcance narrativo, qualidade de leitura e permissão de percepção`);
    }

    if (identityLines.barbarian.level > 0) can.push(`Bárbaro ${romanLevel(identityLines.barbarian.level)}: pressão física e brutalidade corporal em confronto direto`);
    if (identityLines.tyrant.level > 0) can.push(`Tirano ${romanLevel(identityLines.tyrant.level)}: aumenta Força Aplicada em domínio físico ofensivo`);
    if (identityLines.benevolent.level > 0) can.push(`Benevolente ${romanLevel(identityLines.benevolent.level)}: reduz consequência física ao defender, proteger ou segurar linha`);
    if (identityLines.cult.level > 0) can.push(`Culto ${romanLevel(identityLines.cult.level)}: identifica falhas físicas e melhora a exploração técnica`);
    if (identityLines.just.level > 0) can.push(`Justo ${romanLevel(identityLines.just.level)}: melhora defesa limpa, frontal ou protetora`);
    if (identityLines.unjust.level > 0) can.push(`Injusto ${romanLevel(identityLines.unjust.level)}: melhora brecha, finta, ângulo ruim e golpe fora do tempo`);
    if (identityLines.instinct.level > 0) can.push(`Instinto ${romanLevel(identityLines.instinct.level)}: resposta física contra ameaça percebível`);
    if (flags.antiMage) can.push('Contra Magos: leitura e punição física de janelas de conjuração; não é antimagia');
    if (flags.ki) can.push('possui Ki registrado, sujeito a aprovação narrativa de uso complexo');
    if (flags.zetten) can.push('possui Zetten registrado, sujeito a aprovação narrativa de uso complexo');
    if (flags.apex) can.push('alcançou Ápice Físico como marco final da rota física');

    if (!flags.ki) cannot.push('Ki livre; o topo exige requisitos, treino e aprovação narrativa');
    if (!flags.zetten) cannot.push('Zetten livre; exige Ki, Força Aplicada III, Precisão Técnica III e aprovação narrativa');
    cannot.push('Estilo de Luta, arma específica ou golpe personalizado; isso será sistema separado');
    cannot.push('bônus físico em magia criada, projétil mágico, mana pura, Reforço mágico, cura ou antimagia');

    if (flags.base) buffs.push('Físico não gera bônus automático fixo; ele libera leitura, corpo e permissões narrativas.');

    return {
        flags,
        levels: {
            strength: strengthLine.level,
            resistance: resistanceLine.level,
            conditioning: conditioningLine.level,
            mobility: mobilityLine.level,
            reflexes: reflexLine.level,
            precision: precisionLine.level,
            senses: Object.fromEntries(Object.entries(senseLines).map(([key, value]) => [key, value.level])),
            identities: Object.fromEntries(Object.entries(identityLines).map(([key, value]) => [key, value.level])),
        },
        can,
        cannot,
        buffs,
        owned,
        ownedNames: owned.map((node) => node.name),
        advanced: owned
            .filter((node) => (node.tags || []).some((tag) => ['avancado', 'convergencia', 'topo'].includes(tag)))
            .map((node) => node.name),
        approvals: owned.filter((node) => node.requiresApproval).map((node) => node.name),
        weights: ownedWeightedNodes(treeState),
    };
}

async function safeTreeState(db, playerId, treeId) {
    try {
        return await getTreeState(db, playerId, treeId);
    } catch (error) {
        if (error?.code === 'tree_not_found') return null;
        throw error;
    }
}

function analyzeCreation(treeState) {
    const force = getHighestOwnedLevel(treeState, ['forca_magica_i', 'forca_magica_ii', 'forca_magica_iii']);
    const speed = getHighestOwnedLevel(treeState, ['velocidade_magica_i', 'velocidade_magica_ii', 'velocidade_magica_iii']);
    const defense = getHighestOwnedLevel(treeState, ['defesa_magica_i', 'defesa_magica_ii', 'defesa_magica_iii']);
    const density = getHighestOwnedLevel(treeState, ['densidade_i', 'densidade_ii', 'densidade_iii']);
    const precision = getHighestOwnedLevel(treeState, ['precisao_i', 'precisao_ii', 'precisao_iii']);
    const weapons = getHighestOwnedLevel(treeState, ['armas_i', 'armas_ii', 'armas_iii']);
    const humanoids = getHighestOwnedLevel(treeState, ['formas_humanoides_i', 'formas_humanoides_ii', 'formas_humanoides_iii']);
    const environment = getHighestOwnedLevel(treeState, ['ambiente_i', 'ambiente_ii', 'ambiente_iii']);

    const flags = {
        base: hasNode(treeState, 'criacao'),
        control: hasNode(treeState, 'controle'),
        structure: hasNode(treeState, 'estrutura'),
        junction: hasNode(treeState, 'juncao_de_forma'),
        forceLevel: force.level,
        speedLevel: speed.level,
        defenseLevel: defense.level,
        densityLevel: density.level,
        precisionLevel: precision.level,
        weaponsLevel: weapons.level,
        humanoidsLevel: humanoids.level,
        environmentLevel: environment.level,
    };

    const can = [];
    const cannot = [];
    const buffs = [];

    if (flags.base) can.push('formas simples: esfera, lâmina simples, névoa pequena, bloco, fio, projétil pequeno ou barreira simples');
    else cannot.push('formas criadas; precisa comprar Criação');

    if (flags.control) can.push('controle básico da manifestação: mover, guiar, estabilizar e ajustar');
    else cannot.push('controle estável da manifestação criada');

    if (flags.structure) can.push('estrutura mais estável e menos frágil');
    else cannot.push('estrutura sólida/precisa da criação');

    if (flags.forceLevel) buffs.push(`impacto da criação +${percentByLevel(flags.forceLevel)}%`);
    else cannot.push('aumento de impacto da criação por Força Mágica');

    if (flags.speedLevel) buffs.push(`velocidade da manifestação +${percentByLevel(flags.speedLevel)}%`);
    if (flags.defenseLevel) buffs.push(`defesa da criação +${percentByLevel(flags.defenseLevel)}%`);
    if (flags.densityLevel) can.push(`criação mais compacta/sólida, nível ${romanLevel(flags.densityLevel)}`);
    if (flags.precisionLevel) can.push(`criação mais fina/cirúrgica, nível ${romanLevel(flags.precisionLevel)}`);

    if (flags.junction) can.push('combinar formas/funções');
    else cannot.push('combinar formas/funções com Junção de Forma');

    if (flags.weaponsLevel) can.push(`foco em manifestações armadas, nível ${romanLevel(flags.weaponsLevel)}`);
    if (flags.humanoidsLevel) can.push(`foco em corpos/construtos, nível ${romanLevel(flags.humanoidsLevel)}`);
    if (flags.environmentLevel) can.push(`foco em área/campo, nível ${romanLevel(flags.environmentLevel)}`);

    return {
        flags,
        can,
        cannot,
        buffs,
        weights: ownedWeightedNodes(treeState),
    };
}

function analyzeReinforcement(treeState) {
    const intensity = getHighestOwnedLevel(treeState, ['intensidade_i', 'intensidade_ii', 'intensidade_iii']);
    const stability = getHighestOwnedLevel(treeState, ['estabilidade_i', 'estabilidade_ii', 'estabilidade_iii']);
    const attributes = [
        ['forca_reforcada', 'Força'],
        ['velocidade_reforcada', 'Velocidade'],
        ['agilidade_reforcada', 'Agilidade'],
        ['resistencia_reforcada', 'Resistência'],
        ['defesa_reforcada', 'Defesa'],
    ].filter(([nodeId]) => hasNode(treeState, nodeId)).map(([, label]) => label);

    let focusCount = hasNode(treeState, 'reforco') ? 1 : 0;
    if (hasNode(treeState, 'duplo_foco')) focusCount = 2;
    if (hasNode(treeState, 'multiplo_foco')) focusCount = 3;

    const flags = {
        base: hasNode(treeState, 'reforco'),
        intensityLevel: intensity.level,
        stabilityLevel: stability.level,
        focusCount,
        selfBuff: hasNode(treeState, 'invencivel'),
        otherBuff: hasNode(treeState, 'invicto'),
        touchBuff: hasNode(treeState, 'reforco_por_toque'),
        distanceBuff: hasNode(treeState, 'reforco_a_distancia'),
        collectiveBuff: hasNode(treeState, 'reforco_coletivo'),
        junction: hasNode(treeState, 'juncao_de_forma'),
        advanced: hasNode(treeState, 'reforco_avancado'),
        advancedWeapons: hasNode(treeState, 'reforco_avancado_armas'),
        advancedHumanoids: hasNode(treeState, 'reforco_avancado_formas_humanoides'),
        advancedEnvironment: hasNode(treeState, 'reforco_avancado_ambiente'),
        attributes,
    };

    const can = [];
    const cannot = [];

    if (flags.base) can.push('reforço corporal básico');
    else cannot.push('reforço corporal; precisa comprar Reforço');

    if (flags.intensityLevel) can.push(`buff +${percentByLevel(flags.intensityLevel)}%`);
    else if (flags.base) can.push('limite inicial básico de 5%');

    if (flags.stabilityLevel) can.push(`duração/segurança ${romanLevel(flags.stabilityLevel)}`);
    if (flags.focusCount) can.push(`${flags.focusCount} atributo${flags.focusCount > 1 ? 's' : ''} no mesmo reforço`);
    if (flags.selfBuff) can.push('autobuff');
    else cannot.push('autobuff pela rota Invencível');

    if (attributes.length) can.push(`atributos físicos liberados: ${attributes.join(', ')}`);
    else if (flags.selfBuff) cannot.push('atributos físicos específicos de autobuff');

    if (flags.otherBuff) can.push('buff em outros quando fizer sentido com suporte/benção futuramente');
    else cannot.push('buff em aliados pela rota Invicto');

    if (flags.touchBuff) can.push('buff externo por toque');
    if (flags.distanceBuff) can.push('buff externo sem toque, limitado por Alcance/Controle/Emissão');
    if (flags.collectiveBuff) can.push('buff em mais de um alvo');
    if (flags.junction) can.push('ligação com forma/área/armadura/aura/campo');
    if (flags.advanced) can.push('Reforço Avançado');
    if (flags.advancedWeapons) can.push('Reforço Avançado ligado a armas');
    if (flags.advancedHumanoids) can.push('Reforço Avançado ligado a armadura/exoesqueleto/avatar/corpo mágico');
    if (flags.advancedEnvironment) can.push('Reforço Avançado aplicado em área/campo');

    return {
        flags,
        can,
        cannot,
        weights: ownedWeightedNodes(treeState),
    };
}

function analyzeMana(treeState) {
    const bullet = getHighestOwnedLevel(treeState, ['mana_bullet_i', 'mana_bullet_ii', 'mana_bullet_iii']);
    const pulse = getHighestOwnedLevel(treeState, ['pulso_de_mana_i', 'pulso_de_mana_ii', 'pulso_de_mana_iii']);
    const skin = getHighestOwnedLevel(treeState, ['mana_skin_i', 'mana_skin_ii', 'mana_skin_iii']);
    const field = getHighestOwnedLevel(treeState, ['campo_de_mana_i', 'campo_de_mana_ii', 'campo_de_mana_iii']);
    const economy = getHighestOwnedLevel(treeState, ['economia_de_mana_i', 'economia_de_mana_ii', 'economia_de_mana_iii']);
    const recovery = getHighestOwnedLevel(treeState, ['recuperacao_i', 'recuperacao_ii', 'recuperacao_iii']);
    const environment = getHighestOwnedLevel(treeState, ['ambiente_de_mana_i', 'ambiente_de_mana_ii', 'ambiente_de_mana_iii']);
    const zone = getHighestOwnedLevel(treeState, ['mana_zone_i', 'mana_zone_ii', 'mana_zone_iii']);

    const flags = {
        base: hasNode(treeState, 'mana'),
        perception: hasNode(treeState, 'percepcao_de_mana'),
        sensing: hasNode(treeState, 'sentir_mana_i') || hasNode(treeState, 'percepcao_de_mana'),
        sensingLevel: getHighestOwnedLevel(treeState, ['sentir_mana_i', 'sentir_mana_ii', 'sentir_mana_iii']).level,
        signature: hasNode(treeState, 'assinatura_magica'),
        flow: hasNode(treeState, 'fluxo_de_mana_i') || hasNode(treeState, 'circulacao') || hasNode(treeState, 'estabilidade') || hasNode(treeState, 'canalizacao'),
        circulation: hasNode(treeState, 'circulacao'),
        stability: hasNode(treeState, 'estabilidade'),
        channeling: hasNode(treeState, 'canalizacao'),
        emission: hasNode(treeState, 'emissao_de_mana_i'),
        retention: hasNode(treeState, 'retencao_de_mana_i') || hasNode(treeState, 'economia_de_mana_i') || hasNode(treeState, 'recuperacao_i'),
        economy: economy.level > 0,
        economyLevel: economy.level,
        recoveryLevel: recovery.level,
        manaSkin: skin.level > 0,
        manaSkinLevel: skin.level,
        manaMantle: hasNode(treeState, 'manto_de_mana_i'),
        field: field.level > 0,
        fieldLevel: field.level,
        environmentalReading: hasNode(treeState, 'leitura_ambiental'),
        environmentalAdaptation: hasNode(treeState, 'adaptacao_ambiental'),
        environment: environment.level > 0,
        environmentLevel: environment.level,
        resonance: hasNode(treeState, 'ressonancia'),
        method: hasNode(treeState, 'metodo_de_mana'),
        zone: zone.level > 0,
        zoneLevel: zone.level,
        domain: hasNode(treeState, 'dominio_de_mana'),
        fineControl: hasNode(treeState, 'controle_fino_i'),
        fineControlLevel: getHighestOwnedLevel(treeState, ['controle_fino_i', 'controle_fino_ii', 'controle_fino_iii']).level,
        compression: hasNode(treeState, 'compressao_de_mana'),
        objectCoating: hasNode(treeState, 'revestimento_de_objeto'),
        simultaneousMaintenance: hasNode(treeState, 'manutencao_simultanea'),
        pressure: hasNode(treeState, 'pressao_de_mana'),
        bulletLevel: bullet.level,
        pulseLevel: pulse.level,
    };

    const can = [];
    const cannot = [];

    if (flags.base) can.push('base técnica de Mana: sentir, circular, reter e emitir energia mágica');
    if (flags.sensing) can.push(flags.sensingLevel ? `Sentir Mana ${romanLevel(flags.sensingLevel)}` : 'percepção básica de presença mágica');
    if (flags.signature) can.push('distinguir Assinatura Mágica');
    if (flags.flow) can.push('Fluxo de Mana como base para circulação interna, estabilidade e reforço mais limpo');
    if (flags.channeling) can.push('Canalização para direcionar mana a corpo, objeto, técnica ou ponto de uso');
    if (flags.emission) can.push('emissão simples de mana para fora do corpo');
    if (flags.retention) can.push('retenção para sustentar efeitos por mais tempo');
    if (flags.bulletLevel) can.push(`Bala de Mana ${romanLevel(flags.bulletLevel)}`);
    else cannot.push('Bala de Mana');
    if (flags.pulseLevel) can.push(`Pulso de Mana ${romanLevel(flags.pulseLevel)}`);
    if (flags.manaSkin) can.push(`Pele de Mana ${romanLevel(flags.manaSkinLevel)} ativa`);
    if (flags.manaMantle) can.push('Manto de Mana ativo');
    if (flags.fineControl) can.push(`Controle Fino ${romanLevel(flags.fineControlLevel)} para várias partes, curvas, ajuste e manipulação delicada`);
    if (flags.economy) can.push(`Economia ${romanLevel(flags.economyLevel)} reduz gasto/manutenção no uso real; não entra no custo bruto do ADM`);
    if (flags.recoveryLevel) can.push(`Recuperação ${romanLevel(flags.recoveryLevel)} para usos prolongados e pós-gasto`);
    if (flags.field) can.push(`Campo de Mana ${romanLevel(flags.fieldLevel)} para leitura de área`);
    if (flags.environmentalReading) can.push('Leitura Ambiental de mana');
    if (flags.environmentalAdaptation) can.push('Adaptação Ambiental');
    if (flags.environment) can.push(`Mana Ambiente ${romanLevel(flags.environmentLevel)}`);
    if (flags.resonance) can.push('Ressonância com mana do entorno');
    if (flags.method) can.push('Método de Mana');
    if (flags.pressure) can.push('Pressão de Mana, conversando com PRE do Hexágono');
    if (flags.zone) can.push(`Zona de Mana ${romanLevel(flags.zoneLevel)} como capacidade avançada de campo`);
    if (flags.domain) can.push('Domínio de Mana como topo narrativo/manual');

    if (!getOwnedNodeIds(treeState).length) {
        cannot.push('técnicas de Mana compradas');
    } else {
        cannot.push('efeitos especiais que pertencem ao tipo de magia, Criação ou Reforço');
        cannot.push('aprovar técnica automaticamente; o ADM ainda decide com ficha, Hexágono e cena');
    }

    return {
        flags,
        can,
        cannot,
        weights: ownedWeightedNodes(treeState),
    };
}

function getMaintenanceTier(key) {
    return MAINTENANCE_TIERS.find((tier) => tier.key === key) || null;
}

function makeCost(label, weight, maintenanceKey = null, note = null) {
    const cost = calculateRankCost(weight);
    const maintenance = maintenanceKey ? getMaintenanceTier(maintenanceKey) : null;
    return {
        label,
        weight,
        rank: cost.rank,
        rankLabel: `Rank ${cost.rank}`,
        mana: cost.totalMana,
        manaLabel: cost.special ? 'especial' : `${cost.totalMana} mana`,
        maintenance,
        note,
    };
}

function buildCommonCosts(capacity) {
    const costs = {
        criacao: [],
        reforco: [],
        mana: [],
        fisico: [],
    };

    const creation = capacity?.creation?.flags || {};
    if (creation.base) costs.criacao.push(makeCost('Forma simples', 2));
    if (creation.control) costs.criacao.push(makeCost('Forma com Controle', 2));
    if (creation.control && creation.forceLevel >= 1) {
        costs.criacao.push(makeCost('Forma com Controle + Força Mágica I', 3));
    }
    if (creation.control && creation.forceLevel >= 1 && creation.densityLevel >= 1) {
        costs.criacao.push(makeCost('Forma com Controle + Força Mágica I + Densidade I', 4));
    }
    if (creation.environmentLevel >= 1) {
        costs.criacao.push(makeCost('Área pequena com Ambiente I', 5, 'media'));
    }

    const reinforcement = capacity?.reinforcement?.flags || {};
    if (reinforcement.base) {
        costs.reforco.push(makeCost('Reforço básico de 1 ação (+5%)', 2));
    }
    if (reinforcement.base && reinforcement.selfBuff && reinforcement.attributes.length && reinforcement.intensityLevel >= 1) {
        costs.reforco.push(makeCost('Autobuff simples de 1 atributo + Intensidade I', 4, 'leve'));
    }
    if (reinforcement.base && reinforcement.selfBuff && reinforcement.attributes.length && reinforcement.intensityLevel >= 1 && reinforcement.stabilityLevel >= 1) {
        costs.reforco.push(makeCost('Autobuff simples + Intensidade I + Estabilidade I', 5, 'media'));
    }
    if (reinforcement.base && reinforcement.selfBuff && reinforcement.attributes.length >= 2 && reinforcement.focusCount >= 2 && reinforcement.intensityLevel >= 1) {
        costs.reforco.push(makeCost('Autobuff com 2 atributos + Intensidade I', 5, 'media'));
    }
    if (reinforcement.collectiveBuff) {
        costs.reforco.push(makeCost('Reforço coletivo simples', 8, 'muito_pesada'));
    }

    const mana = capacity?.mana?.flags || {};
    if (mana.bulletLevel >= 1) costs.mana.push(makeCost('Bala de Mana I', 2));
    if (mana.bulletLevel >= 2) costs.mana.push(makeCost('Bala de Mana II', 4));
    if (mana.bulletLevel >= 3) costs.mana.push(makeCost('Bala de Mana III', 6));
    if (mana.pulseLevel >= 1) costs.mana.push(makeCost('Pulso de Mana I', 2));
    if (mana.pulseLevel >= 2) costs.mana.push(makeCost('Pulso de Mana II', 4));
    if (mana.pulseLevel >= 3) costs.mana.push(makeCost('Pulso de Mana III', 6));
    if (mana.manaSkin) costs.mana.push(makeCost('Pele de Mana ativa', 2, 'leve'));
    if (mana.manaMantle) costs.mana.push(makeCost('Manto de Mana ativo', 5, 'media', 'pode virar pesada conforme uso'));

    return costs;
}

async function getPlayerTechnicalCapacity(db, playerId) {
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!player) {
        return { ok: false, reason: 'player_not_found', playerId };
    }

    const stats = await getCharacterStats(db, playerId);
    const attributes = getAttributeValues(stats, {
        usePending: stats.distribution_status === 'pending_confirmation',
    });
    const ph = await getPhSummary(db, playerId);
    const hexagon = await getOrCreateHexagon(db, playerId);
    const limits = getHexagonDerivedLimits(hexagon);
    const bonusSummary = await getCharacterBonusSummary(db, playerId).catch(() => null);
    const calculatedManaTotal = Number(bonusSummary?.mana?.total || 0);

    const treeStates = {};
    for (const treeId of TECHNICAL_TREE_IDS) {
        treeStates[treeId] = await safeTreeState(db, playerId, treeId);
    }
    const supportState = await safeTreeState(db, playerId, SUPPORT_TREE_ID);

    const capacity = {
        ok: true,
        playerId,
        player,
        displayName: firstFilled(player.personagem_nome, player.nome, playerId),
        stageName: getStageName(stats.stage_key),
        manaTotal: calculatedManaTotal > 0
            ? calculatedManaTotal
            : (Number(player.mana || 0) > 0 ? Number(player.mana || 0) : null),
        poderMagico: Number(attributes.poder_magico || 0),
        attributes,
        stats,
        ph,
        hexagon,
        hexagonLine: formatHexagonLine(hexagon),
        limits,
        trees: treeStates,
        supportTree: supportState,
    };

    capacity.creation = analyzeCreation(treeStates.criacao);
    capacity.reinforcement = analyzeReinforcement(treeStates.reforco);
    capacity.mana = analyzeMana(treeStates.mana);
    capacity.physical = analyzePhysical(treeStates.fisico);
    capacity.support = analyzeSupport(supportState);
    capacity.treeSummaries = {
        mana: summarizeOwnedByTree(treeStates.mana),
        criacao: summarizeOwnedByTree(treeStates.criacao),
        reforco: summarizeOwnedByTree(treeStates.reforco),
        fisico: summarizeOwnedByTree(treeStates.fisico),
        suporte: summarizeOwnedByTree(supportState),
    };
    capacity.nextNodes = {
        mana: summarizeNextNodes(treeStates.mana),
        criacao: summarizeNextNodes(treeStates.criacao),
        reforco: summarizeNextNodes(treeStates.reforco),
        fisico: summarizeNextNodes(treeStates.fisico),
    };
    capacity.approvalNodes = getOwnedApprovalNodes({ ...treeStates, suporte: supportState });
    capacity.highRiskNodes = getOwnedHighRiskNodes({ ...treeStates, suporte: supportState });
    capacity.commonCosts = buildCommonCosts(capacity);
    capacity.maintenanceTiers = MAINTENANCE_TIERS;

    return capacity;
}

function formatNaturalLimit(capacity) {
    const limits = capacity.limits;
    return [
        `Alcance comum: até ${limits.alcanceLabel}.`,
        `Área comum: ${limits.areaLabel}.`,
        `Duração comum: até ${limits.duracaoLabel}.`,
        `Impacto de mana pura: PM ${limits.pressaoBonus}.`,
        `Controle: ${limits.controleLabel}.`,
        `Emissão: ${limits.emissaoLabel}.`,
        `Percepção: ${limits.percepcaoLabel}.`,
    ];
}

function formatCostItem(item) {
    const maintenance = item.maintenance
        ? ` | manutenção sugerida: ${item.maintenance.label}${item.maintenance.percent ? ` ${item.maintenance.percent}%` : ''}`
        : '';
    const note = item.note ? ` | ${item.note}` : '';
    return `> ${item.label}: Peso ${item.weight} -> ${item.rankLabel} -> ${item.manaLabel}${maintenance}${note}`;
}

function formatCanCannot(title, section, costs = [], options = {}) {
    const full = options.full === true;
    const lines = [
        `*${title}*`,
        'Pode:',
        ...(section.can.length ? section.can.map((item) => `✓ ${item}`) : ['- nada comprado ainda']),
    ];

    if (section.buffs?.length) {
        lines.push('Buffs liberados:', ...section.buffs.map((item) => `✓ ${item}`));
    }

    if (full) {
        lines.push(
            'Não pode:',
            ...(section.cannot.length ? section.cannot.map((item) => `✗ ${item}`) : ['- sem bloqueios principais nesta leitura'])
        );
        if (section.weights?.length) {
            lines.push(
                'Pesos técnicos liberados:',
                ...section.weights.map((item) => `> ${item.name}: peso ${item.weight}`)
            );
        }
    }

    lines.push(
        'Custos comuns:',
        ...(costs.length ? costs.map(formatCostItem) : ['> nenhum exemplo liberado por nós comprados'])
    );

    return lines.join('\n');
}

function formatMaintenanceBlock() {
    return [
        '*Manutenção bruta sugerida*',
        ...MAINTENANCE_TIERS.map((tier) => (
            tier.percent
                ? `> ${tier.label} ${tier.percent}%: ${tier.description}`
                : `> ${tier.label}: ${tier.description}`
        )),
    ].join('\n');
}

function formatTreeSummaryLine(label, summary) {
    return `*${label}:* ${summary.count} no(s) comprado(s)${summary.names.length ? ` — ${compactList(summary.names, 'nenhum', 5)}` : ''}`;
}

function formatNextNodeBlock(capacity) {
    return [
        '*Mana:*',
        bulletList(capacity.nextNodes.mana, 'nenhum próximo passo calculado agora'),
        '',
        '*Criação:*',
        bulletList(capacity.nextNodes.criacao, 'nenhum próximo passo calculado agora'),
        '',
        '*Reforço:*',
        bulletList(capacity.nextNodes.reforco, 'nenhum próximo passo calculado agora'),
        '',
        '*Físico:*',
        bulletList(capacity.nextNodes.fisico, 'nenhum próximo passo calculado agora'),
    ].join('\n');
}

function formatCommonCostsBlock(costs) {
    return [
        '*Mana:*',
        ...(costs.mana.length ? costs.mana.map(formatCostItem) : ['> nenhum exemplo liberado por nos comprados']),
        '',
        '*Criacao:*',
        ...(costs.criacao.length ? costs.criacao.map(formatCostItem) : ['> nenhum exemplo liberado por nos comprados']),
        '',
        '*Reforco:*',
        ...(costs.reforco.length ? costs.reforco.map(formatCostItem) : ['> nenhum exemplo liberado por nos comprados']),
        '',
        '*Físico:*',
        '> Físico não usa custo de Mana comum; a progressão física é comprada com PH.',
    ].join('\n');
}

function formatPlayerCapacity(capacity) {
    if (!capacity?.ok) return 'Não encontrei esse personagem no banco.';

    const summary = buildProfileCapacitySummary(capacity);
    const treeSummaries = capacity.treeSummaries || {};
    const supportCount = Number(treeSummaries.suporte?.count || capacity.support?.ownedNames?.length || 0);
    const canLines = [
        summary.creation,
        summary.reinforcement,
        summary.mana,
        'Usar atributos, bônus e efeitos já registrados na ficha.',
    ].filter(Boolean);

    return [
        '♧ 𝐂𝐀𝐏𝐀𝐂𝐈𝐃𝐀𝐃𝐄 𝐀𝐓𝐔𝐀𝐋',
        '     ──  clovᥱr rpg · leitura simples  ──',
        '',
        `*${capacity.displayName || 'Personagem'}*`,
        `> ${capacity.stageName || 'Estágio indefinido'} · PB ${Number(capacity.stats?.pb_total || 0)}`,
        `> Hexágono: ${capacity.hexagonLine}`,
        '',
        '──  𝐋𝐄𝐈𝐓𝐔𝐑𝐀 𝐆𝐄𝐑𝐀𝐋  ──',
        '',
        summary.summary,
        '',
        `*Alcance comum:* ${capacity.limits.alcanceLabel}.`,
        `*Área comum:* ${capacity.limits.areaLabel}.`,
        `*Duração comum:* ${capacity.limits.duracaoLabel}.`,
        `*Controle:* ${capacity.limits.controleLabel}.`,
        '',
        '──  𝐎 𝐐𝐔𝐄 𝐉𝐀́ 𝐂𝐎𝐍𝐒𝐄𝐆𝐔𝐄  ──',
        '',
        bulletList(canLines, 'Nenhuma capacidade prática registrada ainda.'),
        '',
        '──  𝐎 𝐐𝐔𝐄 𝐀𝐈𝐍𝐃𝐀 𝐍𝐀̃𝐎 𝐄́ 𝐒𝐄𝐆𝐔𝐑𝐎  ──',
        '',
        '> Campo grande.',
        '> Técnica automática ou com muitas funções.',
        '> Efeito persistente sem custo/manutenção.',
        '> Uso avançado sem nó, treino ou aprovação narrativa.',
        '',
        '──  𝐀́𝐑𝐕𝐎𝐑𝐄𝐒  ──',
        '',
        `*Mana:* ${Number(treeSummaries.mana?.count || 0)} nós comprados.`,
        `*Criação:* ${Number(treeSummaries.criacao?.count || 0)} nós comprados.`,
        `*Reforço:* ${Number(treeSummaries.reforco?.count || 0)} nós comprados.`,
        `*Suporte:* ${supportCount ? `${supportCount} nós registrados.` : 'parcialmente liberado.'}`,
        '',
        '──  𝐏𝐑𝐎́𝐗𝐈𝐌𝐎 𝐂𝐀𝐌𝐈𝐍𝐇𝐎  ──',
        '',
        'Use:',
        '*̣.#arvores*',
        '> Ver caminhos disponíveis.',
        '',
        '*̣.#capacidade técnica*',
        '> Ver leitura completa, custos e detalhes.',
    ].join('\n');
}

function buildProfileCapacitySummary(capacity) {
    if (!capacity?.ok) {
        return {
            creation: 'Não encontrei dados de Criação deste personagem.',
            reinforcement: 'Não encontrei dados de Reforço deste personagem.',
            mana: 'Não encontrei dados de Mana deste personagem.',
            physical: 'Não encontrei dados de Físico deste personagem.',
            summary: 'Use .#capacidade para revisar os detalhes quando o perfil estiver completo.',
        };
    }

    const creation = capacity.creation?.flags || {};
    const reinforcement = capacity.reinforcement?.flags || {};
    const mana = capacity.mana?.flags || {};
    const physical = capacity.physical?.flags || {};
    const hexagon = capacity.hexagon || {};
    const hasCreationPerformance = creation.control
        || creation.forceLevel > 0
        || creation.speedLevel > 0
        || creation.defenseLevel > 0;

    let creationSummary = 'Você ainda não possui base de Criação comprada.';
    if (creation.environmentLevel > 0) {
        creationSummary = 'Você já começa a trabalhar com manifestações em área/campo.';
    } else if (creation.junction) {
        creationSummary = 'Você já consegue combinar formas ou funções em uma mesma técnica.';
    } else if (hasCreationPerformance) {
        creationSummary = 'Você cria formas simples e suas manifestações já podem receber melhoria básica de desempenho.';
    } else if (creation.base) {
        creationSummary = 'Você consegue criar formas mágicas simples, como esfera, lâmina simples, névoa pequena, fio, projétil pequeno ou barreira simples.';
    }

    let reinforcementSummary = 'Você ainda não possui reforço corporal comprado.';
    if (reinforcement.collectiveBuff || reinforcement.advancedEnvironment) {
        reinforcementSummary = 'Você já começa a alcançar reforços coletivos ou em área.';
    } else if (reinforcement.otherBuff) {
        reinforcementSummary = 'Você já tem caminho para reforçar outras pessoas, dentro dos limites da ficha.';
    } else if (reinforcement.selfBuff) {
        reinforcementSummary = 'Seu foco atual permite autobuff.';
    } else if (reinforcement.base) {
        reinforcementSummary = 'Você consegue fortalecer o próprio corpo com magia de forma básica.';
    }

    let manaSummary = 'Sua manipulação de mana ainda é básica.';
    if (mana.environment || mana.zone) {
        manaSummary = 'Você já começa a usar mana do ambiente como parte do domínio.';
    } else if (mana.fineControl) {
        manaSummary = 'Você possui melhor controle para ajustes, curvas e manipulação delicada.';
    } else if (mana.manaSkin) {
        manaSummary = 'Você consegue revestir o corpo com mana de forma básica.';
    } else if (mana.bulletLevel > 0) {
        manaSummary = 'Você consegue usar mana pura ofensiva.';
    } else if (mana.flow) {
        manaSummary = 'Seu fluxo de mana ajuda na estabilidade de técnicas e reforços.';
    }

    let physicalSummary = 'Você ainda não possui base física comprada.';
    if (physical.apex) {
        physicalSummary = 'Seu corpo já alcançou o Ápice Físico como marco final da rota física.';
    } else if (physical.zetten) {
        physicalSummary = 'Você possui Zetten registrado, mas usos complexos continuam pedindo aprovação narrativa.';
    } else if (physical.ki) {
        physicalSummary = 'Você possui Ki registrado, mas usos complexos continuam pedindo aprovação narrativa.';
    } else if (physical.barbarian || physical.cult || physical.antiMage || physical.instinct) {
        physicalSummary = 'Você já abriu uma especialização física, voltada a pressão, técnica, leitura ou instinto.';
    } else if (physical.vigor && physical.control) {
        physicalSummary = 'Você já trabalha corpo e controle corporal como base física conjunta.';
    } else if (physical.vigor) {
        physicalSummary = 'Você já começou a desenvolver vigor, fôlego e sustentação corporal.';
    } else if (physical.control) {
        physicalSummary = 'Você já começou a desenvolver controle, precisão e leitura corporal.';
    } else if (physical.base) {
        physicalSummary = 'Você possui a base física: postura, esforço, corpo e leitura corporal inicial.';
    }

    const alcance = Number(hexagon.alcance || 1);
    const retencao = Number(hexagon.retencao || 1);
    const controle = Number(hexagon.controle || 1);
    const hasCompoundPotential = creation.junction
        || creation.environmentLevel > 0
        || reinforcement.collectiveBuff
        || reinforcement.advanced
        || physical.ki
        || physical.zetten
        || physical.apex
        || mana.environment
        || mana.zone;
    const hasControlledPotential = controle >= 2
        || hasCreationPerformance
        || reinforcement.stabilityLevel > 0
        || physical.vigor
        || physical.control
        || physical.instinct
        || mana.flow
        || mana.fineControl;

    let summary = 'Seu personagem funciona melhor com técnicas pequenas, curtas e diretas.';
    if (hasCompoundPotential || alcance >= 4 || retencao >= 4) {
        summary = 'Seu personagem começa a ter potencial para campo, manutenção e técnicas compostas.';
    } else if (hasControlledPotential || alcance >= 2 || retencao >= 2) {
        summary = 'Seu personagem já suporta técnicas controladas de curta/média distância.';
    } else if (!creation.base && !reinforcement.base && !physical.base && !getOwnedNodeIds(capacity.trees?.mana).length) {
        summary = 'Seu personagem ainda não deve focar em campo grande, autonomia ou múltiplas funções.';
    }

    return {
        creation: creationSummary,
        reinforcement: reinforcementSummary,
        mana: manaSummary,
        physical: physicalSummary,
        summary,
    };
}

function formatTechnicalCapacity(capacity, options = {}) {
    if (!capacity?.ok) return 'Não encontrei esse personagem no banco.';
    const full = options.full === true || options.admin === true;
    const admin = options.admin === true;
    const costs = capacity.commonCosts;
    const approvalLines = capacity.approvalNodes.length ? capacity.approvalNodes : ['nenhum no comprado com requiresApproval'];
    const riskLines = capacity.highRiskNodes.length ? capacity.highRiskNodes : ['nenhum no alto/extremo comprado'];

    const lines = [
        admin ? '♧ CAPACIDADE TÉCNICA — ADM' : '♧ CAPACIDADE TÉCNICA',
        admin ? '     ── leitura para aprovação manual ──' : '     ── leitura de limites e árvores ──',
        '',
        `*Player:* ${formatMention(capacity.playerId)} - ${capacity.displayName}`,
        admin ? `*Registro:* ${capacity.playerId}` : null,
        '',
        '── ESCALA ──',
        '',
        `*Estágio:* ${capacity.stageName}`,
        `*Mana:* ${capacity.manaTotal === null ? '-' : capacity.manaTotal}`,
        `*Poder Mágico:* ${capacity.poderMagico}`,
        `*PH disponível:* ${capacity.ph.phAvailable}`,
        `*PH acumulado:* ${capacity.ph.phAccumulated}`,
        '',
        '── HEXÁGONO ──',
        '',
        capacity.hexagonLine,
        '',
        `*PER:* ${Number(capacity.hexagon?.percepcao || 1)} — ${capacity.limits.percepcaoLabel}`,
        `*RET:* ${Number(capacity.hexagon?.retencao || 1)} — ${capacity.limits.duracaoLabel}`,
        `*EMI:* ${Number(capacity.hexagon?.emissao || 1)} — ${capacity.limits.emissaoLabel}`,
        `*CON:* ${Number(capacity.hexagon?.controle || 1)} — ${capacity.limits.controleLabel}`,
        `*PRE:* ${Number(capacity.hexagon?.pressao || 1)} — ${capacity.limits.pressaoBonus}`,
        `*ALC:* ${Number(capacity.hexagon?.alcance || 1)} — ${capacity.limits.alcanceLabel}`,
        '',
        '*Limites derivados:*',
        ...formatNaturalLimit(capacity),
        '',
        '── ÁRVORES ──',
        '',
        formatTreeSummaryLine('Mana', capacity.treeSummaries.mana),
        formatTreeSummaryLine('Criação', capacity.treeSummaries.criacao),
        formatTreeSummaryLine('Reforço', capacity.treeSummaries.reforco),
        `*Suporte:* ${capacity.support.ownedNames.length ? `${capacity.support.ownedNames.length} no(s) registrado(s), mas em revisão` : 'em revisão / bloqueado'}`,
        '',
        formatCanCannot('CRIAÇÃO', capacity.creation, costs.criacao, { full }),
        '',
        formatCanCannot('REFORÇO', capacity.reinforcement, costs.reforco, { full }),
        '',
        formatCanCannot('MANA', capacity.mana, costs.mana, { full }),
        '',
        '── SUPORTE ──',
        '',
        capacity.support.warning,
        'Não considere Suporte como capacidade ativa comum até a liberação de balanceamento.',
        capacity.support.ownedNames.length ? `Nós registrados: ${compactList(capacity.support.ownedNames, 'nenhum')}` : null,
        '',
        '── ATENÇÕES TÉCNICAS ──',
        '',
        '*RequiresApproval comprados:*',
        bulletList(approvalLines),
        '',
        full ? '*Risco alto/extremo comprado:*' : '*Risco alto/extremo:*',
        bulletList(riskLines),
        '',
        full ? '── PRÓXIMOS PASSOS DISPONÍVEIS ──' : null,
        full ? '' : null,
        full ? formatNextNodeBlock(capacity) : null,
        full ? '' : null,
        '── CUSTOS COMUNS ──',
        '',
        formatCommonCostsBlock(costs),
        '',
        formatMaintenanceBlock(),
        '',
        admin ? '── LEITURA DO ADM ──' : '── AVISO ──',
        '',
        admin
            ? 'Esta leitura organiza ficha, árvores, riscos e limites para decisão manual da ADM.'
            : 'Nós com aprovação narrativa não significam uso livre automático.',
        'O bot não aprova, não nega, não nerfa e não avalia técnica automaticamente.',
    ].filter((line) => line !== null);

    return lines.join('\n');
}

const previousFormatPlayerCapacity = formatPlayerCapacity;
formatPlayerCapacity = function formatPlayerCapacity(capacity) {
    return previousFormatPlayerCapacity(capacity)
        .replace(
            /Suporte ainda[^\n]*\n[^\n]*compra continua bloqueada\./,
            'Suporte está parcialmente liberado.\nNós básicos podem ser comprados; Magigramática e avançados exigem aprovação narrativa.'
        );
};

const previousFormatTechnicalCapacity = formatTechnicalCapacity;
formatTechnicalCapacity = function formatTechnicalCapacity(capacity, options = {}) {
    return previousFormatTechnicalCapacity(capacity, options)
        .replace(
            /\*Suporte:\*[^\n]*/,
            `*Suporte:* ${capacity?.support?.ownedNames?.length ? `${capacity.support.ownedNames.length} no(s) registrado(s)` : 'parcialmente liberado'}`
        )
        .replace(
            /N\S* considere Suporte[^\n]*/,
            'Básicos contam como capacidade comum; avançados continuam sob aprovação narrativa.'
        );
};

function cleanCapacityText(value) {
    return String(value ?? '')
        .replace(/Ã¡/g, 'á')
        .replace(/Ã /g, 'à')
        .replace(/Ã¢/g, 'â')
        .replace(/Ã£/g, 'ã')
        .replace(/Ã©/g, 'é')
        .replace(/Ãª/g, 'ê')
        .replace(/Ã­/g, 'í')
        .replace(/Ã³/g, 'ó')
        .replace(/Ã´/g, 'ô')
        .replace(/Ãµ/g, 'õ')
        .replace(/Ãº/g, 'ú')
        .replace(/Ã§/g, 'ç')
        .replace(/Ã/g, 'Á')
        .replace(/Ã‰/g, 'É')
        .replace(/Ã“/g, 'Ó')
        .replace(/Ãš/g, 'Ú')
        .replace(/Ã‡/g, 'Ç')
        .replace(/Â·/g, '·')
        .replace(/Â/g, '')
        .replace(/â€”/g, '-')
        .replace(/â€“/g, '-')
        .replace(/âœ“/g, '✓')
        .replace(/âœ—/g, '✕')
        .replace(/â™§/g, '♧')
        .replace(/â”€â”€/g, '──')
        .trim();
}

function sectionTitle(title) {
    return `──  ${title}  ──`;
}

function lineList(items, fallback = 'nada registrado') {
    const list = (items || [])
        .map(cleanCapacityText)
        .filter(Boolean);

    if (!list.length) return `> ${fallback}`;
    return list.map((item) => `> ${item}`).join('\n');
}

function compactCleanList(items, fallback = 'nenhum', limit = 6) {
    const list = (items || [])
        .map(cleanCapacityText)
        .filter(Boolean);

    if (!list.length) return fallback;

    const visible = list.slice(0, limit);
    const extra = list.length - visible.length;
    return `${visible.join(', ')}${extra > 0 ? ` +${extra}` : ''}`;
}

function formatCostItemClean(item) {
    const label = cleanCapacityText(item?.label || 'Custo');
    const rankLabel = cleanCapacityText(item?.rankLabel || (item?.rank ? `Rank ${item.rank}` : 'Rank ?'));
    const manaLabel = cleanCapacityText(item?.manaLabel || '-');
    const maintenance = item?.maintenance
        ? ` | manutenção: ${cleanCapacityText(item.maintenance.label)}${item.maintenance.percent ? ` ${item.maintenance.percent}%` : ''}`
        : '';
    const note = item?.note ? ` | ${cleanCapacityText(item.note)}` : '';

    return `> ${label}: Peso ${Number(item?.weight || 0)} -> ${rankLabel} -> ${manaLabel}${maintenance}${note}`;
}

function renderCostsClean(costs, fallback = 'nenhum exemplo liberado por nós comprados') {
    if (!costs?.length) return `> ${fallback}`;
    return costs.map(formatCostItemClean).join('\n');
}

function renderTreeTechnicalBlock(title, section, costs, options = {}) {
    const full = options.full === true;
    const canLines = section?.can || [];
    const cannotLines = section?.cannot || [];
    const buffLines = section?.buffs || [];
    const weightLines = section?.weights || [];
    const lines = [
        `*${title}*`,
        '*Pode:*',
        lineList(canLines, 'nada comprado ainda'),
    ];

    if (buffLines.length) {
        lines.push('*Buffs:*', lineList(buffLines));
    }

    lines.push('*Custos comuns:*', renderCostsClean(costs));

    if (cannotLines.length) {
        lines.push('*Não libera:*', lineList(cannotLines));
    }

    if (full && weightLines.length) {
        lines.push(
            '*Pesos técnicos:*',
            lineList(weightLines.map((item) => `${cleanCapacityText(item.name)}: peso ${item.weight}`))
        );
    }

    return lines.join('\n');
}

function buildCleanGeneralSummary(capacity) {
    const creation = capacity?.creation?.flags || {};
    const reinforcement = capacity?.reinforcement?.flags || {};
    const mana = capacity?.mana?.flags || {};
    const physical = capacity?.physical?.flags || {};
    const hexagon = capacity?.hexagon || {};
    const controle = Number(hexagon.controle || 1);
    const alcance = Number(hexagon.alcance || 1);
    const retencao = Number(hexagon.retencao || 1);

    if (creation.environmentLevel > 0 || reinforcement.collectiveBuff || mana.environment || mana.zone || physical.zetten || physical.apex) {
        return 'Já existe potencial para técnicas de campo, área ou manutenção, mas usos amplos continuam dependendo de cena e aprovação narrativa.';
    }

    if (creation.junction || reinforcement.advanced || physical.ki || physical.instinct || controle >= 3 || alcance >= 3 || retencao >= 3) {
        return 'O personagem já suporta técnicas compostas ou controladas, desde que o peso e a manutenção caibam no Hexágono.';
    }

    if (creation.base || reinforcement.base || physical.base || mana.bulletLevel > 0 || mana.manaSkin) {
        return 'O personagem funciona melhor com técnicas curtas, diretas e de peso baixo ou médio.';
    }

    return 'A leitura atual ainda é de base: evitar campo grande, efeito persistente e técnica com muitas funções ao mesmo tempo.';
}

function formatNextNodesClean(capacity) {
    return [
        '*Mana:*',
        lineList(capacity?.nextNodes?.mana || [], 'nenhum próximo passo calculado agora'),
        '*Criação:*',
        lineList(capacity?.nextNodes?.criacao || [], 'nenhum próximo passo calculado agora'),
        '*Reforço:*',
        lineList(capacity?.nextNodes?.reforco || [], 'nenhum próximo passo calculado agora'),
    ].join('\n');
}

function formatMaintenanceClean() {
    return [
        '*Manutenção bruta sugerida:*',
        ...MAINTENANCE_TIERS.map((tier) => (
            tier.percent
                ? `> ${cleanCapacityText(tier.label)} ${tier.percent}%: ${cleanCapacityText(tier.description)}`
                : `> ${cleanCapacityText(tier.label)}: ${cleanCapacityText(tier.description)}`
        )),
    ].join('\n');
}

formatPlayerCapacity = function formatPlayerCapacityClean(capacity) {
    if (!capacity?.ok) return 'Não encontrei esse personagem no banco.';

    const summary = buildProfileCapacitySummary(capacity);
    const treeSummaries = capacity.treeSummaries || {};
    const creation = capacity.creation?.flags || {};
    const supportCount = Number(treeSummaries.suporte?.count || capacity.support?.ownedNames?.length || 0);
    const physicalCount = Number(treeSummaries.fisico?.count || capacity.physical?.ownedNames?.length || 0);
    const canLines = [
        creation.base ? summary.creation : 'Sem progresso relevante em Criação registrado ainda.',
        summary.reinforcement,
        summary.mana,
        summary.physical,
        'Usar atributos, bônus e efeitos já registrados na ficha.',
    ].filter(Boolean);

    return [
        '♧ 𝐂𝐀𝐏𝐀𝐂𝐈𝐃𝐀𝐃𝐄 𝐀𝐓𝐔𝐀𝐋',
        '     ──  clovᥱr rpg · leitura simples  ──',
        '',
        `*${cleanCapacityText(capacity.displayName || 'Personagem')}*`,
        `> ${cleanCapacityText(capacity.stageName || 'Estágio indefinido')} · PB ${Number(capacity.stats?.pb_total || 0)}`,
        `> Hexágono: ${cleanCapacityText(capacity.hexagonLine || '-')}`,
        '',
        sectionTitle('𝐋𝐄𝐈𝐓𝐔𝐑𝐀 𝐆𝐄𝐑𝐀𝐋'),
        `> ${cleanCapacityText(summary.summary)}`,
        '',
        sectionTitle('𝐓𝐄𝐓𝐎 𝐍𝐀𝐓𝐔𝐑𝐀𝐋'),
        `> Alcance comum: ${cleanCapacityText(capacity.limits?.alcanceLabel || '-')}.`,
        `> Área comum: ${cleanCapacityText(capacity.limits?.areaLabel || '-')}.`,
        `> Duração comum: ${cleanCapacityText(capacity.limits?.duracaoLabel || '-')}.`,
        `> Controle: ${cleanCapacityText(capacity.limits?.controleLabel || '-')}.`,
        '',
        sectionTitle('𝐎 𝐐𝐔𝐄 𝐉𝐀́ 𝐂𝐎𝐍𝐒𝐄𝐆𝐔𝐄'),
        lineList(canLines, 'nenhuma capacidade prática registrada ainda'),
        '',
        sectionTitle('𝐎 𝐐𝐔𝐄 𝐀𝐈𝐍𝐃𝐀 𝐏𝐄𝐃𝐄 𝐂𝐔𝐈𝐃𝐀𝐃𝐎'),
        '> Campo grande.',
        '> Técnica automática ou com muitas funções.',
        '> Efeito persistente sem custo/manutenção.',
        '> Uso avançado sem nó, treino ou aprovação narrativa.',
        '',
        sectionTitle('𝐀́𝐑𝐕𝐎𝐑𝐄𝐒'),
        `*Mana:* ${Number(treeSummaries.mana?.count || 0)} nó(s) comprados.`,
        `*Criação:* ${Number(treeSummaries.criacao?.count || 0)} nó(s) comprados.`,
        `*Reforço:* ${Number(treeSummaries.reforco?.count || 0)} nó(s) comprados.`,
        `*Físico:* ${physicalCount} nó(s) comprados.`,
        supportCount
            ? `*Suporte:* ${supportCount} nó(s) registrado(s).`
            : '*Suporte:* Suporte está parcialmente liberado. Básicos podem ser comprados; Magigramática e avançados exigem aprovação narrativa.',
        '',
        sectionTitle('𝐏𝐑𝐎́𝐗𝐈𝐌𝐎 𝐂𝐀𝐌𝐈𝐍𝐇𝐎'),
        '*̣.#arvores*',
        '> Ver caminhos disponíveis.',
        '*̣.#capacidade técnica*',
        '> Ver leitura completa, custos e detalhes.',
    ].join('\n');
};

formatTechnicalCapacity = function formatTechnicalCapacityClean(capacity, options = {}) {
    if (!capacity?.ok) return 'Não encontrei esse personagem no banco.';

    const full = options.full === true || options.admin === true;
    const admin = options.admin === true;
    const costs = capacity.commonCosts || { mana: [], criacao: [], reforco: [], fisico: [] };
    const treeSummaries = capacity.treeSummaries || {};
    const supportCount = Number(treeSummaries.suporte?.count || capacity.support?.ownedNames?.length || 0);
    const physicalCount = Number(treeSummaries.fisico?.count || capacity.physical?.ownedNames?.length || 0);
    const approvalLines = capacity.approvalNodes?.length
        ? capacity.approvalNodes
        : ['nenhum nó comprado com requiresApproval'];
    const riskLines = capacity.highRiskNodes?.length
        ? capacity.highRiskNodes
        : ['nenhum nó alto/extremo comprado'];

    const lines = [
        admin ? '♧ 𝐂𝐀𝐏𝐀𝐂𝐈𝐃𝐀𝐃𝐄 𝐓𝐄́𝐂𝐍𝐈𝐂𝐀 · 𝐀𝐃𝐌' : '♧ 𝐂𝐀𝐏𝐀𝐂𝐈𝐃𝐀𝐃𝐄 𝐓𝐄́𝐂𝐍𝐈𝐂𝐀',
        admin
            ? '     ──  clovᥱr rpg · leitura para aprovação manual  ──'
            : '     ──  clovᥱr rpg · limites, custos e árvores  ──',
        '',
        `*${cleanCapacityText(capacity.displayName || 'Personagem')}*`,
        `> ${cleanCapacityText(capacity.stageName || 'Estágio indefinido')} · PB ${Number(capacity.stats?.pb_total || 0)}`,
        `> Mana total: ${capacity.manaTotal === null ? '-' : capacity.manaTotal}`,
        `> Poder Mágico: ${capacity.poderMagico}`,
        `> PH: ${Number(capacity.ph?.phAvailable || 0)} disponível / ${Number(capacity.ph?.phAccumulated || 0)} acumulado`,
        admin ? `> Registro: ${capacity.playerId}` : null,
        '',
        sectionTitle('𝐋𝐄𝐈𝐓𝐔𝐑𝐀 𝐑𝐀́𝐏𝐈𝐃𝐀'),
        `> ${buildCleanGeneralSummary(capacity)}`,
        '',
        sectionTitle('𝐇𝐄𝐗𝐀́𝐆𝐎𝐍𝐎'),
        `> ${cleanCapacityText(capacity.hexagonLine || '-')}`,
        `> PER ${Number(capacity.hexagon?.percepcao || 1)}: ${cleanCapacityText(capacity.limits?.percepcaoLabel || '-')}`,
        `> RET ${Number(capacity.hexagon?.retencao || 1)}: ${cleanCapacityText(capacity.limits?.duracaoLabel || '-')}`,
        `> EMI ${Number(capacity.hexagon?.emissao || 1)}: ${cleanCapacityText(capacity.limits?.emissaoLabel || '-')}`,
        `> CON ${Number(capacity.hexagon?.controle || 1)}: ${cleanCapacityText(capacity.limits?.controleLabel || '-')}`,
        `> PRE ${Number(capacity.hexagon?.pressao || 1)}: ${cleanCapacityText(capacity.limits?.pressaoBonus || '-')}`,
        `> ALC ${Number(capacity.hexagon?.alcance || 1)}: ${cleanCapacityText(capacity.limits?.alcanceLabel || '-')}`,
        `> Área comum: ${cleanCapacityText(capacity.limits?.areaLabel || '-')}`,
        '',
        sectionTitle('𝐀́𝐑𝐕𝐎𝐑𝐄𝐒'),
        `*Mana:* ${Number(treeSummaries.mana?.count || 0)} nó(s) · ${compactCleanList(treeSummaries.mana?.names)}`,
        `*Criação:* ${Number(treeSummaries.criacao?.count || 0)} nó(s) · ${compactCleanList(treeSummaries.criacao?.names)}`,
        `*Reforço:* ${Number(treeSummaries.reforco?.count || 0)} nó(s) · ${compactCleanList(treeSummaries.reforco?.names)}`,
        `*Suporte:* ${supportCount ? `${supportCount} nó(s) registrado(s) · ${compactCleanList(capacity.support?.ownedNames)}` : 'parcialmente liberado'}`,
        '',
        sectionTitle('𝐂𝐑𝐈𝐀𝐂̧𝐀̃𝐎'),
        renderTreeTechnicalBlock('Criação', capacity.creation, costs.criacao, { full }),
        '',
        sectionTitle('𝐑𝐄𝐅𝐎𝐑𝐂̧𝐎'),
        renderTreeTechnicalBlock('Reforço', capacity.reinforcement, costs.reforco, { full }),
        '',
        sectionTitle('𝐌𝐀𝐍𝐀'),
        renderTreeTechnicalBlock('Mana', capacity.mana, costs.mana, { full }),
        '',
        sectionTitle('𝐒𝐔𝐏𝐎𝐑𝐓𝐄'),
        '*Estado:*',
        '> Suporte está parcialmente liberado.',
        '> Básicos contam como capacidade comum; Magigramática e usos avançados exigem aprovação narrativa.',
        supportCount ? '*Nós registrados:*' : null,
        supportCount ? lineList(capacity.support?.ownedNames) : null,
        '',
        sectionTitle('𝐀𝐓𝐄𝐍𝐂̧𝐎̃𝐄𝐒 𝐓𝐄́𝐂𝐍𝐈𝐂𝐀𝐒'),
        '*RequiresApproval comprados:*',
        lineList(approvalLines),
        '*Risco alto/extremo:*',
        lineList(riskLines),
        '',
        full ? sectionTitle('𝐏𝐑𝐎́𝐗𝐈𝐌𝐎𝐒 𝐍𝐎́𝐒') : null,
        full ? formatNextNodesClean(capacity) : null,
        full ? '' : null,
        sectionTitle('𝐂𝐔𝐒𝐓𝐎𝐒 𝐂𝐎𝐌𝐔𝐍𝐒'),
        '*Mana:*',
        renderCostsClean(costs.mana),
        '*Criação:*',
        renderCostsClean(costs.criacao),
        '*Reforço:*',
        renderCostsClean(costs.reforco),
        '',
        sectionTitle('𝐌𝐀𝐍𝐔𝐓𝐄𝐍𝐂̧𝐀̃𝐎'),
        formatMaintenanceClean(),
        '',
        sectionTitle(admin ? '𝐋𝐄𝐈𝐓𝐔𝐑𝐀 𝐃𝐎 𝐀𝐃𝐌' : '𝐀𝐕𝐈𝐒𝐎'),
        admin
            ? '> Esta leitura organiza ficha, árvores, riscos e limites para decisão manual da ADM.'
            : '> Nós com aprovação narrativa não significam uso livre automático.',
        '> O bot não aprova técnica automaticamente.',
        '> O bot não avalia técnica automaticamente.',
        '> O ADM ainda decide com ficha, Hexágono, cena e contexto.',
    ].filter((line) => line !== null);

    return lines.join('\n');
};

function prettyText(value) {
    return String(value ?? '')
        .replace(/Ã¡/g, 'á')
        .replace(/Ã /g, 'à')
        .replace(/Ã¢/g, 'â')
        .replace(/Ã£/g, 'ã')
        .replace(/Ã©/g, 'é')
        .replace(/Ãª/g, 'ê')
        .replace(/Ã­/g, 'í')
        .replace(/Ã³/g, 'ó')
        .replace(/Ã´/g, 'ô')
        .replace(/Ãµ/g, 'õ')
        .replace(/Ãº/g, 'ú')
        .replace(/Ã§/g, 'ç')
        .replace(/Ã/g, 'Á')
        .replace(/Ã‰/g, 'É')
        .replace(/Ã“/g, 'Ó')
        .replace(/Ãš/g, 'Ú')
        .replace(/Ã‡/g, 'Ç')
        .replace(/Â·/g, '·')
        .replace(/â€”/g, '-')
        .replace(/â€“/g, '-')
        .replace(/âœ“/g, '✓')
        .replace(/âœ•/g, '✕')
        .replace(/â™§/g, '♧')
        .replace(/â”€/g, '─')
        .replace(/â€¢/g, '•')
        .replace(/â“˜/g, 'ⓘ')
        .replace(/NÃ£o/g, 'Não')
        .replace(/nÃ£o/g, 'não')
        .replace(/Ãrvore/g, 'Árvore')
        .replace(/CriaÃ§Ã£o/g, 'Criação')
        .replace(/ReforÃ§o/g, 'Reforço')
        .replace(/nÃ³/g, 'nó')
        .replace(/nÃ³s/g, 'nós')
        .replace(/disponÃ­vel/g, 'disponível')
        .replace(/aprovaÃ§Ã£o/g, 'aprovação')
        .replace(/tÃ©cnica/g, 'técnica')
        .replace(/tÃ©cnico/g, 'técnico')
        .replace(/mÃ¡gica/g, 'mágica')
        .replace(/MÃ¡gico/g, 'Mágico')
        .replace(/manutenÃ§Ã£o/g, 'manutenção')
        .replace(/ManutenÃ§Ã£o/g, 'Manutenção')
        .trim();
}

function prettySection(title) {
    return `_` + `\`─( ◆ )───── ${title}\`` + `_`;
}

function prettyLineList(items, fallback = 'nada registrado') {
    const list = (items || [])
        .map(prettyText)
        .filter(Boolean);

    if (!list.length) return `> ${fallback}`;
    return list.map((item) => `> ${item}`).join('\n');
}

function prettyCompactList(items, fallback = 'nenhum', limit = 6) {
    const list = (items || [])
        .map(prettyText)
        .filter(Boolean);

    if (!list.length) return fallback;
    const visible = list.slice(0, limit);
    const extra = list.length - visible.length;
    return `${visible.join(', ')}${extra > 0 ? ` +${extra}` : ''}`;
}

function prettyCostItem(item) {
    const label = prettyText(item?.label || 'Custo');
    const rankLabel = prettyText(item?.rankLabel || (item?.rank ? `Rank ${item.rank}` : 'Rank ?'));
    const manaLabel = prettyText(item?.manaLabel || '-');
    const maintenance = item?.maintenance
        ? ` | manutenção: ${prettyText(item.maintenance.label)}${item.maintenance.percent ? ` ${item.maintenance.percent}%` : ''}`
        : '';
    const note = item?.note ? ` | ${prettyText(item.note)}` : '';

    return `> ${label}: Peso ${Number(item?.weight || 0)} -> ${rankLabel} -> ${manaLabel}${maintenance}${note}`;
}

function prettyCosts(costs, fallback = 'nenhum exemplo liberado por nós comprados') {
    if (!costs?.length) return `> ${fallback}`;
    return costs.map(prettyCostItem).join('\n');
}

function prettyBasicMagicUse(capacity) {
    const creation = capacity?.creation?.flags || {};
    const reinforcement = capacity?.reinforcement?.flags || {};
    const baseCost = calculateRankCost(2);
    const costLine = `Peso: ${baseCost.weight} -> Rank ${baseCost.rank} -> ${baseCost.totalMana} mana.`;

    const lines = [
        prettySection('USO BÁSICO SEM FEITIÇO'),
        '*Criação base*',
    ];

    if (creation.base) {
        lines.push(
            '> Manifesta formas simples da própria magia sem montar um feitiço completo.',
            '> Exemplos: esfera, lâmina simples, névoa pequena, bloco, fio, projétil curto ou barreira simples.',
            `> ${costLine}`,
            '> Manutenção: instantânea, dentro do alcance e duração do Hexágono.',
            '> Não cria forma complexa, automática, persistente ou com múltiplas funções sem nós próprios.'
        );
    } else {
        lines.push('> Ainda não comprada.');
    }

    lines.push('', '*Reforço base*');

    if (reinforcement.base) {
        lines.push(
            '> Reforça uma parte do corpo para uma ação simples.',
            '> Bônus base: +5% em uma ação física compatível.',
            `> ${costLine}`,
            '> Manutenção: instantânea.',
            '> Não vira buff contínuo, não atinge aliados e não melhora projétil/criação mágica sozinho.'
        );
    } else {
        lines.push('> Ainda não comprado.');
    }

    return lines.join('\n');
}

function prettyTreeTechnicalBlock(title, section, costs, options = {}) {
    const full = options.full === true;
    const canLines = section?.can || [];
    const cannotLines = section?.cannot || [];
    const buffLines = section?.buffs || [];
    const weightLines = section?.weights || [];
    const lines = [
        `*${title}*`,
        '*Pode:*',
        prettyLineList(canLines, 'nada comprado ainda'),
    ];

    if (buffLines.length) {
        lines.push('*Buffs:*', prettyLineList(buffLines));
    }

    lines.push('*Custos comuns:*', prettyCosts(costs));

    if (cannotLines.length) {
        lines.push('*Não libera:*', prettyLineList(cannotLines));
    }

    if (full && weightLines.length) {
        lines.push(
            '*Pesos técnicos:*',
            prettyLineList(weightLines.map((item) => `${prettyText(item.name)}: peso ${item.weight}`))
        );
    }

    return lines.join('\n');
}

function prettyPhysicalTechnicalBlock(section, options = {}) {
    const full = options.full === true;
    const canLines = section?.can || [];
    const cannotLines = section?.cannot || [];
    const buffLines = section?.buffs || [];
    const weightLines = section?.weights || [];
    const advancedLines = section?.advanced || [];
    const approvalLines = section?.approvals || [];
    const lines = [
        '*Físico*',
        '*Pode:*',
        prettyLineList(canLines, 'nada comprado ainda'),
    ];

    lines.push(
        '*Custo e uso:*',
        '> Físico usa PH dos nós e contexto narrativo.',
        '> Não usa peso de Mana nem limite direto do Hexágono.',
        '> Não substitui Estilo de Luta, arma específica ou golpe personalizado.'
    );

    if (buffLines.length) {
        lines.push('*Observações:*', prettyLineList(buffLines));
    }

    if (advancedLines.length) {
        lines.push('*Avançados registrados:*', prettyLineList(advancedLines));
    }

    if (approvalLines.length) {
        lines.push('*Pedem aprovação narrativa:*', prettyLineList(approvalLines));
    }

    if (cannotLines.length) {
        lines.push('*Não libera:*', prettyLineList(cannotLines));
    }

    if (full && weightLines.length) {
        lines.push(
            '*Pesos técnicos:*',
            prettyLineList(weightLines.map((item) => `${prettyText(item.name)}: peso ${item.weight}`))
        );
    }

    return lines.join('\n');
}

function prettyGeneralSummary(capacity) {
    return prettyText(buildCleanGeneralSummary(capacity));
}

function prettyNextNodes(capacity) {
    return [
        '*Mana:*',
        prettyLineList(capacity?.nextNodes?.mana || [], 'nenhum próximo passo calculado agora'),
        '*Criação:*',
        prettyLineList(capacity?.nextNodes?.criacao || [], 'nenhum próximo passo calculado agora'),
        '*Reforço:*',
        prettyLineList(capacity?.nextNodes?.reforco || [], 'nenhum próximo passo calculado agora'),
        '*Físico:*',
        prettyLineList(capacity?.nextNodes?.fisico || [], 'nenhum próximo passo calculado agora'),
    ].join('\n');
}

function prettyMaintenance() {
    return [
        '*Manutenção bruta sugerida:*',
        ...MAINTENANCE_TIERS.map((tier) => (
            tier.percent
                ? `> ${prettyText(tier.label)} ${tier.percent}%: ${prettyText(tier.description)}`
                : `> ${prettyText(tier.label)}: ${prettyText(tier.description)}`
        )),
    ].join('\n');
}

formatPlayerCapacity = function formatPlayerCapacityPretty(capacity) {
    if (!capacity?.ok) return 'Não encontrei esse personagem no banco.';

    const summary = buildProfileCapacitySummary(capacity);
    const treeSummaries = capacity.treeSummaries || {};
    const creation = capacity.creation?.flags || {};
    const supportCount = Number(treeSummaries.suporte?.count || capacity.support?.ownedNames?.length || 0);
    const physicalCount = Number(treeSummaries.fisico?.count || capacity.physical?.ownedNames?.length || 0);
    const canLines = [
        creation.base ? summary.creation : 'Sem progresso relevante em Criação registrado ainda.',
        summary.reinforcement,
        summary.mana,
        summary.physical,
        'Usar atributos, bônus e efeitos já registrados na ficha.',
    ].filter(Boolean);

    return [
        '♧┃𝐂𝐀𝐏𝐀𝐂𝐈𝐃𝐀𝐃𝐄 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  o que seu personagem já consegue fazer  ──',
        '',
        `*${prettyText(capacity.displayName || 'Personagem')}*`,
        `> ${prettyText(capacity.stageName || 'Estágio indefinido')} · PB ${Number(capacity.stats?.pb_total || 0)}`,
        `> Hexágono: ${prettyText(capacity.hexagonLine || '-')}`,
        '',
        prettySection('𝗟𝗲𝗶𝘁𝘂𝗿𝗮 𝗚𝗲𝗿𝗮𝗹'),
        `> ${prettyText(summary.summary)}`,
        '',
        prettySection('𝗧𝗲𝘁𝗼 𝗡𝗮𝘁𝘂𝗿𝗮𝗹'),
        `> Alcance comum: ${prettyText(capacity.limits?.alcanceLabel || '-')}.`,
        `> Área comum: ${prettyText(capacity.limits?.areaLabel || '-')}.`,
        `> Duração comum: ${prettyText(capacity.limits?.duracaoLabel || '-')}.`,
        `> Controle: ${prettyText(capacity.limits?.controleLabel || '-')}.`,
        '',
        prettyBasicMagicUse(capacity),
        '',
        prettySection('𝗢 𝗤𝘂𝗲 𝗝𝗮́ 𝗖𝗼𝗻𝘀𝗲𝗴𝘂𝗲'),
        prettyLineList(canLines, 'nenhuma capacidade prática registrada ainda'),
        '',
        prettySection('𝗢 𝗤𝘂𝗲 𝗔𝗶𝗻𝗱𝗮 𝗣𝗲𝗱𝗲 𝗖𝘂𝗶𝗱𝗮𝗱𝗼'),
        '> Campo grande.',
        '> Técnica automática ou com muitas funções.',
        '> Efeito persistente sem custo/manutenção.',
        '> Uso avançado sem nó, treino ou aprovação narrativa.',
        '',
        prettySection('𝗔́𝗿𝘃𝗼𝗿𝗲𝘀'),
        `*Mana:* ${Number(treeSummaries.mana?.count || 0)} nó(s) comprados.`,
        `*Criação:* ${Number(treeSummaries.criacao?.count || 0)} nó(s) comprados.`,
        `*Reforço:* ${Number(treeSummaries.reforco?.count || 0)} nó(s) comprados.`,
        `*Físico:* ${physicalCount} nó(s) comprados.`,
        supportCount
            ? `*Suporte:* ${supportCount} nó(s) registrado(s).`
            : '*Suporte:* está parcialmente liberado. Básicos podem ser comprados; Magigramática e avançados exigem aprovação narrativa.',
        '',
        prettySection('𝗣𝗿𝗼́𝘅𝗶𝗺𝗼 𝗖𝗮𝗺𝗶𝗻𝗵𝗼'),
        '*̣.#arvores*',
        '> Ver caminhos disponíveis.',
        '*̣.#capacidade técnica*',
        '> Ver leitura completa, custos e detalhes.',
    ].join('\n');
};

formatTechnicalCapacity = function formatTechnicalCapacityPretty(capacity, options = {}) {
    if (!capacity?.ok) return 'Não encontrei esse personagem no banco.';

    const full = options.full === true || options.admin === true;
    const admin = options.admin === true;
    const costs = capacity.commonCosts || { mana: [], criacao: [], reforco: [], fisico: [] };
    const treeSummaries = capacity.treeSummaries || {};
    const supportCount = Number(treeSummaries.suporte?.count || capacity.support?.ownedNames?.length || 0);
    const physicalCount = Number(treeSummaries.fisico?.count || capacity.physical?.ownedNames?.length || 0);
    const approvalLines = capacity.approvalNodes?.length
        ? capacity.approvalNodes
        : ['nenhum nó comprado com requiresApproval'];
    const riskLines = capacity.highRiskNodes?.length
        ? capacity.highRiskNodes
        : ['nenhum nó alto/extremo comprado'];

    const lines = [
        admin ? '♧┃𝐂𝐀𝐏𝐀𝐂𝐈𝐃𝐀𝐃𝐄 𝐓𝐄́𝐂𝐍𝐈𝐂𝐀 · 𝐀𝐃𝐌 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫' : '♧┃𝐂𝐀𝐏𝐀𝐂𝐈𝐃𝐀𝐃𝐄 𝐓𝐄́𝐂𝐍𝐈𝐂𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        admin
            ? '     ──  leitura para aprovação manual  ──'
            : '     ──  limites, custos ᥱ árvores  ──',
        '',
        `*${prettyText(capacity.displayName || 'Personagem')}*`,
        `> ${prettyText(capacity.stageName || 'Estágio indefinido')} · PB ${Number(capacity.stats?.pb_total || 0)}`,
        `> Mana total: ${capacity.manaTotal === null ? '-' : capacity.manaTotal}`,
        `> Poder Mágico: ${capacity.poderMagico}`,
        `> PH: ${Number(capacity.ph?.phAvailable || 0)} disponível / ${Number(capacity.ph?.phAccumulated || 0)} acumulado`,
        admin ? `> Registro: ${capacity.playerId}` : null,
        '',
        prettySection('𝗟𝗲𝗶𝘁𝘂𝗿𝗮 𝗥𝗮́𝗽𝗶𝗱𝗮'),
        `> ${prettyGeneralSummary(capacity)}`,
        '',
        prettySection('𝗛𝗲𝘅𝗮́𝗴𝗼𝗻𝗼'),
        `> ${prettyText(capacity.hexagonLine || '-')}`,
        `> PER ${Number(capacity.hexagon?.percepcao || 1)}: ${prettyText(capacity.limits?.percepcaoLabel || '-')}`,
        `> RET ${Number(capacity.hexagon?.retencao || 1)}: ${prettyText(capacity.limits?.duracaoLabel || '-')}`,
        `> EMI ${Number(capacity.hexagon?.emissao || 1)}: ${prettyText(capacity.limits?.emissaoLabel || '-')}`,
        `> CON ${Number(capacity.hexagon?.controle || 1)}: ${prettyText(capacity.limits?.controleLabel || '-')}`,
        `> PRE ${Number(capacity.hexagon?.pressao || 1)}: ${prettyText(capacity.limits?.pressaoBonus || '-')}`,
        `> ALC ${Number(capacity.hexagon?.alcance || 1)}: ${prettyText(capacity.limits?.alcanceLabel || '-')}`,
        `> Área comum: ${prettyText(capacity.limits?.areaLabel || '-')}`,
        '',
        prettyBasicMagicUse(capacity),
        '',
        prettySection('𝗔́𝗿𝘃𝗼𝗿𝗲𝘀'),
        `*Mana:* ${Number(treeSummaries.mana?.count || 0)} nó(s) · ${prettyCompactList(treeSummaries.mana?.names)}`,
        `*Criação:* ${Number(treeSummaries.criacao?.count || 0)} nó(s) · ${prettyCompactList(treeSummaries.criacao?.names)}`,
        `*Reforço:* ${Number(treeSummaries.reforco?.count || 0)} nó(s) · ${prettyCompactList(treeSummaries.reforco?.names)}`,
        `*Físico:* ${physicalCount} nó(s) · ${prettyCompactList(treeSummaries.fisico?.names)}`,
        `*Suporte:* ${supportCount ? `${supportCount} nó(s) registrado(s) · ${prettyCompactList(capacity.support?.ownedNames)}` : 'está parcialmente liberado'}`,
        '',
        prettySection('𝗖𝗿𝗶𝗮𝗰̧𝗮̃𝗼'),
        prettyTreeTechnicalBlock('Criação', capacity.creation, costs.criacao, { full }),
        '',
        prettySection('𝗥𝗲𝗳𝗼𝗿𝗰̧𝗼'),
        prettyTreeTechnicalBlock('Reforço', capacity.reinforcement, costs.reforco, { full }),
        '',
        prettySection('𝗠𝗮𝗻𝗮'),
        prettyTreeTechnicalBlock('Mana', capacity.mana, costs.mana, { full }),
        '',
        prettySection('𝗙𝗶́𝘀𝗶𝗰𝗼'),
        prettyPhysicalTechnicalBlock(capacity.physical, { full }),
        '',
        prettySection('𝗦𝘂𝗽𝗼𝗿𝘁𝗲'),
        '*Estado:*',
        '> Suporte está parcialmente liberado.',
        '> Básicos contam como capacidade comum; Magigramática e usos avançados exigem aprovação narrativa.',
        supportCount ? '*Nós registrados:*' : null,
        supportCount ? prettyLineList(capacity.support?.ownedNames) : null,
        '',
        prettySection('𝗔𝘁𝗲𝗻𝗰̧𝗼̃𝗲𝘀 𝗧𝗲́𝗰𝗻𝗶𝗰𝗮𝘀'),
        '*RequiresApproval comprados:*',
        prettyLineList(approvalLines),
        '*Risco alto/extremo:*',
        prettyLineList(riskLines),
        '',
        full ? prettySection('𝗣𝗿𝗼́𝘅𝗶𝗺𝗼𝘀 𝗡𝗼́𝘀') : null,
        full ? prettyNextNodes(capacity) : null,
        full ? '' : null,
        prettySection('𝗖𝘂𝘀𝘁𝗼𝘀 𝗖𝗼𝗺𝘂𝗻𝘀'),
        '*Mana:*',
        prettyCosts(costs.mana),
        '*Criação:*',
        prettyCosts(costs.criacao),
        '*Reforço:*',
        prettyCosts(costs.reforco),
        '*Físico:*',
        '> Físico não usa custo de Mana comum.',
        '> A progressão física é comprada com PH nos nós da árvore.',
        '',
        prettySection('𝗠𝗮𝗻𝘂𝘁𝗲𝗻𝗰̧𝗮̃𝗼'),
        prettyMaintenance(),
        '',
        prettySection(admin ? '𝗟𝗲𝗶𝘁𝘂𝗿𝗮 𝗗𝗼 𝗔𝗗𝗠' : '𝗔𝘃𝗶𝘀𝗼'),
        admin
            ? '> Esta leitura organiza ficha, árvores, riscos e limites para decisão manual da ADM.'
            : '> Nós com aprovação narrativa não significam uso livre automático.',
        '> O bot não aprova técnica automaticamente.',
        '> O bot não avalia técnica automaticamente.',
        '> O ADM ainda decide com ficha, Hexágono, cena e contexto.',
    ].filter((line) => line !== null);

    return lines.join('\n');
};

function frontCleanText(value) {
    let text = String(value ?? '');
    const replacements = [
        ['ÃƒÂ¡', 'á'], ['Ãƒ ', 'à'], ['ÃƒÂ¢', 'â'], ['ÃƒÂ£', 'ã'], ['ÃƒÂ©', 'é'],
        ['ÃƒÂª', 'ê'], ['ÃƒÂ­', 'í'], ['ÃƒÂ³', 'ó'], ['ÃƒÂ´', 'ô'], ['ÃƒÂµ', 'õ'],
        ['ÃƒÂº', 'ú'], ['ÃƒÂ§', 'ç'], ['ÃƒÂ', 'Á'], ['Ãƒâ€°', 'É'], ['Ãƒâ€œ', 'Ó'],
        ['ÃƒÅ¡', 'Ú'], ['Ãƒâ€¡', 'Ç'], ['Ã¡', 'á'], ['Ã ', 'à'], ['Ã¢', 'â'],
        ['Ã£', 'ã'], ['Ã©', 'é'], ['Ãª', 'ê'], ['Ã­', 'í'], ['Ã³', 'ó'], ['Ã´', 'ô'],
        ['Ãµ', 'õ'], ['Ãº', 'ú'], ['Ã§', 'ç'], ['Ã', 'Á'], ['Ã‰', 'É'], ['Ã“', 'Ó'],
        ['Ãš', 'Ú'], ['Ã‡', 'Ç'], ['Â·', '·'], ['â€¢', '•'], ['âœ“', '✓'],
        ['âœ•', '✕'], ['â†’', '→'], ['â™§', '♧'], ['â”€', '─'], ['ð–¥”', '𖥔'],
        ['Ãrvore', 'Árvore'], ['Ãrea', 'Área'], ['FÃ­sico', 'Físico'], ['FÃ­sica', 'Física'],
        ['CriaÃ§Ã£o', 'Criação'], ['ReforÃ§o', 'Reforço'], ['PercepÃ§Ã£o', 'Percepção'],
        ['TÃ©cnica', 'Técnica'], ['tÃ©cnica', 'técnica'], ['mÃ¡gica', 'mágica'],
        ['MÃ¡gica', 'Mágica'], ['MÃ¡gico', 'Mágico'], ['nÃ³', 'nó'], ['nÃ³s', 'nós'],
        ['NÃ£o', 'Não'], ['nÃ£o', 'não'], ['aprovaÃ§Ã£o', 'aprovação'],
    ];

    for (let pass = 0; pass < 2; pass += 1) {
        for (const [from, to] of replacements) {
            text = text.split(from).join(to);
        }
    }

    return text.trim();
}

function frontRoman(level) {
    return ['', 'I', 'II', 'III', 'IV', 'V'][Number(level || 0)] || String(level || '');
}

function frontPercent(level) {
    return [0, 10, 20, 30, 40][Number(level || 0)] || 0;
}

function frontHeader(title, subtitle) {
    return [
        `*♧┃${title} 𖥔 CLOVER MULTICOLOR*`,
        `     ── ${subtitle} ──`,
    ];
}

function frontSection(symbol, title) {
    return `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;
}

function frontField(label, value) {
    const displayValue = value === null || value === undefined || value === '' ? '-' : value;
    return `*${label}:* ${frontCleanText(displayValue)}`;
}

function frontList(items, fallback = 'nada registrado') {
    const lines = (items || [])
        .map(frontCleanText)
        .filter(Boolean);

    if (!lines.length) return `> ${fallback}`;
    return lines.map((item) => `> ${item}`).join('\n');
}

function frontCompact(items, fallback = 'nenhum', limit = 5) {
    const lines = (items || [])
        .map(frontCleanText)
        .filter(Boolean);

    if (!lines.length) return fallback;
    const visible = lines.slice(0, limit);
    const extra = lines.length - visible.length;
    return `${visible.join(', ')}${extra > 0 ? ` +${extra}` : ''}`;
}

function frontTreeCount(capacity, treeId) {
    const summaries = capacity?.treeSummaries || {};
    if (treeId === 'suporte') {
        return Number(summaries.suporte?.count || capacity?.support?.ownedNames?.length || 0);
    }
    return Number(summaries[treeId]?.count || 0);
}

function frontCostItem(item) {
    const label = frontCleanText(item?.label || 'Custo');
    const rankLabel = frontCleanText(item?.rankLabel || (item?.rank ? `Rank ${item.rank}` : 'Rank ?'));
    const manaLabel = frontCleanText(item?.manaLabel || '-');
    const maintenance = item?.maintenance
        ? ` | manutenção: ${frontCleanText(item.maintenance.label)}${item.maintenance.percent ? ` ${item.maintenance.percent}%` : ''}`
        : '';
    const note = item?.note ? ` | ${frontCleanText(item.note)}` : '';

    return `> ${label}: Peso ${Number(item?.weight || 0)} → ${rankLabel} → ${manaLabel}${maintenance}${note}`;
}

function frontCosts(costs, fallback = 'nenhum exemplo liberado por nós comprados') {
    if (!costs?.length) return `> ${fallback}`;
    return costs.map(frontCostItem).join('\n');
}

function frontCreationLines(capacity, technical = false) {
    const flags = capacity?.creation?.flags || {};
    const lines = [];

    if (!flags.base) return ['Ainda não possui Criação comprada.'];

    lines.push('Cria formas mágicas simples: esfera, lâmina simples, névoa pequena, bloco, fio, projétil curto ou barreira simples.');
    if (flags.control) lines.push('Pode mover, guiar, estabilizar e ajustar a forma criada.');
    if (flags.structure) lines.push('Pode dar mais firmeza, encaixe e corpo para a manifestação.');
    if (flags.forceLevel) lines.push(`Quando a criação for feita para impacto, pressão ou rompimento, usa Força Mágica ${frontRoman(flags.forceLevel)} (+${frontPercent(flags.forceLevel)}%).`);
    if (flags.speedLevel) lines.push(`Quando a criação precisar avançar, perseguir ou alcançar algo, usa Velocidade Mágica ${frontRoman(flags.speedLevel)} (+${frontPercent(flags.speedLevel)}%).`);
    if (flags.defenseLevel) lines.push(`Quando a criação servir para bloquear, cobrir ou proteger, usa Defesa Mágica ${frontRoman(flags.defenseLevel)} (+${frontPercent(flags.defenseLevel)}%).`);
    if (flags.densityLevel) lines.push(`Quando a forma precisar ser mais compacta, firme ou resistente, usa Densidade ${frontRoman(flags.densityLevel)}.`);
    if (flags.precisionLevel) lines.push(`Quando a forma precisar encaixar ponto exato, brecha ou detalhe fino, usa Precisão ${frontRoman(flags.precisionLevel)}.`);
    if (flags.junction) lines.push('Pode juntar forma e função na mesma magia quando a descrição combinar.');
    if (flags.weaponsLevel) lines.push(`Pode criar manifestações com leitura de arma em nível ${frontRoman(flags.weaponsLevel)}.`);
    if (flags.humanoidsLevel) lines.push(`Pode criar formas humanoides, construtos ou corpos mágicos em nível ${frontRoman(flags.humanoidsLevel)}.`);
    if (flags.environmentLevel) lines.push(`Pode trabalhar criação em ambiente, campo ou área em nível ${frontRoman(flags.environmentLevel)}.`);

    if (technical) {
        if (!flags.junction) lines.push('Sem Junção de Forma, não junta várias funções complexas no mesmo feitiço.');
        if (!flags.environmentLevel) lines.push('Campo grande, forma persistente ou criação automática ainda pede nó, custo e aprovação.');
    }

    return lines;
}

function frontReinforcementLines(capacity, technical = false) {
    const flags = capacity?.reinforcement?.flags || {};
    const lines = [];

    if (!flags.base) return ['Ainda não possui Reforço comprado.'];

    lines.push('Consegue fortalecer o corpo com magia de forma básica.');
    if (flags.intensityLevel) lines.push(`Quando o reforço precisa de potência, usa Intensidade ${frontRoman(flags.intensityLevel)} (+${frontPercent(flags.intensityLevel)}%).`);
    else lines.push('Sem Intensidade comprada, o reforço fica em leitura inicial e pequena.');
    if (flags.stabilityLevel) lines.push(`Quando o reforço precisa durar melhor ou oscilar menos, usa Estabilidade ${frontRoman(flags.stabilityLevel)}.`);
    if (flags.focusCount) lines.push(`Pode manter ${flags.focusCount} atributo${flags.focusCount > 1 ? 's' : ''} como foco do mesmo reforço.`);
    if (flags.attributes?.length) lines.push(`Atributos liberados: ${flags.attributes.join(', ')}.`);
    if (flags.selfBuff) lines.push('Pode aplicar reforço em si pela rota Invencível.');
    if (flags.otherBuff) lines.push('Pode caminhar para reforçar outras pessoas pela rota Invicto.');
    if (flags.touchBuff) lines.push('Pode reforçar outro alvo por toque.');
    if (flags.distanceBuff) lines.push('Pode reforçar outro alvo à distância, respeitando Alcance, Emissão e Controle.');
    if (flags.collectiveBuff) lines.push('Pode reforçar mais de um alvo quando a cena e o custo sustentarem.');
    if (flags.advanced) lines.push('Possui Reforço Avançado para usos mais complexos.');
    if (flags.advancedWeapons) lines.push('Pode ligar reforço avançado a armas.');
    if (flags.advancedHumanoids) lines.push('Pode ligar reforço avançado a armadura, exoesqueleto, avatar ou corpo mágico.');
    if (flags.advancedEnvironment) lines.push('Pode aplicar reforço avançado em área ou campo.');

    if (technical && !flags.attributes?.length) lines.push('Ainda precisa comprar atributos reforçados para deixar o uso menos genérico.');

    return lines;
}

function frontManaLines(capacity, technical = false) {
    const flags = capacity?.mana?.flags || {};
    const lines = [];

    if (!flags.base && !flags.flow && !flags.bulletLevel && !flags.manaSkin) {
        return ['Ainda não possui avanço relevante em Mana registrado.'];
    }

    if (flags.base) lines.push('Possui base de Mana para leitura e manipulação inicial.');
    if (flags.perception || flags.sensing) lines.push(`Consegue perceber mana${flags.sensingLevel ? ` em nível ${frontRoman(flags.sensingLevel)}` : ''}.`);
    if (flags.signature) lines.push('Reconhece assinatura mágica quando houver pista real.');
    if (flags.flow) lines.push('Tem fluxo de mana para estabilizar técnicas, reforços e uso contínuo.');
    if (flags.circulation) lines.push('Circulação ajuda o corpo a lidar melhor com mana interna.');
    if (flags.stability) lines.push('Estabilidade reduz falha, oscilação e desperdício em usos compatíveis.');
    if (flags.channeling) lines.push('Canalização ajuda a direcionar mana para corpo, objeto, técnica ou ponto de uso.');
    if (flags.emission) lines.push('Emissão permite jogar mana para fora do corpo dentro dos limites do Hexágono.');
    if (flags.retention) lines.push('Retenção ajuda a segurar mana, manter efeitos e reduzir perda.');
    if (flags.bulletLevel) lines.push(`Bala de Mana ${frontRoman(flags.bulletLevel)}: mana pura ofensiva simples.`);
    if (flags.pulseLevel) lines.push(`Pulso de Mana ${frontRoman(flags.pulseLevel)}: pressão/onda curta de mana.`);
    if (flags.manaSkin) lines.push(`Pele de Mana ${frontRoman(flags.manaSkinLevel)}: revestimento corporal de mana.`);
    if (flags.manaMantle) lines.push('Manto de Mana: cobertura mais pesada e custosa.');
    if (flags.field) lines.push(`Campo de Mana ${frontRoman(flags.fieldLevel)}: presença de mana em área próxima.`);
    if (flags.economy) lines.push(`Economia de Mana ${frontRoman(flags.economyLevel)}: melhora gasto em uso compatível.`);
    if (flags.recoveryLevel) lines.push(`Recuperação ${frontRoman(flags.recoveryLevel)}: melhora retomada de mana conforme regra da cena.`);
    if (flags.environment) lines.push(`Ambiente de Mana ${frontRoman(flags.environmentLevel)}: usa a mana do entorno quando houver base narrativa.`);
    if (flags.zone) lines.push(`Mana Zone ${frontRoman(flags.zoneLevel)}: domínio de zona dentro dos limites do sistema.`);
    if (flags.fineControl) lines.push('Controle fino melhora curvas, ajustes e manipulação delicada.');

    if (technical) lines.push('Mana pura usa peso, custo, duração e alcance do guia de balanceamento.');

    return lines;
}

function frontPhysicalLines(capacity, technical = false) {
    const physical = capacity?.physical || {};
    const levels = physical.levels || {};
    const flags = physical.flags || {};
    const lines = [];
    const addLevel = (label, level, text) => {
        if (!level) return;
        lines.push(`${label} ${frontRoman(level)}: +${frontPercent(level)}% ${text}`);
    };

    if (!flags.base) return ['Ainda não possui Físico comprado.'];

    lines.push('Possui base física: postura, esforço, corpo e leitura corporal inicial.');
    if (flags.vigor) lines.push('Vigor abre força aplicada, resistência corporal e condicionamento.');
    if (flags.control) lines.push('Controle Corporal abre mobilidade, reflexos e precisão.');
    if (flags.perception) lines.push('Percepção Física abre sentidos e intuição sem bônus numérico.');
    addLevel('Força Aplicada', levels.strength, 'em golpe, pressão, puxar, empurrar, travar, quebrar e força útil.');
    addLevel('Resistência Corporal', levels.resistance, 'em dor, tranco, postura, durabilidade física e continuar sob pressão.');
    addLevel('Condicionamento Físico', levels.conditioning, 'em fôlego, ritmo, retomada e esforço prolongado.');
    addLevel('Mobilidade', levels.mobility, 'em avanço, recuo, perseguição, fuga e reposicionamento.');
    addLevel('Reflexos Corporais', levels.reflexes, 'em reação, esquiva, ajuste corporal e troca de direção.');
    addLevel('Precisão Técnica', levels.precision, 'em brecha real, ponto certo, desarme, entrada limpa e punição de abertura.');

    const senseLabels = {
        visao: 'Visão',
        audicao: 'Audição',
        olfato: 'Olfato',
        tato: 'Tato',
        paladar: 'Paladar',
        intuicao: 'Intuição Corporal',
    };
    const senseEntries = Object.entries(levels.senses || {})
        .filter(([, level]) => level > 0)
        .map(([key, level]) => `${senseLabels[key] || key} ${frontRoman(level)}`);
    if (senseEntries.length) lines.push(`Sentidos treinados: ${senseEntries.join(', ')}.`);

    const identityLabels = {
        barbarian: 'Bárbaro',
        tyrant: 'Tirano',
        benevolent: 'Benevolente',
        cult: 'Culto',
        just: 'Justo',
        unjust: 'Injusto',
        instinct: 'Instinto',
    };
    const identityEntries = Object.entries(levels.identities || {})
        .filter(([, level]) => level > 0)
        .map(([key, level]) => `${identityLabels[key] || key} ${frontRoman(level)}`);
    if (identityEntries.length) lines.push(`Identidades físicas: ${identityEntries.join(', ')}.`);
    if (flags.antiMage) lines.push('Contra Magos: lê e pune janela física de conjuração; não é antimagia.');
    if (flags.ki) lines.push('Ki registrado: usos complexos ainda dependem de aprovação narrativa.');
    if (flags.zetten) lines.push('Zetten registrado: uso decisivo e complexo ainda depende de aprovação narrativa.');
    if (flags.apex) lines.push('Ápice Físico registrado como topo da rota física.');

    if (technical) lines.push('Físico não aumenta magia criada, projétil mágico, mana pura, cura, antimagia ou Estilo de Luta separado.');

    return lines;
}

function frontSupportLines(capacity) {
    const count = frontTreeCount(capacity, 'suporte');
    const names = capacity?.support?.ownedNames || [];

    if (!count) {
        return [
            'Suporte está parcialmente liberado.',
            'Usos básicos podem entrar como capacidade comum.',
            'Magigramática, efeitos avançados e usos sensíveis ainda pedem aprovação narrativa.',
        ];
    }

    return [
        `${count} nó(s) de Suporte registrado(s): ${frontCompact(names)}.`,
        'Básicos contam como capacidade comum; avançados continuam dependendo de aprovação narrativa.',
    ];
}

function frontGeneralReading(capacity) {
    const creation = capacity?.creation?.flags || {};
    const reinforcement = capacity?.reinforcement?.flags || {};
    const mana = capacity?.mana?.flags || {};
    const physical = capacity?.physical?.flags || {};

    if (creation.environmentLevel || reinforcement.collectiveBuff || mana.zone || physical.apex) {
        return 'O personagem já tem ferramentas para cenas grandes, mas custo, alcance, duração e aprovação ainda mandam.';
    }
    if (creation.junction || reinforcement.advanced || mana.field || physical.ki || physical.zetten) {
        return 'O personagem já mistura funções mais fortes; o ADM deve olhar encaixe narrativo e teto da cena.';
    }
    if (creation.base || reinforcement.base || mana.base || physical.base) {
        return 'O personagem tem recursos básicos funcionais. O uso ainda deve escolher uma leitura principal por ação.';
    }
    return 'O personagem ainda depende quase totalmente de atributo, PB, Estágio e interpretação.';
}

function frontTreeOverview(capacity) {
    return [
        frontField('𝑴𝒂𝒏𝒂', `${frontTreeCount(capacity, 'mana')} nó(s)`),
        frontField('𝑪𝒓𝒊𝒂𝒄̧𝒂̃𝒐', `${frontTreeCount(capacity, 'criacao')} nó(s)`),
        frontField('𝑹𝒆𝒇𝒐𝒓𝒄̧𝒐', `${frontTreeCount(capacity, 'reforco')} nó(s)`),
        frontField('𝑭𝒊́𝒔𝒊𝒄𝒐', `${frontTreeCount(capacity, 'fisico')} nó(s)`),
        frontField('𝑺𝒖𝒑𝒐𝒓𝒕𝒆', frontTreeCount(capacity, 'suporte') ? `${frontTreeCount(capacity, 'suporte')} nó(s)` : 'parcialmente liberado'),
    ];
}

function frontOwnedTreeLine(capacity, treeId, label, fallback = 'nenhum nó comprado') {
    const summaries = capacity?.treeSummaries || {};
    const summary = summaries[treeId] || {};
    const names = treeId === 'suporte'
        ? (capacity?.support?.ownedNames || summary.names || [])
        : (summary.names || []);
    const count = treeId === 'suporte'
        ? Number(summary.count || capacity?.support?.ownedNames?.length || 0)
        : Number(summary.count || names.length || 0);

    if (!count || !names.length) return frontField(label, fallback);
    return frontField(label, `${count} nó(s): ${frontCompact(names, 'nenhum', 8)}`);
}

function frontOwnedNodesOverview(capacity) {
    return [
        frontOwnedTreeLine(capacity, 'mana', 'Mana'),
        frontOwnedTreeLine(capacity, 'criacao', 'Criação'),
        frontOwnedTreeLine(capacity, 'reforco', 'Reforço'),
        frontOwnedTreeLine(capacity, 'fisico', 'Físico'),
        frontOwnedTreeLine(capacity, 'suporte', 'Suporte', 'parcialmente liberado'),
    ];
}

function frontNextNodes(capacity) {
    const next = capacity?.nextNodes || {};
    return [
        '*𝑴𝒂𝒏𝒂:*',
        frontList(next.mana || [], 'nenhum próximo passo calculado agora'),
        '*𝑪𝒓𝒊𝒂𝒄̧𝒂̃𝒐:*',
        frontList(next.criacao || [], 'nenhum próximo passo calculado agora'),
        '*𝑹𝒆𝒇𝒐𝒓𝒄̧𝒐:*',
        frontList(next.reforco || [], 'nenhum próximo passo calculado agora'),
        '*𝑭𝒊́𝒔𝒊𝒄𝒐:*',
        frontList(next.fisico || [], 'nenhum próximo passo calculado agora'),
    ].join('\n');
}

function frontMaintenanceLines() {
    return MAINTENANCE_TIERS.map((tier) => (
        tier.percent
            ? `${frontCleanText(tier.label)} ${tier.percent}%: ${frontCleanText(tier.description)}`
            : `${frontCleanText(tier.label)}: ${frontCleanText(tier.description)}`
    ));
}

formatPlayerCapacity = function formatPlayerCapacityFront(capacity) {
    if (!capacity?.ok) return 'Não encontrei esse personagem no banco.';

    return [
        ...frontHeader('CAPACIDADE ATUAL', 'o que seu personagem consegue fazer agora'),
        '',
        frontSection('✓', '𝑹𝒆𝒔𝒖𝒎𝒐'),
        '',
        frontField('𝑷𝒆𝒓𝒔𝒐𝒏𝒂𝒈𝒆𝒎', capacity.displayName || 'Personagem'),
        frontField('𝑬𝒔𝒕𝒂́𝒈𝒊𝒐', capacity.stageName || '-'),
        frontField('𝑷𝑩', Number(capacity.stats?.pb_total || 0)),
        frontField('𝑷𝑯', `${Number(capacity.ph?.phAvailable || 0)} disponível / ${Number(capacity.ph?.phAccumulated || 0)} acumulado`),
        frontField('𝑯𝒆𝒙𝒂́𝒈𝒐𝒏𝒐', capacity.hexagonLine || '-'),
        '',
        frontSection('✦', '𝑳𝒆𝒊𝒕𝒖𝒓𝒂 𝑮𝒆𝒓𝒂𝒍'),
        '',
        `> ${frontGeneralReading(capacity)}`,
        '',
        frontSection('◆', '𝑴𝒂𝒏𝒂'),
        '',
        frontList(frontManaLines(capacity)),
        '',
        frontSection('◇', '𝑪𝒓𝒊𝒂𝒄̧𝒂̃𝒐'),
        '',
        frontList(frontCreationLines(capacity)),
        '',
        frontSection('⬡', '𝑹𝒆𝒇𝒐𝒓𝒄̧𝒐'),
        '',
        frontList(frontReinforcementLines(capacity)),
        '',
        frontSection('■', '𝑭𝒊́𝒔𝒊𝒄𝒐'),
        '',
        frontList(frontPhysicalLines(capacity)),
        '',
        frontSection('✧', '𝑺𝒖𝒑𝒐𝒓𝒕𝒆'),
        '',
        frontList(frontSupportLines(capacity)),
        '',
        frontSection('!', '𝑳𝒊𝒎𝒊𝒕𝒆𝒔 𝑹𝒂́𝒑𝒊𝒅𝒐𝒔'),
        '',
        `> Alcance comum: ${frontCleanText(capacity.limits?.alcanceLabel || '-')}.`,
        `> Área comum: ${frontCleanText(capacity.limits?.areaLabel || '-')}.`,
        `> Duração comum: ${frontCleanText(capacity.limits?.duracaoLabel || '-')}.`,
        `> Controle: ${frontCleanText(capacity.limits?.controleLabel || '-')}.`,
        '> Uma ação deve escolher uma leitura principal.',
        '> Feitiço aprovado não evolui sozinho; se o mago evoluir, precisa pedir atualização.',
    ].join('\n');
};

formatTechnicalCapacity = function formatTechnicalCapacityFront(capacity, options = {}) {
    if (!capacity?.ok) return 'Não encontrei esse personagem no banco.';

    const full = options.full === true || options.admin === true;
    const admin = options.admin === true;
    const costs = capacity.commonCosts || { mana: [], criacao: [], reforco: [], fisico: [] };
    const approvalLines = capacity.approvalNodes?.length
        ? capacity.approvalNodes
        : ['nenhum nó comprado com aprovação obrigatória'];
    const riskLines = capacity.highRiskNodes?.length
        ? capacity.highRiskNodes
        : ['nenhum nó alto/extremo comprado'];

    return [
        ...frontHeader(admin ? 'CAPACIDADE TÉCNICA · ADM' : 'CAPACIDADE TÉCNICA', admin ? 'leitura para aprovação manual' : 'limites, custos e árvores'),
        '',
        frontSection('✓', '𝑰𝒅𝒆𝒏𝒕𝒊𝒇𝒊𝒄𝒂𝒄̧𝒂̃𝒐'),
        '',
        frontField('𝑷𝒆𝒓𝒔𝒐𝒏𝒂𝒈𝒆𝒎', capacity.displayName || 'Personagem'),
        frontField('𝑬𝒔𝒕𝒂́𝒈𝒊𝒐', capacity.stageName || '-'),
        frontField('𝑷𝑩', Number(capacity.stats?.pb_total || 0)),
        frontField('𝑴𝒂𝒏𝒂', capacity.manaTotal === null ? '-' : capacity.manaTotal),
        frontField('𝑷𝒐𝒅𝒆𝒓 𝑴𝒂́𝒈𝒊𝒄𝒐', capacity.poderMagico),
        frontField('𝑷𝑯', `${Number(capacity.ph?.phAvailable || 0)} disponível / ${Number(capacity.ph?.phAccumulated || 0)} acumulado`),
        admin ? frontField('𝑹𝒆𝒈𝒊𝒔𝒕𝒓𝒐', capacity.playerId) : null,
        '',
        frontSection('✦', '𝑯𝒆𝒙𝒂́𝒈𝒐𝒏𝒐'),
        '',
        `> ${frontCleanText(capacity.hexagonLine || '-')}`,
        `> PER ${Number(capacity.hexagon?.percepcao || 1)}: ${frontCleanText(capacity.limits?.percepcaoLabel || '-')}`,
        `> RET ${Number(capacity.hexagon?.retencao || 1)}: ${frontCleanText(capacity.limits?.duracaoLabel || '-')}`,
        `> EMI ${Number(capacity.hexagon?.emissao || 1)}: ${frontCleanText(capacity.limits?.emissaoLabel || '-')}`,
        `> CON ${Number(capacity.hexagon?.controle || 1)}: ${frontCleanText(capacity.limits?.controleLabel || '-')}`,
        `> PRE ${Number(capacity.hexagon?.pressao || 1)}: PM ${frontCleanText(capacity.limits?.pressaoBonus || '-')}`,
        `> ALC ${Number(capacity.hexagon?.alcance || 1)}: ${frontCleanText(capacity.limits?.alcanceLabel || '-')}`,
        `> Área comum: ${frontCleanText(capacity.limits?.areaLabel || '-')}`,
        '',
        frontSection('◆', '𝑨́𝒓𝒗𝒐𝒓𝒆𝒔'),
        '',
        ...frontTreeOverview(capacity),
        '',
        frontSection('✓', 'Nós Comprados'),
        '',
        ...frontOwnedNodesOverview(capacity),
        '',
        frontSection('◇', '𝑪𝒓𝒊𝒂𝒄̧𝒂̃𝒐'),
        '',
        frontList(frontCreationLines(capacity, true)),
        '',
        frontSection('⬡', '𝑹𝒆𝒇𝒐𝒓𝒄̧𝒐'),
        '',
        frontList(frontReinforcementLines(capacity, true)),
        '',
        frontSection('✧', '𝑴𝒂𝒏𝒂'),
        '',
        frontList(frontManaLines(capacity, true)),
        '',
        frontSection('■', '𝑭𝒊́𝒔𝒊𝒄𝒐'),
        '',
        frontList(frontPhysicalLines(capacity, true)),
        '',
        frontSection('✩', '𝑺𝒖𝒑𝒐𝒓𝒕𝒆'),
        '',
        frontList(frontSupportLines(capacity)),
        '',
        frontSection('!', '𝑨𝒕𝒆𝒏𝒄̧𝒐̃𝒆𝒔'),
        '',
        '*𝑨𝒑𝒓𝒐𝒗𝒂𝒄̧𝒂̃𝒐 𝒏𝒂𝒓𝒓𝒂𝒕𝒊𝒗𝒂:*',
        frontList(approvalLines),
        '*𝑹𝒊𝒔𝒄𝒐 𝒂𝒍𝒕𝒐/𝒆𝒙𝒕𝒓𝒆𝒎𝒐:*',
        frontList(riskLines),
        '',
        full ? frontSection('⌁', '𝑷𝒓𝒐́𝒙𝒊𝒎𝒐𝒔 𝑵𝒐́𝒔') : null,
        full ? '' : null,
        full ? frontNextNodes(capacity) : null,
        full ? '' : null,
        frontSection('⬢', '𝑪𝒖𝒔𝒕𝒐𝒔 𝑪𝒐𝒎𝒖𝒏𝒔'),
        '',
        '*𝑴𝒂𝒏𝒂:*',
        frontCosts(costs.mana),
        '*𝑪𝒓𝒊𝒂𝒄̧𝒂̃𝒐:*',
        frontCosts(costs.criacao),
        '*𝑹𝒆𝒇𝒐𝒓𝒄̧𝒐:*',
        frontCosts(costs.reforco),
        '*𝑭𝒊́𝒔𝒊𝒄𝒐:*',
        '> Físico não usa custo comum de Mana.',
        '> A progressão física é comprada com PH nos nós da árvore.',
        '',
        frontSection('▣', '𝑴𝒂𝒏𝒖𝒕𝒆𝒏𝒄̧𝒂̃𝒐'),
        '',
        frontList(frontMaintenanceLines()),
        '',
        frontSection(admin ? '✦' : '✓', admin ? '𝑳𝒆𝒊𝒕𝒖𝒓𝒂 𝒅𝒐 𝑨𝑫𝑴' : '𝑨𝒗𝒊𝒔𝒐'),
        '',
        admin
            ? '> Esta leitura organiza ficha, árvores, riscos e limites para decisão manual da ADM.'
            : '> Nós com aprovação narrativa não significam uso livre automático.',
        '> O bot não aprova técnica automaticamente.',
        '> O bot não avalia técnica automaticamente.',
        '> O ADM ainda decide com ficha, Hexágono, cena e contexto.',
    ].filter((line) => line !== null).join('\n');
};

module.exports = {
    buildCommonCosts,
    buildProfileCapacitySummary,
    formatPlayerCapacity,
    formatTechnicalCapacity,
    getHighestOwnedLevel,
    getOwnedNodeIds,
    getPlayerTechnicalCapacity,
    hasNode,
};
