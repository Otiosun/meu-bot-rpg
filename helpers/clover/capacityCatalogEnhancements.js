'use strict';

const { calculateRankCost } = require('./balanceGuide');

const EXTRA_NODE_TEXTS = {
    mana: {
        leitura_de_flutuacao: {
            player: 'percebe oscilações, variações e instabilidade no fluxo de mana.',
            limit: 'Não identifica sozinho a causa da alteração nem revela técnica escondida sem pista.',
        },
        ritmo_de_mana: {
            player: 'mantém a circulação mais regular durante combate ou uso prolongado.',
            limit: 'Ajuda na continuidade, mas não remove gasto, cansaço ou manutenção.',
        },
        voo_de_vassoura: {
            player: 'aplica mana a um objeto de locomoção para sustentar voo controlado.',
            limit: 'Velocidade, altura, manobra e duração continuam dependendo da técnica e do Hexágono.',
        },
        ocultacao_de_mana: {
            player: 'suaviza, esconde ou disfarça a própria presença mágica.',
            limit: 'Não torna o usuário indetectável contra toda percepção.',
        },
        nucleo_de_mana: {
            player: 'consolida a estabilidade e a reserva funcional de mana dentro do corpo.',
            limit: 'Não cria mana infinita nem concede aumento numérico fora do que estiver registrado na ficha.',
        },
        condutor: {
            player: 'refina a condução do fluxo e a passagem de mana entre usos mantidos.',
            limit: 'Não reduz custo automaticamente e não substitui Controle Fino ou Manutenção Simultânea.',
        },
        reservatorio: {
            player: 'melhora a reserva funcional e a sustentação de mana em usos prolongados.',
            limit: 'Não altera a Mana total sem bônus numérico registrado em outro sistema.',
        },
        dominador: {
            player: 'marca domínio elevado da manipulação de mana em escala maior.',
            limit: 'É base de maestria; campo, Zona de Mana e efeitos decisivos ainda exigem seus próprios nós e aprovação.',
        },
    },
    reforco: {
        foco_de_atributo: {
            player: 'organiza o reforço em torno de um atributo por vez.',
            limit: 'Dois ou três atributos no mesmo feitiço exigem Duplo Foco ou Múltiplo Foco.',
        },
    },
};

const KNOWN_PATTERNS = {
    mana: [
        /^mana$/, /^percepcao_de_mana$/, /^sentir_mana_(i|ii|iii)$/,
        /^leitura_de_flutuacao$/, /^assinatura_magica$/, /^fluxo_de_mana(_i)?$/,
        /^circulacao$/, /^estabilidade$/, /^canalizacao$/, /^ritmo_de_mana$/,
        /^emissao_de_mana_i$/, /^retencao_de_mana_i$/, /^mana_bullet_(i|ii|iii)$/,
        /^pulso_de_mana_(i|ii|iii)$/, /^mana_skin_(i|ii|iii)$/, /^manto_de_mana_i$/,
        /^campo_de_mana_(i|ii|iii)$/, /^economia_de_mana_(i|ii|iii)$/,
        /^recuperacao_(i|ii|iii)$/, /^ocultacao_de_mana$/, /^nucleo_de_mana$/,
        /^leitura_ambiental$/, /^adaptacao_ambiental$/, /^ambiente_de_mana_(i|ii|iii)$/,
        /^ressonancia$/, /^metodo_de_mana$/, /^mana_zone_(i|ii|iii)$/,
        /^dominio_de_mana$/, /^controle_fino_(i|ii|iii)$/, /^compressao_de_mana$/,
        /^voo_de_vassoura$/, /^revestimento_de_objeto$/, /^manutencao_simultanea$/,
        /^pressao_de_mana$/, /^condutor$/, /^reservatorio$/, /^dominador$/,
    ],
    criacao: [/.*/],
    reforco: [
        /^reforco$/, /^intensidade_(i|ii|iii)$/, /^estabilidade_(i|ii|iii)$/,
        /^foco_de_atributo$/, /^duplo_foco$/, /^multiplo_foco$/,
        /^forca_reforcada$/, /^velocidade_reforcada$/, /^agilidade_reforcada$/,
        /^resistencia_reforcada$/, /^defesa_reforcada$/, /^invencivel$/, /^invicto$/,
        /^reforco_por_toque$/, /^reforco_a_distancia$/, /^reforco_coletivo$/,
        /^juncao_de_forma$/, /^reforco_avancado$/, /^reforco_avancado_armas$/,
        /^reforco_avancado_formas_humanoides$/, /^reforco_avancado_ambiente$/,
    ],
    fisico: [/.*/],
    suporte: [/.*/],
};

function clean(value) {
    return String(value ?? '').trim();
}

function n(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function sentence(value) {
    const text = clean(value);
    if (!text) return '';
    return /[.!?]$/.test(text) ? text : `${text}.`;
}

function roman(level) {
    return ['', 'I', 'II', 'III', 'IV', 'V'][n(level)] || String(level || '');
}

function section(symbol, title) {
    return `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;
}

function list(lines, fallback = 'nada registrado') {
    const values = (lines || []).map(clean).filter(Boolean);
    if (!values.length) return `> ${fallback}`;
    return values.map((line) => `> ${line}`).join('\n');
}

function basicPb(capacity) {
    const total = n(capacity?.stats?.pb_total, 10);
    return Math.max(10, Math.floor(total * 0.25));
}

function stageWeightHint(capacity) {
    const pb = n(capacity?.stats?.pb_total, 10);
    if (pb >= 2560) return 'Peso 13+ (especial)';
    if (pb >= 1280) return 'Peso 11–12';
    if (pb >= 640) return 'Peso 10';
    if (pb >= 320) return 'Peso 8–9';
    if (pb >= 160) return 'Peso 7';
    if (pb >= 80) return 'Peso 6';
    if (pb >= 40) return 'Peso 5';
    if (pb >= 20) return 'Peso 4';
    return 'Peso 1–3';
}

function treeState(capacity, treeId) {
    if (treeId === 'suporte') return capacity?.supportTree || null;
    return capacity?.trees?.[treeId] || null;
}

function ownedNodes(capacity, treeId) {
    if (treeId === 'suporte' && Array.isArray(capacity?.support?.owned) && capacity.support.owned.length) {
        return capacity.support.owned.filter(Boolean);
    }

    const state = treeState(capacity, treeId);
    const ids = [...(state?.ownedIds || [])];
    const byId = state?.tree?.nodesById || {};
    const nodes = ids.map((id) => byId[id]).filter(Boolean);
    if (nodes.length) return nodes;

    const names = treeId === 'suporte'
        ? capacity?.support?.ownedNames
        : capacity?.treeSummaries?.[treeId]?.names;
    return (names || []).map((name) => ({ id: null, name, shortEffect: '' }));
}

function isKnownNode(treeId, nodeId) {
    if (!nodeId) return false;
    return (KNOWN_PATTERNS[treeId] || []).some((pattern) => pattern.test(nodeId));
}

function nodeConfig(treeId, nodeId) {
    return EXTRA_NODE_TEXTS[treeId]?.[nodeId] || null;
}

function nodePlayerLine(treeId, node) {
    const config = nodeConfig(treeId, node?.id);
    const description = config?.player
        || node?.metadata?.playerSummary
        || node?.shortEffect
        || node?.effect
        || 'avanço registrado na árvore';
    return `${clean(node?.name || node?.id || 'Nó')}: ${sentence(description)}`;
}

function nodeTechnicalLines(treeId, node) {
    const config = nodeConfig(treeId, node?.id);
    const name = clean(node?.name || node?.id || 'Nó');
    const effect = config?.player || node?.effect || node?.shortEffect || 'efeito registrado na árvore';
    const lines = [`${name}: ${sentence(effect)}`];
    if (config?.limit) lines.push(`Limite de ${name}: ${sentence(config.limit)}`);
    if (node?.metadata?.technicalWeight !== undefined) {
        lines.push(`Peso técnico de ${name}: +${n(node.metadata.technicalWeight)} quando entrar na técnica.`);
    }
    if (node?.requiresApproval) lines.push(`${name} exige aprovação antes do uso livre.`);
    if (node?.metadata?.risk) lines.push(`${name} tem risco ${node.metadata.risk}.`);
    if (node?.metadata?.notDoes) lines.push(`${name} não faz: ${sentence(node.metadata.notDoes)}`);
    return lines;
}

function supplementalNodes(capacity, treeId) {
    const nodes = ownedNodes(capacity, treeId);
    if (treeId === 'suporte') return nodes;
    return nodes.filter((node) => nodeConfig(treeId, node.id) || !isKnownNode(treeId, node.id));
}

function supplementalPlayerSections(capacity) {
    return ['mana', 'criacao', 'reforco', 'fisico']
        .map((treeId) => ({
            treeId,
            lines: supplementalNodes(capacity, treeId).map((node) => nodePlayerLine(treeId, node)),
        }))
        .filter((entry) => entry.lines.length);
}

function supplementalTechnicalSections(capacity) {
    return ['mana', 'criacao', 'reforco', 'fisico']
        .map((treeId) => ({
            treeId,
            lines: supplementalNodes(capacity, treeId).flatMap((node) => nodeTechnicalLines(treeId, node)),
        }))
        .filter((entry) => entry.lines.length);
}

function supportPlayerLines(capacity) {
    const nodes = ownedNodes(capacity, 'suporte');
    if (!nodes.length) {
        return [
            'Suporte está parcialmente liberado.',
            'Usos básicos podem entrar como capacidade comum.',
            'Magigramática, debuff forte, selo, cura alta e efeito sensível ainda pedem aprovação.',
        ];
    }
    return [
        ...nodes.map((node) => nodePlayerLine('suporte', node)),
        'Efeitos sensíveis continuam dependendo de alvo, condição, duração, alcance, falha possível e limite claro.',
    ];
}

function supportTechnicalLines(capacity) {
    const nodes = ownedNodes(capacity, 'suporte');
    return [
        '*Capacidade atual:*',
        list(supportPlayerLines(capacity)),
        ...(nodes.length ? [
            '*Leitura dos nós comprados:*',
            list(nodes.flatMap((node) => nodeTechnicalLines('suporte', node))),
        ] : []),
        '*Onde entra:*',
        list([
            'Bênção simples, cura pequena, condição leve, auxílio narrativo e suporte básico entram quando a árvore liberar.',
            'Debuff, maldição, selo, restrição, armadilha, cura alta ou efeito mental precisam de aprovação e falha possível.',
            'Quanto mais o efeito tira resposta do alvo, maior deve ser o custo e a restrição.',
        ]),
        '*Onde não entra:*',
        list([
            'Não concede prisão perfeita.',
            'Não concede cura total fácil.',
            'Não remove turno sem regra explícita.',
            'Não aplica debuff real sem nó, condição, duração e possibilidade de resposta.',
        ]),
    ];
}

function hasManaProgress(capacity) {
    const flags = capacity?.mana?.flags || {};
    return Boolean(
        flags.base || flags.perception || flags.sensing || flags.signature || flags.flow
        || flags.circulation || flags.stability || flags.channeling || flags.emission
        || flags.retention || flags.bulletLevel || flags.pulseLevel || flags.manaSkin
        || flags.manaMantle || flags.field || flags.economy || flags.recoveryLevel
        || flags.environmentalReading || flags.environmentalAdaptation || flags.environment
        || flags.resonance || flags.method || flags.zone || flags.fineControl
        || flags.compression || flags.objectCoating || flags.simultaneousMaintenance
        || flags.pressure || flags.domain || supplementalNodes(capacity, 'mana').length
    );
}

function finalPlayerSummary(capacity) {
    const active = [];
    if (hasManaProgress(capacity)) active.push('Mana');
    if (capacity?.creation?.flags?.base) active.push('Criação');
    if (capacity?.reinforcement?.flags?.base) active.push('Reforço');
    if (capacity?.physical?.flags?.base) active.push('Físico');
    if (ownedNodes(capacity, 'suporte').length) active.push('Suporte');
    const base = active.length
        ? `A capacidade atual se apoia em ${active.join(', ')}.`
        : 'A capacidade atual ainda está concentrada no uso mágico inicial.';
    return `${base} O uso básico fica em PB ${basicPb(capacity)}, enquanto técnicas marcantes, compostas ou persistentes continuam dependendo de feitiço aprovado.`;
}

function finalTechnicalSummary(capacity) {
    const blockers = [];
    const creation = capacity?.creation?.flags || {};
    const reinforcement = capacity?.reinforcement?.flags || {};
    const mana = capacity?.mana?.flags || {};
    if (creation.base && !creation.junction) blockers.push('Criação sem Junção');
    if (reinforcement.base && !reinforcement.advanced) blockers.push('Reforço sem aplicação avançada');
    if (hasManaProgress(capacity) && !mana.zone) blockers.push('Mana sem Zona');
    const approvalCount = capacity?.approvalNodes?.length || 0;
    const blockerText = blockers.length ? ` Principais travas: ${blockers.join('; ')}.` : '';
    const approvalText = approvalCount ? ` Há ${approvalCount} nó(s) comprado(s) com aprovação obrigatória.` : '';
    return `Teto comum sugerido para o estágio: ${stageWeightHint(capacity)}. Some apenas as partes usadas na técnica; níveis antigos e nós inativos não entram no Peso.${blockerText}${approvalText}`;
}

function costLine(label, weight, note = '') {
    const cost = calculateRankCost(weight);
    const mana = cost.special ? 'especial' : `${cost.totalMana} mana`;
    return `> ${label}: Peso ${weight} → Rank ${cost.rank} → ${mana}${note ? ` | ${note}` : ''}`;
}

function correctKnownCostLines(text, capacity) {
    let output = String(text || '');
    const mana = capacity?.mana?.flags || {};
    const creation = capacity?.creation?.flags || {};

    if (mana.manaSkin) {
        const label = `Pele de Mana ${roman(mana.manaSkinLevel || 1)}`;
        output = output.replace(
            new RegExp(`> ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: Peso \\d+ → Rank [A-Z] → [^\\n]+`),
            costLine(label, 2, 'manutenção leve; níveis maiores refinam o uso, não aumentam o peso-base sozinhos')
        );
    }

    if (creation.humanoidsLevel) {
        const label = `Construto/Forma humanoide ${roman(creation.humanoidsLevel)}`;
        output = output.replace(
            new RegExp(`> ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: Peso \\d+ → Rank [A-Z] → [^\\n]+`),
            costLine(label, 3 + creation.humanoidsLevel, 'normalmente exige manutenção')
        );
    }

    return output;
}

module.exports = {
    correctKnownCostLines,
    finalPlayerSummary,
    finalTechnicalSummary,
    hasManaProgress,
    list,
    section,
    supplementalPlayerSections,
    supplementalTechnicalSections,
    supportPlayerLines,
    supportTechnicalLines,
};
