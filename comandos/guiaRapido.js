const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { normalizeText } = require('../helpers/textUtils');
const { formatQuickGuide } = require('../helpers/clover/balanceGuide');

const TITLE_SUFFIX = '𖥔 CLOVER MULTICOLOR';

function header(title, subtitle) {
    return [
        `*♧┃${title} ${TITLE_SUFFIX}*`,
        `     ── ${subtitle} ──`,
    ];
}

function section(symbol, title) {
    return `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;
}

function command(commandText, description) {
    return [
        `*̣${commandText}*`,
        `> ${description}`,
    ];
}

function renderGuideMenu() {
    return [
        ...header('GUIAS DO MAGO', 'entenda cada parte do sistema'),
        '',
        section('✓', '𝑨́𝒓𝒗𝒐𝒓𝒆𝒔'),
        '',
        ...command(`${COMMAND_PREFIX}guia mana`, 'Entender Mana, emissão, retenção e Hexágono.'),
        ...command(`${COMMAND_PREFIX}guia criacao`, 'Entender formas mágicas, estrutura e manifestação.'),
        ...command(`${COMMAND_PREFIX}guia reforco`, 'Entender buff mágico, corpo e aliados.'),
        ...command(`${COMMAND_PREFIX}guia suporte`, 'Entender cura, bênção, praga, condição e trava narrativa.'),
        ...command(`${COMMAND_PREFIX}guia fisico`, 'Entender corpo, atributos físicos e identidade física.'),
        '',
        section('◆', '𝑩𝒂𝒍𝒂𝒏𝒄𝒆𝒂𝒎𝒆𝒏𝒕𝒐'),
        '',
        ...command(`${COMMAND_PREFIX}guia rapido`, 'Ver pesos, custo, alcance, duração e manutenção.'),
    ].join('\n');
}

function renderManaGuide() {
    return [
        ...header('GUIA DE MANA', 'base técnica e limites de alcance'),
        '',
        section('✓', '𝑶 𝑸𝒖𝒆 𝑬́'),
        '',
        '*𝑴𝒂𝒏𝒂:*',
        '> É a técnica de sentir, circular, reter, emitir e controlar energia mágica.',
        '> Não é tipo de magia. É a base que ajuda magia, reforço e mana pura a funcionarem melhor.',
        '',
        section('✦', '𝑸𝒖𝒂𝒏𝒅𝒐 𝑬𝒏𝒕𝒓𝒂'),
        '',
        '*𝑷𝒆𝒓𝒄𝒆𝒑𝒄̧𝒂̃𝒐:*',
        '> Quando precisa sentir mana, notar fluxo, assinatura ou presença mágica.',
        '*𝑭𝒍𝒖𝒙𝒐:*',
        '> Quando precisa circular mana sem quebrar controle.',
        '*𝑬𝒎𝒊𝒔𝒔𝒂̃𝒐:*',
        '> Quando lança, projeta, impulsiona ou manda mana para fora.',
        '*𝑹𝒆𝒕𝒆𝒏𝒄̧𝒂̃𝒐:*',
        '> Quando sustenta efeito, economiza gasto ou mantém algo ativo.',
        '',
        section('◇', '𝑳𝒊𝒎𝒊𝒕𝒆'),
        '',
        '> A árvore diz o que o personagem sabe fazer.',
        '> O Hexágono diz até onde isso funciona bem.',
        '> Mana não aprova técnica automaticamente.',
    ].join('\n');
}

function renderCreationGuide() {
    return [
        ...header('GUIA DE CRIAÇÃO', 'forma mágica e manifestação'),
        '',
        section('✓', '𝑶 𝑸𝒖𝒆 𝑬́'),
        '',
        '*𝑪𝒓𝒊𝒂𝒄̧𝒂̃𝒐:*',
        '> É a capacidade de manifestar magia em forma: projétil, lâmina, barreira, fio, névoa, arma, construto ou campo.',
        '> Ela melhora a coisa criada, não o corpo do personagem.',
        '',
        section('✦', '𝑸𝒖𝒂𝒏𝒅𝒐 𝑬𝒏𝒕𝒓𝒂'),
        '',
        '*𝑭𝒐𝒓𝒄̧𝒂 𝑴𝒂́𝒈𝒊𝒄𝒂:*',
        '> Quando a criação foi feita para bater, pressionar, empurrar ou romper.',
        '*𝑽𝒆𝒍𝒐𝒄𝒊𝒅𝒂𝒅𝒆 𝑴𝒂́𝒈𝒊𝒄𝒂:*',
        '> Quando a criação precisa se mover, alcançar ou chegar rápido.',
        '*𝑫𝒆𝒇𝒆𝒔𝒂 𝑴𝒂́𝒈𝒊𝒄𝒂:*',
        '> Quando a criação serve para bloquear, cobrir ou proteger.',
        '*𝑫𝒆𝒏𝒔𝒊𝒅𝒂𝒅𝒆:*',
        '> Quando a forma precisa ser mais firme, compacta, resistente ou difícil de desfazer.',
        '*𝑷𝒓𝒆𝒄𝒊𝒔𝒂̃𝒐:*',
        '> Quando a forma precisa encaixar em ponto exato, detalhe fino ou brecha pequena.',
        '',
        section('◇', '𝑳𝒊𝒎𝒊𝒕𝒆'),
        '',
        '> Não diga que o personagem tem Força Mágica passiva.',
        '> Diga que ele pode aplicar esse treino quando a criação for narrada para impacto.',
        '> Criação não buffa corpo. Isso é Reforço.',
    ].join('\n');
}

function renderReinforcementGuide() {
    return [
        ...header('GUIA DE REFORÇO', 'buff mágico no corpo e em alvos'),
        '',
        section('✓', '𝑶 𝑸𝒖𝒆 𝑬́'),
        '',
        '*𝑹𝒆𝒇𝒐𝒓𝒄̧𝒐:*',
        '> É magia aplicada para fortalecer corpo, atributo físico, defesa corporal, arma, aliado ou forma avançada.',
        '> Ele melhora quem recebe o reforço, não melhora projétil ou criação mágica comum sozinho.',
        '',
        section('✦', '𝑸𝒖𝒂𝒏𝒅𝒐 𝑬𝒏𝒕𝒓𝒂'),
        '',
        '*𝑰𝒏𝒕𝒆𝒏𝒔𝒊𝒅𝒂𝒅𝒆:*',
        '> Quando o reforço precisa dar mais potência.',
        '*𝑬𝒔𝒕𝒂𝒃𝒊𝒍𝒊𝒅𝒂𝒅𝒆:*',
        '> Quando o reforço precisa durar melhor, falhar menos ou manter controle.',
        '*𝑭𝒐𝒄𝒐:*',
        '> Define quantos atributos entram no mesmo reforço.',
        '*𝑨𝒍𝒗𝒐:*',
        '> Autobuff, toque, distância ou coletivo mudam custo, risco e limite.',
        '',
        section('◇', '𝑳𝒊𝒎𝒊𝒕𝒆'),
        '',
        '> Reforço depende de atributo liberado, alcance, duração, custo e narração.',
        '> Buff em aliado, coletivo ou à distância precisa ser mais caro e mais limitado.',
    ].join('\n');
}

function renderSupportGuide() {
    return [
        ...header('GUIA DE SUPORTE', 'cura, buff, debuff e condição'),
        '',
        section('✓', '𝑶 𝑸𝒖𝒆 𝑬́'),
        '',
        '*𝑺𝒖𝒑𝒐𝒓𝒕𝒆:*',
        '> É a árvore de efeitos auxiliares: cura, bênção, praga, condição, vínculo, selo, buff, debuff, armadilha e transmissão.',
        '> É a árvore que mais precisa de trava clara.',
        '',
        section('✦', '𝑻𝒐𝒅𝒐 𝑺𝒖𝒑𝒐𝒓𝒕𝒆 𝑷𝒓𝒆𝒄𝒊𝒔𝒂'),
        '',
        '*𝑨𝒍𝒗𝒐:*',
        '> Quem recebe o efeito.',
        '*𝑪𝒐𝒏𝒅𝒊𝒄̧𝒂̃𝒐:*',
        '> O que precisa acontecer para funcionar.',
        '*𝑫𝒖𝒓𝒂𝒄̧𝒂̃𝒐:*',
        '> Quanto tempo fica ativo.',
        '*𝑭𝒂𝒍𝒉𝒂:*',
        '> Como o alvo resiste, escapa, quebra ou reduz.',
        '',
        section('◇', '𝑳𝒊𝒎𝒊𝒕𝒆'),
        '',
        '> Cura grande, prisão perfeita, maldição forte, selo absoluto e debuff sem resposta pedem aprovação narrativa.',
        '> Suporte nunca deve remover toda resposta do alvo sem custo pesado.',
    ].join('\n');
}

function renderPhysicalGuide() {
    return [
        ...header('GUIA FÍSICO', 'corpo, atributo e leitura narrativa'),
        '',
        section('✓', '𝑶 𝑸𝒖𝒆 𝑬́'),
        '',
        '*𝑭𝒊́𝒔𝒊𝒄𝒐:*',
        '> É treino corporal. Ele diz como o personagem usa melhor Força, Velocidade, Agilidade e Resistência.',
        '> Não cria atributo novo e não aumenta magia.',
        '',
        section('◆', '𝑪𝒂𝒎𝒊𝒏𝒉𝒐𝒔'),
        '',
        '*𝑽𝒊𝒈𝒐𝒓:*',
        '> Bater, empurrar, quebrar, aguentar dor, resistir tranco e manter fôlego.',
        '*𝑪𝒐𝒏𝒕𝒓𝒐𝒍𝒆 𝑪𝒐𝒓𝒑𝒐𝒓𝒂𝒍:*',
        '> Correr, reposicionar, reagir, esquivar, acertar brecha e executar movimento fino.',
        '*𝑷𝒆𝒓𝒄𝒆𝒑𝒄̧𝒂̃𝒐 𝑭𝒊́𝒔𝒊𝒄𝒂:*',
        '> Sentidos, leitura corporal e intuição física. Não dá bônus numérico.',
        '*𝑰𝒅𝒆𝒏𝒕𝒊𝒅𝒂𝒅𝒆:*',
        '> Bárbaro, Culto, Instinto e expressões de postura em combate.',
        '',
        section('◇', '𝑳𝒊𝒎𝒊𝒕𝒆'),
        '',
        '> Físico não melhora magia criada, projétil mágico, mana pura, cura ou Reforço mágico.',
        '> Estilo de Luta, arma específica e golpe personalizado são sistemas separados.',
    ].join('\n');
}

function resolveGuide(body) {
    const topic = normalizeText(body || '');
    if (!topic) return renderGuideMenu();
    if (['rapido', 'rápido', 'balanceamento', 'adm'].includes(topic)) return formatQuickGuide();
    if (['mana', 'hexagono', 'hexágono'].includes(topic)) return renderManaGuide();
    if (['criacao', 'criação', 'criacao magica', 'criação mágica'].includes(topic)) return renderCreationGuide();
    if (['reforco', 'reforço'].includes(topic)) return renderReinforcementGuide();
    if (['suporte', 'support'].includes(topic)) return renderSupportGuide();
    if (['fisico', 'físico', 'fisica', 'física'].includes(topic)) return renderPhysicalGuide();
    return renderGuideMenu();
}

module.exports = {
    nome: `${COMMAND_PREFIX}guia rapido`,
    aliases: [
        `${COMMAND_PREFIX}guiarapido`,
        `${COMMAND_PREFIX}guia rápido`,
        `${COMMAND_PREFIX}guia`,
    ],
    descricao: 'Mostra guias rápidos Clover por árvore ou balanceamento.',
    executar: async ({ sock, m, idChat, body }) => {
        await sendReply({
            sock,
            idChat,
            m,
            text: resolveGuide(body),
        });
    },
};
