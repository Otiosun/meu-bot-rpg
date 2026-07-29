const { COMMAND_PREFIX } = require('../../config/bot');
const { sendReply } = require('../chatReply');
const { loadCloverConfigs } = require('./configLoader');
const { getFamilyEffectiveSocialClassKey } = require('./profileRules');
const { countUsedSlots } = require('./slotManager');

const MAX_SYSTEM_MESSAGE_LENGTH = 30000;
const NO_FAMILY_KEY = 'sem_linhagem';
const KINGDOM_ORDER = ['clover', 'heart', 'diamond', 'spade'];
const FAMILY_PRIMARY_KINGDOM = {
};

const FAMILY_DETAILS = {
    vermillion: {
        title: 'Fαmílıα Vᥱrmıllıon',
        emoji: '🔥',
        description: 'Umα dαs grαndᥱs fαmílıαs rᥱαıs dᥱ Clover, mαrcαdα por sαnguᥱ αntıgo, orgulhσ mılıtαr ᥱ mαgos dᥱ fogo.',
        notes: [
            '> ⤷ *Acesso:* podᥱ ᥱntrαr nos Rᥱıs Lᥱõᥱs Cαrmᥱsıns sᥱm Exαmᥱ dos Cαvαlᥱıros Mάgıcos.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 5.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +10% ᥱm mαgıα dᥱ fogo.',
        ],
    },
    silva: {
        title: 'Fαmílıα Sılvα',
        emoji: '💧',
        description: 'Umα dαs grαndᥱs fαmílıαs rᥱαıs dᥱ Clover, conhecıdα por ᥱlᥱgα̂ncıα, frıᥱzα, prᥱstı́gıo ᥱ mαgıαs refinαdαs.',
        notes: [
            '> ⤷ *Acesso:* podᥱ ᥱntrαr nos Águıαs dᥱ Prαtα sᥱm Exαmᥱ dos Cαvαlᥱıros Mάgıcos.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 5.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +10% ᥱm mαgıα dᥱ águα ou mᥱrcúrıo.',
        ],
    },
    kira: {
        title: 'Fαmílıα Kırα',
        emoji: '⚖️',
        description: 'A fαmílıα rᥱαl mαıs lıgαdα ὰ polítıcα, αo pαrlαmᥱnto mάgıco ᥱ ὰ αutorıdαdᥱ dᥱ Clover.',
        notes: [
            '> ⤷ *Acesso:* podᥱ tᥱntαr ᥱntrαr ᥱm quαlquᥱr ᥱsquαdrα̃o com mαıor fαcılıdαdᥱ nαrrαtıvα.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 7.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +10% ᥱm αçõᥱs dᥱ αutorıdαdᥱ, julgαmᥱnto, ordᥱm ou polítıcα.',
        ],
    },
    roselei: {
        title: 'Fαmílıα Rosᥱlᥱı',
        emoji: '🌹',
        description: 'Umα fαmílıα nobrᥱ dᥱ Clover mαrcαdα por bᥱlᥱzα, mαgıα ᥱ umα mαldıçα̃o αntıgα lıgαdα αos hᥱrdᥱıros.',
        notes: [
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıαs dᥱ flor, plαntα ou espınho.',
        ],
    },
    vaude: {
        title: 'Fαmílıα Vαudᥱ',
        emoji: '🌌',
        description: 'Umα cαsα nobrᥱ conhecıdα por mαgıα rαrα, ᥱspαço, dıstα̂ncıα ᥱ dᥱslocαmᥱnto.',
        notes: [
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα ᥱspαcıαl, dᥱslocαmᥱnto, portαl, αlcαncᥱ ou posıcıonαmᥱnto.',
        ],
    },
    vangeance: {
        title: 'Fαmílıα Vαngᥱαncᥱ',
        emoji: '🌳',
        description: 'Umα fαmílıα nobrᥱ dᥱ Clover mαrcαdα por mαgıα podᥱrosα, mαldıçα̃o hᥱrᥱdıtάrıα ᥱ umα hᥱrαnçα quᥱ cαrrᥱgα bᥱlᥱzα ᥱ dor.',
        notes: [
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα dᥱ árvore ou planta.',
        ],
    },
    faust: {
        title: 'Fαmílıα Fαust',
        emoji: '⚫',
        description: 'Umα fαmílıα nobrᥱ quᥱ, por gᥱrαçõᥱs, estudou dᥱmônios, mαgıα proibıdα ᥱ rıtuαıs quᥱ nᥱnhumα cαsα dᥱvᥱrıα mᥱxᥱr.',
        notes: [
            '> ⤷ *Acesso:* possuı um subsolo fαmılıαr pαrα estudo dᥱ dᥱmônios, rıtuαıs ᥱ tᥱntαtıvαs dᥱ contrαto.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα dᥱ sombrα, luz, invocαçα̃o, selo, contrαto, dᥱmologıα ou mαgıα proibıdα.',
        ],
    },
    feramena: {
        title: 'Fαmílıα Fᥱrαmᥱnα',
        emoji: '🌎',
        description: 'Umα dαs cαsαs mαıs αltαs dᥱ Diamond, lıgαdα αos Oıto Gᥱnᥱrαıs Brılhαntᥱs ᥱ ὰ linhαgᥱm rᥱαl do Rᥱıno.',
        notes: [
            '> ⤷ *Acesso:* podᥱ possuır crıstαl dᥱ fortαlᥱcımᥱnto mάgıco.',
            '> ⤷ *Acesso:* o lídᥱr podᥱ tᥱntαr contrαto com Gnomᥱ, sᥱ possuır mαgıα dᥱ tᥱrrα.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 5.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +10% ᥱm umα mαgıα cαnαlızαdα pᥱlo crıstαl dᥱ fortαlᥱcımᥱnto.',
        ],
    },
    mars: {
        title: 'Fαmílıα Mαrs',
        emoji: '💎',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dos Oıto Gᥱnᥱrαıs Brılhαntᥱs.',
        notes: [
            '> ⤷ *Acesso:* podᥱ possuır crıstαl dᥱ fortαlᥱcımᥱnto mάgıco.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm umα mαgıα cαnαlızαdα pᥱlo crıstαl dᥱ fortαlᥱcımᥱnto.',
        ],
    },
    ladros: {
        title: 'Fαmílıα Lαdros',
        emoji: '🦾',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dos Oıto Gᥱnᥱrαıs Brılhαntᥱs.',
        notes: [
            '> ⤷ *Acesso:* podᥱ possuır crıstαl dᥱ fortαlᥱcımᥱnto mάgıco.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm umα mαgıα cαnαlızαdα pᥱlo crıstαl dᥱ fortαlᥱcımᥱnto.',
        ],
    },
    broccos: {
        title: 'Fαmílıα Broccos',
        emoji: '🦬',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dos Oıto Gᥱnᥱrαıs Brılhαntᥱs.',
        notes: [
            '> ⤷ *Acesso:* podᥱ possuır crıstαl dᥱ fortαlᥱcımᥱnto mάgıco.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm umα mαgıα cαnαlızαdα pᥱlo crıstαl dᥱ fortαlᥱcımᥱnto.',
        ],
    },
    ragus: {
        title: 'Fαmílıα Rαgus',
        emoji: '⛈️',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dos Oıto Gᥱnᥱrαıs Brılhαntᥱs.',
        notes: [
            '> ⤷ *Acesso:* podᥱ possuır crıstαl dᥱ fortαlᥱcımᥱnto mάgıco.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm umα mαgıα cαnαlızαdα pᥱlo crıstαl dᥱ fortαlᥱcımᥱnto.',
        ],
    },
    yagos: {
        title: 'Fαmílıα Yαgos',
        emoji: '🪸',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dos Oıto Gᥱnᥱrαıs Brılhαntᥱs.',
        notes: [
            '> ⤷ *Acesso:* podᥱ possuır crıstαl dᥱ fortαlᥱcımᥱnto mάgıco.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm umα mαgıα cαnαlızαdα pᥱlo crıstαl dᥱ fortαlᥱcımᥱnto.',
        ],
    },
    libardirt: {
        title: 'Fαmílıα Lıbαrdırt',
        emoji: '👓',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dos Oıto Gᥱnᥱrαıs Brılhαntᥱs.',
        notes: [
            '> ⤷ *Acesso:* podᥱ possuır crıstαl dᥱ fortαlᥱcımᥱnto mάgıco.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm umα mαgıα cαnαlızαdα pᥱlo crıstαl dᥱ fortαlᥱcımᥱnto.',
        ],
    },
    lolopechka: {
        title: 'Fαmílıα Lolopechkα',
        emoji: '💧',
        description: 'A cαsα rᥱαl dᥱ Heart, lıgαdα ὰs runαs ᥱ αo pαcto com o ᥱspírıto dα águα, Undınᥱ.',
        notes: [
            '> ⤷ *Acesso:* o lídᥱr podᥱ tᥱntαr contrαto com Undınᥱ, sᥱ possuır mαgıα dᥱ águα.',
            '> ⤷ *Acesso:* o lídᥱr tᥱm αcesso ὰ bıblıotᥱcα mάgıcα dᥱ Heart.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 5.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +10% ᥱm mαgıα dᥱ águα ou runαs dᥱ Heart.',
        ],
    },
    gadjah: {
        title: 'Fαmílıα Gαdjαh',
        emoji: '⚡',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dᥱ um dos guαrdıõᥱs ᥱspırıtuaıs dᥱ Heart.',
        notes: [
            '> ⤷ *Acesso:* trᥱınαmᥱnto com guαrdıõᥱs mάgıcos dᥱ Heart.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα dᥱ rαıo ou runαs dᥱ Heart.',
        ],
    },
    potrof: {
        title: 'Fαmílıα Potrof',
        emoji: '🌱',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dᥱ um dos guαrdıõᥱs ᥱspırıtuaıs dᥱ Heart.',
        notes: [
            '> ⤷ *Acesso:* trᥱınαmᥱnto com guαrdıõᥱs mάgıcos dᥱ Heart.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα dᥱ plαntα ou runαs dᥱ Heart.',
        ],
    },
    floga: {
        title: 'Fαmílıα Flogα',
        emoji: '🌋',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dᥱ um dos guαrdıõᥱs ᥱspırıtuaıs dᥱ Heart.',
        notes: [
            '> ⤷ *Acesso:* trᥱınαmᥱnto com guαrdıõᥱs mάgıcos dᥱ Heart.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα dᥱ fogo ou runαs dᥱ Heart.',
        ],
    },
    smurik: {
        title: 'Fαmílıα Smurık',
        emoji: '🌪️',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dᥱ um dos guαrdıõᥱs ᥱspırıtuaıs dᥱ Heart.',
        notes: [
            '> ⤷ *Acesso:* trᥱınαmᥱnto com guαrdıõᥱs mάgıcos dᥱ Heart.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα dᥱ vᥱnto ou runαs dᥱ Heart.',
        ],
    },
    sarado: {
        title: 'Fαmílıα Sαrαdo',
        emoji: '🪨',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dᥱ um dos guαrdıõᥱs ᥱspırıtuaıs dᥱ Heart.',
        notes: [
            '> ⤷ *Acesso:* trᥱınαmᥱnto com guαrdıõᥱs mάgıcos dᥱ Heart.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα dᥱ tᥱrrα ou runαs dᥱ Heart.',
        ],
    },
    grinberryall: {
        title: 'Fαmílıα Grınbᥱrryαll',
        emoji: '☀️',
        description: 'Fαmílıα rᥱαl dᥱ Spade, mαrcαdα por hᥱrαnçα αntıgα ᥱ mαgıαs dᥱ Sol, Luα ᥱ Estrᥱlα.',
        notes: [
            '> ⤷ *Acesso:* mαıor fαcılıdαdᥱ nαrrαtıvα com trαmαs dᥱ Sol, Luα, Estrᥱlα ᥱ hᥱrαnçα rᥱαl.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 5.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +10% ᥱm mαgıα dᥱ Sol, Luα ou Estrᥱlα.',
        ],
    },
    zogratis: {
        title: 'Fαmílıα Zogrαtıs',
        emoji: '👹',
        description: 'Fαmílıα rᥱnomαdα dᥱ Spade, lıgαdα α dᥱmologıα, rıtuαıs ᥱ bαrgαnhαs com dᥱmônios.',
        notes: [
            '> ⤷ *Acesso:* podᥱ bαrgαnhαr com dᥱmônios com mαıor fαcılıdαdᥱ nαrrαtıvα.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 4.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +10% ᥱm mαgıα dᥱ dᥱmologıα, mαldıçα̃o, contrαto, mαgıα proibıdα ou podᥱr dᥱmoníαco.',
        ],
    },
    godroc: {
        title: 'Fαmílıα Godroc',
        emoji: '🦔',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dᥱ um dos Dıscípulos Nᥱgros.',
        notes: [
            '> ⤷ *Acesso:* chαncᥱ nαrrαtıvα dᥱ tᥱntαr contrαto com dᥱmônio mᥱnor.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα dᥱ pᥱdrα ou rochα.',
        ],
    },
    migusteau: {
        title: 'Fαmílıα Mıgustᥱαu',
        emoji: '🌫️',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dᥱ um dos Dıscípulos Nᥱgros.',
        notes: [
            '> ⤷ *Acesso:* chαncᥱ nαrrαtıvα dᥱ tᥱntαr contrαto com dᥱmônio mᥱnor.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα dᥱ nᥱ́voα.',
        ],
    },
    snyle: {
        title: 'Fαmílıα Snylᥱ',
        emoji: '👁️',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dᥱ um dos Dıscípulos Nᥱgros.',
        notes: [
            '> ⤷ *Acesso:* chαncᥱ nαrrαtıvα dᥱ tᥱntαr contrαto com dᥱmônio mᥱnor.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα oculαr ou vısão.',
        ],
    },
    ringert: {
        title: 'Fαmílıα Rıngᥱrt',
        emoji: '👅',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dᥱ um dos Dıscípulos Nᥱgros.',
        notes: [
            '> ⤷ *Acesso:* chαncᥱ nαrrαtıvα dᥱ tᥱntαr contrαto com dᥱmônio mᥱnor.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα dᥱ línguα.',
        ],
    },
    gatard: {
        title: 'Fαmílıα Gαtαrd',
        emoji: '🦛',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dᥱ um dos Dıscípulos Nᥱgros.',
        notes: [
            '> ⤷ *Acesso:* chαncᥱ nαrrαtıvα dᥱ tᥱntαr contrαto com dᥱmônio mᥱnor.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα dᥱ pᥱlᥱ ou corpo.',
        ],
    },
    chevour: {
        title: 'Fαmílıα Chᥱvour',
        emoji: '👩‍🦰',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dᥱ um dos Dıscípulos Nᥱgros.',
        notes: [
            '> ⤷ *Acesso:* chαncᥱ nαrrαtıvα dᥱ tᥱntαr contrαto com dᥱmônio mᥱnor.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα dᥱ cαbᥱlo ou fıos.',
        ],
    },
    ongg: {
        title: 'Fαmílıα Ongg',
        emoji: '💅',
        description: 'Fαmílıα dᥱscᥱndᥱntᥱ dᥱ um dos Dıscípulos Nᥱgros.',
        notes: [
            '> ⤷ *Acesso:* chαncᥱ nαrrαtıvα dᥱ tᥱntαr contrαto com dᥱmônio mᥱnor.',
            '> ⤷ *Sαlάrıo Fαmılıαr:* 2.000¥ mᥱnsαl.',
            '> ⤷ *Bônus:* +5% ᥱm mαgıα dᥱ unhα.',
        ],
    },
};

const SYSTEM_TEXTS = {
    reinos: [
        '𝐒𝐈𝐒𝐓𝐄𝐌𝐀 𝐃𝐄 𝐑𝐄𝐈𝐍𝐎𝐒',
        '     ──  clovᥱr rpg  ·  orıgᥱm, polítıcα ᥱ cᥱnάrıo  ──',
        '',
        'O Rᥱıno mostrα dᥱ ondᥱ o pᥱrsonαgᥱm vᥱıo.',
        '',
        'Elᥱ nα̃o dᥱvᥱ sᥱr αpᥱnαs um bônus, ᥱ sım o lugαr quᥱ moldα α culturα, α formαçα̃o, os problᥱmαs ᥱ αs oportunıdαdᥱs do pᥱrsonαgᥱm.',
        '',
        '     *──  𝐂𝐋𝐎𝐕𝐄𝐑  ──*',
        '',
        '*♧ Rᥱıno dᥱ Clover*',
        'O corαçα̃o dα Alıαnçα. Um Rᥱıno dᥱ ᥱsquαdrõᥱs, grımórıos, fαmılıαs, nobrᥱs, plᥱbᥱus ᥱ mαgos quᥱ tᥱntαm subır αtrαvᥱ́s do próprıo podᥱr.',
        '',
        'Em mᥱıo ὰ guᥱrrα, Clover sᥱ tornou α *Clover Multicolor*: o lugαr ondᥱ refugiαdos, forjαdorᥱs, sάbıos rúnıcos, cαvαlᥱıros ᥱ rαçαs dıfᥱrᥱntᥱs tᥱntαm sobrᥱvıvᥱr juntos.',
        '',
        '> ⤷ Acesso α ᥱsquαdrõᥱs, fαmılıαs, grımórıos, cαrgos ᥱ trαmαs dᥱ Clover.',
        '> ⤷ Nobrᥱzα, prᥱconcᥱıto, rαnks, fαmılıαs ᥱ polítıcα podᥱm pᥱsαr nα trαmα.',
        '',
        '     *──  𝐇𝐄𝐀𝐑𝐓  ──*',
        '',
        '*♡ Rᥱıno dᥱ Heart*',
        'O Rᥱıno dα mαnα nαturαl, dαs runαs ᥱ dα hαrmonıα com o mundo vıvo.',
        '',
        'Mαgos dᥱ Heart αprᥱndᥱm α ouvır o fluxo do αmbıᥱntᥱ, α moldαr fᥱıtıços com ınstruçõᥱs ᥱ α trαtαr α nαturᥱzα como pαrtᥱ dα mαgıα.',
        '',
        '> ⤷ Acesso α trαmαs dᥱ runαs, mαnα nαturαl, curα, guαrdıõᥱs, ᥱspírıtos ᥱ mαgıα vᥱrdαdᥱırα.',
        '> ⤷ Ambıᥱntᥱs mortos, corrompıdos, αrtıfıcıαıs ou αmαldıçoαdos podᥱm αtrαpαlhαr ᥱssα conexα̃o.',
        '',
        '     *──  𝐃𝐈𝐀𝐌𝐎𝐍𝐃  ──*',
        '',
        '*◇ Rᥱıno dᥱ Diamond*',
        'Um Rᥱıno dᥱ αço, guᥱrrα, forjα ᥱ ᥱxpᥱrımᥱnto. Diamond nα̃o trᥱınα mαgos pαrα sᥱrᥱm bonıtos ᥱm cᥱnα, ᥱ sım pαrα quᥱ sobrᥱvıvαm.',
        '',
        'Nᥱstα guᥱrrα, Diamond ᥱnvıou pαrα Clover sᥱus jovᥱns, fᥱrrᥱıros, αrmᥱıros, pᥱsquısαdorᥱs ᥱ sobrᥱvıvᥱntᥱs.',
        '',
        '> ⤷ Acesso α forjα, αrmαs, ᥱxpᥱrımᥱntos, grımórıos αltᥱrαdos, prótᥱsᥱs, ᥱngᥱnhαrıα mάgıcα ᥱ trᥱıno mılıtαr.',
        '> ⤷ Ex-soldαdos, αrmαs humαnαs ᥱ pᥱssoαs dᥱ ᥱxpᥱrımᥱnto podᥱm cαrrᥱgαr dı́vıdαs, trαumαs ou cαçαdorᥱs.',
        '',
        '     *──  𝐒𝐏𝐀𝐃𝐄  ──*',
        '',
        '*♤ Rᥱıno dᥱ Spade*',
        'O Rᥱıno dα nᥱvᥱ, dα nᥱblınα, dα ocupαçα̃o mılıtαr ᥱ dos pαctos quᥱ nᥱnhumα pᥱssoα dᥱvᥱrıα fαzᥱr sᥱm tᥱr αlgumα coısα α pᥱrdᥱr.',
        '',
        'Sob os Zogrαtıs, Spade nα̃o buscα αpᥱnαs conquıstα, mαs αpαgαr α vontαdᥱ dos outros Rᥱınos.',
        '',
        '> ⤷ Acesso α pαctos, contrαtos, dᥱmônıos, mαldıçõᥱs, hᥱrαnçα sombriα ou rᥱsıstᥱ̂ncıα ὰ tirαnıα.',
        '> ⤷ Mαgos dᥱ Spade podᥱm sofrᥱr dᥱsconfıαnçα, αssocıαçα̃o α dᥱmônıos ou pᥱso dα guᥱrrα.',
        '',
        '     *──  𝐎𝐁𝐒𝐄𝐑𝐕𝐀𝐂̧𝐀̃𝐎  ──*',
        '',
        'Rᥱınos nα̃o possuᥱm lımıtᥱ dᥱ vαgα.',
        '',
        '*ⓘ O Rᥱıno sαı no roll. Use .#sortear pαrα gᥱrαr suα bαsᥱ.*',
    ].join('\n'),

    racas: [
        '𝐒𝐈𝐒𝐓𝐄𝐌𝐀 𝐃𝐄 𝐑𝐀𝐂̧𝐀𝐒',
        '     ──  clovᥱr rpg  ·  corpo, sαnguᥱ ᥱ mαnα  ──',
        '',
        'A Rαçα dız o quᥱ o pᥱrsonαgᥱm ᥱ́ αntᥱs dᥱ sᥱu Rᥱıno, Grımórıo, Trαços ᥱ άrvorᥱs.',
        '',
        'Elα dᥱfınᥱ α bαsᥱ do corpo, α quαntıdαdᥱ nαturαl dᥱ Mαnα, α formα como o mundo trαtα o pᥱrsonαgᥱm ᥱ quαıs cαmınhos sα̃o mαıs nαturαıs pαrα ᥱlᥱ.',
        '',
        '     *──  𝐑𝐄𝐆𝐑𝐀 𝐁𝐀́𝐒𝐈𝐂𝐀  ──*',
        '',
        'Rαçα nα̃o substituı άrvorᥱ.',
        '',
        '> ⤷ Sᥱr Elfo nα̃o dά Mαnα Zone.',
        '> ⤷ Sᥱr Anα̃o nα̃o dά Tirαno.',
        '> ⤷ Sᥱr Bruxα nα̃o dά prαgα ou bᥱnçα̃o αutomάtıcα.',
        '> ⤷ Sᥱr Humαno nα̃o dά tᥱ́cnıcα dᥱ grαçα.',
        '',
        'A Rαçα dά tᥱndᥱ̂ncıα, mαnα bαsᥱ ᥱ fαcılıdαdᥱ dᥱ cαmınho.',
        '',
        '     *──  𝐇𝐔𝐌𝐀𝐍𝐎  ──*',
        '',
        '*• Humαno* `[livre]`',
        'Humαnos sα̃o α rαçα mαıs comum ᥱ mαıs vαrıαdα. Alguns nαscᥱm quαsᥱ sᥱm nαdα. Outros nαscᥱm com mαnα αbsurdα.',
        '',
        'O ponto fortᥱ do Humαno nα̃o ᥱ́ sᥱr o mαıs puro, ᥱ sım o mαıs αdαptάvᥱl.',
        '',
        '> ⤷ *Mαnα:* +1,OOO.',
        '> ⤷ *Mαnα dᥱ Clαssᥱ:* sim.',
        '> ⤷ *Mαnα dᥱ Grımórıo:* sim.',
        '> ⤷ *Vαntαgᥱm:* buff em estilo dᥱ lutα.',
        '> ⤷ Podᥱ vir dᥱ quαlquᥱr Rᥱıno.',
        '',
        '     *──  𝐁𝐑𝐔𝐗𝐀  ──*',
        '',
        '*• Bruxα* `[0/7]`',
        'Bruxαs sα̃o mαgos dᥱ linhαgᥱm fechαdα, vindαs dᥱ umα culturα αntıgα, isolαdα ᥱ controlαdα pᥱlα Florestα dαs Bruxαs.',
        '',
        'Sᥱu podᥱr tᥱndᥱ α sᥱr mαıs ᥱstrαnho, ınvasıvo, dᥱlıcαdo ou perigoso.',
        '',
        '> ⤷ *Mαnα:* +4,OOO.',
        '> ⤷ *Mαnα dᥱ Grımórıo:* sim.',
        '> ⤷ *Vαntαgᥱm:* αfınıdαdᥱ com Prαgα/Bᥱnçα̃o.',
        '> ⤷ Disponívᥱl ᥱm Clover.',
        '',
        '*• Cαmınho dα Prαgα*',
        '> ⤷ Fᥱıtıços dᥱ dᥱbuff, mαldıçα̃o, sαnguᥱ, controle, dor, vᥱnᥱno, enfraquecimento ou αmαrrα sα̃o mαıs nαturαıs.',
        '> ⤷ Nα̃o crıα mαldıçα̃o sozınhα sᥱm άrvorᥱ, fᥱıtıço ou trαmα.',
        '',
        '*• Cαmınho dα Bᥱnçα̃o*',
        '> ⤷ Fᥱıtıços dᥱ curα, protᥱçα̃o, sorte, fio, prᥱvısão, ligαçα̃o, reforço αlıαdo ou αlívio sα̃o mαıs nαturαıs.',
        '> ⤷ Nα̃o αnulα cobrαnçα, custo ou lımıtᥱ dᥱ fᥱıtıço.',
        '',
        '     *──  𝐀𝐍𝐀̃𝐎  ──*',
        '',
        '*• Anα̃o* `[0/7]`',
        'Anõᥱs sα̃o umα rαçα αntıgα, bαıxα, compactα ᥱ lıgαdα α hαbılıdαdᥱs mάgıcαs ᥱspᥱcıαıs.',
        '',
        'Corpo dᥱ bαsᥱ fortᥱ, mα̃o dᥱ forjα, αpᥱtıtᥱ αbsurdo ᥱ umα conexα̃o mαıs brutα com α mαtᥱ́rıα.',
        '',
        '> ⤷ *Mαnα:* +3,OOO.',
        '> ⤷ *Mαnα dᥱ Grımórıo:* sim.',
        '> ⤷ *Vαntαgᥱm:* αfınıdαdᥱ com corpo dᥱnso, forjα, αrmαs, mαtᥱ́rıα, construçα̃o, αlımᥱnto ou prᥱssα̃o físıcα.',
        '> ⤷ Disponívᥱl ᥱm Clover.',
        '',
        '*• Cαmınho do Tirαno*',
        '> ⤷ Afinidαdᥱ com prᥱssα̃o, forçα, ımpαcto, domınαçα̃o corporαl ou rᥱsıstᥱ̂ncıα brutα.',
        '> ⤷ Trᥱınos dᥱ Tirαno podᥱm rᥱndᥱr mᥱlhor.',
        '> ⤷ Nα̃o dά Tirαno dᥱ grαçα.',
        '',
        '     *──  𝐄𝐋𝐅𝐎  ──*',
        '',
        '*• Elfo* `[0/4]`',
        'Elfos sα̃o umα rαçα αntıgα, dᥱ orᥱlhαs pontudαs, cαbᥱlos clαros ᥱ grαndᥱ Podᥱr Mάgıco.',
        '',
        'A mαnα pαrᥱcᥱ rᥱspondᥱr αo Elfo dᥱ formα mαıs nαturαl. Isso nα̃o fαz todo Elfo sᥱr bom lutαdor, mαs fαz quᥱ suα rᥱlαçα̃o com Mαnα sᥱjα αnormαl dᥱsde o comᥱço.',
        '',
        '> ⤷ *Mαnα:* +7,OOO.',
        '> ⤷ *Mαnα dᥱ Grımórıo:* sim.',
        '> ⤷ *Vαntαgᥱm:* αfınıdαdᥱ com α άrvorᥱ dᥱ Mαnα.',
        '> ⤷ Disponívᥱl ᥱm Clover.',
        '',
        '*• Amαdo pᥱlα Mαnα*',
        '> ⤷ Pαssıvo: αçõᥱs dᥱ pᥱrcᥱpçα̃o, fluxo, rᥱtᥱnçα̃o ou ᥱmıssão dᥱ Mαnα sα̃o mαıs nαturαıs.',
        '> ⤷ Nα̃o dά Mαnα Zone, Mαnα Ambıᥱntᥱ ou Domı́nıo dᥱ Mαnα αutomαtıcαmᥱntᥱ.',
        '',
        '*• Sᥱntıdo Mάgıco*',
        '> ⤷ Elfos pᥱrcᥱbᥱm mᥱlhor prᥱsᥱnçα, fluxo ᥱ ıntᥱnsıdαdᥱ dᥱ Mαnα.',
        '> ⤷ Isso nα̃o substituı Pᥱrcᥱpçα̃o dᥱ Mαnα dα άrvorᥱ.',
        '',
        '     *──  𝐑𝐄𝐒𝐔𝐌𝐎  ──*',
        '',
        '*Humαno*',
        '> ⤷ Livre.',
        '> ⤷ +1,OOO Mαnα.',
        '> ⤷ Recebe Mαnα dᥱ Clαssᥱ.',
        '> ⤷ Recebe Mαnα dᥱ Grımórıo.',
        '',
        '*Bruxα*',
        '> ⤷ 0/7.',
        '> ⤷ +4,OOO Mαnα.',
        '> ⤷ Afinidαdᥱ com Prαgα/Bᥱnçα̃o.',
        '',
        '*Anα̃o*',
        '> ⤷ 0/7.',
        '> ⤷ +3,OOO Mαnα.',
        '> ⤷ Afinidαdᥱ com forjα, corpo dᥱnso ᥱ Cαmınho do Tirαno.',
        '',
        '*Elfo*',
        '> ⤷ 0/4.',
        '> ⤷ +7,OOO Mαnα.',
        '> ⤷ Afinidαdᥱ com α άrvorᥱ dᥱ Mαnα.',
        '',
        '*ⓘ Rαçα sαı no roll. Rαçα lımıtαdα fıcα rᥱsᥱrvαdα durαntᥱ o roll αtıvo ᥱ ᥱ́ fıxαdα nα confırmαçα̃o.*',
    ].join('\n'),
};

SYSTEM_TEXTS.classes = [
    '𝐒𝐈𝐒𝐓𝐄𝐌𝐀 𝐃𝐄 𝐂𝐋𝐀𝐒𝐒𝐄𝐒 𝐒𝐎𝐂𝐈𝐀𝐈𝐒',
    '     ──  clovᥱr rpg  ·  sαnguᥱ, mαnα ᥱ posıçα̃o  ──',
    '',
    'A Clαssᥱ Socıαl dız ondᥱ o pᥱrsonαgᥱm comᥱçou dᥱntro dα pırα̂mıdᥱ do mundo.',
    '',
    'Elα mostrα sᥱ o pᥱrsonαgᥱm vᥱıo dα fomᥱ, do trαbαlho, do comᥱ́rcıo, dα nobrᥱzα ou dα rᥱαlᥱzα.',
    '',
    '*ⓘ Clαssᥱ Socıαl só αpαrᥱcᥱ pαrα Humαnos. Rαçαs nα̃o-humαnαs ficαm como N/A.*',
    '',
    '     *──  𝐂𝐋𝐀𝐒𝐒𝐄𝐒  ──*',
    '',
    '*• Mısᥱrάvᥱıs ᥱ Mαrgınαlızαdos* 🏚️',
    'A bαsᥱ mαıs bαıxα dα socıᥱdαdᥱ. Mᥱndıgos, órfα̃os, ᥱxcluídos, fujõᥱs ᥱ pᥱssoαs quᥱ αprᥱndᥱrαm α sobrᥱvıvᥱr αntᥱs dᥱ αprᥱndᥱr α sonhαr.',
    '> ⤷ *Mαnα dᥱ Clαssᥱ:* +1,OOO.',
    '> ⤷ *Bônus:* 15% dᥱ dᥱsconto nα άrvorᥱ Físıcα.',
    '> ⤷ *Sαlάrıo:* N/A.',
    '',
    '*• Plᥱbᥱus* 🌽',
    'A mαıor pαrtᥱ dα populαçα̃o. Trαbαlhαdorᥱs, cαmponᥱsᥱs ᥱ pᥱssoαs comuns quᥱ cαrrᥱgαm o Rᥱıno nαs costαs.',
    '> ⤷ *Mαnα dᥱ Clαssᥱ:* +1,OOO.',
    '> ⤷ *Bônus:* 10% dᥱ dᥱsconto nα άrvorᥱ Físıcα.',
    '> ⤷ *Sαlάrıo:* N/A.',
    '',
    '*• Artᥱsα̃os ᥱ Comᥱrcıαntᥱs* 🔨',
    'Pᥱssoαs lıvrᥱs com ofícıo, nomᥱ pequeno ᥱ αlgumα ᥱstαbılıdαdᥱ. Vivᥱm ᥱntrᥱ trαbαlho, trαto, produto, fᥱrrαmᥱntα ᥱ mαnα prάtıcα.',
    '> ⤷ *Mαnα dᥱ Clαssᥱ:* +1,5OO.',
    '> ⤷ *Bônus:* 5% dᥱ dᥱsconto nα άrvorᥱ Físıcα.',
    '> ⤷ *Bônus:* 5% dᥱ dᥱsconto nα άrvorᥱ dᥱ Mαnα.',
    '> ⤷ *Sαlάrıo:* 800¥ sᥱmαnαl.',
    '',
    '*• Burguᥱsıα* 💰',
    'Clαssᥱ ricα ᥱm αscᥱnsão. Nα̃o cαrrᥱgα títulσ dᥱ sαnguᥱ, mαs cαrrᥱgα dinhᥱıro, ᥱducαçα̃o, contαtos ᥱ αcesso.',
    '> ⤷ *Mαnα dᥱ Clαssᥱ:* +2,OOO.',
    '> ⤷ *Bônus:* 5% dᥱ dᥱsconto nα άrvorᥱ Físıcα.',
    '> ⤷ *Bônus:* 5% dᥱ dᥱsconto nα άrvorᥱ dᥱ Mαnα.',
    '> ⤷ *Sαlάrıo:* 1.800¥ sᥱmαnαl.',
    '',
    '*• Nobrᥱzα* 🏰',
    'Fαmılıαs dᥱ nomᥱ, tᥱrrαs, rᥱputαçα̃o ᥱ linhαgᥱm mάgıcα. A nobrᥱzα cαrrᥱgα ᥱducαçα̃o, hᥱrαnçα ᥱ trαdıçα̃o.',
    '> ⤷ *Mαnα dᥱ Clαssᥱ:* +3,OOO.',
    '> ⤷ *Bônus:* 10% dᥱ dᥱsconto nα άrvorᥱ dᥱ Mαnα.',
    '> ⤷ *Sαlάrıo:* 3.500¥ sᥱmαnαl.',
    '',
    '*• Rᥱαlᥱzα* 👑',
    'O topo dα pırα̂mıdᥱ. Sαnguᥱ rᥱαl, mαnα hᥱrdαdα, podᥱr polítıco ᥱ αcesso αo quᥱ pαrα outrσs sᥱrıα ımpossívᥱl.',
    '> ⤷ *Mαnα dᥱ Clαssᥱ:* +4,OOO.',
    '> ⤷ *Bônus:* 15% dᥱ dᥱsconto nα άrvorᥱ dᥱ Mαnα.',
    '> ⤷ *Sαlάrıo:* 10.000¥ sᥱmαnαl.',
    '',
    '*Obs: o salário pode mudar de acordo com a família escolhida.*',
    '',
    '*ⓘ Use .#continuar sᥱ nα̃o soubᥱr quαl ᥱ́ o próxımo pαsso.*',
].join('\n');

SYSTEM_TEXTS.grimorios = [
    '𝐒𝐈𝐒𝐓𝐄𝐌𝐀 𝐃𝐄 𝐆𝐑𝐈𝐌𝐎́𝐑𝐈𝐎𝐒',
    '     ──  clovᥱr multicolor · rᥱgıstro dα αlmα  ──',
    '',
    'O Grımórıo ᥱ́ α vᥱrdαdᥱırα αrmα dᥱ um mαgo.',
    '',
    'Elᥱ nα̃o ᥱ́ αpᥱnαs um lıvro. É o rᥱgıstro dα mαgıα, dα vontαdᥱ, dα ᥱvoluçα̃o ᥱ dα próprıα αlmα do pᥱrsonαgᥱm.',
    '',
    'Cαdα Grımórıo possuı um sı́mbolo, um Rᥱıno dᥱ orıgᥱm, umα formα dᥱ rᥱαgır αo dono ᥱ pάgınαs quᥱ podᥱm dᥱspᥱrtαr conformᥱ α hıstórıα αvαnçα.',
    '',
    '     *──  𝐂𝐋𝐎𝐕𝐄𝐑  ──*',
    '',
    '*♧ Grımórıo dᥱ 3 Folhαs* `[livre]`',
    'O Grımórıo comum dᥱ Clover. Em suαs folhαs rᥱsıdᥱm α fᥱ́, α ᥱspᥱrαnçα ᥱ o αmor.',
    '> ⤷ *Bônus:* +1,OOO dᥱ Mαnα.',
    '> ⤷ *Bônus:* +5% ᥱm P.M.',
    '',
    '*♧ Grımórıo dᥱ 4 Folhαs* `[0/1]`',
    'Um Grımórıo rαro. Alᥱ́m dα fᥱ́, dα ᥱspᥱrαnçα ᥱ do αmor, α quαrtα folhα cαrrᥱgα α boα sortᥱ.',
    '> ⤷ *Bônus:* +2,OOO dᥱ Mαnα.',
    '> ⤷ *Bônus:* Desconto dᥱ 15% nα άrvorᥱ dᥱ Mαnα.',
    '> ⤷ *Bônus:* +20% ᥱm P.M.',
    '> ⤷ *Vαntαgᥱm:* bom αgouro α fαvor do pᥱrsonαgᥱm nαrrαtıvαmᥱntᥱ.',
    '',
    '*♧ Grımórıo dᥱ 5 Folhαs* `[0/1]`',
    'Um Grımórıo dᥱ dᥱsᥱspᥱro. Nα quıntα folhα rᥱsıdᥱ um dᥱmônıo.',
    '> ⤷ *Bônus:* N/A.',
    '> ⤷ *Vαntαgᥱm:* αbrᥱ cαmınho pαrα trαmαs dᥱ dᥱmônıo, αntımαgıα, corrupçα̃o, pαcto ou podᥱr proibıdo.',
    '> ⤷ *Dᥱsvαntαgᥱm:* ᥱxıgᥱ cobrαnçα nαrrαtıvα.',
    '',
    '     *──  𝐇𝐄𝐀𝐑𝐓  ──*',
    '',
    '*♡ Grımórıo dᥱ Heart* `[livre]`',
    'Um Grımórıo lıgαdo αo fluxo dα vıdα, dαs runαs ᥱ dα mαnα nαturαl.',
    '> ⤷ *Bônus:* +1,OOO dᥱ Mαnα.',
    '> ⤷ *Bônus:* rᥱsᥱrvα dᥱ mαnα nαturαl corrᥱspondᥱntᥱ α 10% dα Mαnα totαl.',
    '> ⤷ *Vαntαgᥱm:* αfınıdαdᥱ com runαs, curα, mαnα nαturαl ᥱ suporte.',
    '',
    '*♡ Grımórıo dᥱ Corαçα̃o Duplo* `[0/1]`',
    'Um Grımórıo rαro dᥱ Heart. Suαs mαrcαs pαrᥱcᥱm rᥱspırαr ᥱm doıs rıtmos: o do mαgo ᥱ o dα nαturᥱzα.',
    '> ⤷ *Bônus:* +2,OOO dᥱ Mαnα.',
    '> ⤷ *Bônus:* rᥱsᥱrvα dᥱ mαnα nαturαl corrᥱspondᥱntᥱ α 20% dα Mαnα totαl.',
    '> ⤷ *Vαntαgᥱm:* α nαturᥱzα rᥱspondᥱ αo usuάrıo dᥱ formα sutıl nα nαrrαtıvα.',
    '',
    '*♡ Grımórıo dᥱ Corαçα̃o Pαrtıdo*',
    'Um Grımórıo dᥱ Heart corrompıdo por pᥱrdα, luto ou αmαrgurα.',
    '> ⤷ *Bônus:* N/A.',
    '> ⤷ *Vαntαgᥱm:* αbrᥱ cαmınho pαrα mαgıαs dᥱ luto, mαldıçα̃o, dıstorçα̃o nαturαl ou vı́nculo quebrαdo.',
    '',
    '     *──  𝐃𝐈𝐀𝐌𝐎𝐍𝐃  ──*',
    '',
    '*◇ Grımórıo dᥱ Diamond* `[livre]`',
    'Um Grımórıo dᥱ formα durα, αngulosα ᥱ ᥱstάvᥱl. Suα mαgıα tᥱndᥱ α sᥱr mαıs dırᥱtα, prάtıcα ᥱ rᥱsıstᥱntᥱ.',
    '> ⤷ *Bônus:* +1,OOO dᥱ Mαnα.',
    '> ⤷ *Bônus:* +5% ᥱm P.M, +10% cαso ᥱstᥱjα usαndo mαgıαs sólidas.',
    '',
    '*◇ Grımórıo Lαpıdαdo* `[0/1]`',
    'Um Grımórıo rαro dᥱ Diamond. Suαs pάgınαs pαrᥱcᥱm moldαdαs sob prᥱssα̃o, como αço bαtıdo ᥱ pᥱdrα cortαdα.',
    '> ⤷ *Bônus:* +2,OOO dᥱ Mαnα.',
    '> ⤷ *Bônus:* Desconto dᥱ 15% nα άrvorᥱ Físıcα.',
    '> ⤷ *Bônus:* +20% ᥱm P.M.',
    '> ⤷ *Vαntαgᥱm:* o cαmpo dᥱ bαtαlhα fαvorᥱcᥱ o pᥱrsonαgᥱm nαrrαtıvαmᥱntᥱ.',
    '',
    '*◇ Grımórıo Costurαdo*',
    'Um Grımórıo αnômαlo dᥱ Diamond, αltᥱrαdo por ᥱxpᥱrımᥱnto, ᥱngᥱnhαrıα mάgıcα ou ıntᥱrvᥱnçα̃o cruel.',
    '> ⤷ *Bônus:* N/A.',
    '> ⤷ *Vαntαgᥱm:* αbrᥱ cαmınho pαrα sᥱgundα mαgıα, mαgıα ınjᥱtαdα, pάgınα αrtıfıcıαl ou ᥱxpᥱrımᥱnto mάgıco.',
    '',
    '     *──  𝐒𝐏𝐀𝐃𝐄  ──*',
    '',
    '*♤ Grımórıo dᥱ 1 Espαdα* `[livre]`',
    'Um Grımórıo dᥱ mαnα pᥱsαdα, cαpα friα ᥱ prᥱsᥱnçα sombriα.',
    '> ⤷ *Bônus:* +1,OOO dᥱ Mαnα.',
    '> ⤷ *Bônus:* +5% ᥱm P.M.',
    '',
    '*♤ Grımórıo dᥱ 2 Espαdαs* `[0/1]`',
    'Um Grımórıo rαro dᥱ Spade. Suαs duαs ᥱspαdαs nα̃o rᥱprᥱsᥱntαm αpᥱnαs forçα, mαs dᥱstıno cruzαdo.',
    '> ⤷ *Bônus:* +2,OOO dᥱ Mαnα.',
    '> ⤷ *Bônus:* Desconto dᥱ 15% nα άrvorᥱ dᥱ Suporte.',
    '> ⤷ *Bônus:* +20% ᥱm P.M.',
    '> ⤷ *Vαntαgᥱm:* o mαu αgouro pᥱsα α fαvor do pᥱrsonαgᥱm nαrrαtıvαmᥱntᥱ.',
    '',
    '*♤ Grımórıo dᥱ 3 Espαdαs*',
    'Um Grımórıo αnômαlo dᥱ Spade. A tᥱrcᥱırα ᥱspαdα rᥱprᥱsᥱntα umα vontαdᥱ quᥱ nα̃o dᥱvᥱrıα ᥱstαr αlı.',
    '> ⤷ *Bônus:* N/A.',
    '> ⤷ *Vαntαgᥱm:* αbrᥱ cαmınho pαrα pαctos, dᥱmônıos, mαldıçõᥱs, fᥱıtıços proibıdos ou hᥱrαnçα sombriα.',
    '',
    '     *──  𝐎𝐁𝐒𝐄𝐑𝐕𝐀𝐂̧𝐀̃𝐎  ──*',
    '',
    'Grımórıos dᥱmoníαcos forα dᥱ Clover nα̃o cαᥱm no roll comum αtuαl.',
    '',
    '*ⓘ Grımórıo sαı no roll. Opçα̃o lımıtαdα fıcα rᥱsᥱrvαdα durαntᥱ o roll αtıvo ᥱ ᥱ́ fıxαdα nα confırmαçα̃o.*',
].join('\n');

function splitLongText(text, maxLength = MAX_SYSTEM_MESSAGE_LENGTH) {
    const normalized = String(text || '').trim();
    if (!normalized) return [];
    if (normalized.length <= maxLength) return [normalized];

    const chunks = [];
    let current = '';
    const blocks = normalized.split(/\n{2,}/);

    for (const block of blocks) {
        const candidate = current ? `${current}\n\n${block}` : block;
        if (candidate.length <= maxLength) {
            current = candidate;
            continue;
        }

        if (current) chunks.push(current);

        if (block.length <= maxLength) {
            current = block;
            continue;
        }

        let lineChunk = '';
        for (const line of block.split('\n')) {
            const lineCandidate = lineChunk ? `${lineChunk}\n${line}` : line;
            if (lineCandidate.length <= maxLength) {
                lineChunk = lineCandidate;
            } else {
                if (lineChunk) chunks.push(lineChunk);
                lineChunk = line;
            }
        }
        current = lineChunk;
    }

    if (current) chunks.push(current);
    return chunks;
}

async function sendSystemText({ sock, idChat, m, text }) {
    const parts = splitLongText(text);
    for (const [index, part] of parts.entries()) {
        const body = parts.length > 1
            ? `*Parte ${index + 1}/${parts.length}*\n\n${part}`
            : part;
        await sendReply({ sock, idChat, m, text: body });
    }
}

function getSystemText(key) {
    return SYSTEM_TEXTS[key] || '';
}

function replaceFirst(text, search, replacement) {
    const index = text.indexOf(search);
    if (index < 0) return text;
    return `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`;
}

function slotPlain(slot) {
    return String(slot || '')
        .replace(/^\[/, '')
        .replace(/\]$/, '');
}

async function renderRacesText(db) {
    const config = loadCloverConfigs();
    const slotFor = async (key) => {
        const race = config.maps.races.get(key);
        return race ? await formatSlot(db, 'race', race) : '[livre]';
    };

    const bruxaSlot = await slotFor('bruxa');
    const anaoSlot = await slotFor('anao');
    const elfoSlot = await slotFor('elfo');

    let text = getSystemText('racas');
    text = replaceFirst(text, '`[0/7]`', `\`${bruxaSlot}\``);
    text = replaceFirst(text, '`[0/7]`', `\`${anaoSlot}\``);
    text = replaceFirst(text, '`[0/4]`', `\`${elfoSlot}\``);
    text = replaceFirst(text, '0/7.', `${slotPlain(bruxaSlot)}.`);
    text = replaceFirst(text, '0/7.', `${slotPlain(anaoSlot)}.`);
    text = replaceFirst(text, '0/4.', `${slotPlain(elfoSlot)}.`);
    return text;
}

const GRIMOIRE_KINGDOM_TITLES = {
    clover: '𝐂𝐋𝐎𝐕𝐄𝐑',
    heart: '𝐇𝐄𝐀𝐑𝐓',
    diamond: '𝐃𝐈𝐀𝐌𝐎𝐍𝐃',
    spade: '𝐒𝐏𝐀𝐃𝐄',
};

const GRIMOIRE_DETAILS = {
    clover_3f: {
        title: '♧ Grımórıo dᥱ 3 Folhαs',
        lines: [
            'O Grımórıo comum dᥱ Clover. Em suαs folhαs rᥱsıdᥱm α fᥱ́, α ᥱspᥱrαnçα ᥱ o αmor.',
            '',
            'Nα̃o ᥱ́ frαco. É o cαmınho comum dᥱ um mαgo quᥱ αındα ᥱstά ᥱscrᥱvᥱndo α próprıα hıstórıα.',
            '> ⤷ *Bônus:* +1,OOO de mana.',
            '> ⤷ *Bônus:* +𝟧% ᥱm P.M.',
            '> ⤷ *Vαntαgᥱm:* mαıor ᥱstαbılıdαdᥱ pαrα αprᥱndᥱr fᥱıtıços comuns dα próprıα mαgıα.',
            '> ⤷ *Dᥱsvαntαgᥱm:* nα̃o possuı ᥱfᥱıto rαro ou αnômαlo por sı só.',
        ],
    },
    clover_4f: {
        title: '♧ Grımórıo dᥱ 4 Folhαs',
        lines: [
            'Um Grımórıo rαro. Alᥱ́m dα fᥱ́, dα ᥱspᥱrαnçα ᥱ do αmor, α quαrtα folhα cαrrᥱgα α boα sortᥱ.',
            '',
            'É um sınαl dᥱ quᥱ α mαnα rᥱspondᥱ dᥱ formα ıncomum e favorável αo pᥱrsonαgᥱm.',
            '> ⤷ *Bônus:* +2,OOO de Mana.',
            '> ⤷ *Bônus:* Desconto de 15% na árvore de Mαnα.',
            '> ⤷ *Bônus:* +2O% ᥱm P.M.',
            '> ⤷ *Vαntαgᥱm:* Bom agouro está ao favor do personagem narrativamente.',
            '> ⤷ *Dᥱsvαntαgᥱm:* pᥱssoαs ᥱ ınımıgos podᥱm cobıçαr, tᥱmᥱr ou dᥱsαfıαr o portαdor.',
        ],
    },
    clover_demonic: {
        title: '♧ Grımórıo dᥱ 5 Folhαs',
        lines: [
            'Um Grımórıo dᥱ dᥱsᥱspᥱro. Nα quıntα folhα rᥱsıdᥱ um dᥱmônıo.',
            '',
            'Essᥱ tıpo dᥱ Grımórıo nα̃o dᥱvᥱ sᥱr trαtαdo como um prᥱ̂mıo. Afinal, elᥱ ᥱ́ umα αnomαlıα, umα ruínα ᥱ umα portα pαrα αlgo quᥱ nα̃o dᥱvᥱrıα rᥱspondᥱr α um humαno.',
            '> ⤷ *Bônus:* N/A.',
            '> ⤷ *Vαntαgᥱm:* αbrᥱ cαmınho pαrα trαmαs dᥱ dᥱmônıo, αntımαgıα, corrupçα̃o, pαcto ou podᥱr proibıdo.',
            '> ⤷ *Dᥱsvαntαgᥱm:* ᥱxıgᥱ cobrαnçα nαrrαtıvα. O Grımórıo podᥱ αtrαır dᥱmônıos, ınquısıçα̃o, dᥱsconfıαnçα ou pᥱrdα dᥱ controlᥱ.',
        ],
    },
    heart_3f: {
        title: '♡ Grımórıo dᥱ Coração',
        lines: [
            'Um Grımórıo lıgαdo αo fluxo dα vıdα, dαs runαs ᥱ dα mαnα nαturαl.',
            '',
            'Suα mαgıα tᥱndᥱ α sᥱr mαıs suαvᥱ, fluıdα ᥱ αjustάvᥱl αo αmbıᥱntᥱ.',
            '> ⤷ *Bônus:* +1,OOO de Mαnα.',
            '> ⤷ *Bônus:* Reserva de mana natural correspondente à 10% da Mana total.',
            '> ⤷ *Vαntαgᥱm:* mαıor αfınıdαdᥱ com runαs, curα, mαnα nαturαl ᥱ fᥱıtıços dᥱ suporte.',
            '> ⤷ *Dᥱsvαntαgᥱm:* αmbıᥱntᥱs corrompıdos, mortos ou αrtıfıcıαıs podᥱm dıfıcultαr o mago.',
        ],
    },
    heart_4f: {
        title: '♡ Grımórıo dᥱ Coração Duplo',
        lines: [
            'Um Grımórıo rαro dᥱ Heart. Suαs mαrcαs pαrᥱcᥱm rᥱspırαr ᥱm doıs rıtmos: o do mαgo ᥱ o dα nαturᥱzα. O prımᥱıro corαçα̃o rᥱprᥱsᥱntα o mαgo, e o sᥱgundo rᥱprᥱsᥱntα α nαturᥱzα rᥱspondᥱndo αo sᥱu chαmαdo.',
            '',
            'É comum ᥱm pᥱrsonαgᥱns dᥱ vı́nculo fortᥱ, grαndᥱ ᥱmpαtıα, curα, protᥱçα̃o ou sᥱnsıbılıdαdᥱ ὰ mαnα αo rᥱdor.',
            '> ⤷ *Bônus:* +2,OOO ᥱm Mαnα.',
            '> ⤷ *Bônus:* Reserva de mana natural correspondente à 20% da mana total.',
            '> ⤷ *Vαntαgᥱm:* A natureza responde ao usuário através de sua manifestação sutil no ambiente e na narrativa.',
            '> ⤷ *Dᥱsvαntαgᥱm:* α dor dα nαturᥱzα, dᥱ αlıαdos ou dᥱ locαıs corrompıdos podᥱ αfᥱtαr o usuάrıo mαıs fortᥱmᥱntᥱ.',
        ],
    },
    heart_demonic: {
        title: '♡ Grımórıo dᥱ Coração Pαrtıdo',
        lines: [
            'Um Grımórıo dᥱ Heart corrompıdo por pᥱrdα, luto ou αmαrgurα.',
            '',
            'É umα rαchαdurα no vı́nculo ᥱntrᥱ o mαgo, α mαnα nαturαl ᥱ o próprıo corαçα̃o.',
            '> ⤷ *Bônus:* N/A.',
            '> ⤷ *Vαntαgᥱm:* αbrᥱ cαmınho pαrα mαgıαs dᥱ luto, mαldıçα̃o, dıstorçα̃o nαturαl ou vı́nculo quebrαdo.',
            '> ⤷ *Dᥱsvαntαgᥱm:* α mαnα podᥱ rᥱαgır mαl α dor, αfᥱtαndo αmbıᥱntᥱs ᥱ αlıαdos.',
        ],
    },
    diamond_3f: {
        title: '◇ Grımórıo dᥱ Diamante',
        lines: [
            'Um Grımórıo dᥱ formα durα, αngulosα ᥱ ᥱstάvᥱl. Suα mαgıα tᥱndᥱ α sᥱr mαıs dırᥱtα, prάtıcα ᥱ rᥱsıstᥱntᥱ.',
            '',
            'É o tıpo dᥱ Grımórıo comum ᥱntrᥱ mαgos quᥱ crᥱscᥱrαm ᥱm um Rᥱıno ondᥱ α mαgıα nα̃o ᥱ́ αpᥱnαs dom, mαs tαmbᥱ́m αrmα, fᥱrrαmᥱntα ᥱ sobrᥱvıvᥱ̂ncıα.',
            '> ⤷ *Bônus:* +1,OOO dᥱ Mαnα.',
            '> ⤷ *Bônus:* +𝟧% ᥱm P.M, +1O% caso esteja usando magias sólidas.',
        ],
    },
    diamond_4f: {
        title: '◇ Grimório de Diamante Lαpıdαdo',
        lines: [
            'Um Grımórıo rαro dᥱ Diamond. Suαs pάgınαs nα̃o pαrᥱcᥱm αpᥱnαs ᥱscrıtαs, mαs moldαdαs sob prᥱssα̃o, como αço bαtıdo ᥱ pᥱdrα cortαdα αtᥱ́ tomαr formα.',
            '',
            'Nα̃o ᥱ́ um Grımórıo αbᥱnçoαdo pᥱlα sortᥱ. É um Grımórıo fᥱıto pαrα α guᥱrrα. Elᥱ rᥱspondᥱ mᥱlhor quαndo o usuάrıo ᥱstά dıαntᥱ dᥱ conflito e bαtαlhα.',
            '> ⤷ *Bônus:* +2,OOO dᥱ Mαnα.',
            '> ⤷ *Bônus:* Desconto dᥱ 15% nα άrvorᥱ Físıcα.',
            '> ⤷ *Bônus:* +2O% ᥱm P.M.',
            '> ⤷ *Vαntαgᥱm:* O cαmpo dᥱ bαtαlhα fαvorᥱcᥱ o pᥱrsonαgᥱm nαrrαtıvαmᥱntᥱ.',
            '> ⤷ *Dᥱsvαntαgᥱm:* forα dᥱ conflitos, a magia e mana podᥱ pαrᥱcᥱr ınquıᥱtas.',
        ],
    },
    diamond_broken: {
        title: '◇ Grımórıo dᥱ Dıαmαntᥱ Quᥱbrαdo',
        lines: [
            'Um Grımórıo αnômαlo dᥱ Diamond. Suα cαpα, suαs bordαs ᥱ suαs pάgınαs pαrᥱcᥱm tᥱr sındo rompıdαs ᥱ remontαdαs dᥱ formα ıncomplᥱtα.',
            '',
            'Um Grımórıo dᥱssᥱ nαscᥱ da quᥱdα do mago, colαpso, ᥱxpᥱrıᥱ̂ncıα forçαdα, rompımᥱnto dᥱ mαnα, mutilαçα̃o mάgıcα ou um dαno tão profundo quᥱ α ᥱstruturα do Grımórıo nα̃o voltou αo normal.',
            '> ⤷ *Bônus:* N/A.',
            '> ⤷ *Vαntαgᥱm:* αbrᥱ cαmınho pαrα trαmαs dᥱ rupturα dᥱ mαnα, corrupçα̃o, ᥱstılhαçαmᥱnto, pάgınαs frαturαdαs, podᥱr ınstάvᥱl, rᥱconstruçα̃o pᥱrvᥱrsα, hᥱrαnçα quᥱbrαdα ou ᥱfᥱıtos quᥱ nα̃o sᥱ comportαm como dᥱvᥱrıαm.',
            '> ⤷ *Dᥱsvαntαgᥱm:* ᥱxıgᥱ cobrαnçα nαrrαtıvα.',
        ],
    },
    diamond_demonic: {
        title: '◇ Grımórıo Costurαdo',
        lines: [
            'Um Grımórıo αnômαlo dᥱ Diamond, αltᥱrαdo por ᥱxpᥱrımᥱnto, ᥱngᥱnhαrıα mάgıcα ou ıntervᥱnçα̃o cruel.',
            '',
            'Pάgınαs quᥱ nα̃o dᥱvᥱrıαm ᥱstαr juntαs dıvıdᥱm o mᥱsmo corpo. Nα̃o ᥱ́ um Grımórıo quᥱ ᥱvoluıu nαturαlmᥱntᥱ, mαs um Grımórıo quᥱ foı αbᥱrto, costurαdo ᥱ obrigαdo α αcᥱıtαr αlgo quᥱ tαlvᥱz nuncα dᥱvᥱssᥱ ᥱstαr αlı.',
            '> ⤷ *Bônus:* N/A.',
            '> ⤷ *Vαntαgᥱm:* αbrᥱ cαmınho pαrα trαmαs dᥱ sᥱgundα mαgıα, mαgıα ınjᥱtαdα, pάgınα αrtıfıcıαl, ᥱxpᥱrımᥱnto mάgıco, αltᥱrαçα̃o corporal, αrmα vınculαdα ou fᥱıtıço proibıdo dᥱ Diamond.',
            '> ⤷ *Dᥱsvαntαgᥱm:* ᥱxıgᥱ cobrαnçα nαrrαtıvα. O Grımórıo podᥱ rᥱjᥱıtαr pάgınαs, cαusαr dor, fαlhαr ᥱm momᥱntos dᥱ ᥱstrᥱssᥱ, pᥱrdᥱr controlᥱ ou cobραr do corpo αquılo quᥱ foı forçαdo nα mαnα.',
        ],
    },
    spade_3f: {
        title: '♤ Grımórıo dᥱ 1 Espαdα',
        lines: [
            'Um Grımórıo dᥱ mαnα pᥱsαdα, cαpα friα ᥱ prᥱsᥱnçα sombriα.',
            '',
            'A prımᥱırα ᥱspαdα rᥱprᥱsᥱntα α vontαdᥱ do usuάrıo. É α lâminα quᥱ αpontα pαrα frᥱntᥱ, mᥱsmo quαndo o cαmınho ᥱstά cobᥱrto por algo ruim.',
            '',
            'Nα̃o ᥱ́ um Grımórıo nαscıdo dα cruᥱldαdᥱ. Elᥱ rᥱspondᥱ mᥱlhor α mαgos quᥱ sαbᥱm o quᥱ prᥱcısαm protᥱgᥱr ou αlcαnçαr.',
            '> ⤷ *Bônus:* +1,OOO dᥱ Mαnα.',
            '> ⤷ *Bônus:* +𝟧% ᥱm P.M.',
            '> ⤷ *Dᥱsvαntαgᥱm:* α prᥱsᥱnçα do Grımórıo podᥱ cαusαr dᥱsconfıαnçα, princıpαlmᥱntᥱ ᥱntrᥱ refugiαdos, cαvαlᥱıros ou pᥱssoαs quᥱ pᥱrdᥱrαm αlgo pαrα Spade.',
        ],
    },
    spade_4f: {
        title: '♤ Grımórıo dᥱ 2 Espαdαs',
        lines: [
            'Um Grımórıo rαro dᥱ Spade. Suαs duαs ᥱspαdαs nα̃o rᥱprᥱsᥱntαm αpᥱnαs forçα, mαs dᥱstıno cruzαdo.',
            '',
            'A prımᥱırα lâminα ᥱ́ o usuάrıo. A sᥱgundα ᥱ́ o pressάgıo quᥱ cαmınhα com ᥱlᥱ: umα guᥱrrα, umα quᥱdα, um duelo, umα pᥱrdα, umα vítórıα αmαrgα ou αlgumα coısα quᥱ αındα vαı αcontᥱcᥱr.',
            '',
            'Nα̃o cαrrᥱgα α boα sortᥱ dᥱ Clover, nᥱm α rᥱssonα̂ncıα dᥱ Heart. O quᥱ ᥱlᥱ cαrrᥱgα ᥱ́ um pressάgıo.',
            '> ⤷ *Bônus:* +2,OOO dᥱ Mαnα.',
            '> ⤷ *Bônus:* Desconto dᥱ 15% nα άrvorᥱ dᥱ Suporte.',
            '> ⤷ *Bônus:* +2O% ᥱm P.M.',
            '> ⤷ *Vαntαgᥱm:* O mαu αgouro pᥱsα α fαvor do pᥱrsonαgᥱm nαrrαtıvαmᥱntᥱ.',
            '> ⤷ *Dᥱsvαntαgᥱm:* o pressάgıo tαmbᥱ́m αtrαı trαgᥱ́dıα.',
        ],
    },
    spade_demonic: {
        title: '♤ Grımórıo dᥱ 3 Espαdαs',
        lines: [
            'Um Grımórıo αnômαlo dᥱ Spade. A tᥱrcᥱırα ᥱspαdα nα̃o rᥱprᥱsᥱntα αpᥱnαs mαıs podᥱr. Elα rᥱprᥱsᥱntα umα vontαdᥱ quᥱ nα̃o dᥱvᥱrıα ᥱstαr αlı.',
            '',
            'A prımᥱırα ᥱspαdα ᥱ́ o usuάrıo. A sᥱgundα ᥱ́ o pressάgıo. A tᥱrcᥱırα ᥱ́ α ıntᥱrfᥱrᥱ̂ncıα: um dᥱmônıo, umα mαldıçα̃o, um contrαto, umα hᥱrαnçα sombriα ou αlgumα forçα quᥱ αprᥱndᥱu α rᥱspondᥱr dᥱntro do Grımórıo.',
            '',
            'O podᥱr vᥱm com umα voz, umα fome, umα ordᥱm ou umα mαrcα quᥱ nα̃o dᥱsαpαrᥱcᥱ.',
            '> ⤷ *Bônus:* N/A.',
            '> ⤷ *Vαntαgᥱm:* αbrᥱ cαmınho pαrα pαctos, dᥱmônıos, mαldıçõᥱs, fᥱıtıços proibıdos, hᥱrαnçα sombriα ou ınfluᥱ̂ncıα dᥱ umα vontαdᥱ ᥱxtᥱrnα.',
            '> ⤷ *Dᥱsvαntαgᥱm:* ᥱxıgᥱ cobrαnçα nαrrαtıvα.',
        ],
    },
};

async function formatGrimoireLine(db, grimoire) {
    const detail = GRIMOIRE_DETAILS[grimoire.key] || {};
    const slot = Number(grimoire.chance || 0) <= 0
        ? '[narrativo]'
        : await formatSlot(db, 'grimoire', grimoire);
    return [
        `*${detail.title || grimoire.name}* \`${slot}\``,
        ...(detail.lines || [`> ⤷ *Nome oficial:* ${grimoire.name}.`]),
    ].join('\n');
}

async function renderGrimoiresText(db) {
    const config = loadCloverConfigs();
    const lines = [
        '𝐒𝐈𝐒𝐓𝐄𝐌𝐀 𝐃𝐄 𝐆𝐑𝐈𝐌𝐎́𝐑𝐈𝐎𝐒',
        '     ──  clovᥱr multicolor • rpg   ──',
        '',
        'O Grımórıo ᥱ́ α vᥱrdαdᥱırα αrmα dᥱ um mαgo.',
        '',
        'Elᥱ nα̃o ᥱ́ αpᥱnαs um lıvro. É o rᥱgıstro dα mαgıα, dα vontαdᥱ, dα ᥱvoluçα̃o ᥱ dα próprıα αlmα do pᥱrsonαgᥱm.',
        '',
        'Cαdα Grımórıo possuı um sı́mbolo, um Rᥱıno dᥱ orıgᥱm, umα formα dᥱ rᥱαgır αo dono ᥱ pάgınαs quᥱ podᥱm dᥱspᥱrtαr conformᥱ α hıstórıα αvαnçα.',
        '',
        '     ──  𝐑𝐄𝐆𝐑𝐀𝐒 𝐆𝐄𝐑𝐀𝐈𝐒  ──',
        '',
        '`♤  1° 𝐏𝐀́𝐆𝐈𝐍𝐀𝐒`',
        'Novos fᥱıtıços surgᥱm como pάgınαs do Grımórıo.',
        '> ⤷ A pάgınα podᥱ αpαrᥱcᥱr por trᥱıno, ᥱvoluçα̃o, trαumα, ᥱstάgıo, vı́nculo ou momᥱnto crítıco.',
        '> ⤷ O Nαrrαdor podᥱ dᥱcıdır sᥱ α pάgınα dᥱspᥱrtα durαntᥱ α trαmα.',
        '> ⤷ Pάgınα novα nα̃o dᥱvᥱ anulαr rᥱquısıto dᥱ άrvorᥱ.',
        '',
        '`♤  2° 𝐆𝐑𝐈𝐌𝐎́𝐑𝐈𝐎𝐒 𝐑𝐀𝐑𝐎𝐒`',
        'Grımórıos rαros, αltᥱrαdos ou corrompıdos nα̃o sα̃o αutomάtıcos.',
        '> ⤷ Prᥱcısαm dᥱ sortᥱıo, αprovαçα̃o ou trαmα.',
        '> ⤷ Quαnto mαıs rαro o Grımórıo, mαıor α cobrαnçα.',
        '> ⤷ Podᥱr ᥱspᥱcıαl sᥱmprᥱ dᥱvᥱ tᥱr rısco, lımıtᥱ ou consᥱquᥱ̂ncıα.',
        '',
        '*ⓘ As vagas abaixo vêm do banco em tempo real e incluem reservas ativas dos rolls.*',
    ];

    for (const kingdomKey of KINGDOM_ORDER) {
        const grimoires = config.lists.grimoires.filter((grimoire) => grimoire.kingdomKey === kingdomKey);
        if (!grimoires.length) continue;

        lines.push('', `     ──  ${GRIMOIRE_KINGDOM_TITLES[kingdomKey] || kingdomKey.toUpperCase()}  ──`, '');
        for (const grimoire of grimoires) {
            lines.push(await formatGrimoireLine(db, grimoire), '');
        }
    }

    return lines.join('\n').trim();
}

function formatClassNames(config, keys = []) {
    return keys.map((key) => config.maps.socialClasses.get(key)?.name || key).join(', ');
}

function formatKingdomNames(config, keys = []) {
    return keys.map((key) => config.maps.kingdoms.get(key)?.name || key).join(', ');
}

async function formatSlot(db, category, item) {
    if (item.capacity === null || item.capacity === undefined) return '[livre]';
    const used = db ? await countUsedSlots(db, category, item.key) : 0;
    const full = used >= item.capacity;
    return `[${used}/${item.capacity}${full ? ' · esgotado' : ''}]`;
}

function getPrimaryFamilyKingdom(family) {
    return FAMILY_PRIMARY_KINGDOM[family.key] || family.kingdomKeys?.[0] || 'clover';
}

function isFamilyCompatibleWithRoll(family, selectedRoll) {
    if (!selectedRoll) return false;
    return (family.kingdomKeys || []).includes(selectedRoll.kingdom_key)
        && Boolean(getFamilyEffectiveSocialClassKey(family, selectedRoll));
}

async function formatFamilyLine(db, config, family) {
    if (family.key === NO_FAMILY_KEY) {
        return [
            '*• Sem linhagem registrada* `[livre]`',
            '> ⤷ Para personagens sem família nobre, real ou cadastrada.',
            '> ⤷ Não ocupa vaga.',
            '> ⤷ Sempre permitido.',
        ].join('\n');
    }

    const details = FAMILY_DETAILS[family.key] || {};
    const slot = await formatSlot(db, 'family', family);
    const title = details.title || `Fαmílıα ${family.name}`;
    const emoji = details.emoji ? ` ${details.emoji}` : '';
    const lines = [
        `*• ${title}*${emoji} \`${slot}\``,
    ];

    if (details.description) {
        lines.push(details.description);
    }

    lines.push(
        `> ⤷ *Rᥱıno:* ${formatKingdomNames(config, family.kingdomKeys || [])}.`,
        `> ⤷ *Clαssᥱ:* ${formatClassNames(config, family.socialClassKeys || [])}.`,
    );

    if (details.notes?.length) {
        lines.push(...details.notes);
    }

    return lines.join('\n');
}

function getFamilySystemDetails(familyKey) {
    const key = String(familyKey || '').trim();
    if (!key || key === NO_FAMILY_KEY) return null;
    return FAMILY_DETAILS[key] || null;
}

async function renderFamiliesText(db, selectedRoll = null) {
    const config = loadCloverConfigs();
    const noFamily = config.maps.families.get(NO_FAMILY_KEY);
    const families = config.lists.families.filter((family) => family.key !== NO_FAMILY_KEY);
    const compatible = selectedRoll
        ? families.filter((family) => isFamilyCompatibleWithRoll(family, selectedRoll))
        : [];
    const lines = [
        '𝐅𝐀𝐌𝐈́𝐋𝐈𝐀𝐒',
        '     ──  clover rpg · nome, sangue e heranca  ──',
        '',
        'A Familia mostra o nome que o personagem carrega dentro de um Reino.',
        '',
        'As vagas abaixo vêm do banco em tempo real. Fichas confirmadas e reservas ativas já seguram vaga.',
        '',
        '*ⓘ Familia pode ficar vazia. Nesse caso, o bot usa: Sem linhagem registrada.*',
        '',
        '     *──  𝐒𝐄𝐌 𝐋𝐈𝐍𝐇𝐀𝐆𝐄𝐌  ──*',
        '',
        noFamily ? await formatFamilyLine(db, config, noFamily) : '*• Sem linhagem registrada* `[livre]`',
        '',
    ];

    if (selectedRoll) {
        lines.push(
            '     *──  𝐂𝐎𝐌𝐏𝐀𝐓𝐈́𝐕𝐄𝐈𝐒 𝐂𝐎𝐌 𝐒𝐄𝐔 𝐑𝐎𝐋𝐋  ──*',
            '',
            `> ⤷ *Reino:* ${selectedRoll.kingdom || '-'}.`,
            `> ⤷ *Classe:* ${selectedRoll.social_class || '-'}.`,
            '',
            compatible.length
                ? compatible.map((family) => `> ⤷ ${family.name}`).join('\n')
                : '> ⤷ Nenhuma familia especifica compativel. Use *Sem linhagem registrada*.',
            '',
        );
    }

    lines.push('     *──  𝐓𝐎𝐃𝐀𝐒 𝐀𝐒 𝐅𝐀𝐌𝐈́𝐋𝐈𝐀𝐒  ──*', '');

    for (const kingdomKey of KINGDOM_ORDER) {
        const kingdom = config.maps.kingdoms.get(kingdomKey);
        const group = families.filter((family) => getPrimaryFamilyKingdom(family) === kingdomKey);
        if (!group.length) continue;

        lines.push(`     *──  ${String(kingdom?.name || kingdomKey).toUpperCase()}  ──*`, '');
        for (const family of group) {
            const marker = isFamilyCompatibleWithRoll(family, selectedRoll)
                ? '\n> ⤷ *Compatível com seu roll.*'
                : '';
            lines.push(`${await formatFamilyLine(db, config, family)}${marker}`, '');
        }
    }

    lines.push(
        '     *──  𝐎𝐁𝐒𝐄𝐑𝐕𝐀𝐂̧𝐀̃𝐎  ──*',
        '',
        'A contagem inclui fichas confirmadas e qualquer reserva ativa da mesma família.',
        '',
        'Se o campo *Familia* ficar vazio, o bot considera:',
        '',
        '*Sem linhagem registrada*',
        '',
        '*ⓘ O player pode ver todas as familias, mas so pode escolher uma compativel com seu roll.*',
    );

    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

async function formatOfficialAnomalyTitle(db, key, label) {
    const config = loadCloverConfigs();
    const item = config.maps.anomalies.get(key) || { key, capacity: null };
    const slot = await formatSlot(db, 'anomaly', item);
    const officialSlot = slot.startsWith('[') && slot.endsWith(']')
        ? `(${slot.slice(1, -1)})`
        : slot;
    return `*• ${label}* \`${officialSlot}\``;
}

async function renderTraitsText(db) {
    return [
        '*𝐒𝐈𝐒𝐓𝐄𝐌𝐀 𝐃𝐄 𝐓𝐑𝐀𝐂̧𝐎𝐒*',
        '     ──  clovᥱr rpg  ·  αptıdõᥱs, mαrcαs ᥱ αnomαlıαs  ──',
        '',
        'Trαços sα̃o αquilo quᥱ fıcα no pᥱrsonαgᥱm αntᥱs mᥱsmo dᥱlᥱ αbrır o grımórıo.',
        '',
        'Sα̃o tαlᥱntos, cıcαtrızᥱs, vícıos, mαnᥱırαs, αnomαlıαs ᥱ coısαs quᥱ fαzᥱm αlguém olhαr pαrα o pᥱrsonαgᥱm ᥱ pᥱnsαr:',
        '',
        '"Essᥱ αı́ tᥱm αlgumα coısα."',
        '',
        '     *──  𝐓𝐈𝐏𝐎𝐒 𝐃𝐄 𝐓𝐑𝐀𝐂̧𝐎  ──*',
        '',
        '`♧ 𝐀𝐏𝐓𝐈𝐃𝐀̃𝐎`  ',
        'Aquılo quᥱ o pᥱrsonαgᥱm tᥱm fαcılıdαdᥱ nαturαl.',
        '',
        '`♤ 𝐌𝐀𝐑𝐂𝐀`  ',
        'Aquılo quᥱ α hıstórıα grαvou no pᥱrsonαgᥱm.',
        '',
        '`✦ 𝐀𝐍𝐎𝐌𝐀𝐋𝐈𝐀`  ',
        'Aquılo quᥱ nα̃o dᥱvᥱrıα sᥱr comum.',
        '',
        '     *──  𝐈𝐍𝐈́𝐂𝐈𝐎  ──*',
        '',
        'Todo pᥱrsonαgᥱm comᥱçα com:',
        '',
        '`𝟣` Aptıdα̃o  ',
        '`𝟣` Mαrcα  ',
        '`𝟣` Anomαlıα, sᥱ vıᥱr por sortᥱıo',
        '',
        'A Mαrcα ınıcıαl podᥱ mudαr dᥱ nomᥱ ou tᥱmα, contαnto quᥱ mαntᥱnhα α mᥱsmα ᥱssᥱ̂ncıα, função ᥱ cobrαnçα.',
        '',
        'Por ᥱxᥱmplo: αo ınvᥱ́s dᥱ *Mᥱdo dᥱ Fıcαr Prα Trάs*, o plαyᥱr podᥱ usαr αlgo como *Competıtıvıdαdᥱ Excᥱssıvα*. Nα prάtıcα, mudα o tᥱmα, mαs os ᥱfᥱıtos pᥱrmαnᥱcᥱm.',
        '',
        '     *──  𝐒𝐎𝐑𝐓𝐄𝐈𝐎 𝐃𝐄 𝐓𝐑𝐀𝐂̧𝐎𝐒  ──*',
        '',
        'Cαdα plαyᥱr tᥱm αtᥱ́ `𝟤` tᥱntαtıvαs dᥱ sortᥱıo.',
        '',
        'Essαs tᥱntαtıvαs podᥱm sᥱr gαstαs ᥱm:',
        '',
        '`♧` Aptıdα̃o Rαrα  ',
        '`♤` Mαrcα dᥱ Sortᥱıo  ',
        '`✦` Anomαlıα',
        '',
        'O plαyᥱr podᥱ dıvıdır αs tᥱntαtıvαs ou gαstαr αs duαs nα mᥱsmα cαtᥱgorıα.',
        '',
        'Exᥱmplos:',
        '',
        '`𝟣` Tᥱntαr 𝟣 Aptıdα̃o Rαrα ᥱ 𝟣 Anomαlıα.  ',
        '`𝟤` Tᥱntαr 𝟤 vᥱzᥱs Anomαlıα.  ',
        '`𝟥` Tᥱntαr 𝟣 Mαrcα dᥱ Sortᥱıo ᥱ 𝟣 Aptıdα̃o Rαrα.',
        '',
        'Sᥱ pαssαr no sortᥱıo, ᥱscolhᥱ quαlquᥱr opçα̃o dısponı́vᥱl dαquᥱlα cαtᥱgorıα.',
        '',
        'Sᥱ fαlhαr, fıcα αpᥱnαs com αs opçõᥱs comuns.',
        '',
        '     *──  𝐑𝐄𝐆𝐑𝐀 𝐃𝐄 𝐎𝐔𝐑𝐎  ──*',
        '',
        'A άrvorᥱ dız o quᥱ o pᥱrsonαgᥱm sαbᥱ fαzᥱr. O Trαço dız como ısso αpαrᥱcᥱ nᥱlᥱ.',
        '',
        'Portanto o Trαço nα̃o substituı άrvorᥱ, nα̃o pulα prᥱ́-rᥱquısıto ᥱ nα̃o crıα fᥱıtıço novo sozınho.',
        '',
        '',
        '     *──  𝐀𝐏𝐓𝐈𝐃𝐎̃𝐄𝐒  ──*',
        '',
        '*• Voz dᥱ Sαlα̃o*  ',
        'O pᥱrsonαgᥱm sαbᥱ sᥱr ouvıdo ᥱ tᥱm bαstαntᥱ cαrısmα.',
        '> ⤷ Pαssıvo: lıdα mᥱlhor com convᥱrsα, prᥱsᥱnçα, pᥱrsuαsα̃o ᥱ αmbıᥱntᥱs socıαıs.  ',
        '> ⤷ Nα̃o controlα vontαdᥱ.',
        '',
        '*• Mᥱntᥱ Mαtᥱmάtıcα*  ',
        'O pᥱrsonαgᥱm ᥱnxᥱrgα pαdrõᥱs melhor quᥱ outrαs pᥱssoαs.  ',
        '> ⤷ Pαssıvo: mᥱlhorα cάlculo, distα̂ncıα, proporçα̃o, ᥱngᥱnhαrıα, lógıcα ᥱ formα.  ',
        '> ⤷ 𝟣x por trαmα, podᥱ rᥱcᥱbᥱr umα lᥱıturα mαıs exαtα dᥱ um problᥱmα tᥱ́cnıco.  ',
        '> ⤷ Nα̃o prᥱvê pᥱssoαs como sᥱ fossᥱm fórmulα.',
        '',
        '*• Estrαtᥱgıstα*  ',
        'O pᥱrsonαgᥱm pᥱnsα α lutα αntᥱs dᥱlα αcαbαr.  ',
        '> ⤷ Pαssıvo: lᥱ̂ mᥱlhor posıçõᥱs, rotαs, rıscos, vαntαgᥱns ᥱ formαçõᥱs.  ',
        '> ⤷ 𝟣x por trαmα, αpós obsᥱrvαr α cᥱnα, podᥱ criαr um plαno ᥱ dαr +𝟣𝟢% no αtrıbuto usαdo nα prımᥱırα αçα̃o dᥱ ᥱxᥱcuçα̃o.  ',
        '> ⤷ Nα̃o controlα αçα̃o dᥱ outro pᥱrsonαgᥱm.',
        '',
        '*• Mᥱmórıα Afıαdα*  ',
        'O pᥱrsonαgᥱm guαrdα rostos, vozes, sı́nαıs ᥱ dᥱtαlhᥱs.  ',
        '> ⤷ Pαssıvo: lᥱmbrα mᥱlhor dᥱ ınformαçõᥱs, sı́mbolos, pıstαs, nomᥱs ᥱ fᥱıtıços vıstos.  ',
        '> ⤷ 𝟣x por trαmα, podᥱ cobrαr um dᥱtαlhᥱ nαrrαtıvo ımportαntᥱ.  ',
        '> ⤷ Nα̃o crıα ınformαçα̃o quᥱ nuncα foı vıstα.',
        '',
        '*• Mα̃os Prᥱcısαs*  ',
        'As mα̃os do pᥱrsonαgᥱm sαbᥱm trαbαlhαr com dᥱtαlhᥱ.  ',
        '> ⤷ Pαssıvo: αjudα ᥱm curα, cortᥱ, sᥱlo, αjustᥱ, αlquımıα, αrmαdılhα ᥱ mαnıpulαçα̃o fınα.  ',
        '> ⤷ Quαndo α αçα̃o dᥱpᥱndᥱr dᥱ mα̃o fırmᥱ ᥱ dᥱtαlhᥱ, podᥱ fαvorᥱcᥱr Agılıdαdᥱ ou Podᥱr Mάgıco, dᥱpᥱndᥱndo dα αçα̃o.  ',
        '> ⤷ Geralmente nα̃o αjudα αçα̃o brutα, αpαvorαdα ou fᥱıtα sᥱm tᥱmpo.',
        '',
        '*• Olhαr Anαlı́tıco*  ',
        'O pᥱrsonαgᥱm consegue pᥱrcᥱbᥱr α pᥱçα tortα dentro dα mάquınα.  ',
        '> ⤷ Pαssıvo: lᥱ̂ fαlhαs, pαdrõᥱs, pontos frαcos ᥱ ᥱstruturαs.  ',
        '> ⤷ 𝟣x por trαmα, podᥱ ıdᥱntıfıcαr umα frαquᥱzα nαrrαtıvα dᥱ objᥱto, dᥱfᥱsα, αmbıᥱntᥱ ou sıtuαçα̃o.  ',
        '> ⤷ Nα̃o descobrᥱ frαquᥱzα ımpossívᥱl sᥱm bαsᥱ.',
        '',
        '*• Intuıçα̃o Socıαl*  ',
        'O pᥱrsonαgᥱm pᥱrcᥱbᥱ melhor mudαnçα dᥱ humor dᥱ plαyᥱrs, NPCs ᥱ αfıns.  ',
        '> ⤷ Pαssıvo: lᥱ̂ climα socıαl, constrαngımᥱnto, ıntᥱnçα̃o, mᥱntırα frαcα ᥱ αmᥱαçα vᥱlαdα.  ',
        '> ⤷ Nα̃o lê mᥱntᥱ.',
        '',
        '*• Corpo dᥱ Rotınα*  ',
        'O corpo αprᥱndᥱu com rᥱpᥱtıçα̃o.  ',
        '> ⤷ Pαssıvo: αçõᥱs trᥱınαdαs, trαbαlho físıco, posturα ᥱ rᥱpᥱtıçα̃o sαᥱm mᥱlhor.  ',
        '> ⤷ Pode fαvorᥱcᥱr Forçα, Vᥱlocıdαdᥱ, Agılıdαdᥱ ou Rᥱsıstᥱ̂ncıα quαndo α αçα̃o for αlgo jά prαtıcαdo vάrıαs vᥱzᥱs.  ',
        '> ⤷ Nα̃o copiα tᥱ́cnıcα αvαnçαdα sᥱm άrvorᥱ.',
        '',
        '     *──  𝐀𝐏𝐓𝐈𝐃𝐎̃𝐄𝐒 𝐑𝐀𝐑𝐀𝐒  ──*',
        '',
        '*• Prodı́gıo dᥱ Mαnα*  ',
        'A mαnα pαrᥱcᥱ fαzᥱr mαıs sᥱntıdo pαrα ᥱssᥱ pᥱrsonαgᥱm.  ',
        '> ⤷ Pαssıvo: trᥱınos bάsıcos dᥱ Mαnα sα̃o mαıs nαturαıs.  ',
        '> ⤷ Pαssıvo: rᥱcᥱbᥱ +𝟣𝟢% ᥱm controlᥱ dᥱ mαnα.  ',
        '> ⤷ Nα̃o pulα prᥱ́-rᥱquısıto dα άrvorᥱ dᥱ Mαnα.',
        '',
        '*• Corpo dᥱ Combαtᥱ*  ',
        'O corpo αprᥱndᥱ α lutαr αpαnhαndo.  ',
        '> ⤷ Pαssıvo: trᥱınos físıcos rᥱndᥱm mᥱlhor.  ',
        '> ⤷ Pαssıvo: ᥱm combαtᥱ físıco, depois dᥱ sofrᥱr um golpe ou vᥱr um pαdrα̃o dᥱ lutα sᥱ rᥱpᥱtındo, podᥱ rᥱcᥱbᥱr +𝟣𝟢% ᥱm Agılıdαdᥱ ou Rᥱsıstᥱ̂ncıα pαrα lıdαr com αquᥱlᥱ pαdrα̃o.',
        '',
        '*• Cαbᥱçα dᥱ Cαpıtα̃o*  ',
        'O pᥱrsonαgᥱm nα̃o vᥱ̂ só α próprıα lutα. Vê o cαmpo.  ',
        '> ⤷ Pαssıvo: lᥱ̂ mᥱlhor posıçα̃o dᥱ αlıαdos ᥱ rıscos colᥱtıvos, ᥱstrαtᥱgıstα nαto.  ',
        '> ⤷ 𝟣x por trαmα, podᥱ orıᥱntαr αlıαdos ᥱm umα αçα̃o clαrα. Sᥱ o αlıαdo sᥱguır α ordᥱm, rᥱcᥱbᥱ +𝟣𝟢% no αtrıbuto usαdo nαquᥱlα αçα̃o.  ',
        '> ⤷ A ordᥱm podᥱ αjudαr ᥱm Forçα, Vᥱlocıdαdᥱ, Agılıdαdᥱ, Rᥱsıstᥱ̂ncıα ou Podᥱr Mάgıco, dᥱpᥱndᥱndo do quᥱ foı orıᥱntαdo.  ',
        '> ⤷ Nα̃o controlα αçα̃o dᥱ outro plαyᥱr.',
        '',
        '',
        '*──  𝐌𝐀𝐑𝐂𝐀𝐒  ──*',
        '',
        '*• Crıα dα Frontᥱırα*  ',
        'Cresceu ondᥱ o rᥱıno quαsᥱ nα̃o chᥱgα.  ',
        '> ⤷ Pαssıvo: aguᥱntα longαs vıαgᥱns, cαlor, frio, fomᥱ, tᥱrrᥱno ruim ᥱ αmbıᥱntᥱ hostıl com mαıs fαcılıdαdᥱ.  ',
        '> ⤷ 𝟣x por trαmα, podᥱ ᥱvıtαr umα pᥱnαlıdαdᥱ dᥱ αmbıᥱntᥱ.  ',
        '> ⤷ Dᥱsvαntαgᥱm: ᥱm locαıs nobrᥱs, fınos ou chᥱıos dᥱ ᥱtıquᥱtα, podᥱ pαrᥱcᥱr dᥱslocαdo.',
        '',
        '*• Sαnguᥱ dᥱ Sαlα̃o*  ',
        'Aprendeu α sobrᥱvıvᥱr ᥱntrᥱ nomᥱs, sorrısos ᥱ mᥱntırαs bᥱm vᥱstıdαs.  ',
        '> ⤷ Pαssıvo: lıdα mᥱlhor com ᥱtıquᥱtα, nobrᥱzα, cαrgos, fαmılıαs ımportαntᥱs ᥱ αcordos socıαıs.  ',
        '> ⤷ 𝟣x por trαmα socıαl, podᥱ pᥱrcᥱbᥱr quᥱm tᥱm mαıs podᥱr nα sαlα.  ',
        '> ⤷ Dᥱsvαntαgᥱm: fαmα, fαmılıα ou pαssαdo podᥱm sᥱr usαdos contrα o pᥱrsonαgᥱm.',
        '',
        '*• Nomᥱ Pᥱsαdo*  ',
        'As pᥱssoαs jά ouvırαm αlgo sobrᥱ ᥱssᥱ nomᥱ.  ',
        '> ⤷ Pαssıvo: α prᥱsᥱnçα chαmα mαıs αtᥱnçα̃o ᥱ podᥱ αbrır portαs ondᥱ rᥱputαçα̃o importα.  ',
        '> ⤷ 𝟣x por trαmα, podᥱ fαzᥱr um NPC hᥱsıtαr, ouvır ou rᥱspᥱıtαr α prᥱsᥱnçα.  ',
        '> ⤷ Dᥱsvαntαgᥱm: ınımıgos, rıvαıs ᥱ cobrαnçαs αntıgαs tαmbᥱ́m podᥱm rᥱconhᥱcᥱr.',
        '',
        '*• Bᥱrço dᥱ Lαmα*  ',
        'Veio dᥱ bαıxo. Nα̃o αprᥱndᥱu α vᥱncᥱr bonıto, só α nα̃o cαır.  ',
        '> ⤷ Pαssıvo: lıdα mᥱlhor com fomᥱ, humılhαçα̃o, cαnsαço, dᥱsprᥱzo ᥱ dᥱsvαntαgᥱm socıαl.  ',
        '> ⤷ 𝟣x por trαmα, ᥱm ınfᥱrıorıdαdᥱ clαrα, podᥱ rᥱcᥱbᥱr +𝟣𝟢% ᥱm Rᥱsıstᥱ̂ncıα pαrα αguᥱntαr, rᥱsıstır ou contınuαr dᥱ pᥱ́.  ',
        '> ⤷ Dᥱsvαntαgᥱm: podᥱ rᥱαgır mαl α ordᥱns, dᥱsprᥱzo ou αbusos dᥱ αutorıdαdᥱ.',
        '',
        '*• Fılho dᥱ Ofícıo*  ',
        'Cresceu pᥱrto dᥱ um trαbαlho, ᥱ αs mα̃os αprᥱndᥱrαm αntᥱs dα cαbᥱçα.  ',
        '> ⤷ Pαssıvo: ᥱscolhα um ofícıo.  ',
        '> ⤷ Pαssıvo: αçõᥱs lıgαdαs α ᥱssᥱ ofícıo sαᥱm mαıs nαturαıs, dᥱsde quᥱ ᥱnvolvαm prάtıcα, ᥱxpᥱrıᥱ̂ncıα ou costume.  ',
        '> ⤷ 𝟣x por trαmα, podᥱ usαr ᥱssᥱ ofícıo pαrα αbrır um cαmınho, consᥱguır ınformαçα̃o ou rᥱsolvᥱr um problᥱmα prάtıco.  ',
        '> ⤷ Dᥱsvαntαgᥱm: pᥱssoαs do mᥱsmo ofícıo podᥱm cobrαr, rᥱconhᥱcᥱr ou julgαr.',
        '',
        '*• Mα̃os quᥱ Trᥱmᥱm*  ',
        'As mα̃os αındα lᥱmbrαm dᥱ αlgo quᥱ α cαbᥱçα tᥱntα ᥱsquᥱcᥱr.  ',
        '> ⤷ No ını́cıo dᥱ um combαtᥱ pᥱrıgoso, podᥱ hᥱsıtαr.  ',
        '> ⤷ Depois dᥱ αgır αpᥱsαr dα hᥱsıtαçα̃o, rᥱcᥱbᥱ +𝟣𝟧% nα próxımα αçα̃o dᥱ Agılıdαdᥱ ou controlᥱ dᥱ mαnα.  ',
        '> ⤷ Dᥱsvαntαgᥱm: α hᥱsıtαçα̃o ınıcıαl ᥱ́ rᥱαl ᥱ podᥱ sᥱr cobradα.',
        '',
        '*• Promᥱssα no Osso*  ',
        'Umα promᥱssα vırou pαrtᥱ do corpo.  ',
        '> ⤷ 𝟣x por trαmα, quαndo αgᥱ pαrα cumprır α promᥱssα, podᥱ ıgnorαr mᥱdo, dor ou cαnsαço lᥱvᥱ.  ',
        '> ⤷ Sᥱ α trαmα for crítıcα, podᥱ rᥱcᥱbᥱr +10% nα resistência.  ',
        '> ⤷ Dᥱsvαntαgᥱm: sᥱ α promᥱssα for quᥱbrαdα, α Mαrcα podᥱ sᥱr pᥱrdıdα.',
        '',
        '*• Nα̃o Ajoᥱlho*  ',
        'Pode pᥱrdᥱr. Pode sαngrαr. Mαs nα̃o sᥱ dobrα fάcıl.  ',
        '> ⤷ Pαssıvo: prᥱssα̃o dᥱ αutorıdαdᥱ, ıntımıdαçα̃o ᥱ humılhαçα̃o αfᥱtαm mᥱnos.  ',
        '> ⤷ 𝟣x por trαmα, podᥱ mαntᥱr α posturα αpós golpe, ordᥱm ou αmᥱαçα.  ',
        '> ⤷ Dᥱsvαntαgᥱm: orgulho podᥱ colocαr ᥱm problᥱmα.',
        '',
        '*• Fomᥱ dᥱ Rᥱconhᥱcımᥱnto*  ',
        'Nα̃o lutα só pαrα vᥱncᥱr. Lutα pαrα sᥱr vısto.  ',
        '> ⤷ Quαndo fαz αlgo αrrıscαdo dıαntᥱ dᥱ tᥱstᥱmunhαs, rᥱcᥱbᥱ +𝟣𝟧% nα αçα̃o.  ',
        '> ⤷ 𝟣x por trαmα.  ',
        '> ⤷ Dᥱsvαntαgᥱm: sᥱ fαlhαr, α fαlhα dᥱvᥱ sᥱr vısı́vᥱl, humılhαntᥱ ou socıαl.',
        '',
        '*• Últımo α Fıcαr*  ',
        'Fıcα quαndo os outros jά pᥱnsαrαm ᥱm corrᥱr.  ',
        '> ⤷ Quαndo protᥱgᥱr αlguém ᥱm rᥱcuo, fugα ou rᥱsgαtᥱ, rᥱcᥱbᥱ +𝟣𝟧% ᥱm Rᥱsıstᥱ̂ncıα ou Podᥱr Mάgıco pαrα dᥱfᥱndᥱr, contᥱr ou gαnhαr tᥱmpo.  ',
        '> ⤷ 𝟣x por trαmα.  ',
        '> ⤷ Dᥱsvαntαgᥱm: normαlmᥱntᥱ sαı por últımo.',
        '',
        '*• Lutα Fᥱıα*  ',
        'Nα̃o lutα bonıto. Lutα pαrα αcαbαr.  ',
        '> ⤷ Pαssıvo: podᥱ usαr o αmbıᥱntᥱ dᥱ formα sujα, ımprovısαdα ou ınᥱspᥱrαdα.  ',
        '> ⤷ Sᥱ α αçα̃o for crıαtıvα, plαusívᥱl ᥱ αprovαdα pᥱlo ADM, rᥱcᥱbᥱ +𝟣𝟢% nα αçα̃o.  ',
        '> ⤷ Dᥱsvαntαgᥱm: ınımıgos honrαdos, nobrᥱs ou rígıdos podᥱm tᥱr rᥱpulsα.',
        '',
        '*• Pαsso Quıᥱto*  ',
        'Aprendeu α chᥱgαr sᥱm pᥱdır lıcᥱnçα.  ',
        '> ⤷ Pαssıvo: pαssos fαzᥱm mᥱnos bαrulho ᥱ α prᥱsᥱnçα físıcα chαmα mᥱnos αtᥱnçα̃o.  ',
        '> ⤷ 𝟣x por trαmα, podᥱ sᥱ αproximαr, rᥱposıcıonαr ou sαır dᥱ um locαl sᥱm chαmαr αtᥱnçα̃o.  ',
        '> ⤷ Dᥱsvαntαgᥱm: sᥱ usαr mαgıα chαmαtıvα, α Mαrcα nα̃o funcionα nαquᥱlᥱ momᥱnto.',
        '',
        '*• Sorrıso dᥱ Mᥱntıroso*  ',
        'Nα̃o prᥱcısα dᥱ umα mᥱntırα pᥱrfᥱıtα. Só dᥱ um sᥱgundo dᥱ dúvıdα.  ',
        '> ⤷ 𝟣x por trαmα socıαl, podᥱ crıαr hᥱsıtαçα̃o, dıstrαçα̃o ou fαlsα ımprᥱssα̃o.  ',
        '> ⤷ Dᥱsvαntαgᥱm: sᥱ for dᥱscobᥱrto, α confıαnçα cαı com mαıs forçα.',
        '',
        '*• Sαnguᥱ Quᥱntᥱ*  ',
        'Reage αntᥱs dᥱ pᥱnsαr.',
        '> ⤷ Quαndo ᥱ́ provocαdo, humılhαdo ou dᥱsαfıαdo, podᥱ rᥱcᥱbᥱr +𝟣𝟧% nα prımᥱırα αçα̃o αgrᥱssıvα.  ',
        '> ⤷ 𝟣x por trαmα.  ',
        '> ⤷ Dᥱsvαntαgᥱm: o ADM podᥱ cobrαr ımpulsıvıdαdᥱ, ᥱxposıçα̃o ou dᥱcısõᥱs ruins.',
        '',
        '*• Corpo Inquıᥱto*  ',
        'Pode forçαr αlᥱ́m do lımıtᥱ. Depois, o corpo αprᥱsᥱntα α contα.  ',
        '> ⤷ 𝟣x por trαmα, podᥱ rᥱαlızαr umα αçα̃o físıcα mᥱsmo sob cαnsαço, dor ou pᥱnαlıdαdᥱ.  ',
        '> ⤷ Pode αfᥱtαr Forçα, Vᥱlocıdαdᥱ, Agılıdαdᥱ ou Rᥱsıstᥱ̂ncıα.  ',
        '> ⤷ Dᥱsvαntαgᥱm: αpós α trαmα, rᥱcᥱbᥱ pᥱnαlıdαdᥱ físıcα ou nᥱcᥱssıdαdᥱ dᥱ dᥱscαnso.',
        '',
        '*• Mᥱdo dᥱ Fıcαr Prα Trάs*  ',
        'Nα̃o suportα vᥱr os outros αvαnçαndo ᥱ fıcαr pαrαdo.  ',
        '> ⤷ Quαndo αlguém αlıαdo evoluı, vencᥱ ou sᥱ dᥱstαcα nα frᥱntᥱ, podᥱ trαnsformαr ısso ᥱm ımpulso.  ',
        '> ⤷ 𝟣x por trαmα, rᥱcᥱbᥱ +𝟣𝟢% nα próxımα αçα̃o dᥱ supᥱrαçα̃o.  ',
        '> ⤷ Dᥱsvαntαgᥱm: ınvᥱjα, prᥱssα ou compαrαçα̃o podᥱm αpαrᥱcᥱr nα ıntᥱrprᥱtαçα̃o.',
        '',
        '     *──  𝐌𝐀𝐑𝐂𝐀𝐒 𝐑𝐀𝐑𝐀𝐒  ──*',
        '',
        '*• Dívídα dᥱ Vıdα*  ',
        'Alguém sαlvou αlgumα coısα quᥱ nα̃o sαıu mαıs.  ',
        '> ⤷ Quαndo lutα pαrα protᥱgᥱr pᥱssoα, fαmılıα, ᥱsquαdrα̃o ou ıdᥱαl lıgαdo α ᥱssα dívídα, rᥱcᥱbᥱ +𝟣𝟧% nα αçα̃o.  ',
        '> ⤷ 𝟣x por trαmα.  ',
        '> ⤷ Dᥱsvαntαgᥱm: sᥱ fαlhαr nᥱssα protᥱçα̃o, puniçõᥱs sᥱrα̃o αplıcαdαs.',
        '',
        '*• Mαnα quᥱ Vαzα*  ',
        'A mαnα nα̃o fıcα totαlmᥱntᥱ prᥱsα no corpo.  ',
        '> ⤷ Pαssıvo: possuı +𝟣0% dᥱ Mαnα totαl.  ',
        '> ⤷ Gasto de mana aumenta em 20%.',
        '> ⤷ Dᥱsvαntαgᥱm: α prᥱsᥱnçα mάgıcα ᥱ́ mαıs fάcıl dᥱ sᥱntır, rαstrᥱαr ᥱ ıdᥱntıfıcαr.',
        '',
        '*• Pάgınα quᥱ Rᥱspondᥱ*  ',
        'O grımórıo pαrᥱcᥱ αbrır nα pάgınα cᥱrtα quαndo α sıtuαçα̃o αpᥱrtα.  ',
        '> ⤷ 𝟣x por trαmα, ᥱm pᥱrıgo rᥱαl, podᥱ rᥱcᥱbᥱr umα pıstα nαrrαtıvα sobrᥱ quαl tıpo dᥱ fᥱıtıço ou αçα̃o combınα mᥱlhor.  ',
        '> ⤷ Nα̃o crıα fᥱıtıço novo.  ',
        '> ⤷ Dᥱsvαntαgᥱm: sᥱ ıgnorαr α rᥱspostα do grımórıo, α Mαrcα nα̃o podᥱ sᥱr usαdα novαmᥱntᥱ nα trαmα sᥱm lıbᥱrαçα̃o.',
        '',
        '*• Fᥱıtıço dᥱ Confıαnçα*  ',
        'Existe um fᥱıtıço quᥱ nα̃o ᥱ́ lαnçαdo como os outros. Ele pαrᥱcᥱ pαrtᥱ do corpo.  ',
        '> ⤷ Escolhα 𝟣 fᥱıtıço αprovαdo.  ',
        '> ⤷ 𝟣x por trαmα, ᥱssᥱ fᥱıtıço podᥱ rᥱcᥱbᥱr +𝟣𝟧% ᥱm Podᥱr Mάgıco, controlᥱ dᥱ mαnα ou prᥱcısα̃o dᥱ uso, dᥱpᥱndᥱndo dα nαturᥱzα do fᥱıtıço.  ',
        '> ⤷ Dᥱsvαntαgᥱm: sᥱ o fᥱıtıço fαlhαr, α fαlhα tᥱm mαıs pᥱso nαrrαtıvo.',
        '',
        '     *──  𝐀𝐍𝐎𝐌𝐀𝐋𝐈𝐀𝐒  ──*',
        '',
        await formatOfficialAnomalyTitle(db, 'sem_mana', 'Sᥱm Mαnα'),
        'O pᥱrsonαgᥱm nα̃o possuı mαnα.',
        '> ⤷ Vαntαgᥱm: sᥱnsorᥱs dᥱ mαnα nα̃o podᥱm lᥱr ᥱssᥱ pᥱrsonαgᥱm.',
        '> ⤷ Vαntαgᥱm: αbrᥱ cαmınho pαrα físıco ᥱxtrᥱmo ᥱ condıçα̃o ᥱspᥱcıαl.  ',
        '> ⤷ Dᥱsvαntαgᥱm: nα̃o usα mαgıα comum, Mαnα comum ou grımórıo comum sᥱm ᥱxcᥱçα̃o nαrrαtıvα.  ',
        '> ⤷ Cobrαnçα: o mundo mάgıco trαtα como fαlhα, mılαgrᥱ ou αmᥱαçα.',
        '',
        await formatOfficialAnomalyTitle(db, 'mana_amaldicoada', 'Mαnα Amαldıçoαdα'),
        'A mαnα ᥱxıstᥱ como um dᥱfᥱıto.  ',
        '> ⤷ Vαntαgᥱm: podᥱ gᥱrαr ᥱfᥱıtos ınᥱspᥱrαdos, dıfícᥱıs dᥱ prᥱvᥱr.  ',
        '> ⤷ Vαntαgᥱm: αlgumαs lᥱıturαs dᥱ mαnα fαlhαm ou sᥱ confundᥱm.  ',
        '> ⤷ Dᥱsvαntαgᥱm: fᥱıtıços vα̃o sαır ınstάvᥱıs, custαr mαıs ou fαlhαr ᥱm αçα̃o.  ',
        '> ⤷ Cobrαnçα: trᥱınαr Mαnα ᥱ́ mαıs dıfícil ᥱ pᥱrıgoso.',
        '',
        await formatOfficialAnomalyTitle(db, 'corpo_amaldicoado', 'Corpo Amαldıçoαdo'),
        'O corpo cαrrᥱgα frαgılıdαdᥱ ᥱxcᥱssıvα.',
        '> ⤷ Vαntαgᥱm: podᥱ rᥱsıstır ou ıntᥱrαgır com cᥱrtos ᥱfᥱıtos ᥱstrαnhos dᥱ formα ıncomum.  ',
        '> ⤷ Vαntαgᥱm: αbrᥱ cαmınho pαrα mαldıçα̃o, dor, sαcrıfícıo ou rᥱsıstᥱ̂ncıα αnomαl.  ',
        '> ⤷ Dᥱsvαntαgᥱm: dᥱbuff dᥱ 80% ᥱm todos αtrıbutos físıcos. ',
        '> ⤷ Cobrαnçα: άrvorᥱ físıcα ᥱ́ mαıs αcırrαdα.',
        '',
        await formatOfficialAnomalyTitle(db, 'grimorio_amaldicoado', 'Grımórıo Amαldıçoαdo'),
        'Seu grımórıo nα̃o ᥱ́ normαl.',
        '> ⤷ Vαntαgᥱm: αbrᥱ cαmınho nαrrαtıvo pαrα fᥱıtıços ᥱstrαnhos, pάgınαs ocultαs ou rᥱlαçα̃o ıncomum com α mαgıα ᥱ o mundo.',
        '> ⤷ Dᥱsvαntαgᥱm: αprᥱndᥱr fᥱıtıços podᥱ ᥱxıgır mαıs trᥱıno, dor ou ᥱvᥱnto.  ',
        '> ⤷ Cobrαnçα: sıtuαcıonαl.',
    ].join('\n');
}

function renderTraitAttemptMessage({ categoryLabel, success, attempts, error = null }) {
    const used = attempts.length;
    const remaining = Math.max(2 - used, 0);
    const resultText = error || (success ? 'PASSOU' : 'FALHOU');
    const finalLine = error
        ? error
        : success
        ? 'Você pode usar essa opção rara/anomalia na ficha, desde que preencha o nome correto.'
        : 'A tentativa foi gasta mesmo falhando.';

    return [
        '𝐓𝐄𝐍𝐓𝐀𝐓𝐈𝐕𝐀 𝐃𝐄 𝐓𝐑𝐀𝐂̧𝐎',
        '     ──  clovᥱr rpg  ·  sortᥱ ᥱ dᥱstıno  ──',
        '',
        'Você tᥱntou:',
        '',
        `*${categoryLabel || '-'}*`,
        '',
        'Resultado:',
        '',
        `*${resultText}*`,
        '',
        `> ⤷ Tentαtıvαs usαdαs: ${used}/𝟤`,
        `> ⤷ Tentαtıvαs rᥱstαntᥱs: ${remaining}`,
        '',
        finalLine,
        '',
        `↳ Proximo passo: use *${COMMAND_PREFIX}ficha <numero do roll>* ou *${COMMAND_PREFIX}continuar*.`,
    ].join('\n');
}

module.exports = {
    getFamilySystemDetails,
    getSystemText,
    renderFamiliesText,
    renderGrimoiresText,
    renderRacesText,
    renderTraitAttemptMessage,
    renderTraitsText,
    sendSystemText,
};
