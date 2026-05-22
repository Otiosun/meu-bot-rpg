const { COMMAND_PREFIX } = require('../config/bot');
const { collapseWhitespace, normalizeText, stripMarkdown } = require('./textUtils');
const { getPlayerRollByNumber } = require('./rollManager');

const PROFILE_TEMPLATE_COMMAND = `${COMMAND_PREFIX}Ficha`;
const PROFILE_SUBMISSION_COMMAND = `${COMMAND_PREFIX}Ficha Pessoal`;
const PROFILE_SUBMISSION_ALIASES = [
    `${COMMAND_PREFIX}Fichapessoal`,
    `${COMMAND_PREFIX}𝐅icha 𝐏essoal`,
];

const genderMap = {
    masculino: 'Masculino',
    homem: 'Masculino',
    macho: 'Masculino',
    feminino: 'Feminino',
    mulher: 'Feminino',
    femea: 'Feminino',
};

function normalizeLabel(value) {
    return normalizeText(stripMarkdown(value)).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeValue(value) {
    return collapseWhitespace(stripMarkdown(value));
}

function parseNumber(value) {
    const match = String(value || '').match(/\d+/);
    return match ? Number(match[0]) : null;
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
    return genderMap[normalizeText(value)] || null;
}

function appearanceSignature(value) {
    const normalized = normalizeText(value).replace(/[^a-z0-9 ]+/g, ' ');
    return normalized
        .split(/\s+/)
        .filter(Boolean)
        .sort()
        .join(' ');
}

function isAppearanceDetailed(value) {
    const cleaned = normalizeValue(value);
    const normalized = normalizeText(cleaned);
    const words = normalized.split(/\s+/).filter(Boolean);

    if (!cleaned) return false;
    if (cleaned.length < 10 || words.length < 3) return false;
    if (looksLikePlaceholder(cleaned)) return false;
    return true;
}

function resolveField(section, label) {
    const key = normalizeLabel(label).replace(/\s+/g, '');

    if (section === 'pessoal') {
        if (key.includes('gosta') || key.includes('hobb')) return 'gosta_de_fazer';
        if (key.includes('idade')) return 'idade_real';
        if (key.includes('nome')) return 'nome_real';
        return null;
    }

    if (key.includes('roll')) return 'numero_roll';
    if (key.includes('gener') || key.includes('gner') || key.includes('sexo')) return 'personagem_genero';
    if (key.includes('apar')) return 'personagem_aparencia';
    if (key.includes('idade')) return 'personagem_idade';
    if (key.includes('nome')) return 'personagem_nome';
    return null;
}

function renderProfileTemplate() {
    return [
        `🧾 *Modelo da ${PROFILE_TEMPLATE_COMMAND}*`,
        '',
        `${PROFILE_SUBMISSION_COMMAND}`,
        '',
        '# Ficha Pessoal',
        '*Nome:* ',
        '*Idade:* ',
        '*O que gosta de fazer:* ',
        '',
        '# Ficha de Personagem',
        '*Nome:* ',
        '*Idade:* ',
        '*Aparencia:* ',
        '*Genero:* ',
        '*Numero do Roll:* ',
        '',
        'Preencha exatamente nessa ordem.',
        'Nao altere a estrutura nem os campos.',
    ].join('\n');
}

function parseProfileSubmission(body) {
    const lines = String(body || '').split('\n');
    const fields = {
        nome_real: null,
        idade_real: null,
        gosta_de_fazer: null,
        personagem_nome: null,
        personagem_idade: null,
        personagem_aparencia: null,
        personagem_genero: null,
        numero_roll: null,
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

        if (normalizedLine.includes('ficha de personagem')) {
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

        if (!valueRaw || looksLikePlaceholder(valueRaw)) {
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

async function findAppearanceConflict(db, playerId, appearanceValue) {
    const signature = appearanceSignature(appearanceValue);
    const players = await db.all(
        `SELECT id, personagem_nome, personagem_aparencia
         FROM jogadores
         WHERE id <> ? AND personagem_aparencia IS NOT NULL AND personagem_aparencia <> '-'`,
        [playerId]
    );

    return players.find((player) => appearanceSignature(player.personagem_aparencia) === signature) || null;
}

async function analyzeProfileSubmission(db, playerId, body) {
    const parsed = parseProfileSubmission(body);
    const errors = [];

    if (!parsed.sawCharacterHeader) {
        errors.push('A ficha precisa manter o bloco "Ficha de Personagem".');
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
        errors.push('O nome da ficha pessoal nao pode ficar vazio.');
    }

    if (!idadeReal || idadeReal <= 15) {
        errors.push('A idade precisa ser maior que 15.');
    }

    if (!normalizeValue(fields.gosta_de_fazer)) {
        errors.push('O campo "O que gosta de fazer" nao pode ficar vazio.');
    }

    if (!normalizeValue(fields.personagem_nome)) {
        errors.push('O nome do personagem nao pode ficar vazio.');
    }

    if (!idadePersonagem) {
        errors.push('A idade do personagem precisa ser valida.');
    }

    if (!generoCanonical) {
        errors.push('O genero precisa ser Masculino/Feminino, Homem/Mulher ou Macho/Femea.');
    }

    if (!isAppearanceDetailed(fields.personagem_aparencia)) {
        errors.push('A aparencia precisa estar preenchida e identificar personagem e obra.');
    }

    let appearanceConflict = null;
    if (fields.personagem_aparencia) {
        appearanceConflict = await findAppearanceConflict(db, playerId, fields.personagem_aparencia);
        if (appearanceConflict) {
            errors.push('A aparencia informada ja esta em uso por outro jogador.');
        }
    }

    if (!rollNumber) {
        errors.push('O numero do roll informado nao e valido.');
    }

    let roll = null;
    if (rollNumber) {
        roll = await getPlayerRollByNumber(db, playerId, rollNumber);
        if (!roll) {
            errors.push('O numero do roll informado nao foi encontrado nos seus rolls salvos.');
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        payload: {
            nomeReal: normalizeValue(fields.nome_real),
            idadeReal,
            gostaDeFazer: normalizeValue(fields.gosta_de_fazer),
            personagemNome: normalizeValue(fields.personagem_nome),
            personagemIdade: idadePersonagem,
            personagemAparencia: normalizeValue(fields.personagem_aparencia),
            personagemGenero: generoCanonical,
            numeroRoll: rollNumber,
            roll,
            appearanceConflict,
        },
    };
}

async function savePendingConfirmation(db, playerId, payload) {
    await db.run(
        `INSERT INTO pending_profile_confirmations (player_id, payload, created_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(player_id) DO UPDATE SET payload = excluded.payload, created_at = CURRENT_TIMESTAMP`,
        [playerId, JSON.stringify(payload)]
    );
}

async function getPendingConfirmation(db, playerId) {
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
    const payload = await getPendingConfirmation(db, playerId);
    if (!payload) return { ok: false, reason: 'missing_pending' };

    await db.run(
        `UPDATE jogadores
         SET nome_real = ?,
             idade_real = ?,
             gosta_de_fazer = ?,
             personagem_nome = ?,
             personagem_idade = ?,
             personagem_aparencia = ?,
             personagem_genero = ?,
             numero_roll_escolhido = ?,
             ficha_status = 'confirmada',
             nome = ?,
             idade = ?,
             aparencia = ?,
             reino = ?,
             classe = ?,
             familia = ?,
             raca = ?,
             grimorio = ?,
             magia = '-'
         WHERE id = ?`,
        [
            payload.nomeReal,
            payload.idadeReal,
            payload.gostaDeFazer,
            payload.personagemNome,
            payload.personagemIdade,
            payload.personagemAparencia,
            payload.personagemGenero,
            payload.numeroRoll,
            payload.personagemNome,
            String(payload.personagemIdade),
            payload.personagemAparencia,
            payload.roll.kingdom,
            payload.roll.social_class,
            payload.roll.family || '-',
            payload.roll.race,
            payload.roll.grimoire,
            playerId,
        ]
    );

    await clearPendingConfirmation(db, playerId);

    return {
        ok: true,
        payload,
    };
}

function renderValidationErrors(errors) {
    return [
        '❌ *Ficha com pendencias.*',
        '',
        'Encontrei estes problemas:',
        '',
        ...errors.map((error) => `• ${error}`),
        '',
        'Corrija a ficha e envie novamente respondendo este modelo.',
        `Se precisar do modelo de novo, use *${PROFILE_TEMPLATE_COMMAND}*.`,
    ].join('\n');
}

function renderConfirmationSummary(payload) {
    const lines = [
        '✅ *Ficha validada com sucesso!*',
        '',
        'Sua ficha esta pronta para confirmacao.',
        '',
        'Resumo conferido:',
        `• Nome real: ${payload.nomeReal}`,
        `• Idade real: ${payload.idadeReal}`,
        `• Gosta de fazer: ${payload.gostaDeFazer}`,
        `• Personagem: ${payload.personagemNome}`,
        `• Idade do personagem: ${payload.personagemIdade}`,
        `• Genero: ${payload.personagemGenero}`,
        `• Aparencia: ${payload.personagemAparencia}`,
        `• Roll escolhido: #${payload.numeroRoll}`,
        `• Reino: ${payload.roll.kingdom}`,
        `• Classe social: ${payload.roll.social_class}`,
        `• Raca: ${payload.roll.race}`,
        `• Grimorio: ${payload.roll.grimoire}`,
        `• Raridade magica: ${payload.roll.magic_rarity}`,
    ];

    if (payload.roll.family && payload.roll.family !== '-') {
        lines.push(`• Familia / origem: ${payload.roll.family}`);
    }

    lines.push('');
    lines.push('Agora use:');
    lines.push(`*${COMMAND_PREFIX}confirmar*`);
    lines.push('');
    lines.push('Depois disso, vou te guiar para escolher sua magia.');

    return lines.join('\n');
}

function renderConfirmedFicha(player, roll) {
    const lines = [
        '🧾 *Sua ficha atual*',
        '',
        'Ficha pessoal:',
        `• Nome real: ${player.nome_real || '-'}`,
        `• Idade real: ${player.idade_real || '-'}`,
        `• O que gosta de fazer: ${player.gosta_de_fazer || '-'}`,
        '',
        'Ficha de personagem:',
        `• Nome: ${player.personagem_nome || '-'}`,
        `• Idade: ${player.personagem_idade || '-'}`,
        `• Genero: ${player.personagem_genero || '-'}`,
        `• Aparencia: ${player.personagem_aparencia || '-'}`,
        `• Roll escolhido: ${player.numero_roll_escolhido ? `#${player.numero_roll_escolhido}` : '-'}`,
        `• Magia escolhida: ${player.magia && player.magia !== '-' ? player.magia : 'pendente'}`,
    ];

    if (roll) {
        lines.push('');
        lines.push('Dados do roll vinculado:');
        lines.push(`• Reino: ${roll.kingdom}`);
        lines.push(`• Classe social: ${roll.social_class}`);
        if (roll.family && roll.family !== '-') lines.push(`• Familia / origem: ${roll.family}`);
        lines.push(`• Raca: ${roll.race}`);
        lines.push(`• Grimorio: ${roll.grimoire}`);
        lines.push(`• Raridade magica: ${roll.magic_rarity}`);
    }

    return lines.join('\n');
}

module.exports = {
    PROFILE_SUBMISSION_ALIASES,
    PROFILE_SUBMISSION_COMMAND,
    PROFILE_TEMPLATE_COMMAND,
    analyzeProfileSubmission,
    clearPendingConfirmation,
    confirmPendingProfile,
    getPendingConfirmation,
    parseProfileSubmission,
    renderConfirmedFicha,
    renderConfirmationSummary,
    renderProfileTemplate,
    renderValidationErrors,
    savePendingConfirmation,
};
