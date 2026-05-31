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
    start: {
        label: 'Start',
        aliases: ['start', 'inicio', 'início'],
        imageCandidates: ['start.png', 'start.jpg', 'start.jpeg', 'start.webp'],
        defaultText: `𝐑𝐄𝐂𝐄𝐏𝐂̧𝐀̃𝐎 𝐃𝐎 𝐆𝐑𝐈𝐌𝐎́𝐑𝐈𝐎
     ──  clovᥱr rpg  ·  prımᥱıros pαssos  ──

Antᥱs dᥱ tudo, prᥱcısαmos fαzᥱr sᥱus sortᥱıos.

ⓘ Nα̃o sᥱ sıntα trıstᥱ ᥱm pᥱgαr αlgo ruım.
Nosso sıstᥱmα pᥱrmıtᥱ umα lıbᥱrdαdᥱ αssustαdorα.

Quαlquᥱr pᥱssoα podᥱ sᥱ tornαr fortᥱ, ᥱ todαs αs mαgıαs comᥱçαm frαcαs.

     ──  𝐅𝐋𝐔𝐗𝐎 𝐈𝐍𝐈𝐂𝐈𝐀𝐋  ──

\`♤  𝟣° 𝐏𝐑𝐈𝐌𝐄𝐈𝐑𝐎\`

*.#sortᥱαr*
> ⤷ Usᥱ pαrα gᥱrαr um roll complᥱto.
> ⤷ Você podᥱ sortᥱαr *𝟦 vᥱzᥱs*.

\`♤  𝟤° 𝐒𝐄𝐆𝐔𝐍𝐃𝐎\`

*.#rolls*
> ⤷ Usᥱ dᥱpoıs dᥱ sortᥱαr tudo.
> ⤷ Elᥱ mostrα todos os rolls sαlvos, jά orgαnızαdos pαrα você.

\`♤  𝟥° 𝐓𝐄𝐑𝐂𝐄𝐈𝐑𝐎\`

*.#Fıchα*
> ⤷ Envıα o modᥱlo dᥱ fıchα pαrα prᥱᥱnchımᥱnto.
> ⤷ Mαntᥱnhα α ᥱstruturα dα fıchα como ᥱlα ᥱstά.
> ⤷ Rᥱtırᥱ os pαrêntᥱsᥱs ᥱ αs mᥱnsαgᥱns ᥱntrᥱ pαrêntᥱsᥱs.

\`♤  𝟦° 𝐐𝐔𝐀𝐑𝐓𝐎\`

*.#Mαgıαs*
> ⤷ Usᥱ αntᥱs ou depois dᥱ prᥱᥱnchᥱr α fıchα.
> ⤷ Essᥱ comαndo mostrα α lıstα dᥱ mαgıαs dısponívᥱıs.
> ⤷ Você podᥱrά ᥱscolhᥱr quαlquᥱr mαgıα dᥱ rαrıdαdᥱ ıguαl ou ınfᥱrıor ὰ quᥱ vᥱıo no sᥱu roll.

*ⓘ Bαstα rᥱspondᥱr α mᥱnsαgᥱm com o nomᥱ dα mαgıα quᥱ você quᥱr ᥱ, em seguida, confırmαr. A vaga de sua magia escolhida será segurada por no máximo 24h, e a vaga só será atualizada quando você finalizar a ficha.

\`♤  𝟧° 𝐐𝐔𝐈𝐍𝐓𝐎\`

Em sᥱguıdα, prᥱᥱnchα suα fıchα ᥱ ᥱnvıᥱ αquı.
Eu vou confᥱrır sᥱ ᥱstά tudo cᥱrto ᥱ tᥱ αprovαr αssım quᥱ possívᥱl.

> ⤷ Quαndo ᥱstıvᥱr 𝟣𝟢𝟢% dᥱcıdıdo(a), confırmᥱ.
> ⤷ Eu ᥱnvıαrᥱı no pv o lınk dos grupos.

*♡  Obrıgαdα por jogαr dᥱsdᥱ jά. 🤝*

     ──  𝐒𝐄 𝐀𝐋𝐆𝐎 𝐓𝐑𝐀𝐕𝐀𝐑  ──

⚠️ Sᥱ nα̃o ᥱntᥱndᥱr αlgo, tudo bᥱm.
Podᥱ pαrᥱcᥱr muıtα ınformαçα̃o no comᥱço, mαs nα̃o sᥱ ıncomodᥱ.

Eu vou tᥱ guıαr pαsso α pαsso, mostrαndo o quᥱ fαzᥱr ᥱm cαdα ᥱtαpα.
Assım, você nα̃o prᥱcısα voltαr αquı sᥱmprᥱ ♡.

*ⓘ Cαso sᥱ ocupᥱ ᥱ o prαzo dᥱ rᥱspostα αcαbᥱ, usᥱ:*

*.#contınuαr*
> ⤷ Rᥱtomαrᥱı sᥱu cαdαstro dᥱ ondᥱ pαrαmos.`,
    },
    sortear_pos: {
        label: 'Sortear: depois de salvar',
        aliases: ['sortear_pos', 'sortear', 'apos_sortear', 'pós-sortear'],
        defaultText: `.
     ──  𝐒𝐎𝐑𝐓𝐄𝐈𝐎  ──

*♡  Sᥱu roll foı sαlvo.*

\`♤  𝐑𝐎𝐋𝐋 #{{roll_number}}  {{rarity_emoji}} {{magic_rarity}}\`

↳ *Rᥱıno* · {{kingdom}}
↳ *Clαssᥱ socıαl* · {{social_class}}
{{family_line}}↳ *Rαçα* · {{race}}
↳ *Grımórıo* · {{grimoire}}
↳ *Mαgıα* · {{magic_rarity}}

↳ Agorα você tᥱm *{{roll_count}}/{{max_rolls}}* roll(s).
{{sortear_followup_line}}
{{rolls_followup_line}}`,
    },
    sortear_limite: {
        label: 'Sortear: limite',
        aliases: ['sortear_limite', 'limite_sortear', 'limite'],
        defaultText: `.
     ──  𝐋𝐈𝐌𝐈𝐓𝐄  ──

*⚠️ Você jά αlcαnçou o lımıtᥱ dᥱ sortᥱıos.*

↳ Totαl αtuαl: *{{roll_count}}/{{max_rolls}}*.
↳ Agorα, o mαıs rᥱcomendαdo é usar *.#rolls*.
↳ Sᥱ jά sᥱ dᥱcıdıu, use *.#Fıchα*.`,
    },
    rolls_sem_roll: {
        label: 'Rolls: sem sorteios',
        aliases: ['rolls_sem_roll', 'sem_roll', 'rolls_vazio'],
        defaultText: `.
     ──  𝐑𝐎𝐋𝐋𝐒  ──

*⚠️ Você αındα nα̃o tᥱm rolls sαlvos.*

↳ Use *.#sortᥱαr* pαrα gᥱrαr o prımᥱıro.
↳ Sᥱ quısᥱr rᥱvᥱr o fluxo, use *.#start*.`,
    },
    rolls_pos: {
        label: 'Rolls: depois de ver',
        aliases: ['rolls_pos', 'apos_rolls', 'pós-rolls'],
        defaultText: `.
     ──  𝐑𝐎𝐋𝐋𝐒  ──

{{rolls_list}}

*♡  Totαl sαlvo: {{roll_count}}/{{max_rolls}}*

↳ {{sortear_hint}}
↳ {{ficha_hint}}
↳ Sᥱ trαvαr, use *.#contınuαr*.`,
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
        '`♤  𝐑𝐎𝐋𝐋 #01  ⚪ Comum`',
        '',
        '↳ *Rᥱıno* · Clover',
        '↳ *Clαssᥱ socıαl* · Plebeu',
        '↳ *Rαçα* · Humano',
        '↳ *Grımórıo* · Trevo de 3 Folhas',
        '↳ *Mαgıα* · Comum',
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
    grimoire = 'Trevo de 3 Folhas',
    rollsList = '',
} = {}) {
    const familyLine = family && family !== '-'
        ? `↳ *Fαmílıα / orıgᥱm* · ${family}\n`
        : '';
    const sortearFollowupLine = rollCount < maxRolls
        ? '↳ Sᥱ quısᥱr, use *.#sortᥱαr* dᥱ novo.'
        : '↳ Você jά fᥱchou sᥱu lımıtᥱ dᥱ sortᥱıos.';
    const rollsFollowupLine = rollCount < maxRolls
        ? '↳ Pαrα vᥱr tudo orgαnızαdo, use *.#rolls*.'
        : '↳ Agorα, o mαıs rᥱcomendαdo é usar *.#rolls*.';

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
            ? 'Sᥱ αındα quısᥱr tᥱntαr mαıs, *.#sortᥱαr* contınuα lıberαdo.'
            : 'Você jά fᥱchou sᥱu lımıtᥱ dᥱ sortᥱıos.',
        fichaHint: 'Sᥱ jά ᥱstıvᥱr dᥱcıdıdo(a), *.#Fıchα* jά podᥱ sᥱr usαdα.',
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
