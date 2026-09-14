const { assertLifecycleAllowed, lifecycleSkip, isPreResetLifecycle } = require('./lifecyclePolicy');
const path = require('path');

const { normalizeText } = require('../textUtils');

const CLOVER_ROOT = path.resolve(process.env.CLOVER_RPG_DIR || path.join(__dirname, '..', '..'));
const STAGES = require(path.join(CLOVER_ROOT, 'data', 'clover', 'estagios.json'));
const DEFAULT_STAGE_KEY = '9';

const ATTRIBUTES = [
    {
        key: 'forca',
        label: 'Força',
        aliases: ['forca', 'força', 'for'],
    },
    {
        key: 'velocidade',
        label: 'Velocidade',
        aliases: ['velocidade', 'velo', 'vel'],
    },
    {
        key: 'agilidade',
        label: 'Agilidade',
        aliases: ['agilidade', 'agi'],
    },
    {
        key: 'resistencia',
        label: 'Resistência',
        aliases: ['resistencia', 'resistência', 'res'],
    },
    {
        key: 'poder_magico',
        label: 'Poder Mágico',
        aliases: ['poder magico', 'poder mágico', 'pm', 'p m', 'p.m', 'poder'],
    },
];

const ATTRIBUTE_KEYS = ATTRIBUTES.map((attribute) => attribute.key);
const ATTRIBUTE_ALIASES = new Map();

for (const attribute of ATTRIBUTES) {
    for (const alias of attribute.aliases) {
        ATTRIBUTE_ALIASES.set(normalizeAttributeName(alias), attribute.key);
    }
}

function normalizeAttributeName(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getStageConfig(stageKey = DEFAULT_STAGE_KEY) {
    return STAGES.find((stage) => String(stage.key) === String(stageKey)) || STAGES[0];
}

function getDefaultStage() {
    return getStageConfig(DEFAULT_STAGE_KEY);
}

function getStageName(stageKey) {
    return getStageConfig(stageKey).name;
}

function getAutomaticStages() {
    return STAGES
        .filter((stage) => stage.automatic !== false && Number.isFinite(Number(stage.ph_required)))
        .sort((left, right) => Number(left.ph_required) - Number(right.ph_required));
}

function getStageByPh(phAccumulated = 0) {
    const ph = Math.max(0, Number(phAccumulated || 0));
    return getAutomaticStages()
        .filter((stage) => ph >= Number(stage.ph_required || 0))
        .pop() || getDefaultStage();
}

function getNextStageByPh(phAccumulated = 0, stageKey = null) {
    if (String(stageKey) === 'arcano') return null;
    const ph = Math.max(0, Number(phAccumulated || 0));
    return getAutomaticStages().find((stage) => Number(stage.ph_required || 0) > ph) || null;
}

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function sumAttributes(values) {
    return ATTRIBUTE_KEYS.reduce((total, key) => total + Number(values?.[key] || 0), 0);
}

function hasConfirmedDistribution(stats) {
    return stats?.distribution_status === 'confirmed'
        || Boolean(stats?.confirmed_at)
        || Number(stats?.pb_spent || 0) > 0;
}

function getAttributeValues(stats, options = {}) {
    const pending = options.usePending
        ? safeJsonParse(stats?.pending_distribution_json, null)
        : null;
    const source = pending || stats || {};
    return ATTRIBUTE_KEYS.reduce((result, key) => ({
        ...result,
        [key]: Number(source[key] || 0),
    }), {});
}

async function ensureCharacterStats(db, playerId) {
    const existing = await db.get(
        'SELECT * FROM clover_character_stats WHERE player_id = ?',
        [playerId]
    );
    if (existing) return existing;

    assertLifecycleAllowed({surface:'internal',operation:'character_stats.initialize',mutationClass:'CURRENT_WORLD'});
    const stage = getDefaultStage();
    await db.run(
        `INSERT INTO clover_character_stats
         (player_id, stage_key, pb_total, pb_spent, distribution_status, created_at, updated_at)
         VALUES (?, ?, ?, 0, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [playerId, stage.key, stage.pb]
    );

    return db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', [playerId]);
}

function getPbUsage(stats, options = {}) {
    const usePending = options.usePending || stats?.distribution_status === 'pending_confirmation';
    const values = getAttributeValues(stats, { usePending });
    const used = usePending ? sumAttributes(values) : Number(stats?.pb_spent || 0);
    const pbTotal = Number(stats?.pb_total || getDefaultStage().pb);

    return {
        pbTotal,
        used,
        free: Math.max(0, pbTotal - used),
    };
}

async function getCharacterStats(db, playerId) {
    return ensureCharacterStats(db, playerId);
}

function resolveAttributeKey(label) {
    return ATTRIBUTE_ALIASES.get(normalizeAttributeName(label)) || null;
}

function parseDistributionInput(body) {
    const cleaned = normalizeText(body)
        .replace(/[^a-z0-9.-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^distribuir\s+/, '');
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    const values = {};
    const errors = [];
    let labelTokens = [];

    for (const token of tokens) {
        if (/^-?\d+$/.test(token)) {
            if (!labelTokens.length) {
                errors.push(`Valor sem atributo: ${token}.`);
                continue;
            }

            const label = labelTokens.join(' ');
            const key = resolveAttributeKey(label);
            if (!key) {
                errors.push(`Atributo não reconhecido: ${label}.`);
                labelTokens = [];
                continue;
            }

            if (Object.prototype.hasOwnProperty.call(values, key)) {
                errors.push(`Atributo repetido: ${ATTRIBUTES.find((item) => item.key === key).label}.`);
                labelTokens = [];
                continue;
            }

            const number = Number(token);
            if (!Number.isInteger(number) || number < 0) {
                errors.push(`Valor inválido para ${label}.`);
            } else {
                values[key] = number;
            }
            labelTokens = [];
        } else {
            labelTokens.push(token);
        }
    }

    if (labelTokens.length) {
        errors.push(`Faltou valor para: ${labelTokens.join(' ')}.`);
    }

    return { values, errors };
}

function parseUpgradeInput(body) {
    const cleaned = normalizeText(body)
        .replace(/[^a-z0-9.-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(upar|up|aumentar|somar|subir|evoluir)\s+/, '');
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    const values = {};
    const errors = [];
    const ignoredTokens = new Set(['em', 'no', 'na', 'nos', 'nas', 'de', 'do', 'da']);
    let labelTokens = [];
    let pendingAmount = null;

    const addValue = (rawLabel, rawAmount) => {
        const label = rawLabel.join(' ');
        const key = resolveAttributeKey(label);
        const amount = Number(rawAmount);

        if (!key) {
            errors.push(`Atributo nÃ£o reconhecido: ${label}.`);
            return;
        }

        if (!Number.isInteger(amount) || amount <= 0) {
            errors.push(`Valor invÃ¡lido para ${label}. Use um nÃºmero positivo.`);
            return;
        }

        if (Object.prototype.hasOwnProperty.call(values, key)) {
            errors.push(`Atributo repetido: ${ATTRIBUTES.find((item) => item.key === key).label}.`);
            return;
        }

        values[key] = amount;
    };

    for (const token of tokens) {
        if (ignoredTokens.has(token)) continue;

        if (/^-?\d+$/.test(token)) {
            const amount = Number(token);
            if (labelTokens.length) {
                addValue(labelTokens, pendingAmount !== null ? pendingAmount : amount);
                labelTokens = [];
                pendingAmount = pendingAmount !== null ? amount : null;
            } else if (pendingAmount !== null) {
                errors.push(`Valor sem atributo: ${pendingAmount}.`);
                pendingAmount = amount;
            } else {
                pendingAmount = amount;
            }
        } else {
            labelTokens.push(token);
        }
    }

    if (labelTokens.length) {
        addValue(labelTokens, pendingAmount !== null ? pendingAmount : 1);
        pendingAmount = null;
    }

    if (pendingAmount !== null) {
        errors.push(`Valor sem atributo: ${pendingAmount}.`);
    }

    if (!Object.keys(values).length && !errors.length) {
        errors.push('Informe o atributo que deseja upar.');
    }

    return { values, errors };
}

function validateDistribution(stats, values) {
    const errors = [];
    const pbTotal = Number(stats.pb_total || getDefaultStage().pb);
    const maxPerAttribute = Math.floor(pbTotal / 2);
    const alreadyConfirmed = hasConfirmedDistribution(stats);
    const currentValues = getAttributeValues(stats);
    const finalValues = alreadyConfirmed
        ? ATTRIBUTE_KEYS.reduce((result, key) => ({
            ...result,
            [key]: Object.prototype.hasOwnProperty.call(values || {}, key)
                ? Number(values[key] || 0)
                : Number(currentValues[key] || 0),
        }), {})
        : values || {};
    const used = sumAttributes(finalValues);

    for (const attribute of ATTRIBUTES) {
        const value = Number(finalValues[attribute.key] || 0);
        if (!alreadyConfirmed && !Object.prototype.hasOwnProperty.call(finalValues, attribute.key)) {
            errors.push(`Faltou informar ${attribute.label}.`);
            continue;
        }
        if (alreadyConfirmed && Object.prototype.hasOwnProperty.call(values || {}, attribute.key)) {
            const currentValue = Number(currentValues[attribute.key] || 0);
            if (value < currentValue) {
                errors.push(`${attribute.label} não pode ser reduzido sem comando ADM.`);
            }
        }
        if (value < 1) {
            errors.push(`${attribute.label} precisa ter pelo menos 1 ponto.`);
        }
        if (value > maxPerAttribute) {
            errors.push(`${attribute.label} não pode passar de ${maxPerAttribute} PB agora.`);
        }
    }

    if (used > pbTotal) {
        errors.unshift(`A soma (${used}) passou do PB total (${pbTotal}).`);
    }

    return {
        ok: errors.length === 0,
        errors,
        used,
        free: Math.max(0, pbTotal - used),
        pbTotal,
        maxPerAttribute,
        values: finalValues,
    };
}

function validateAttributeUpgrade(stats, increments) {
    const errors = [];
    const pbTotal = Number(stats.pb_total || getDefaultStage().pb);
    const maxPerAttribute = Math.floor(pbTotal / 2);
    const currentValues = getAttributeValues(stats);
    const finalValues = { ...currentValues };

    if (stats.distribution_status === 'pending_confirmation') {
        errors.push('Existe uma distribuiÃ§Ã£o pendente. Confirme ou cancele antes de upar atributo.');
    }

    for (const attribute of ATTRIBUTES) {
        const increment = Number(increments?.[attribute.key] || 0);
        if (!increment) continue;

        if (!Number.isInteger(increment) || increment < 0) {
            errors.push(`Valor invÃ¡lido para ${attribute.label}. Use um nÃºmero positivo.`);
            continue;
        }

        finalValues[attribute.key] = Number(finalValues[attribute.key] || 0) + increment;
        if (finalValues[attribute.key] > maxPerAttribute) {
            errors.push(`${attribute.label} nÃ£o pode passar de ${maxPerAttribute} PB agora.`);
        }
    }

    if (!Object.values(increments || {}).some((value) => Number(value || 0) > 0)) {
        errors.push('Informe pelo menos 1 ponto para upar.');
    }

    const used = sumAttributes(finalValues);
    if (used > pbTotal) {
        errors.unshift(`A soma (${used}) passou do PB total (${pbTotal}).`);
    }

    return {
        ok: errors.length === 0,
        errors,
        used,
        free: Math.max(0, pbTotal - used),
        pbTotal,
        maxPerAttribute,
        values: finalValues,
        increments,
    };
}

async function savePendingDistribution(db, playerId, values) {
    assertLifecycleAllowed({surface:'internal',operation:'savePendingDistribution',mutationClass:'CURRENT_WORLD'});
    const stats = await ensureCharacterStats(db, playerId);
    const validation = validateDistribution(stats, values);
    if (!validation.ok) {
        return { ok: false, reason: 'invalid_distribution', validation };
    }

    await db.run(
        `UPDATE clover_character_stats
         SET pending_distribution_json = ?,
             distribution_status = 'pending_confirmation',
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [JSON.stringify(validation.values), playerId]
    );

    return {
        ok: true,
        validation,
        stats: await getCharacterStats(db, playerId),
        values: validation.values,
    };
}

async function applyAttributeUpgrade(db, playerId, increments) {
    assertLifecycleAllowed({surface:'internal',operation:'applyAttributeUpgrade',mutationClass:'CURRENT_WORLD'});
    const stats = await ensureCharacterStats(db, playerId);
    const validation = validateAttributeUpgrade(stats, increments);
    if (!validation.ok) {
        return { ok: false, reason: 'invalid_upgrade', validation };
    }

    await db.run(
        `UPDATE clover_character_stats
         SET forca = ?,
             velocidade = ?,
             agilidade = ?,
             resistencia = ?,
             poder_magico = ?,
             pb_spent = ?,
             distribution_status = 'confirmed',
             pending_distribution_json = NULL,
             confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [
            validation.values.forca,
            validation.values.velocidade,
            validation.values.agilidade,
            validation.values.resistencia,
            validation.values.poder_magico,
            validation.used,
            playerId,
        ]
    );

    return {
        ok: true,
        validation,
        values: validation.values,
        stats: await getCharacterStats(db, playerId),
    };
}

async function confirmPendingDistribution(db, playerId) {
    assertLifecycleAllowed({surface:'internal',operation:'confirmPendingDistribution',mutationClass:'CURRENT_WORLD'});
    const stats = await ensureCharacterStats(db, playerId);
    if (!stats.pending_distribution_json || stats.distribution_status !== 'pending_confirmation') {
        return { ok: false, reason: 'missing_pending' };
    }
    if (stats.distribution_status === 'confirmed') {
        return { ok: false, reason: 'already_confirmed' };
    }

    const values = safeJsonParse(stats.pending_distribution_json, null);
    const validation = validateDistribution(stats, values || {});
    if (!validation.ok) {
        return { ok: false, reason: 'invalid_distribution', validation };
    }

    await db.run(
        `UPDATE clover_character_stats
         SET forca = ?,
             velocidade = ?,
             agilidade = ?,
             resistencia = ?,
             poder_magico = ?,
             pb_spent = ?,
             distribution_status = 'confirmed',
             pending_distribution_json = NULL,
             confirmed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [
            validation.values.forca,
            validation.values.velocidade,
            validation.values.agilidade,
            validation.values.resistencia,
            validation.values.poder_magico,
            validation.used,
            playerId,
        ]
    );

    return {
        ok: true,
        validation,
        values: validation.values,
        stats: await getCharacterStats(db, playerId),
    };
}

async function cancelPendingDistribution(db, playerId) {
    assertLifecycleAllowed({surface:'internal',operation:'cancelPendingDistribution',mutationClass:'CURRENT_WORLD'});
    const stats = await ensureCharacterStats(db, playerId);
    if (!stats.pending_distribution_json || stats.distribution_status !== 'pending_confirmation') {
        return { ok: false, reason: 'missing_pending' };
    }

    await db.run(
        `UPDATE clover_character_stats
         SET pending_distribution_json = NULL,
             distribution_status = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE player_id = ?`,
        [hasConfirmedDistribution(stats) ? 'confirmed' : 'pending', playerId]
    );

    return { ok: true, stats: await getCharacterStats(db, playerId) };
}

function formatDistributionStatus(status) {
    if (status === 'confirmed') return 'confirmado';
    if (status === 'pending_confirmation') return 'aguardando confirmação';
    return 'pendente';
}

function renderAttributeBlock(values) {
    const labelMap = {
        forca: '𝐅𝐨𝐫𝐜̧𝐚',
        velocidade: '𝐕𝐞𝐥𝐨𝐜𝐢𝐝𝐚𝐝𝐞',
        agilidade: '𝐀𝐠𝐢𝐥𝐢𝐝𝐚𝐝𝐞',
        resistencia: '𝐑𝐞𝐬𝐢𝐬𝐭𝐞̂𝐧𝐜𝐢𝐚',
        poder_magico: '𝐏𝐨𝐝𝐞𝐫 𝐌𝐚́𝐠𝐢𝐜𝐨',
    };
    return ATTRIBUTES.map((attribute) => `*${labelMap[attribute.key] || attribute.label}:* ${Number(values?.[attribute.key] || 0)}`).join('\n');
}

function renderAttributesPanel(stats) {
    const usePending = stats.distribution_status === 'pending_confirmation';
    const values = getAttributeValues(stats, { usePending });
    const { pbTotal, used, free } = getPbUsage(stats, { usePending });
    const lines = [
        '♧┃𝐀𝐓𝐑𝐈𝐁𝐔𝐓𝐎𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  distribuição de PB ᥱ corpo do personagem  ──',
        '',
        '_`─( ✦ )───── 𝗣𝗼𝗻𝘁𝗼𝘀`_',
        '',
        `*𝐄𝐬𝐜𝐚𝐥𝐚:* ${getStageName(stats.stage_key)}`,
        `*𝐏𝐁 𝐭𝐨𝐭𝐚𝐥:* ${pbTotal}`,
        `*𝐏𝐁 𝐮𝐬𝐚𝐝𝐨:* ${used}`,
        `*𝐏𝐁 𝐥𝐢𝐯𝐫𝐞:* ${free}`,
        `*𝐒𝐭𝐚𝐭𝐮𝐬:* ${formatDistributionStatus(stats.distribution_status)}`,
        '',
        '_`─( ◆ )───── 𝗔𝘁𝗿𝗶𝗯𝘂𝘁𝗼𝘀`_',
        '',
        renderAttributeBlock(values),
    ];

    if (stats.distribution_status === 'pending') {
        lines.push(
            '',
            '_`─( ■ )───── 𝗨𝘀𝗮𝗿`_',
            '',
            '*̣.#atributos distribuir força 2 velocidade 2 agilidade 2 resistência 2 pm 2*'
        );
    } else if (stats.distribution_status === 'confirmed' && free > 0) {
        lines.push(
            '',
            '_`─( ! )───── 𝗔𝘃𝗶𝘀𝗼`_',
            '',
            'Você possui PB livre. Use valores totais finais, sem reduzir atributos já confirmados.',
            '',
            '_`─( ■ )───── 𝗘𝘅𝗲𝗺𝗽𝗹𝗼`_',
            '',
            '*̣.#atributos distribuir força 4 velocidade 4 agilidade 4 resistência 4 pm 4*'
        );
    } else if (stats.distribution_status === 'pending_confirmation') {
        lines.push(
            '',
            '_`─( ✓ )───── 𝗖𝗼𝗻𝗳𝗶𝗿𝗺𝗮𝗿`_',
            '',
            '*̣.#confirmaratributos*',
            '',
            '_`─( ! )───── 𝗖𝗮𝗻𝗰𝗲𝗹𝗮𝗿`_',
            '',
            '*̣.#cancelaratributos*'
        );
    }

    return lines.join('\n');
}

function renderPendingDistribution(stats, values, validation) {
    return [
        '♧┃𝐃𝐈𝐒𝐓𝐑𝐈𝐁𝐔𝐈𝐂̧𝐀̃𝐎 𝐏𝐄𝐍𝐃𝐄𝐍𝐓𝐄 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  revise antes de confirmar  ──',
        '',
        '_`─( ✦ )───── 𝗣𝗼𝗻𝘁𝗼𝘀`_',
        '',
        `*𝐏𝐁 𝐭𝐨𝐭𝐚𝐥:* ${validation.pbTotal}`,
        `*𝐏𝐁 𝐮𝐬𝐚𝐝𝐨:* ${validation.used}`,
        `*𝐏𝐁 𝐥𝐢𝐯𝐫𝐞:* ${validation.free}`,
        '',
        '_`─( ◆ )───── 𝗔𝘁𝗿𝗶𝗯𝘂𝘁𝗼𝘀`_',
        '',
        renderAttributeBlock(values),
        '',
        '_`─( ✓ )───── 𝗖𝗼𝗻𝗳𝗶𝗿𝗺𝗮𝗿`_',
        '',
        '*̣.#confirmaratributos*',
        '',
        '_`─( ! )───── 𝗖𝗮𝗻𝗰𝗲𝗹𝗮𝗿`_',
        '',
        '*̣.#cancelaratributos*',
    ].join('\n');
}

function renderConfirmedDistribution(stats) {
    const values = getAttributeValues(stats);
    const { pbTotal, used, free } = getPbUsage(stats);
    return [
        '♧┃𝐀𝐓𝐑𝐈𝐁𝐔𝐓𝐎𝐒 𝐂𝐎𝐍𝐅𝐈𝐑𝐌𝐀𝐃𝐎𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  distribuição salva  ──',
        '',
        '_`─( ✦ )───── 𝗣𝗼𝗻𝘁𝗼𝘀`_',
        '',
        `*𝐄𝐬𝐜𝐚𝐥𝐚:* ${getStageName(stats.stage_key)}`,
        `*𝐏𝐁 𝐭𝐨𝐭𝐚𝐥:* ${pbTotal}`,
        `*𝐏𝐁 𝐮𝐬𝐚𝐝𝐨:* ${used}`,
        `*𝐏𝐁 𝐥𝐢𝐯𝐫𝐞:* ${free}`,
        '',
        '_`─( ◆ )───── 𝗔𝘁𝗿𝗶𝗯𝘂𝘁𝗼𝘀`_',
        '',
        renderAttributeBlock(values),
    ].join('\n');
}

function renderDistributionErrors(errors) {
    return [
        '♧┃𝐃𝐈𝐒𝐓𝐑𝐈𝐁𝐔𝐈𝐂̧𝐀̃𝐎 𝐈𝐍𝐕𝐀́𝐋𝐈𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '     ──  nada foi gasto ou salvo  ──',
        '',
        'Nα̃o consᥱguı αplıcαr ᥱssα dıstrıbuıçα̃o.',
        'Nαdα foı gαsto.',
        'Nαdα foı sαlvo.',
        '',
        '_`─( ! )───── 𝗔𝗷𝘂𝘀𝘁𝗲`_',
        '',
        ...errors.map((error) => `> ${error}`),
        '',
        '_`─( ■ )───── 𝗨𝘀𝗲`_',
        '',
        '*̣.#atributos distribuir força 2 velocidade 2 agilidade 2 resistência 2 pm 2*',
    ].join('\n');
}

module.exports = {
    ATTRIBUTES,
    ATTRIBUTE_KEYS,
    applyAttributeUpgrade,
    cancelPendingDistribution,
    confirmPendingDistribution,
    ensureCharacterStats,
    formatDistributionStatus,
    getAttributeValues,
    getCharacterStats,
    getDefaultStage,
    getNextStageByPh,
    getPbUsage,
    getStageByPh,
    getStageConfig,
    getStageName,
    parseDistributionInput,
    parseUpgradeInput,
    renderAttributeBlock,
    renderAttributesPanel,
    renderConfirmedDistribution,
    renderDistributionErrors,
    renderPendingDistribution,
    savePendingDistribution,
    sumAttributes,
    validateAttributeUpgrade,
    validateDistribution,
};
