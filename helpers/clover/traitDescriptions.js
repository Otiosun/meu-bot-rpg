const OFFICIAL_TRAIT_DESCRIPTIONS = {
    voz_de_salao: {
        summary: 'O personagem sabe ser ouvido e possui bastante carisma.',
        lines: [
            'Passivo: lida melhor com conversa, presença, persuasão e ambientes sociais.',
            'Não controla vontade.',
        ],
    },
    mente_matematica: {
        summary: 'O personagem enxerga padrões melhor que outras pessoas.',
        lines: [
            'Passivo: melhora cálculo, distância, proporção, engenharia, lógica e forma.',
            '1x por trama, pode receber uma leitura mais exata de um problema técnico.',
            'Não prevê pessoas como se fossem fórmula.',
        ],
    },
    estrategista: {
        summary: 'O personagem pensa a luta antes dela acabar.',
        lines: [
            'Passivo: lê melhor posições, rotas, riscos, vantagens e formações.',
            '1x por trama, após observar a cena, pode criar um plano e dar +10% no atributo usado na primeira ação de execução.',
            'Não controla ação de outro personagem.',
        ],
    },
    memoria_afiada: {
        summary: 'O personagem guarda rostos, vozes, sinais e detalhes.',
        lines: [
            'Passivo: lembra melhor de informações, símbolos, pistas, nomes e feitiços vistos.',
            '1x por trama, pode cobrar um detalhe narrativo importante.',
            'Não cria informação que nunca foi vista.',
        ],
    },
    maos_precisas: {
        summary: 'As mãos do personagem sabem trabalhar com detalhe.',
        lines: [
            'Passivo: ajuda em cura, corte, selo, ajuste, alquimia, armadilha e manipulação fina.',
            'Quando a ação depender de mão firme e detalhe, pode favorecer Agilidade ou Poder Mágico, dependendo da ação.',
            'Geralmente não ajuda ação bruta, apavorada ou feita sem tempo.',
        ],
    },
    olhar_analitico: {
        summary: 'O personagem percebe a peça torta dentro da máquina.',
        lines: [
            'Passivo: lê falhas, padrões, pontos fracos e estruturas.',
            '1x por trama, pode identificar uma fraqueza narrativa de objeto, defesa, ambiente ou situação.',
            'Não descobre fraqueza impossível sem base.',
        ],
    },
    intuicao_social: {
        summary: 'O personagem percebe melhor mudanças de humor, intenção e clima social.',
        lines: [
            'Passivo: lê clima social, constrangimento, intenção, mentira fraca e ameaça velada.',
            'Não lê mente.',
        ],
    },
    corpo_de_rotina: {
        summary: 'O corpo aprendeu com repetição.',
        lines: [
            'Passivo: ações treinadas, trabalho físico, postura e repetição saem melhor.',
            'Pode favorecer Força, Velocidade, Agilidade ou Resistência quando a ação for algo já praticado várias vezes.',
            'Não copia técnica avançada sem árvore.',
        ],
    },
    prodigio_de_mana: {
        summary: 'A mana parece fazer mais sentido para esse personagem.',
        lines: [
            'Passivo: treinos básicos de Mana são mais naturais.',
            'Passivo: recebe +10% em controle de mana.',
            'Não pula pré-requisito da árvore de Mana.',
        ],
    },
    corpo_de_combate: {
        summary: 'O corpo aprendeu a lutar apanhando.',
        lines: [
            'Passivo: treinos físicos rendem melhor.',
            'Em combate físico, depois de sofrer um golpe ou ver um padrão se repetindo, pode receber +10% em Agilidade ou Resistência para lidar com aquele padrão.',
        ],
    },
    cabeca_de_capitao: {
        summary: 'O personagem não vê só a própria luta. Vê o campo.',
        lines: [
            'Passivo: lê melhor posição de aliados, riscos coletivos e organização de cena.',
            '1x por trama, pode orientar aliados em uma ação clara. Se o aliado seguir a ordem, recebe +10% no atributo usado naquela ação.',
            'A ordem pode ajudar Força, Velocidade, Agilidade, Resistência ou Poder Mágico, dependendo do que foi orientado.',
            'Não controla ação de outro player.',
        ],
    },
    cria_da_fronteira: {
        summary: 'Cresceu onde o reino quase não chega.',
        lines: [
            'Passivo: aguenta longas viagens, calor, frio, fome, terreno ruim e ambiente hostil com mais facilidade.',
            '1x por trama, pode evitar uma penalidade de ambiente.',
            'Desvantagem: em locais nobres, finos ou cheios de etiqueta, pode parecer deslocado.',
        ],
    },
    sangue_de_salao: {
        summary: 'Aprendeu a sobreviver entre nomes, sorrisos e mentiras bem vestidas.',
        lines: [
            'Passivo: lida melhor com etiqueta, nobreza, cargos, famílias importantes e acordos sociais.',
            '1x por trama social, pode perceber quem tem mais poder na sala.',
            'Desvantagem: fama, família ou passado podem ser usados contra o personagem.',
        ],
    },
    nome_pesado: {
        summary: 'As pessoas já ouviram algo sobre esse nome.',
        lines: [
            'Passivo: sua presença chama mais atenção e pode abrir portas onde reputação importa.',
            '1x por trama, pode fazer um NPC hesitar, ouvir ou respeitar sua presença.',
            'Desvantagem: inimigos, rivais e cobranças antigas também podem reconhecer.',
        ],
    },
    berco_de_lama: {
        summary: 'Veio de baixo. Não aprendeu a vencer bonito, só a não cair.',
        lines: [
            'Passivo: lida melhor com fome, humilhação, cansaço, desprezo e desvantagem social.',
            '1x por trama, em inferioridade clara, pode receber +10% em Resistência para aguentar, resistir ou continuar de pé.',
            'Desvantagem: pode reagir mal a ordens, desprezo ou abusos de autoridade.',
        ],
    },
    filho_de_oficio: {
        summary: 'Cresceu perto de um trabalho, e as mãos aprenderam antes da cabeça.',
        lines: [
            'Passivo: escolha um ofício.',
            'Ações ligadas a esse ofício saem mais naturais, desde que envolvam prática, experiência ou costume.',
            '1x por trama, pode usar esse ofício para abrir caminho, conseguir informação ou resolver um problema prático.',
            'Desvantagem: pessoas do mesmo ofício podem cobrar, reconhecer ou julgar.',
        ],
    },
    maos_que_tremem: {
        summary: 'As mãos ainda lembram de algo que a cabeça tenta esquecer.',
        lines: [
            'No início de um combate perigoso, pode hesitar.',
            'Depois de agir apesar da hesitação, recebe +15% na próxima ação de Agilidade ou controle de mana.',
            'Desvantagem: a hesitação inicial é real e pode ser cobrada.',
        ],
    },
    promessa_no_osso: {
        summary: 'Uma promessa virou parte do corpo.',
        lines: [
            '1x por trama, quando age para cumprir a promessa, pode ignorar medo, dor ou cansaço leve.',
            'Se a trama for crítica, pode receber +10% em Resistência.',
            'Desvantagem: se a promessa for quebrada, a Marca pode ser perdida.',
        ],
    },
    nao_ajoelho: {
        summary: 'Pode perder. Pode sangrar. Mas não se dobra fácil.',
        lines: [
            'Passivo: pressão de autoridade, intimidação e humilhação afetam menos.',
            '1x por trama, pode manter a postura após golpe, ordem ou ameaça.',
            'Desvantagem: orgulho pode colocar em problema.',
        ],
    },
    fome_de_reconhecimento: {
        summary: 'Não luta só para vencer. Luta para ser visto.',
        lines: [
            'Quando faz algo arriscado diante de testemunhas, recebe +15% na ação.',
            '1x por trama.',
            'Desvantagem: se falhar, a falha deve ser visível, humilhante ou social.',
        ],
    },
    ultimo_a_ficar: {
        summary: 'Fica quando os outros já pensaram em correr.',
        lines: [
            'Quando protege alguém em recuo, fuga ou resgate, recebe +15% em Resistência ou Poder Mágico para defender, conter ou ganhar tempo.',
            '1x por trama.',
            'Desvantagem: normalmente sai por último.',
        ],
    },
    luta_feia: {
        summary: 'Não luta bonito. Luta para acabar.',
        lines: [
            'Passivo: pode usar o ambiente de forma suja, improvisada ou inesperada.',
            'Se a ação for criativa, plausível e aprovada pela ADM, recebe +10% na ação.',
            'Desvantagem: inimigos honrados, nobres ou rígidos podem ter repulsa.',
        ],
    },
    passo_quieto: {
        summary: 'Aprendeu a chegar sem pedir licença.',
        lines: [
            'Passivo: passos fazem menos barulho e a presença física chama menos atenção.',
            '1x por trama, pode se aproximar, reposicionar ou sair de um local sem chamar atenção.',
            'Desvantagem: se usar magia chamativa, a Marca não funciona naquele momento.',
        ],
    },
    sorriso_de_mentiroso: {
        summary: 'Não precisa de uma mentira perfeita. Só de um segundo de dúvida.',
        lines: [
            '1x por trama social, pode criar hesitação, distração ou falsa impressão.',
            'Desvantagem: se for descoberto, a confiança cai com mais força.',
        ],
    },
    sangue_quente: {
        summary: 'Reage antes de pensar.',
        lines: [
            'Quando é provocado, humilhado ou desafiado, pode receber +15% na primeira ação agressiva.',
            '1x por trama.',
            'Desvantagem: o ADM pode cobrar impulsividade, exposição ou decisões ruins.',
        ],
    },
    corpo_inquieto: {
        summary: 'Pode forçar além do limite. Depois, o corpo apresenta a conta.',
        lines: [
            '1x por trama, pode realizar uma ação física mesmo sob cansaço, dor ou penalidade.',
            'Pode afetar Força, Velocidade, Agilidade ou Resistência.',
            'Desvantagem: após a trama, recebe penalidade física ou necessidade de descanso.',
        ],
    },
    medo_de_ficar_pra_tras: {
        summary: 'Não suporta ver os outros avançando e ficar parado.',
        lines: [
            'Quando alguém aliado evolui, vence ou se destaca na frente, pode transformar isso em impulso.',
            '1x por trama, recebe +10% na próxima ação de superação.',
            'Desvantagem: inveja, pressa ou comparação podem aparecer na interpretação.',
        ],
    },
    divida_de_vida: {
        summary: 'Alguém salvou alguma coisa que não saiu mais.',
        lines: [
            'Quando luta para proteger pessoa, família, esquadrão ou ideal ligado a essa dívida, recebe +15% na ação.',
            '1x por trama.',
            'Desvantagem: se falhar nessa proteção, punições serão aplicadas.',
        ],
    },
    mana_que_vaza: {
        summary: 'A mana não fica totalmente presa no corpo.',
        lines: [
            'Passivo: presença mágica é mais perceptível e instável.',
            'Pode favorecer emissão, pressão ou leitura de mana quando a cena comportar esse vazamento.',
            'Desvantagem: ocultação, silêncio mágico e controle fino podem ser mais difíceis.',
        ],
    },
    pagina_que_responde: {
        summary: 'O grimório reage de um jeito que parece pessoal demais.',
        lines: [
            '1x por trama, uma página pode reagir a uma escolha, emoção ou risco importante.',
            'Pode facilitar leitura de feitiço, despertar pista ou abrir caminho narrativo.',
            'Não cria feitiço novo sem árvore, treino ou aprovação.',
        ],
    },
    feitico_de_confianca: {
        summary: 'A magia responde melhor quando existe confiança real.',
        lines: [
            'Quando age por vínculo, promessa ou confiança genuína, pode receber +10% na ação.',
            '1x por trama.',
            'Não funciona por manipulação falsa ou vínculo encenado.',
        ],
    },
    sem_mana: {
        summary: 'O personagem nasceu sem fluxo comum de mana.',
        lines: [
            'Anomalia narrativa: limita caminhos mágicos comuns e exige tratamento individual.',
            'Não concede poder automático por si só.',
            'Caminhos especiais dependem de aprovação e trama.',
        ],
    },
    mana_amaldicoada: {
        summary: 'A mana do personagem carrega uma corrupção, peso ou ruído estranho.',
        lines: [
            'Anomalia narrativa: a magia pode gerar efeitos colaterais, suspeita ou risco.',
            'Pode abrir caminho para maldição, pacto, corrupção ou marca proibida.',
            'Não concede maldição pronta sem árvore, feitiço ou aprovação.',
        ],
    },
    corpo_amaldicoado: {
        summary: 'O corpo carrega uma cobrança que não parece natural.',
        lines: [
            'Anomalia narrativa: dor, limite, mutação, marca física ou instabilidade podem ser cobrados.',
            'Pode abrir caminho para resistência estranha ou custo corporal.',
            'Não concede buff físico automático sem regra, treino ou aprovação.',
        ],
    },
    grimorio_amaldicoado: {
        summary: 'O grimório responde como se algo errado estivesse escrito nele.',
        lines: [
            'Anomalia narrativa: páginas, símbolos ou feitiços podem cobrar preço.',
            'Pode abrir caminho para efeitos proibidos, pactos ou páginas instáveis.',
            'Não concede feitiço raro automático sem aprovação.',
        ],
    },
};

function getOfficialTraitDescription(key) {
    const normalizedKey = String(key || '').trim();
    return OFFICIAL_TRAIT_DESCRIPTIONS[normalizedKey] || null;
}

module.exports = {
    OFFICIAL_TRAIT_DESCRIPTIONS,
    getOfficialTraitDescription,
};
