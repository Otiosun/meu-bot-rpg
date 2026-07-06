const fs = require('fs');
const path = require('path');

const { COMMAND_PREFIX, MAX_PLAYER_ROLLS } = require('../config/bot');
const { normalizeText } = require('./textUtils');

const STORAGE_FILE = path.join(process.cwd(), 'config', 'custom-messages.json');
const IMAGE_DIR = path.join(process.cwd(), 'assets', 'onboarding');

const MESSAGE_DEFINITIONS = {
    recepcao: {
        label: 'Recepção',
        aliases: ['recepcao', 'recepção', 'welcome', 'boasvindas', 'boas-vindas'],
        imageCandidates: ['recepcao.png', 'recepcao.jpg', 'recepcao.jpeg', 'recepcao.webp', 'welcome.png', 'welcome.jpg', 'welcome.jpeg', 'welcome.webp'],
        defaultText: `*𖹭.ᐟ・✿  Sᥱjα muıto bᥱm-vındo(a),* @!!

É um prαzᥱr tᥱr suα prᥱsᥱnçα ᥱm nosso rpg ❤︎

— Vαmos ınıcıαr com α crıαçα̃o do sᥱu pᥱrsonαgᥱm? Eu mᥱsmα vou tᥱ guıαr!

_Basta mandar \`.#start\` quando quiser prosseguir._`,
    },
    historia: {
        label: 'História do RPG',
        aliases: ['historia', 'história', 'historia_rpg', 'historiarpg', 'lore'],
        imageCandidates: ['historia.png', 'historia.jpg', 'historia.jpeg', 'historia.webp', 'historia_rpg.png', 'historia_rpg.jpg', 'historia_rpg.jpeg', 'historia_rpg.webp', 'lore.png', 'lore.jpg', 'lore.jpeg', 'lore.webp'],
        defaultText: `♧┃𝐇𝐈𝐒𝐓𝐎́𝐑𝐈𝐀 𝐃𝐎 𝐑𝐏𝐆 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫
     ──  mundo, reinos e ponto de partida  ──

_` + '`' + `─( ✦ )───── 𝗔𝘃𝗶𝘀𝗼` + '`' + `_

ⓘ A história oficial do RPG ainda não foi configurada aqui.

> A administração pode atualizar este comando com texto, quebra de linha e imagem usando *.#mensagem historia*.`,
    },
    divulgacao: {
        label: 'Divulgação',
        aliases: ['divulgacao', 'divulgação', 'divulgar', 'spam', 'propaganda'],
        imageCandidates: ['divulgacao.png', 'divulgacao.jpg', 'divulgacao.jpeg', 'divulgacao.webp', 'divulgacao_rpg.png', 'divulgacao_rpg.jpg', 'divulgacao_rpg.jpeg', 'divulgacao_rpg.webp', 'spam.png', 'spam.jpg', 'spam.jpeg', 'spam.webp'],
        defaultText: `♧┃𝐃𝐈𝐕𝐔𝐋𝐆𝐀𝐂̧𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫
     ──  texto pronto para convite  ──

_` + '`' + `─( ✦ )───── 𝗔𝘃𝗶𝘀𝗼` + '`' + `_

ⓘ O texto de divulgação ainda não foi configurado.

> A administração pode atualizar este comando com texto, quebra de linha e imagem usando *.#mensagem divulgacao*.`,
    },
    start: {
        label: 'Start',
        aliases: ['start', 'inicio', 'início'],
        imageCandidates: ['start.png', 'start.jpg', 'start.jpeg', 'start.webp'],
        defaultText: `𝐑𝐄𝐂𝐄𝐏𝐂̧𝐀̃𝐎 𝐃𝐎 𝐆𝐑𝐈𝐌𝐎́𝐑𝐈𝐎
     ──  clovᥱr multicolor · prımᥱıros pαssos  ──

Sᥱjα bᥱm-vındo(a) αo *Clovᥱr Multıcolor*.

Antes dᥱ αbrır sᥱu grımórıo, prᥱcısαmos dᥱscobrır α bαsᥱ do sᥱu pᥱrsonαgᥱm.

Aquı você nα̃o vαı fαzᥱr hıstórıα, pᥱrsonαlıdαdᥱ ou αtrıbutos αgorα.
Isso vᥱm dᥱpoıs, com cαlmα.

Mαs nα̃o confundα:
> Hıstórıα ᥱ pᥱrsonαlıdαdᥱ sα̃o tα̃o ımportαntᥱs quαnto podᥱr.
> Um pᥱrsonαgᥱm fortᥱ sᥱm αlmα nα̃o durα muito nᥱstᥱ mundo.

Por ısso, lᥱıα os sıstᥱmαs com αtᥱnçα̃o. Seu Rᥱıno, Rαçα, Grımórıo, Mαgıα, Fαmílıα ᥱ Trαços prᥱcısαm combınαr com α ıdᥱıα do sᥱu pᥱrsonαgᥱm.

     *──  𝐂𝐎𝐌𝐎 𝐂𝐎𝐌𝐄𝐂̧𝐀𝐑  ──*

\`𝟣\` Usᥱ *.#sortear*
> ⤷ Você podᥱ fαzᥱr αtᥱ́ *𝟦 rolls*.

Cαdα roll podᥱ mostrαr:
> ⤷ Rᥱıno.
> ⤷ Rαçα.
> ⤷ Clαssᥱ Socıαl, cαso sᥱjα Humαno.
> ⤷ Grımórıo.
> ⤷ Rαrıdαdᥱ Mάgıcα.

Antes dᥱ ᥱscolhᥱr, lᥱıα os sıstᥱmαs:

> ⤷ *.#reinos* — vᥱjα α orıgᥱm do pᥱrsonαgᥱm.
> ⤷ *.#racas* — vᥱjα αs rαçαs ᥱ lımıtᥱs.
> ⤷ *.#classes* — vᥱjα αs clαssᥱs socıαıs.
> ⤷ *.#grimorios* — vᥱjα os grımórıos.
> ⤷ *.#familias* — vᥱjα fαmílıαs ᥱ vαgαs.
> ⤷ *.#tracos* — vᥱjα Aptıdõᥱs, Mαrcαs ᥱ Anomαlıαs.

\`𝟤\` Usᥱ *.#rolls*
> ⤷ Vᥱjα todos os rolls quᥱ você tirou.
> ⤷ Escolhα com cαlmα. Essα bαsᥱ vαı guıαr suα fıchα.

\`𝟥\` Escolhα um roll com *.#ficha <número>*
> ⤷ Exᥱmplo: *.#ficha 𝟤*
> ⤷ O bot vαı mαndαr o modᥱlo dα fıchα jά com o número do roll prᥱᥱnchıdo.

\`𝟦\` Escolhα suα Mαgıα com *.#magias*
> ⤷ A mαgıα prᥱcısα sᥱr compatívᥱl com α rαrıdαdᥱ do sᥱu roll.
> ⤷ Ao ᥱscolhᥱr, α mαgıα podᥱ fıcαr rᥱsᥱrvαdα por *𝟣 horα*.
> ⤷ Sᥱ pαssαr do tᥱmpo, prᥱcısα ᥱscolhᥱr dᥱ novo.

\`𝟧\` Consultᥱ Fαmílıαs ᥱ Trαços
> ⤷ Usᥱ *.#familias* pαrα vᥱr αs fαmílıαs compatívᥱıs.
> ⤷ Usᥱ *.#tracos* pαrα vᥱr Aptıdõᥱs, Mαrcαs ᥱ Anomαlıαs.

Sᥱ quısᥱr tᥱntαr αlgo rαro:
> ⤷ *.#tracos tentar aptidao*
> ⤷ *.#tracos tentar marca*
> ⤷ *.#tracos tentar anomalia*

Você tᥱm αpᥱnαs *𝟤 tᥱntαtıvαs ᥱspᥱcıαıs*.
Usᥱ com cαlmα.

\`𝟨\` Prᥱᥱnchα α fıchα
> ⤷ A fıchα ınıcıαl pᥱdᥱ αpᥱnαs os dαdos bάsıcos.
> ⤷ Hıstórıα, pᥱrsonαlıdαdᥱ ᥱ αtrıbutos sᥱrα̃o fᥱıtos dᥱpoıs.

\`𝟩\` Confırmᥱ com *.#confirmarFicha*
> ⤷ O bot vαı vᥱr sᥱ α mαgıα, fαmílıα, trαços ᥱ vαgαs ᥱstα̃o corretos.
> ⤷ Sᥱ tıvᥱr ᥱrro, ᥱlᥱ vαı αvısαr o quᥱ prᥱcısα corrigır.

     *──  𝐂𝐎𝐌𝐀𝐍𝐃𝐎𝐒 𝐔́𝐓𝐄𝐈𝐒  ──*

*.#sortear*
> Fαz um roll dᥱ crıαçα̃o.

*.#rolls*
> Mostrα sᥱus rolls sαlvos.

*.#ficha <número>*
> Escolhᥱ um roll ᥱ rᥱcᥱbᥱ o modᥱlo dα fıchα.

*.#magias*
> Mostrα αs mαgıαs ᥱ pᥱrmıtᥱ ᥱscolhᥱr/rᥱsᥱrvαr.

*.#familias*
> Mostrα αs fαmílıαs disponívᥱıs.

*.#tracos*
> Mostrα Aptıdõᥱs, Mαrcαs ᥱ Anomαlıαs.

*.#continuar*
> Usᥱ sᥱmprᥱ quᥱ sᥱ pᥱrdᥱr.
> O bot vαı dızᥱr ᥱxαtαmᥱntᥱ ᥱm quαl ᥱtαpα você ᥱstά ᥱ o quᥱ prᥱcısα fαzᥱr αgorα.

*.#cancelarFicha*
> Cαncᥱlα α fıchα pᥱndᥱntᥱ ᥱ lıbᥱrα rᥱsᥱrvαs.

*ⓘ Lᥱıα. Escolhα. Pᥱnsᥱ. O grımórıo rᥱspondᥱ mᥱlhor α quᥱm sαbᥱ quᥱm ᥱ́.*`,
    },
    sortear_pos: {
        label: 'Sortear: depois de salvar',
        aliases: ['sortear_pos', 'sortear', 'apos_sortear', 'pós-sortear'],
        defaultText: `♧┃𝐑𝐎𝐋𝐋 𝐃𝐎 𝐃𝐄𝐒𝐓𝐈𝐍𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫
     ──  reino, raça, classe ᥱ grimório  ──

_\`─( ✓ )───── 𝗦𝗮𝗹𝘃𝗼\`_

*𝐑𝐨𝐥𝐥:* #{{roll_number}}
*𝐓𝐨𝐭𝐚𝐥:* {{roll_count}}/{{max_rolls}}

_\`─( 𖥔 )───── 𝗗𝗲𝘀𝘁𝗶𝗻𝗼\`_

*𝐑𝐞𝐢𝐧𝐨:* {{kingdom}}
*𝐂𝐥𝐚𝐬𝐬𝐞:* {{social_class}}
{{family_line}}*𝐑𝐚𝐜̧𝐚:* {{race}}
*𝐆𝐫𝐢𝐦𝐨́𝐫𝐢𝐨:* {{grimoire}}
*𝐑𝐚𝐫𝐢𝐝𝐚𝐝𝐞 𝐌𝐚́𝐠𝐢𝐜𝐚:* {{rarity_emoji}} {{magic_rarity}}

_\`─( ■ )───── 𝗣𝗿𝗼́𝘅𝗶𝗺𝗼\`_

{{sortear_followup_line}}
{{rolls_followup_line}}`,
    },
    sortear_limite: {
        label: 'Sortear: limite',
        aliases: ['sortear_limite', 'limite_sortear', 'limite'],
        defaultText: `♧┃𝐋𝐈𝐌𝐈𝐓𝐄 𝐃𝐄 𝐑𝐎𝐋𝐋𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫
     ──  sorteios encerrados  ──

_\`─( ! )───── 𝗟𝗶𝗺𝗶𝘁𝗲\`_

*𝐓𝐨𝐭𝐚𝐥 𝐚𝐭𝐮𝐚𝐥:* {{roll_count}}/{{max_rolls}}
> Você já alcançou o limite de sorteios.

_\`─( ■ )───── 𝗔𝗴𝗼𝗿𝗮\`_

*̣.#rolls*
> Revisar seus rolls.
*̣.#ficha <número>*
> Escolher um roll para a ficha.`,
    },
    rolls_sem_roll: {
        label: 'Rolls: sem sorteios',
        aliases: ['rolls_sem_roll', 'sem_roll', 'rolls_vazio'],
        defaultText: `♧┃𝐑𝐎𝐋𝐋𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫
     ──  destinos salvos  ──

_\`─( ! )───── 𝗩𝗮𝘇𝗶𝗼\`_

> Você ainda não tem rolls salvos.

_\`─( ■ )───── 𝗨𝘀𝗲\`_

*̣.#sortear*
> Gerar o primeiro roll.
*̣.#start*
> Rever o fluxo de criação.`,
    },
    rolls_pos: {
        label: 'Rolls: depois de ver',
        aliases: ['rolls_pos', 'apos_rolls', 'pós-rolls'],
        defaultText: `♧┃𝐑𝐎𝐋𝐋𝐒 𝐒𝐀𝐋𝐕𝐎𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫
     ──  destinos disponíveis para ficha  ──

_\`─( 𖥔 )───── 𝗗𝗲𝘀𝘁𝗶𝗻𝗼𝘀\`_

{{rolls_list}}

_\`─( ✦ )───── 𝗥𝗲𝘀𝘂𝗺𝗼\`_

*𝐓𝐨𝐭𝐚𝐥 𝐬𝐚𝐥𝐯𝐨:* {{roll_count}}/{{max_rolls}}

_\`─( ■ )───── 𝗔𝗴𝗼𝗿𝗮\`_

> {{sortear_hint}}
> {{ficha_hint}}
> Se travar, use *.#continuar*.`,
    },
    continuar_sem_roll: {
        label: 'Continuar: sem rolls',
        aliases: ['continuar_sem_roll', 'continuar_inicio'],
        defaultText: `*♡  Vαmos rᥱtomαr sᥱu cαdαstro.*

↳ No momᥱnto você αındα nα̃o tᥱm rolls sαlvos.
↳ Use *.#start* pαrα rᥱvᥱr os prımᥱıros pαssos.
↳ Ou vα dırᥱto pαrα *.#sortᥱαr*.`,
    },
    continuar_com_roll: {
        label: 'Continuar: com rolls',
        aliases: ['continuar_com_roll', 'continuar_roll'],
        defaultText: `*♡  Vαmos rᥱtomαr dᥱ ondᥱ pαrαmos.*

↳ Você jά tᥱm *{{roll_count}}/{{max_rolls}}* roll(s) sαlvos.
↳ O mαıs rᥱcomendαdo αgorα é pαssαr em *.#rolls*.
↳ Mαs, sᥱ jά tıvᥱr um fαvorıto, *.#Fıchα* tαmbém jά podᥱ sᥱr usαdα.`,
    },
    continuar_apos_rolls: {
        label: 'Continuar: depois dos rolls',
        aliases: ['continuar_apos_rolls', 'continuar_ficha'],
        defaultText: `*♡  Agorα sᥱguımos pαrα α fıchα.*

↳ Sᥱus rolls jά forαm rᥱvıstos.
↳ Use *.#Fıchα* quαndo quısᥱr comᥱçαr o prᥱᥱnchımᥱnto.
↳ Sᥱ quısᥱr, *.#Mαgıαs* tαmbém podᥱ sᥱr consultαdo dᥱpoıs quᥱ o roll ᥱstıvᥱr dᥱfınıdo.`,
    },
};

function ensureStorageDirs() {
    fs.mkdirSync(path.dirname(STORAGE_FILE), { recursive: true });
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

function loadOverrides() {
    ensureStorageDirs();

    if (!fs.existsSync(STORAGE_FILE)) return {};

    try {
        const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function saveOverrides(data) {
    ensureStorageDirs();
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function resolveContentKey(input) {
    const normalizedInput = normalizeText(input);

    for (const [key, definition] of Object.entries(MESSAGE_DEFINITIONS)) {
        const aliases = [key, ...(definition.aliases || [])];
        if (aliases.some((alias) => normalizeText(alias) === normalizedInput)) {
            return key;
        }
    }

    return null;
}

function listEditableMessages() {
    return Object.entries(MESSAGE_DEFINITIONS).map(([key, definition]) => ({
        key,
        label: definition.label,
    }));
}

function getSampleRollList() {
    return [
        '_`─( 𖥔 )───── 𝗥𝗼𝗹𝗹 #01 ⚪`_',
        '',
        '*𝐑𝐞𝐢𝐧𝐨:* Clover',
        '*𝐂𝐥𝐚𝐬𝐬𝐞:* Plebeu',
        '*𝐑𝐚𝐜̧𝐚:* Humano',
        '*𝐆𝐫𝐢𝐦𝐨́𝐫𝐢𝐨:* Grimório de 3 Folhas',
        '*𝐑𝐚𝐫𝐢𝐝𝐚𝐝𝐞 𝐌𝐚́𝐠𝐢𝐜𝐚:* Comum',
    ].join('\n');
}

function buildTemplateContext({
    playerId = null,
    rollCount = 1,
    maxRolls = MAX_PLAYER_ROLLS,
    rollNumber = '02',
    rarityEmoji = '🔵',
    magicRarity = 'Rara',
    kingdom = 'Clover',
    socialClass = 'Plebeu',
    family = '-',
    race = 'Humano',
    grimoire = 'Grimório de 3 Folhas',
    rollsList = '',
} = {}) {
    const familyLine = family && family !== '-'
        ? `*𝐅𝐚𝐦𝐢́𝐥𝐢𝐚:* ${family}\n`
        : '';
    const sortearFollowupLine = rollCount < maxRolls
        ? '> Se quiser, use *.#sortear* de novo.'
        : '> Você já fechou seu limite de sorteios.';
    const rollsFollowupLine = rollCount < maxRolls
        ? '> Para ver tudo organizado, use *.#rolls*.'
        : '> Agora, o mais recomendado é usar *.#rolls*.';

    return {
        playerId,
        rollCount,
        maxRolls,
        rollNumber,
        rarityEmoji,
        magicRarity,
        kingdom,
        socialClass,
        family,
        familyLine,
        sortearFollowupLine,
        rollsFollowupLine,
        race,
        grimoire,
        rollsList: rollsList || getSampleRollList(),
        sortearHint: rollCount < maxRolls
            ? 'Se ainda quiser tentar mais, *.#sortear* continua liberado.'
            : 'Você já fechou seu limite de sorteios.',
        fichaHint: 'Se já estiver decidido(a), *.#ficha <número>* já pode ser usada.',
    };
}

function renderTemplate(text, context = {}) {
    const mention = context.playerId ? `@${String(context.playerId).split('@')[0]}` : '@!!';
    const replacements = {
        '@!!': mention,
        '{{mention}}': mention,
        '{{prefix}}': COMMAND_PREFIX,
        '{{roll_count}}': String(context.rollCount ?? ''),
        '{{max_rolls}}': String(context.maxRolls ?? MAX_PLAYER_ROLLS),
        '{{roll_number}}': String(context.rollNumber ?? ''),
        '{{rarity_emoji}}': context.rarityEmoji || '',
        '{{magic_rarity}}': context.magicRarity || '',
        '{{kingdom}}': context.kingdom || '',
        '{{social_class}}': context.socialClass || '',
        '{{family}}': context.family || '',
        '{{family_line}}': context.familyLine || '',
        '{{sortear_followup_line}}': context.sortearFollowupLine || '',
        '{{rolls_followup_line}}': context.rollsFollowupLine || '',
        '{{race}}': context.race || '',
        '{{grimoire}}': context.grimoire || '',
        '{{rolls_list}}': context.rollsList || '',
        '{{sortear_hint}}': context.sortearHint || '',
        '{{ficha_hint}}': context.fichaHint || '',
    };

    let rendered = String(text || '');
    Object.entries(replacements).forEach(([token, value]) => {
        rendered = rendered.split(token).join(value);
    });

    return rendered.trim();
}

function getMessageDefinition(key) {
    return MESSAGE_DEFINITIONS[key] || null;
}

function getMessageText(key) {
    const definition = getMessageDefinition(key);
    if (!definition) return null;

    const overrides = loadOverrides();
    return overrides[key]?.text || definition.defaultText;
}

function renderEditableMessage(key, context = {}) {
    const text = getMessageText(key);
    if (!text) return '';
    return renderTemplate(text, context);
}

function removeImageFilesForKey(key) {
    const candidates = ['png', 'jpg', 'jpeg', 'webp'].map((ext) => path.join(IMAGE_DIR, `${key}.${ext}`));
    candidates.forEach((filePath) => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
}

function mimeToExtension(mimeType) {
    const normalized = String(mimeType || '').toLowerCase();
    if (normalized.includes('png')) return 'png';
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
    if (normalized.includes('webp')) return 'webp';
    return null;
}

function findImagePath(key) {
    const definition = getMessageDefinition(key);
    if (!definition) return null;

    const overrides = loadOverrides();
    const storedFile = overrides[key]?.image;
    if (storedFile) {
        const storedPath = path.join(IMAGE_DIR, storedFile);
        if (fs.existsSync(storedPath)) return storedPath;
    }

    for (const filename of definition.imageCandidates || []) {
        const fullPath = path.join(IMAGE_DIR, filename);
        if (fs.existsSync(fullPath)) return fullPath;
    }

    return null;
}

function saveEditableText(key, text) {
    const definition = getMessageDefinition(key);
    if (!definition) return false;

    const safeText = String(text || '').trim();
    if (!safeText) return false;

    const overrides = loadOverrides();
    overrides[key] = {
        ...(overrides[key] || {}),
        text: safeText,
    };
    saveOverrides(overrides);
    return true;
}

function saveEditableImage(key, buffer, mimeType) {
    const definition = getMessageDefinition(key);
    const extension = mimeToExtension(mimeType);
    if (!definition || !buffer || !extension) return false;

    ensureStorageDirs();
    removeImageFilesForKey(key);

    const filename = `${key}.${extension}`;
    fs.writeFileSync(path.join(IMAGE_DIR, filename), buffer);

    const overrides = loadOverrides();
    overrides[key] = {
        ...(overrides[key] || {}),
        image: filename,
    };
    saveOverrides(overrides);
    return true;
}

function clearEditableImage(key) {
    const definition = getMessageDefinition(key);
    if (!definition) return false;

    removeImageFilesForKey(key);

    const overrides = loadOverrides();
    if (overrides[key]) {
        delete overrides[key].image;
        if (!overrides[key].text) delete overrides[key];
        saveOverrides(overrides);
    }

    return true;
}

function resetEditableMessage(key) {
    const definition = getMessageDefinition(key);
    if (!definition) return false;

    removeImageFilesForKey(key);

    const overrides = loadOverrides();
    delete overrides[key];
    saveOverrides(overrides);
    return true;
}

function renderWelcomeMessage(playerId) {
    return renderEditableMessage('recepcao', buildTemplateContext({ playerId, rollCount: 0 }));
}

function renderStartMessage(playerId, rollCount = 0) {
    return renderEditableMessage('start', buildTemplateContext({ playerId, rollCount }));
}

function renderRollStageMessage(rollCount, extraContext = {}) {
    const key = rollCount >= MAX_PLAYER_ROLLS ? 'sortear_limite' : 'sortear_pos';
    return renderEditableMessage(key, buildTemplateContext({ rollCount, ...extraContext }));
}

function renderRollReviewMessage(rollCount, extraContext = {}) {
    const key = rollCount > 0 ? 'rolls_pos' : 'rolls_sem_roll';
    return renderEditableMessage(key, buildTemplateContext({ rollCount, ...extraContext }));
}

function renderContinueNoRollsMessage() {
    return renderEditableMessage('continuar_sem_roll', buildTemplateContext({ rollCount: 0 }));
}

function renderContinueAfterRollMessage(rollCount) {
    return renderEditableMessage('continuar_com_roll', buildTemplateContext({ rollCount }));
}

function renderContinueAfterReviewMessage(rollCount) {
    return renderEditableMessage('continuar_apos_rolls', buildTemplateContext({ rollCount }));
}

module.exports = {
    buildTemplateContext,
    clearEditableImage,
    findImagePath,
    listEditableMessages,
    renderContinueAfterReviewMessage,
    renderContinueAfterRollMessage,
    renderContinueNoRollsMessage,
    renderEditableMessage,
    renderRollReviewMessage,
    renderRollStageMessage,
    renderStartMessage,
    renderWelcomeMessage,
    resetEditableMessage,
    resolveContentKey,
    saveEditableImage,
    saveEditableText,
};
