const RANK_BY_WEIGHT = [
    { min: 1, max: 3, rank: 'E', manaPerWeight: 50 },
    { min: 4, max: 5, rank: 'D', manaPerWeight: 80 },
    { min: 6, max: 7, rank: 'C', manaPerWeight: 120 },
    { min: 8, max: 9, rank: 'B', manaPerWeight: 180 },
    { min: 10, max: 12, rank: 'A', manaPerWeight: 250 },
    { min: 13, max: null, rank: 'S', manaPerWeight: null, special: true },
];

const MAINTENANCE_TIERS = [
    { key: 'nenhuma', label: 'nenhuma', percent: 0, description: 'instantâneo' },
    { key: 'leve', label: 'leve', percent: 30, description: 'uma coisa simples ativa' },
    { key: 'media', label: 'média', percent: 40, description: 'área pequena, movimento ou efeito simples' },
    { key: 'pesada', label: 'pesada', percent: 50, description: 'área + efeito, múltiplas partes ou buff forte' },
    { key: 'muito_pesada', label: 'muito pesada', percent: 60, description: 'coletivo, seletivo, automático ou campo grande' },
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
    { value: 1, alcance: '3m', area: 'raio 2m-3m', duracao: '1 ciclo', pressao: '+0%', controle: 'instável', emissao: 'curta e simples' },
    { value: 2, alcance: '8m', area: 'raio 5m', duracao: '2 ciclos', pressao: '+5%', controle: 'básico', emissao: 'estável' },
    { value: 3, alcance: '15m', area: 'raio 8m-10m', duracao: '3 ciclos', pressao: '+10%', controle: 'preciso', emissao: 'moldável' },
    { value: 4, alcance: '30m', area: 'área grande', duracao: 'cena curta', pressao: '+20%', controle: 'refinado', emissao: 'forte' },
    { value: 5, alcance: '50m+', area: 'campo amplo', duracao: 'longa', pressao: '+30%', controle: 'cirúrgico', emissao: 'avançada' },
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
        manaPerWeight: tier.manaPerWeight,
        totalMana: tier.manaPerWeight === null ? null : parsedWeight * tier.manaPerWeight,
        special: tier.special === true,
        label: tier.special
            ? `Rank ${tier.rank} especial`
            : `Rank ${tier.rank} - ${tier.manaPerWeight} mana por peso`,
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
        ...RANK_BY_WEIGHT.map((item) => (
            item.special
                ? `> ${item.min}+: Rank ${item.rank} — especial, sem custo automático.`
                : `> ${item.min}-${item.max}: Rank ${item.rank} — ${item.manaPerWeight} mana por peso.`
        )),
        '',
        '*Como calcular*',
        '> Ativação = Peso total × mana por peso.',
        '> Exemplo: Peso 4 = Rank D = 4 × 80 = 320 mana.',
        '> Conte só o que o feitiço usa nessa versão.',
        '> Não some pré-requisitos, níveis antigos ou tudo que o player comprou.',
        '',
        '*Hexágono de Mana*',
        '> Percepção: notar mana, mirar melhor, ler fluxo e agir em caos.',
        '> Retenção: duração, sustentação e menor desgaste.',
        '> Emissão: lançar, projetar, impulsionar e enviar para fora.',
        '> Controle: moldar, curvar, dividir, estabilizar e selecionar alvo.',
        '> Pressão: impacto bruto e disputa de potência.',
        '> Alcance: distância e tamanho de área.',
        '',
        '*Limites rápidos do Hexágono*',
        ...HEXAGON_LIMITS.map((item) => (
            `> ${item.value}/5: ${item.alcance} · ${item.area} · ${item.duracao} · Pressão ${item.pressao} · Controle ${item.controle} · Emissão ${item.emissao}.`
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
        '> Pressão do Hexágono soma impacto automático só em mana pura.',
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
