const { getMaintenanceRate, getManaActivationCost } = require('./spellRuntimeRules');

const RANK_BY_WEIGHT = [
    { min: 1, max: 3, rank: 'E' },
    { min: 4, max: 5, rank: 'D' },
    { min: 6, max: 7, rank: 'C' },
    { min: 8, max: 9, rank: 'B' },
    { min: 10, max: 12, rank: 'A' },
    { min: 13, max: 13, rank: 'S' },
    { min: 14, max: null, rank: 'Especial', special: true },
];

const MAINTENANCE_TIERS = [
    { key: 'nenhuma', label: 'nenhuma', percent: getMaintenanceRate('instant') * 100, description: 'instantâneo' },
    { key: 'sustentado_usuario', label: 'sustentado no usuário', percent: getMaintenanceRate('sustained_user') * 100, description: 'por ciclo adicional' },
    { key: 'campo_estrutura', label: 'campo, estrutura ou múltiplas operações', percent: getMaintenanceRate('field_structure') * 100, description: 'por ciclo adicional' },
    { key: 'autonomo_alimentado', label: 'autônomo alimentado pelo caster', percent: getMaintenanceRate('caster_fed_autonomous') * 100, description: 'por ciclo adicional' },
    { key: 'destacado', label: 'destacado', percent: null, description: 'exige fonte, duração e regra próprias' },
];

const STAGE_WEIGHT_LIMITS = [
    { stage: '9º', pb: 10, weight: '1-3', note: 'efeito simples, curto e direto' },
    { stage: '8º', pb: 20, weight: '4', note: 'primeiro feitiço composto simples' },
    { stage: '7º', pb: 40, weight: '5', note: 'técnica funcional com limite claro' },
    { stage: '6º', pb: 80, weight: '6', note: 'uso avançado inicial' },
    { stage: '5º', pb: 160, weight: '7', note: 'efeito forte, mas ainda controlado' },
    { stage: '4º', pb: 320, weight: '8-9', note: 'técnica grande ou perigosa' },
    { stage: '3º', pb: 640, weight: '10', note: 'alta complexidade' },
    { stage: '2º', pb: 1280, weight: '11-12', note: 'elite, caro e raro' },
    { stage: '1º', pb: 2560, weight: '13+', note: 'especial; exige aprovação pesada' },
    { stage: '0º/Arcano', pb: '5120+', weight: 'especial', note: 'evento, marco narrativo ou regra própria' },
];

const HEXAGON_LIMITS = [
    { value: 1, alcance: '3 m', duracao: '1 ciclo' },
    { value: 2, alcance: '8 m', duracao: '2 ciclos' },
    { value: 3, alcance: '15 m', duracao: '3 ciclos' },
    { value: 4, alcance: '30 m', duracao: '5 ciclos' },
    { value: 5, alcance: '60 m', duracao: '8 ciclos' },
    { value: 6, alcance: '120 m', duracao: '12 ciclos ou cena curta' },
    { value: 7, alcance: '250 m+', duracao: 'cena prolongada com Mana/fonte/coerência' },
];

function calculateRankCost(weight) {
    const parsedWeight = Number(weight);
    if (!Number.isInteger(parsedWeight) || parsedWeight <= 0) {
        throw new Error('Peso precisa ser um inteiro positivo.');
    }

    const tier = RANK_BY_WEIGHT.find((item) => (
        parsedWeight >= item.min && (item.max === null || parsedWeight <= item.max)
    ));

    if (!tier) {
        throw new Error('Faixa de peso nao encontrada.');
    }

    return {
        weight: parsedWeight,
        rank: tier.rank,
        manaPerWeight: null,
        totalMana: getManaActivationCost(parsedWeight),
        special: tier.special === true,
        label: tier.special
            ? `Rank ${tier.rank} especial`
            : `Rank ${tier.rank} - ${getManaActivationCost(parsedWeight)} mana para ativar`,
    };
}

function formatQuickGuide() {
    return [
        '♧┃*GUIA RÁPIDO DE BALANCEAMENTO*',
        '── ADM, player e feitiços aprovados ──',
        '',
        '*Ideia central*',
        '> Feitiço aprovado é uma foto do personagem agora.',
        '> Se o mago evoluir, o feitiço não evolui junto.',
        '> Para melhorar alcance, dano, duração, área ou efeito, precisa nova avaliação.',
        '',
        '*Regra de ouro*',
        '> A árvore diz o que o personagem sabe fazer.',
        '> O Hexágono diz até onde ele faz.',
        '> O Peso diz quanto custa.',
        '> O ADM corta exagero e escreve os limites.',
        '',
        '*Fluxo do ADM em 5 passos*',
        '1. Resuma o feitiço em uma frase.',
        '2. Escolha o tipo: Criação, Reforço, Suporte ou Mana pura.',
        '3. Veja se a árvore libera o efeito.',
        '4. Use o Hexágono para alcance, duração, impacto, mira e área.',
        '5. Some só as partes ativas, defina Peso, custo e limites.',
        '',
        '*Peso comum por Estágio*',
        '> Teto sugerido para feitiço novo comum. Não é trava automática do bot.',
        ...STAGE_WEIGHT_LIMITS.map((item) => (
            `> ${item.stage.includes('/') ? item.stage : `${item.stage} Estágio`} · PB ${item.pb}: Peso ${item.weight} — ${item.note}.`
        )),
        '',
        '*Peso / Rank / Mana*',
        '> Rank aqui é só faixa de custo, não título do feitiço.',
        ...Array.from({ length: 13 }, (_, index) => {
            const weight = index + 1;
            const cost = calculateRankCost(weight);
            return `> W${weight}: Rank ${cost.rank} — ${cost.totalMana} mana.`;
        }),
        '> W14+: especial, sem custo automático comum.',
        '',
        '*Como calcular*',
        '> Ativação usa a tabela central de custo por Peso.',
        '> Exemplo: Peso 4 = Rank D = 320 mana.',
        '> Conte só o que o feitiço usa nessa versão.',
        '> Não some pré-requisitos, níveis antigos ou tudo que o player comprou.',
        '',
        '*Hexágono de Mana*',
        '> Controle: moldar, curvar, dividir, estabilizar e selecionar alvo.',
        '> Precisão: finesse e seleção; nunca vira acerto automático.',
        '> Estabilidade: integridade sob movimento, choque e interferência.',
        '> Retenção: duração; não cria persistência independente.',
        '> Alcance: distância da técnica.',
        '> Escala: tamanho, área e quantidade de alvos.',
        '',
        '*Limites rápidos do Hexágono*',
        ...HEXAGON_LIMITS.map((item) => (
            `> ${item.value}/7: Alcance ${item.alcance} · Retenção ${item.duracao}.`
        )),
        '',
        '*Tipos de feitiço*',
        '> Criação: cria forma mágica, projétil, barreira, arma, construto, névoa, campo.',
        '> Reforço: melhora corpo, atributo físico, defesa corporal, arma ou aliado.',
        '> Suporte: cura, bênção, buff, debuff, selo, condição, vínculo, armadilha, maldição.',
        '> Mana pura: bala, pulso, passo, pele, manto e pressão de mana sem tipo de magia.',
        '',
        '*Pesos base de Criação*',
        '> Forma simples: +1.',
        '> Controle usado: +1.',
        '> Defesa/Velocidade/Força Mágica I/II/III: +1/+2/+3.',
        '> Estrutura: +1.',
        '> Densidade I/II/III: +1/+2/+3.',
        '> Precisão I/II/III: +1/+2/+3.',
        '> Junção de Forma: +2.',
        '> Armas, Formas Humanoides ou Ambiente I/II/III: +2/+3/+4.',
        '',
        '*Pesos base de Reforço*',
        '> Reforço base: +1.',
        '> Intensidade I/II/III: +1/+2/+3.',
        '> Estabilidade I/II/III: +1/+2/+3.',
        '> 1/2/3 atributos no mesmo feitiço: +1/+2/+3.',
        '> Autobuff/Invencível: +1.',
        '> Buff em outro alvo/Invicto: +2.',
        '> Reforço à distância: +2.',
        '> Reforço coletivo: +3.',
        '> Junção de Forma: +2.',
        '> Reforço Avançado Armas/Formas/Ambiente: +2/+3/+4.',
        '',
        '*Suporte*',
        '> Use com mais cuidado. Básico pode ser bênção, cura, buff simples ou condição leve.',
        '> Debuff, maldição, restrição, selo forte, armadilha perfeita e magia proibida pedem aprovação direta.',
        '> Suporte precisa dizer alvo, condição, duração, alcance, falha possível e limite.',
        '',
        '*Mana pura*',
        '> Mana é técnica de manipulação, não tipo de magia.',
        '> Bala de Mana I/II/III: Peso 2/4/6.',
        '> Pulso de Mana I/II/III: Peso 2/4/6.',
        '> Passo de Mana I/II/III: Peso 2/4/6.',
        '> Pele de Mana ativa: Peso 2.',
        '> Manto de Mana ativo: Peso 5.',
        '> Pressão de Mana usa PB/confronto; não é eixo do Hexágono.',
        '',
        '*Manutenção*',
        ...MAINTENANCE_TIERS.map((tier) => (
            tier.percent
                ? `> ${tier.label} ${tier.percent}%: ${tier.description}.`
                : `> ${tier.label}: ${tier.description}.`
        )),
        '> Retenção e Economia de Mana podem reduzir manutenção/custo.',
        '> Redução comum máxima: 30%, salvo aprovação especial.',
        '',
        '*Cortes obrigatórios*',
        '> Sem acerto automático.',
        '> Sem prisão perfeita.',
        '> Sem cura total fácil.',
        '> Sem dano inevitável.',
        '> Sem duração infinita.',
        '> Sem alvo ilimitado.',
        '> Sem autonomia completa sem custo alto.',
        '> Sem efeito que remove toda resposta do alvo.',
        '',
        '*Modelo de ficha aprovada*',
        '> Nome:',
        '> Versão:',
        '> Tipo:',
        '> Custo:',
        '> Alcance:',
        '> Duração:',
        '> Efeito:',
        '> Limites:',
        '> Notas ADM:',
        '',
        '*Exemplo curto*',
        '> Nome: Mão de Lama',
        '> Versão: 1',
        '> Tipo: Criação',
        '> Custo: 100 mana',
        '> Alcance: curto',
        '> Duração: 1 turno',
        '> Efeito: cria uma mão simples de lama para agarrar, puxar ou segurar algo leve.',
        '> Limites: não esmaga, não prende inevitavelmente e não age sozinha.',
        '',
        '*Resumo final*',
        '> Player descreve a ideia.',
        '> ADM aprova uma versão menor e clara.',
        '> Bot guarda só a ficha aprovada.',
        '> Se quiser melhorar depois, entra em nova avaliação.',
        '',
        '*Comandos úteis*',
        '> .#capacidade — visão simples do personagem.',
        '> .#capacidade técnica @player — leitura completa para ADM.',
        '> .#hexagono — ver limites de Mana.',
        '> .#arvore mana / criacao / reforco / suporte — ver nós.',
    ].join('\n');
}

module.exports = {
    MAINTENANCE_TIERS,
    RANK_BY_WEIGHT,
    STAGE_WEIGHT_LIMITS,
    calculateRankCost,
    formatQuickGuide,
};
