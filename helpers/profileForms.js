const { assertLifecycleAllowed, lifecycleSkip, isPreResetLifecycle } = require('./clover/lifecyclePolicy');
const { COMMAND_PREFIX } = require('../config/bot');
const { collapseWhitespace, getClosestTextMatches, normalizeText, stripMarkdown } = require('./textUtils');
const { getPlayerRollByNumber } = require('./rollManager');
const {
    findMagicOption,
    findMagicOptions,
    getAllMagics,
    getAvailableMagicsForRoll,
    getMagicSlotKey,
    getPendingMagicConfirmation,
    clearPendingMagicConfirmation,
} = require('./magicManager');
const {
    canReserve,
    getCapacity,
    occupySlot,
    releasePlayerCategorySlotsExcept,
} = require('./clover/slotManager');
const { validateTraitSubmission } = require('./clover/traitManager');
const { isFamilyApplicableForRoll, validateFamilyChoice } = require('./clover/profileRules');

const PROFILE_TEMPLATE_COMMAND = `${COMMAND_PREFIX}Ficha`;
const PROFILE_SUBMISSION_COMMAND = `${COMMAND_PREFIX}Ficha Pessoal`;
const NO_FAMILY_KEY = 'sem_linhagem';
const MIN_CHARACTER_AGE = 15;
const PROFILE_SUBMISSION_ALIASES = [
    `${COMMAND_PREFIX}Fichapessoal`,
    `${COMMAND_PREFIX}𝐅icha 𝐏essoal`,
];
const PROFILE_CONFIRMATION_TTL_DAYS = 7;
const HEART_ELEMENTAL_MAGIC_CORES = new Set([
    'agua',
    'ar',
    'areia',
    'arvore',
    'fogo',
    'gelo',
    'neve',
    'plantas',
    'plantas venenosas',
    'raio',
    'terra',
    'vento',
]);
const OPTIONAL_PROFILE_FIELDS = new Set([
    'familia',
    'magia',
    'tentativa_especial_1',
    'tentativa_especial_2',
    'aptidao_rara',
    'marca_rara',
    'anomalia',
]);

const genderMap = {
    m: 'Masculino',
    masc: 'Masculino',
    masculino: 'Masculino',
    homem: 'Masculino',
    macho: 'Masculino',
    male: 'Masculino',
    f: 'Feminino',
    fem: 'Feminino',
    feminino: 'Feminino',
    femenino: 'Feminino',
    femino: 'Feminino',
    feminijuo: 'Feminino',
    mulher: 'Feminino',
    femea: 'Feminino',
    female: 'Feminino',
    nb: 'Não binário',
    'nao binario': 'Não binário',
    'não binário': 'Não binário',
    'non binary': 'Não binário',
    'nao-binario': 'Não binário',
    outro: 'Outro',
    outra: 'Outro',
    na: 'N/A',
    'n a': 'N/A',
};

function normalizeLabel(value) {
    return normalizeText(stripMarkdown(value)).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeValue(value) {
    return collapseWhitespace(stripMarkdown(value));
}

function normalizeMagicCoreForWarning(value) {
    return normalizeText(stripMarkdown(value))
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^magia\s+(de|da|do|das|dos)\s+/, '')
        .replace(/^magia\s+/, '')
        .trim();
}

function isHeartRoll(roll) {
    const kingdomKey = normalizeMagicCoreForWarning(roll?.kingdom_key || roll?.kingdomKey || '');
    const kingdomName = normalizeMagicCoreForWarning(roll?.kingdom || '');
    return kingdomKey === 'heart' || kingdomName === 'heart';
}

function isElementalMagicForHeart(value) {
    return HEART_ELEMENTAL_MAGIC_CORES.has(normalizeMagicCoreForWarning(value));
}

function renderHeartElementalWarning(payload, player = null) {
    const magicAlreadyChosen = player?.magia && player.magia !== '-';
    const magicLabel = payload?.magic?.label || (magicAlreadyChosen ? player.magia : null);

    if (!isHeartRoll(payload?.roll) || !magicLabel || isElementalMagicForHeart(magicLabel)) {
        return null;
    }

    return [
        '♧ 𝐀𝐕𝐈𝐒𝐎 𝐃𝐄 𝐇𝐄𝐀𝐑𝐓',
        '',
        `Você escolheu *Heart* com *${magicLabel}*.`,
        '',
        'Heart tem vários benefícios exclusivos ligados a magia elemental, runas e mana natural.',
        'Seguir sem magia elemental pode fazer o personagem perder parte desses benefícios exclusivos.',
        '',
        `Se quiser trocar, corrija o campo *Magia* na ficha antes de usar *${COMMAND_PREFIX}confirmarFicha*.`,
        `Se estiver tudo certo, use *${COMMAND_PREFIX}confirmarFicha* normalmente.`,
    ].join('\n');
}

function parseNumber(value) {
    const match = String(value || '').match(/\d+/);
    return match ? Number(match[0]) : null;
}

function isBlankChoice(value) {
    const normalized = normalizeText(value)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return !normalized
        || normalized === '-'
        || normalized === 'n a'
        || normalized === 'na'
        || normalized === 'nao'
        || normalized === 'nao se aplica'
        || normalized === 'nenhuma'
        || normalized === 'nenhum';
}

function looksLikePlaceholder(value) {
    const normalized = normalizeText(value);
    return [
        'seu nome aqui',
        'sua idade real',
        'autoexplicativo',
        'coloque o personagem',
        'identifique de alguma forma',
        'ponha aqui o numero do roll',
        'sua idade',
    ].some((snippet) => normalized.includes(snippet));
}

function canonicalGender(value) {
    const normalized = normalizeText(value)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (normalized.startsWith('fem')) return 'Feminino';
    return genderMap[normalized] || null;
}

function normalizeAppearanceValue(value) {
    const normalized = normalizeText(value).replace(/[^a-z0-9]+/g, ' ');
    return normalized
        .split(/\s+/)
        .filter(Boolean)
        .join(' ');
}

function isAppearanceDetailed(value) {
    const cleaned = normalizeValue(value);
    const normalized = normalizeText(cleaned);
    const words = normalized.split(/\s+/).filter(Boolean);

    if (!cleaned) return false;
    if (cleaned.length < 2 || words.length < 1) return false;
    if (looksLikePlaceholder(cleaned)) return false;
    return true;
}

function resolveField(section, label) {
    const key = normalizeLabel(label).replace(/\s+/g, '');

    if (section === 'pessoal') {
        if (key.includes('disponibilidade')) return 'disponibilidade_detalhada';
        if (key.includes('gosta') || key.includes('hobb')) return 'gosta_de_fazer';
        if (key.includes('idade')) return 'idade_real';
        if (key.includes('nome')) return 'nome_real';
        return null;
    }

    if (key.includes('roll')) return 'numero_roll';
    if (key.includes('tentativa') && key.includes('1')) return 'tentativa_especial_1';
    if (key.includes('tentativa') && key.includes('2')) return 'tentativa_especial_2';
    if (key.includes('aptidao') && key.includes('rara')) return 'aptidao_rara';
    if (key.includes('aptidao')) return 'aptidao_comum';
    if (key.includes('marca') && key.includes('rara')) return 'marca_rara';
    if (key.includes('marca')) return 'marca_comum';
    if (key.includes('anomalia')) return 'anomalia';
    if (key.includes('familia')) return 'familia';
    if (key.includes('magia')) return 'magia';
    if (key.includes('gener') || key.includes('gner') || key.includes('sexo')) return 'personagem_genero';
    if (key.includes('apar')) return 'personagem_aparencia';
    if (key.includes('idade')) return 'personagem_idade';
    if (key.includes('nome')) return 'personagem_nome';
    return null;
}

function safeTemplateValue(value) {
    const normalized = normalizeValue(value);
    return normalized && normalized !== '-' ? normalized : '';
}

function renderRollPreview(prefill = {}) {
    if (!prefill.roll) return [];

    const roll = prefill.roll;
    const grimoire = safeTemplateValue(roll.grimoire).replace(/\bGrimorio\b/g, 'Grimório');
    return [
        '     --  roll escolhido  --',
        '',
        `> Roll #${roll.roll_number || prefill.numeroRoll || '-'}`,
        `> Reino ${roll.kingdom || '-'}`,
        `> Classe ${roll.social_class || '-'}`,
        `> Raça ${roll.race || '-'}`,
        `> Grimório ${grimoire || '-'}`,
        `> Raridade mágica ${roll.magic_rarity || '-'}`,
        '',
    ];
}

function renderProfileTemplate(prefill = {}) {
    return [
        '.#Ficha pessoal',
        '     --  dados do jogador  --',
        '',
        `*Nome:* ${safeTemplateValue(prefill.nomeReal)}`,
        `*Idade pessoal:* ${safeTemplateValue(prefill.idadeReal)}`,
        `*O que gosta de fazer:* ${safeTemplateValue(prefill.gostaDeFazer)}`,
        `*Disponibilidade detalhada:* ${safeTemplateValue(prefill.disponibilidadeDetalhada)}`,
        '',
        ...renderRollPreview(prefill),
        '     --  dados do personagem  --',
        '',
        `*Nome:* ${safeTemplateValue(prefill.personagemNome)}`,
        `*Idade do personagem (mínimo ${MIN_CHARACTER_AGE}):* ${safeTemplateValue(prefill.personagemIdade)}`,
        `*Aparência:* ${safeTemplateValue(prefill.personagemAparencia)}`,
        `*Gênero:* ${safeTemplateValue(prefill.personagemGenero)}`,
        `*Número do Roll:* ${safeTemplateValue(prefill.numeroRoll)}`,
        `*Família:* ${safeTemplateValue(prefill.familia)}`,
        `*Magia:* ${safeTemplateValue(prefill.magia)}`,
        '',
        '     --  traços  --',
        '',
        `*Aptidão:* ${safeTemplateValue(prefill.aptidao)}`,
        `*Marca:* ${safeTemplateValue(prefill.marca)}`,
        `*Anomalia:* ${safeTemplateValue(prefill.anomalia)}`,
        '',
        '     --  observações  --',
        '',
        `> Idade do personagem precisa ter no mínimo ${MIN_CHARACTER_AGE}.`,
        '> Família pode ficar em branco, N/A ou Nenhuma.',
        '> Magia pode ser preenchida direto na ficha se for compatível com o roll.',
    ].join('\n');
}

function parseProfileSubmission(body) {
    const lines = String(body || '').split('\n');
    const fields = {
        nome_real: null,
        idade_real: null,
        gosta_de_fazer: null,
        disponibilidade_detalhada: null,
        personagem_nome: null,
        personagem_idade: null,
        personagem_aparencia: null,
        personagem_genero: null,
        numero_roll: null,
        familia: null,
        magia: null,
        aptidao_comum: null,
        marca_comum: null,
        tentativa_especial_1: null,
        tentativa_especial_2: null,
        aptidao_rara: null,
        marca_rara: null,
        anomalia: null,
    };
    const duplicates = [];
    const unknownFields = [];
    const placeholders = [];

    let currentSection = 'pessoal';
    let sawCharacterHeader = false;

    for (const rawLine of lines) {
        const cleanedLine = normalizeValue(rawLine);
        const normalizedLine = normalizeLabel(rawLine);
        if (!cleanedLine) continue;

        if (normalizedLine.includes('ficha pessoal')) {
            currentSection = 'pessoal';
            continue;
        }

        if (normalizedLine.includes('dados do jogador')) {
            currentSection = 'pessoal';
            continue;
        }

        if (normalizedLine.includes('ficha de personagem') || normalizedLine.includes('dados do personagem')) {
            currentSection = 'personagem';
            sawCharacterHeader = true;
            continue;
        }

        if (normalizedLine.includes('aptidao') && normalizedLine.includes('marca')) {
            currentSection = 'personagem';
            sawCharacterHeader = true;
            continue;
        }

        if (!cleanedLine.includes(':')) continue;

        const separatorIndex = cleanedLine.indexOf(':');
        const labelRaw = cleanedLine.slice(0, separatorIndex);
        const valueRaw = cleanedLine.slice(separatorIndex + 1).trim();
        const fieldKey = resolveField(currentSection, labelRaw);

        if (!fieldKey) {
            unknownFields.push(cleanedLine);
            continue;
        }

        if (fields[fieldKey] !== null) {
            duplicates.push(normalizeLabel(labelRaw));
            continue;
        }

        if ((!valueRaw || looksLikePlaceholder(valueRaw)) && !OPTIONAL_PROFILE_FIELDS.has(fieldKey)) {
            placeholders.push(normalizeLabel(labelRaw));
        }

        fields[fieldKey] = valueRaw;
    }

    return {
        fields,
        duplicates,
        unknownFields,
        placeholders,
        sawCharacterHeader,
    };
}

function looksLikeProfileSubmission(body) {
    const normalized = normalizeText(body)
        .replace(/\s+/g, ' ')
        .trim();

    return [
        '.#ficha pessoal',
        '#ficha pessoal',
    ].some((marker) => normalized.startsWith(marker) || normalized.includes(marker));
}

function buildProfileTemplatePrefill({ player = null, pending = null, rollNumber = null, magicLabel = null, roll = null } = {}) {
    const traits = pending?.traits || {};
    const firstFilled = (...values) => values.find((value) => safeTemplateValue(value)) || '';
    return {
        roll,
        nomeReal: firstFilled(pending?.nomeReal, player?.nome_real),
        idadeReal: firstFilled(pending?.idadeReal, player?.idade_real),
        gostaDeFazer: firstFilled(pending?.gostaDeFazer, player?.gosta_de_fazer),
        disponibilidadeDetalhada: firstFilled(pending?.disponibilidadeDetalhada, player?.disponibilidade_detalhada),
        personagemNome: firstFilled(pending?.personagemNome, player?.personagem_nome),
        personagemIdade: firstFilled(pending?.personagemIdade, player?.personagem_idade),
        personagemAparencia: firstFilled(pending?.personagemAparencia, player?.personagem_aparencia),
        personagemGenero: firstFilled(pending?.personagemGenero, player?.personagem_genero),
        numeroRoll: firstFilled(rollNumber, pending?.numeroRoll, player?.numero_roll_escolhido),
        familia: firstFilled(pending?.family?.name, player?.familia),
        magia: firstFilled(magicLabel, pending?.magic?.label, player?.magia),
        aptidao: firstFilled(traits.rareAptitude?.name, traits.commonAptitude?.name, player?.aptidao_rara, player?.aptidao_comum),
        marca: firstFilled(traits.rareMark?.name, traits.commonMark?.name, player?.marca_rara, player?.marca_comum),
        anomalia: firstFilled(traits.anomaly?.name, player?.anomalia),
    };
}

async function findAppearanceConflict(db, playerId, appearanceValue) {
    const signature = normalizeAppearanceValue(appearanceValue);
    if (!signature) return null;

    const players = await db.all(
        `SELECT id, personagem_nome, personagem_aparencia, personagem_aparencia_normalizada
         FROM jogadores
         WHERE id <> ?
           AND ficha_status IN ('confirmada', 'aprovada')
           AND personagem_aparencia IS NOT NULL
           AND personagem_aparencia <> '-'`,
        [playerId]
    );

    return players.find((player) => {
        const storedSignature = player.personagem_aparencia_normalizada
            || normalizeAppearanceValue(player.personagem_aparencia);
        return storedSignature === signature;
    }) || null;
}

function getLimitedRollSlot(category, roll) {
    const key = category === 'race' ? roll?.race_key : roll?.grimoire_key;
    if (!key) return null;

    try {
        const capacity = getCapacity(category, key);
        return capacity === null ? null : { category, key, capacity };
    } catch {
        return null;
    }
}

async function analyzeProfileSubmission(db, playerId, body) {
    const parsed = parseProfileSubmission(body);
    const errors = [];

    if (!parsed.sawCharacterHeader) {
        errors.push('A ficha precisa manter o bloco de dados do personagem.');
    }

    if (parsed.unknownFields.length > 0) {
        errors.push('Encontrei campos fora do modelo da ficha.');
    }

    if (parsed.duplicates.length > 0) {
        errors.push('Encontrei campos repetidos na ficha.');
    }

    if (parsed.placeholders.length > 0) {
        errors.push('Alguns campos ainda parecem estar com texto de exemplo.');
    }

    const fields = parsed.fields;
    const idadeReal = parseNumber(fields.idade_real);
    const idadePersonagem = parseNumber(fields.personagem_idade);
    const generoCanonical = fields.personagem_genero ? canonicalGender(fields.personagem_genero) : null;
    const rollNumber = parseNumber(fields.numero_roll);

    if (!normalizeValue(fields.nome_real)) {
        errors.push('O nome da ficha pessoal não pode ficar vazio.');
    }

    if (!idadeReal || idadeReal <= 0) {
        errors.push('A idade pessoal precisa ser informada. Ela não tem idade mínima.');
    }

    if (!normalizeValue(fields.gosta_de_fazer)) {
        errors.push('O campo "O que gosta de fazer" não pode ficar vazio.');
    }

    if (!normalizeValue(fields.disponibilidade_detalhada)) {
        errors.push('O campo "Disponibilidade detalhada" não pode ficar vazio.');
    }

    if (!normalizeValue(fields.personagem_nome)) {
        errors.push('O nome do personagem não pode ficar vazio.');
    }

    if (!idadePersonagem || idadePersonagem < MIN_CHARACTER_AGE) {
        errors.push(`A idade do personagem precisa ser válida e ter no mínimo ${MIN_CHARACTER_AGE} anos.`);
    }

    if (!generoCanonical) {
        errors.push('O gênero precisa ser Masculino, Feminino, Não binário, Outro ou N/A.');
    }

    if (!isAppearanceDetailed(fields.personagem_aparencia)) {
        errors.push('A aparência precisa estar preenchida e identificar personagem e obra.');
    }

    const appearanceConflict = null;

    if (!rollNumber) {
        errors.push('O número do roll informado não é válido.');
    }

    let roll = null;
    if (rollNumber) {
        roll = await getPlayerRollByNumber(db, playerId, rollNumber);
        if (!roll) {
            errors.push('O número do roll informado não foi encontrado nos seus rolls salvos.');
        }
    }

    let family = null;
    let familyApplies = false;
    if (roll) {
        const familyValidation = validateFamilyChoice(fields.familia, roll);
        family = familyValidation.family;
        familyApplies = familyValidation.applies !== false;
        errors.push(...familyValidation.errors);
    }

    const player = await db.get('SELECT numero_roll_escolhido, magia FROM jogadores WHERE id = ?', [playerId]);
    const pendingMagic = await getPendingMagicConfirmation(db, playerId);

    let magicChoice = null;
    if (roll && !isBlankChoice(fields.magia)) {
        const allMatches = findMagicOptions(getAllMagics(), fields.magia);
        const availableMatches = findMagicOptions(getAvailableMagicsForRoll(roll), fields.magia);

        if (allMatches.length > 1 && availableMatches.length > 1) {
            errors.push(`A magia informada ficou ambigua. Opcoes proximas: ${availableMatches.slice(0, 6).map((item) => item.label).join(', ')}.`);
        } else if (availableMatches.length) {
            magicChoice = availableMatches[0];
        } else {
            const existingMagic = allMatches[0] || findMagicOption(getAllMagics(), fields.magia);
            const suggestions = existingMagic ? [] : getClosestTextMatches(fields.magia, getAllMagics());
            errors.push(existingMagic
                ? `A magia informada não é compatível com a raridade do roll escolhido.`
                : `A magia informada não existe.${suggestions.length ? ` Opções próximas: ${suggestions.join(', ')}.` : ''}`);
        }
    } else if (roll && pendingMagic?.magic_label && (!pendingMagic.roll_number || Number(pendingMagic.roll_number) === Number(roll.roll_number))) {
        magicChoice = findMagicOption(getAvailableMagicsForRoll(roll), pendingMagic.magic_label);
    }

    if (roll && !magicChoice && player?.magia && player.magia !== '-') {
        magicChoice = findMagicOption(getAvailableMagicsForRoll(roll), player.magia);
    }

    if (roll && !magicChoice) {
        errors.push(`O campo "Magia" precisa estar preenchido com uma magia compatível com o roll.`);
    }

    const traitValidation = await validateTraitSubmission(db, playerId, fields);
    errors.push(...traitValidation.errors);

    return {
        ok: errors.length === 0,
        errors,
        payload: {
            nomeReal: normalizeValue(fields.nome_real),
            idadeReal,
            gostaDeFazer: normalizeValue(fields.gosta_de_fazer),
            disponibilidadeDetalhada: normalizeValue(fields.disponibilidade_detalhada),
            personagemNome: normalizeValue(fields.personagem_nome),
            personagemIdade: idadePersonagem,
            personagemAparencia: normalizeValue(fields.personagem_aparencia),
            personagemAparenciaNormalizada: normalizeAppearanceValue(fields.personagem_aparencia),
            personagemGenero: generoCanonical,
            numeroRoll: rollNumber,
            roll,
            family,
            familyApplies,
            magic: magicChoice,
            magicKey: magicChoice ? getMagicSlotKey(magicChoice.label) : null,
            traits: traitValidation.payload,
            appearanceConflict,
        },
    };
}

async function savePendingConfirmation(db, playerId, payload) {
    assertLifecycleAllowed({surface:'internal',operation:'savePendingConfirmation',mutationClass:'CURRENT_WORLD'});

    await purgeExpiredProfileConfirmations(db);
    await db.run(
        `INSERT INTO pending_profile_confirmations (player_id, payload, created_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(player_id) DO UPDATE SET payload = excluded.payload, created_at = CURRENT_TIMESTAMP`,
        [playerId, JSON.stringify(payload)]
    );
}

async function purgeExpiredProfileConfirmations(db) {
    await db.run(
        `DELETE FROM pending_profile_confirmations
         WHERE created_at < datetime('now', ?)`,
        [`-${PROFILE_CONFIRMATION_TTL_DAYS} days`]
    );
}

async function getPendingConfirmation(db, playerId) {
    await purgeExpiredProfileConfirmations(db);
    const row = await db.get(
        `SELECT payload
         FROM pending_profile_confirmations
         WHERE player_id = ?`,
        [playerId]
    );

    if (!row) return null;
    try {
        return JSON.parse(row.payload);
    } catch {
        return null;
    }
}

async function clearPendingConfirmation(db, playerId) {
    await db.run('DELETE FROM pending_profile_confirmations WHERE player_id = ?', [playerId]);
}

async function confirmPendingProfile(db, playerId) {
    assertLifecycleAllowed({surface:'internal',operation:'confirmPendingProfile',mutationClass:'CURRENT_WORLD'});

    const payload = await getPendingConfirmation(db, playerId);
    if (!payload) return { ok: false, reason: 'missing_pending' };

    const finalErrors = [];
    const currentPlayer = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    const currentRoll = payload.numeroRoll
        ? await getPlayerRollByNumber(db, playerId, payload.numeroRoll)
        : null;

    if (!currentRoll) {
        finalErrors.push('O roll escolhido não existe mais. Reenvie a ficha com um roll válido.');
    } else {
        payload.roll = currentRoll;
    }

    const noFamilySelected = payload.family?.key === NO_FAMILY_KEY;
    const familyApplies = noFamilySelected || (currentRoll ? isFamilyApplicableForRoll(currentRoll) : payload.familyApplies !== false);
    if (familyApplies && !payload.family?.key) {
        finalErrors.push('Família pendente inválida. Reenvie a ficha.');
    } else if (familyApplies) {
        const familySlot = await canReserve(db, 'family', payload.family.key, { excludePlayerId: playerId });
        if (!familySlot.ok) {
            finalErrors.push('A família escolhida ficou sem vagas. Troque a família e reenvie a ficha.');
        }
    }

    const pendingMagic = await getPendingMagicConfirmation(db, playerId);
    let finalMagic = null;
    let finalMagicKey = null;
    const availableMagics = currentRoll ? getAvailableMagicsForRoll(currentRoll) : [];

    if (payload.magic?.label && currentRoll) {
        finalMagic = findMagicOption(availableMagics, payload.magic.label);
        if (!finalMagic) {
            finalErrors.push('A magia preenchida na ficha não é compatível com o roll escolhido.');
        } else {
            finalMagicKey = getMagicSlotKey(finalMagic.label);
        }
    } else if (pendingMagic && currentRoll && (!pendingMagic.roll_number || Number(pendingMagic.roll_number) === Number(payload.numeroRoll))) {
        finalMagic = findMagicOption(availableMagics, pendingMagic.magic_label);
        if (!finalMagic) {
            finalErrors.push('A magia pendente não é compatível com o roll escolhido. Preencha outra magia na ficha.');
        } else {
            finalMagicKey = getMagicSlotKey(finalMagic.label);
        }
    } else if (currentPlayer?.magia && currentPlayer.magia !== '-') {
        finalMagic = findMagicOption(availableMagics, currentPlayer.magia);
        if (!finalMagic) {
            finalErrors.push('A magia salva anteriormente não é compatível com o roll escolhido. Preencha outra magia na ficha.');
        } else {
            finalMagicKey = currentPlayer.magia_key || getMagicSlotKey(finalMagic.label);
        }
    } else {
        finalErrors.push('Escolha uma magia na ficha ou use .#magias antes de confirmar.');
    }

    if (finalMagic?.capacity) {
        const magicSlot = await canReserve(db, 'magic', finalMagicKey, { excludePlayerId: playerId });
        if (!magicSlot.ok) {
            finalErrors.push('A magia escolhida ficou sem vagas. Troque a magia e reenvie a ficha.');
        }
    }

    if (payload.traits?.anomaly?.key) {
        const anomalySlot = await canReserve(db, 'anomaly', payload.traits.anomaly.key, { excludePlayerId: playerId });
        if (!anomalySlot.ok) {
            finalErrors.push('A anomalia escolhida ficou sem vagas. Troque ou remova a anomalia e reenvie a ficha.');
        }
    }

    const raceSlot = currentRoll ? getLimitedRollSlot('race', currentRoll) : null;
    if (raceSlot) {
        const availableRace = await canReserve(db, 'race', raceSlot.key, { excludePlayerId: playerId });
        if (!availableRace.ok) {
            finalErrors.push('A raça sorteada ficou sem vagas. Escolha outro roll ou refaça os rolls disponíveis.');
        }
    }

    const grimoireSlot = currentRoll ? getLimitedRollSlot('grimoire', currentRoll) : null;
    if (grimoireSlot) {
        const availableGrimoire = await canReserve(db, 'grimoire', grimoireSlot.key, { excludePlayerId: playerId });
        if (!availableGrimoire.ok) {
            finalErrors.push('O grimório sorteado ficou sem vagas. Escolha outro roll ou refaça os rolls disponíveis.');
        }
    }

    if (finalErrors.length) {
        return {
            ok: false,
            reason: 'final_validation_failed',
            errors: finalErrors,
            payload,
        };
    }

    if (familyApplies && payload.family?.key) {
        const occupiedFamily = await occupySlot(db, playerId, 'family', payload.family.key, 'profile_family', payload.numeroRoll);
        if (!occupiedFamily.ok) {
            return {
                ok: false,
                reason: 'family_full',
                errors: ['A família escolhida ficou sem vagas. Troque a família e reenvie a ficha.'],
                payload,
            };
        }
    }

    if (finalMagic?.capacity) {
        const occupiedMagic = await occupySlot(db, playerId, 'magic', finalMagicKey, 'profile_magic', payload.numeroRoll);
        if (!occupiedMagic.ok) {
            return {
                ok: false,
                reason: 'magic_full',
                errors: ['A magia escolhida ficou sem vagas. Troque a magia e reenvie a ficha.'],
                payload,
            };
        }
    }
    if (finalMagicKey) {
        await releasePlayerCategorySlotsExcept(db, playerId, 'magic', finalMagicKey);
    }

    if (payload.traits?.anomaly?.key) {
        const occupiedAnomaly = await occupySlot(db, playerId, 'anomaly', payload.traits.anomaly.key, 'profile_anomaly', payload.numeroRoll);
        if (!occupiedAnomaly.ok) {
            return {
                ok: false,
                reason: 'anomaly_full',
                errors: ['A anomalia escolhida ficou sem vagas. Troque ou remova a anomalia e reenvie a ficha.'],
                payload,
            };
        }
    }

    if (raceSlot) {
        const occupiedRace = await occupySlot(db, playerId, 'race', raceSlot.key, 'profile_race', payload.numeroRoll);
        if (!occupiedRace.ok) {
            return {
                ok: false,
                reason: 'race_full',
                errors: ['A raça sorteada ficou sem vagas. Escolha outro roll ou refaça os rolls disponíveis.'],
                payload,
            };
        }
    }

    if (grimoireSlot) {
        const occupiedGrimoire = await occupySlot(db, playerId, 'grimoire', grimoireSlot.key, 'profile_grimoire', payload.numeroRoll);
        if (!occupiedGrimoire.ok) {
            return {
                ok: false,
                reason: 'grimoire_full',
                errors: ['O grimório sorteado ficou sem vagas. Escolha outro roll ou refaça os rolls disponíveis.'],
                payload,
            };
        }
    }

    if (raceSlot) {
        await releasePlayerCategorySlotsExcept(db, playerId, 'race', raceSlot.key);
    }
    if (grimoireSlot) {
        await releasePlayerCategorySlotsExcept(db, playerId, 'grimoire', grimoireSlot.key);
    }

    const nextFichaStatus = 'aprovada';
    const traits = payload.traits || {};

    await db.run(
        `UPDATE jogadores
         SET nome_real = ?,
             idade_real = ?,
             gosta_de_fazer = ?,
             disponibilidade_detalhada = ?,
             personagem_nome = ?,
             personagem_idade = ?,
             personagem_aparencia = ?,
             personagem_aparencia_normalizada = ?,
             personagem_aparencia_status = 'pending',
             personagem_aparencia_motivo = NULL,
             personagem_aparencia_approved_by = NULL,
             personagem_aparencia_approved_at = NULL,
             personagem_aparencia_updated_at = CURRENT_TIMESTAMP,
             personagem_genero = ?,
             numero_roll_escolhido = ?,
             ficha_status = ?,
             nome = ?,
             idade = ?,
             aparencia = ?,
             reino = ?,
             classe = ?,
             familia = ?,
             raca = ?,
             grimorio = ?,
             familia_key = ?,
             magia = ?,
             magia_key = ?,
             aptidao_comum = ?,
             aptidao_comum_key = ?,
             marca_comum = ?,
             marca_comum_key = ?,
             aptidao_rara = ?,
             aptidao_rara_key = ?,
             marca_rara = ?,
             marca_rara_key = ?,
             anomalia = ?,
             anomalia_key = ?,
             tentativas_especiais = ?,
             jogo_status = 'bloqueado',
             jogo_liberado_at = NULL,
             jogo_liberado_by = NULL,
             jogo_bloqueio_motivo = NULL
         WHERE id = ?`,
        [
            payload.nomeReal,
            payload.idadeReal,
            payload.gostaDeFazer,
            payload.disponibilidadeDetalhada || '-',
            payload.personagemNome,
            payload.personagemIdade,
            payload.personagemAparencia,
            payload.personagemAparenciaNormalizada || normalizeAppearanceValue(payload.personagemAparencia),
            payload.personagemGenero,
            payload.numeroRoll,
            nextFichaStatus,
            payload.personagemNome,
            String(payload.personagemIdade),
            payload.personagemAparencia,
            payload.roll.kingdom,
            payload.roll.social_class,
            familyApplies ? payload.family.name : '-',
            payload.roll.race,
            payload.roll.grimoire,
            familyApplies ? payload.family.key : null,
            finalMagic.label,
            finalMagicKey,
            traits.commonAptitude?.name || '-',
            traits.commonAptitude?.key || null,
            traits.commonMark?.name || '-',
            traits.commonMark?.key || null,
            traits.rareAptitude?.name || '-',
            traits.rareAptitude?.key || null,
            traits.rareMark?.name || '-',
            traits.rareMark?.key || null,
            traits.anomaly?.name || '-',
            traits.anomaly?.key || null,
            JSON.stringify(traits.attempts || []),
            playerId,
        ]
    );

    await clearPendingConfirmation(db, playerId);
    await clearPendingMagicConfirmation(db, playerId);
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);

    return {
        ok: true,
        payload,
        player,
    };
}

function renderValidationErrors(errors) {
    return [
        '♧ 𝐅𝐈𝐂𝐇𝐀 𝐂𝐎𝐌 𝐀𝐉𝐔𝐒𝐓𝐄𝐒',
        '',
        'Sua ficha não foi apagada.',
        'Só encontrei alguns pontos para corrigir:',
        '',
        ...errors.map((error) => `• ${error}`),
        '',
        'Corrija a ficha e envie novamente respondendo o modelo.',
        `Se precisar do modelo de novo, use *${PROFILE_TEMPLATE_COMMAND}*.`,
    ].join('\n');
}

function renderConfirmationSummary(payload, player = null) {
    const magicAlreadyChosen = player?.magia && player.magia !== '-';
    const magicLabel = payload.magic?.label || (magicAlreadyChosen ? player.magia : '-');
    const lines = [
        '♧ 𝐅𝐈𝐂𝐇𝐀 𝐕𝐀𝐋𝐈𝐃𝐀𝐃𝐀',
        '     ──  clover rpg · confirmação  ──',
        '',
        'A ficha passou pela validação base.',
        'Confira se está tudo certo antes de fechar.',
        '',
        '──  𝐉𝐎𝐆𝐀𝐃𝐎𝐑  ──',
        '',
        `> ⤷ *Nome:* ${payload.nomeReal}`,
        `> ⤷ *Idade pessoal:* ${payload.idadeReal}`,
        `> ⤷ *Gosta de fazer:* ${payload.gostaDeFazer}`,
        `> ⤷ *Disponibilidade:* ${payload.disponibilidadeDetalhada || '-'}`,
        '',
        '──  𝐏𝐄𝐑𝐒𝐎𝐍𝐀𝐆𝐄𝐌  ──',
        '',
        `> ⤷ *Nome:* ${payload.personagemNome}`,
        `> ⤷ *Idade:* ${payload.personagemIdade}`,
        `> ⤷ *Gênero:* ${payload.personagemGenero}`,
        `> ⤷ *Aparência:* ${payload.personagemAparencia}`,
        '',
        '──  𝐑𝐎𝐋𝐋 𝐄 𝐄𝐒𝐂𝐎𝐋𝐇𝐀𝐒  ──',
        '',
        `> ⤷ *Roll:* #${payload.numeroRoll}`,
        `> ⤷ *Reino:* ${payload.roll.kingdom}`,
        `> ⤷ *Classe social:* ${payload.roll.social_class}`,
        `> ⤷ *Raça:* ${payload.roll.race}`,
        `> ⤷ *Grimório:* ${payload.roll.grimoire}`,
        `> ⤷ *Raridade mágica:* ${payload.roll.magic_rarity}`,
        `> ⤷ *Família:* ${payload.family?.name || '-'}`,
        `> ⤷ *Magia:* ${magicLabel}`,
        `> ⤷ *Aptidão:* ${payload.traits?.rareAptitude?.name || payload.traits?.commonAptitude?.name || '-'}`,
        `> ⤷ *Marca:* ${payload.traits?.rareMark?.name || payload.traits?.commonMark?.name || '-'}`,
        `> ⤷ *Anomalia:* ${payload.traits?.anomaly?.name || '-'}`,
    ];

    lines.push('');
    lines.push('──  𝐀𝐆𝐎𝐑𝐀  ──');
    lines.push('');
    lines.push(`*̣${COMMAND_PREFIX}confirmarFicha*`);
    lines.push('> Fechar a ficha base.');
    lines.push(`*̣${COMMAND_PREFIX}ficha ${payload.numeroRoll}*`);
    lines.push('> Receber o modelo de novo, se quiser corrigir algo.');
    lines.push('');
    lines.push('ⓘ Seus rolls continuam salvos. Confirmar a ficha não apaga seus sorteios.');

    return lines.join('\n');
}

function renderConfirmedFicha(player, roll) {
    const manaTotal = Number.isFinite(Number(player.mana)) ? Number(player.mana) : null;
    const appearanceStatus = player.personagem_aparencia_status === 'approved'
        ? 'Aprovada'
        : player.personagem_aparencia_status === 'rejected'
        ? 'Negada'
        : 'Pendente';
    const lines = [
        '♧ 𝐅𝐈𝐂𝐇𝐀 𝐂𝐋𝐎𝐕𝐄𝐑',
        '     ──  clover rpg · dados atuais  ──',
        '',
        '──  𝐉𝐎𝐆𝐀𝐃𝐎𝐑  ──',
        '',
        `> ⤷ *Nome:* ${player.nome_real || '-'}`,
        `> ⤷ *Idade pessoal:* ${player.idade_real || '-'}`,
        `> ⤷ *Gosta de fazer:* ${player.gosta_de_fazer || '-'}`,
        `> ⤷ *Disponibilidade:* ${player.disponibilidade_detalhada || '-'}`,
        '',
        '──  𝐏𝐄𝐑𝐒𝐎𝐍𝐀𝐆𝐄𝐌  ──',
        '',
        `> ⤷ *Nome:* ${player.personagem_nome || '-'}`,
        `> ⤷ *Idade:* ${player.personagem_idade || '-'}`,
        `> ⤷ *Gênero:* ${player.personagem_genero || '-'}`,
        `> ⤷ *Aparência:* ${player.personagem_aparencia || '-'}`,
        `> ⤷ *Status da aparência:* ${appearanceStatus}`,
        '',
        '──  𝐄𝐒𝐂𝐎𝐋𝐇𝐀𝐒  ──',
        '',
        `> ⤷ *Roll escolhido:* ${player.numero_roll_escolhido ? `#${player.numero_roll_escolhido}` : '-'}`,
        `> ⤷ *Família:* ${player.familia || '-'}`,
        `> ⤷ *Magia:* ${player.magia && player.magia !== '-' ? player.magia : 'pendente'}`,
        `> ⤷ *Aptidão:* ${player.aptidao_comum || '-'}`,
        `> ⤷ *Marca:* ${player.marca_comum || '-'}`,
        `> ⤷ *Aptidão rara:* ${player.aptidao_rara || '-'}`,
        `> ⤷ *Marca rara:* ${player.marca_rara || '-'}`,
        `> ⤷ *Anomalia:* ${player.anomalia || '-'}`,
        `> ⤷ *Mana total:* ${manaTotal === null ? '-' : manaTotal}`,
    ];

    if (roll) {
        lines.push('');
        lines.push('──  𝐑𝐎𝐋𝐋 𝐕𝐈𝐍𝐂𝐔𝐋𝐀𝐃𝐎  ──');
        lines.push('');
        lines.push(`> ⤷ *Reino:* ${roll.kingdom}`);
        lines.push(`> ⤷ *Classe social:* ${roll.social_class}`);
        lines.push(`> ⤷ *Raça:* ${roll.race}`);
        lines.push(`> ⤷ *Grimório:* ${roll.grimoire}`);
        lines.push(`> ⤷ *Raridade mágica:* ${roll.magic_rarity}`);
    }

    lines.push(
        '',
        'ⓘ Use *̣.#status* para ver sua etapa atual.',
        'Use *̣.#aparencia* se precisar reenviar ou trocar aparência.'
    );

    return lines.join('\n');
}

module.exports = {
    MIN_CHARACTER_AGE,
    PROFILE_SUBMISSION_ALIASES,
    PROFILE_SUBMISSION_COMMAND,
    PROFILE_TEMPLATE_COMMAND,
    analyzeProfileSubmission,
    buildProfileTemplatePrefill,
    canonicalGender,
    clearPendingConfirmation,
    confirmPendingProfile,
    getPendingConfirmation,
    looksLikeProfileSubmission,
    isAppearanceDetailed,
    normalizeAppearanceValue,
    parseProfileSubmission,
    renderConfirmedFicha,
    renderConfirmationSummary,
    renderHeartElementalWarning,
    renderProfileTemplate,
    renderValidationErrors,
    savePendingConfirmation,
};
