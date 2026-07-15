'use strict';

const SUPPORT_TEXTS = {
    suporte: {
        label: 'Suporte',
        player: 'abre a base para proteger, curar, fortalecer, enfraquecer, vincular ou interferir por meio de efeitos aplicados.',
        limit: 'Não causa dano bruto nem cria manifestação direta sozinho.',
    },
    magigramatica: {
        label: 'Magigramática',
        player: 'organiza magia como fórmula, símbolo, regra e condição, abrindo caminho para selos, comunicação e efeitos estruturados.',
        limit: 'Não permite reescrever qualquer magia livremente; cada aplicação precisa de regra, alvo e condição claros.',
    },
    praga: {
        label: 'Praga',
        player: 'abre interferências negativas persistentes, progressivas ou contaminantes.',
        limit: 'Não funciona como maldição livre nem aplica consequência inevitável; exige aprovação e resposta possível.',
    },
    bencao: {
        label: 'Bênção',
        player: 'abre efeitos positivos aplicados em si, aliados, objetos ou condições.',
        limit: 'Não apaga custo, ferimento ou consequência sozinho.',
    },
    selo: {
        label: 'Selo',
        player: 'permite guardar, organizar, travar ou ativar um efeito por meio de uma marca ou estrutura fixa.',
        limit: 'Precisa definir carga, duração, alvo, alcance e condição de ativação.',
    },
    comunicacao: {
        label: 'Comunicação',
        player: 'transmite mensagem, voz, sinal, marca ou informação por um vínculo mágico.',
        limit: 'Não cria telepatia absoluta, rede ilimitada ou rastreamento perfeito.',
    },
    juncao_de_forma: {
        label: 'Junção de Forma',
        player: 'liga um efeito de Suporte a forma, objeto, área, selo ou manifestação.',
        limit: 'Não transforma qualquer suporte em técnica automática; a combinação precisa de custo e função definidos.',
    },
    transformacao: {
        label: 'Transformação',
        player: 'altera estado, aparência, forma ou propriedade dentro do atributo mágico do usuário.',
        limit: 'Não transmuta qualquer coisa sem base no atributo, alcance e limite narrativo.',
    },
    armadilha: {
        label: 'Armadilha',
        player: 'prepara um efeito para ativar quando uma condição definida acontecer.',
        limit: 'O gatilho não é perfeito: precisa de alcance, leitura, duração e possibilidade de falha.',
    },
    condicao: {
        label: 'Condição',
        player: 'define quando, como, contra quem ou em qual situação um efeito funciona.',
        limit: 'Não vira contrato absoluto nem regra sem saída por conta própria.',
    },
    magia_proibida: {
        label: 'Magia Proibida',
        player: 'abre práticas perigosas, impuras ou restritas ligadas a um arco, pacto, anomalia ou pesquisa específica.',
        limit: 'Nunca é uso comum; exige autorização direta e consequência narrativa.',
    },
    maldicao: {
        label: 'Maldição',
        player: 'aplica efeito nocivo persistente de natureza corporal, espiritual ou mágica.',
        limit: 'Não é inevitável, permanente ou livre de condição; exige controle humano e resposta possível.',
    },
    ilusao: {
        label: 'Ilusão',
        player: 'interfere em percepção, aparência ou sensação.',
        limit: 'Não controla a mente por completo nem obriga o alvo a aceitar uma realidade sem resistência.',
    },
    absorcao: {
        label: 'Absorção',
        player: 'puxa, drena, redireciona ou consome energia e efeitos dentro de um limite definido.',
        limit: 'Não rouba mana sem teto nem absorve qualquer técnica automaticamente.',
    },
    enfraquecimento: {
        label: 'Enfraquecimento',
        player: 'reduz força, eficiência, estabilidade ou potência de um alvo afetado.',
        limit: 'Não anula o personagem inteiro e precisa indicar valor, duração e falha possível.',
    },
    restricao: {
        label: 'Restrição',
        player: 'limita movimento, ação, alcance, magia ou ativação dentro de uma condição definida.',
        limit: 'Não paralisa totalmente nem bloqueia toda magia sem aprovação especial.',
    },
    debuff: {
        label: 'Debuff',
        player: 'consolida uma redução mecânica ou situacional aplicada a alvo, técnica ou condição.',
        limit: 'Precisa de regra antiacúmulo e não substitui Praga ou Maldição.',
    },
    efeito: {
        label: 'Efeito',
        player: 'estrutura um benefício que não cabe apenas em cura ou buff.',
        limit: 'A função precisa ser descrita; efeitos amplos ou genéricos exigem aprovação.',
    },
    cura: {
        label: 'Cura',
        player: 'recupera dano, desgaste, condição ou ferimento dentro do alcance do atributo mágico.',
        limit: 'Não nega morte, trauma grave ou consequência importante sem aprovação direta.',
    },
    transmissao: {
        label: 'Transmissão',
        player: 'envia efeito, energia, sinal ou função por vínculo, marca, selo ou distância.',
        limit: 'Precisa limitar alvo, distância, vínculo e duração; não cria rede ilimitada.',
    },
    buff: {
        label: 'Buff',
        player: 'concede melhoria temporária de atributo, proteção, eficiência ou técnica.',
        limit: 'Precisa de limite por cena e regra antiacúmulo.',
    },
};

function clean(value) {
    return String(value ?? '').trim();
}

function sentence(value) {
    const text = clean(value);
    return /[.!?]$/.test(text) ? text : `${text}.`;
}

function list(lines, fallback = 'nada registrado') {
    const values = (lines || []).map(clean).filter(Boolean);
    if (!values.length) return `> ${fallback}`;
    return values.map((line) => `> ${line}`).join('\n');
}

function ownedSupportNodes(capacity) {
    if (Array.isArray(capacity?.support?.owned) && capacity.support.owned.length) {
        return capacity.support.owned.filter(Boolean);
    }
    const state = capacity?.supportTree;
    const ids = [...(state?.ownedIds || [])];
    const byId = state?.tree?.nodesById || {};
    const nodes = ids.map((id) => byId[id]).filter(Boolean);
    if (nodes.length) return nodes;
    return (capacity?.support?.ownedNames || []).map((name) => ({ id: null, name }));
}

function catalogEntry(node) {
    return SUPPORT_TEXTS[node?.id] || {
        label: clean(node?.name || node?.id || 'Nó de Suporte'),
        player: clean(node?.metadata?.playerSummary || node?.shortEffect || node?.effect || 'efeito de Suporte registrado'),
        limit: 'Exige leitura manual até receber texto específico no catálogo.',
    };
}

function playerLine(node) {
    const entry = catalogEntry(node);
    return `${entry.label}: ${sentence(entry.player)}`;
}

function technicalNodeLines(node) {
    const entry = catalogEntry(node);
    const lines = [
        `${entry.label}: ${sentence(entry.player)}`,
        `Limite de ${entry.label}: ${sentence(entry.limit)}`,
    ];
    if (node?.metadata?.technicalWeight !== undefined) {
        lines.push(`Peso técnico de ${entry.label}: +${Number(node.metadata.technicalWeight || 0)} quando entrar na técnica.`);
    }
    if (node?.requiresApproval) lines.push(`${entry.label} exige aprovação antes do uso livre.`);
    if (node?.metadata?.risk) lines.push(`${entry.label} tem risco ${node.metadata.risk}.`);
    return lines;
}

function supportPlayerLines(capacity) {
    const nodes = ownedSupportNodes(capacity);
    if (!nodes.length) {
        return [
            'Suporte está parcialmente liberado.',
            'Usos básicos podem entrar como capacidade comum.',
            'Magigramática, debuff forte, selo, cura alta e efeitos sensíveis ainda pedem aprovação.',
        ];
    }
    return [
        ...nodes.map(playerLine),
        'Efeitos sensíveis continuam dependendo de alvo, condição, duração, alcance, falha possível e limite claro.',
    ];
}

function supportTechnicalLines(capacity) {
    const nodes = ownedSupportNodes(capacity);
    return [
        '*Capacidade atual:*',
        list(supportPlayerLines(capacity)),
        ...(nodes.length ? [
            '*Leitura dos nós comprados:*',
            list(nodes.flatMap(technicalNodeLines)),
        ] : []),
        '*Onde entra:*',
        list([
            'Bênção, cura, buff, comunicação, transmissão, selo, condição e outros efeitos entram apenas quando o caminho comprado liberar.',
            'Praga, debuff, maldição, absorção, restrição, ilusão e magia proibida exigem condição, duração e possibilidade real de resposta.',
            'Quanto mais o efeito retira escolha do alvo, maior deve ser o custo, o risco e a aprovação.',
        ]),
        '*Onde não entra:*',
        list([
            'Não concede prisão perfeita.',
            'Não concede cura total fácil.',
            'Não remove turno sem regra explícita.',
            'Não cria efeito ilimitado, permanente ou inevitável sem aprovação especial.',
        ]),
    ];
}

module.exports = {
    SUPPORT_TEXTS,
    ownedSupportNodes,
    supportPlayerLines,
    supportTechnicalLines,
};
