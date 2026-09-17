const { assertLifecycleAllowed, lifecycleSkip, isPreResetLifecycle } = require('./lifecyclePolicy');
const {
    ensureCloverQuickEvaluationsSchema,
    ensureCloverSquadSchema,
} = require('../../database');
const { sendReaction, sendReply } = require('../chatReply');
const {
    isOwner,
    normalizeJid,
} = require('../groupAccess');
const { getMessageContextInfo } = require('../messageContext');
const { normalizeText, stripMarkdown } = require('../textUtils');
const { hasAccessPermission } = require('./accessControlService');
const { isConfiguredCloverGroup } = require('./groupManager');
const { addPhInTransaction, ensurePhState } = require('./phService');
const { addYullsInTransaction } = require('./yullsService');
const { tryValidateReferralFromEvaluation } = require('./recruitmentService');
const {
    applyReturnBonusForEvaluation,
    getMessageTimestamp,
    parseManualSceneDate,
    parseSqliteDate,
    recordEvaluationActivity,
    renderReturnBonusResult,
    resolveSceneSentAt,
} = require('./antiGhostService');
const {
    formatNumber,
    formatStars,
    formatYulls,
    getRecommendedPatent,
    hasSquad,
} = require('./cavalierService');
const { syncSquadGroupDescription } = require('./squadService');
const { resolvePlayerSquadMembership } = require('./squadMembershipReadService');
const { grantSquadStarsInTransaction } = require('./squadSeasonStarService');
const { resolveTargetPlayer: resolveCentralTargetPlayer } = require('./targetResolver');
const { recordEvaluationService } = require('./adminService');
const {
    addCatalogItemInTransaction,
    addUncatalogedItemInTransaction,
    ensureInventoryV1,
    getItemTemplateInTransaction,
} = require('./inventoryService');

const WEEKLY_COMMON_PH_LIMIT = 30;
const MIN_PH_REWARD = 5;

const MODALITIES = [
    {
        key: 'treino_solo',
        label: 'Treino Solo',
        aliases: ['treino solo'],
        maxPh: 10,
        weeklyMaxUses: 1,
    },
    {
        key: 'treino_duo',
        label: 'Treino Duo',
        aliases: ['treino duo', 'treino em duo'],
        maxPh: 15,
        weeklyMaxUses: 1,
    },
    {
        key: 'cena_interativa',
        label: 'Cena Interativa',
        aliases: ['cena interativa'],
        maxPh: 20,
        weeklyMaxUses: 1,
    },
    {
        key: 'cena_vinculo',
        label: 'Cena de Vínculo',
        aliases: ['cena de vinculo', 'cena de vínculo', 'cena de v nculo'],
        maxPh: 20,
        weeklyMaxUses: 1,
    },
    {
        key: 'cena_consequencia',
        label: 'Cena de Consequência',
        aliases: ['cena de consequencia', 'cena de consequência', 'cena de consequ ncia'],
        maxPh: 20,
        weeklyMaxUses: 1,
    },
    {
        key: 'diario',
        label: 'Diário',
        aliases: ['diario', 'diário', 'di rio', 'diario do personagem', 'diário do personagem', 'di rio do personagem', 'reflexao', 'reflexão'],
        maxPh: 30,
        weeklyMaxUses: 1,
    },
    {
        key: 'spin_off',
        label: 'Spin-Off',
        aliases: ['spin-off', 'spin off', 'arco pessoal'],
        maxPh: 60,
        bypassWeeklyLimit: true,
    },
    {
        key: 'missao_desenvolvimento',
        label: 'Missão de Desenvolvimento',
        aliases: [
            'missao de desenvolvimento',
            'missão de desenvolvimento',
            'miss o de desenvolvimento',
            'missao desenvolvimento',
            'missão desenvolvimento',
            'desenvolvimento',
        ],
        maxPh: 30,
        bypassWeeklyLimit: true,
    },
    {
        key: 'missao_auto_narrada',
        label: 'Missão Auto-Narrada',
        aliases: ['missao auto narrada', 'missão auto narrada', 'miss o auto narrada', 'missao auto-narrada', 'missão auto-narrada', 'miss o auto-narrada'],
        maxPh: 30,
        weeklyMaxUses: 1,
    },
    {
        key: 'outro',
        label: 'Outro',
        aliases: ['outro'],
        maxPh: 30,
        weeklyMaxUses: 1,
    },
];

const PHYSICAL_TRAINING_MODALITY_KEYS = new Set(['treino_solo', 'treino_duo']);
const COMBAT_BODY_TRAIT_KEY = 'corpo_de_combate';
const COMBAT_BODY_TRAIT_LABEL = 'corpo de combate';

const FIELD_LABELS = [
    'Pessoa',
    'PH',
    'Yulls',
    'Yull',
    'Dinheiro',
    'Estrelas',
    'Estrela',
    'Inventário',
    'Inventario',
    'Invent rio',
    'Itens',
    'Item',
    'Tipo de treino',
    'Modalidade',
    'Conta para salário',
    'Conta para salario',
    'Data da cena',
    'Cena enviada em',
    'Data',
];

function isFilled(value) {
    const text = String(value || '').trim();
    return Boolean(text) && !['-', 'nenhum', 'nenhuma', '0'].includes(normalizeText(text));
}

function compactNormalized(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeTraitKey(value) {
    return compactNormalized(value).replace(/\s+/g, '_');
}

function playerHasTrait(player, traitKey, traitLabel) {
    const targetKey = normalizeTraitKey(traitKey);
    const targetLabel = compactNormalized(traitLabel || traitKey);
    const fields = [
        player?.aptidao_rara_key,
        player?.aptidao_comum_key,
        player?.marca_rara_key,
        player?.marca_comum_key,
        player?.anomalia_key,
        player?.aptidao_rara,
        player?.aptidao_comum,
        player?.marca_rara,
        player?.marca_comum,
        player?.anomalia,
    ];

    return fields.some((value) => {
        if (!isFilled(value)) return false;
        return normalizeTraitKey(value) === targetKey || compactNormalized(value) === targetLabel;
    });
}

function getAutomaticEvaluationBonuses(player, data) {
    const bonuses = [];
    const basePh = Number(data?.ph || 0);

    if (
        basePh > 0
        && PHYSICAL_TRAINING_MODALITY_KEYS.has(data?.modality?.key)
        && playerHasTrait(player, COMBAT_BODY_TRAIT_KEY, COMBAT_BODY_TRAIT_LABEL)
    ) {
        bonuses.push({
            key: COMBAT_BODY_TRAIT_KEY,
            label: 'Corpo de Combate',
            type: 'ph',
            amount: Math.max(1, Math.floor(basePh * 0.1)),
            reason: 'Treino fisico solo/duo.',
        });
    }

    return bonuses;
}

function applyAutomaticEvaluationBonuses(player, data) {
    const automaticBonuses = getAutomaticEvaluationBonuses(player, data);
    if (!automaticBonuses.length) {
        return {
            ...data,
            basePh: Number(data.ph || 0),
            automaticBonuses: [],
        };
    }

    const phBonus = automaticBonuses
        .filter((bonus) => bonus.type === 'ph')
        .reduce((total, bonus) => total + Number(bonus.amount || 0), 0);

    return {
        ...data,
        basePh: Number(data.ph || 0),
        ph: Number(data.ph || 0) + phBonus,
        automaticBonuses,
    };
}

function looksLikeQuickEvaluation(text) {
    const normalized = compactNormalized(text);
    if (!normalized) return false;

    const padded = ` ${normalized} `;
    const hasTerm = (term) => padded.includes(` ${term} `);
    const hasTitle = normalized.includes('ficha de avaliacao')
        || normalized.includes('ficha de avalia');
    const structuralFieldHits = [
        hasTerm('pessoa'),
        hasTerm('ph'),
        hasTerm('yulls') || hasTerm('yull') || hasTerm('dinheiro'),
        hasTerm('estrelas') || hasTerm('estrela'),
        hasTerm('inventario') || hasTerm('itens') || hasTerm('item'),
        normalized.includes('tipo de treino') || hasTerm('modalidade'),
        normalized.includes('conta para salario'),
        normalized.includes('data da cena') || normalized.includes('cena enviada em'),
    ].filter(Boolean).length;
    const hasModality = MODALITIES.some((modality) => (
        modality.aliases.some((alias) => normalized.includes(compactNormalized(alias)))
    ));
    const hasRewardField = hasTerm('ph')
        || hasTerm('yulls')
        || hasTerm('yull')
        || hasTerm('dinheiro')
        || hasTerm('estrelas')
        || hasTerm('estrela')
        || hasTerm('inventario')
        || hasTerm('itens')
        || hasTerm('item');

    return (hasTitle && structuralFieldHits >= 3)
        || (structuralFieldHits >= 4 && hasModality && hasRewardField);
}
function getCleanText(text) {
    return stripMarkdown(text)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFieldBoundary(labels) {
    const options = labels
        .map((label) => escapeRegExp(label))
        .join('|');
    return `(?=\\s*(?:${options})\\s*:|\\s*[_\`]*\\s*[-─]+\\s*\\(|$)`;
}

function readField(text, labels) {
    const clean = getCleanText(text);
    const boundary = buildFieldBoundary(FIELD_LABELS);

    for (const label of labels) {
        const pattern = new RegExp(`${escapeRegExp(label)}\\s*:\\s*([\\s\\S]*?)${boundary}`, 'i');
        const match = clean.match(pattern);
        if (!match) continue;
        return String(match[1] || '').trim();
    }

    const acceptedLabels = labels.map(compactNormalized);
    for (const line of clean.split('\n')) {
        const colonIndex = line.indexOf(':');
        if (colonIndex < 0) continue;

        const rawKey = line.slice(0, colonIndex);
        const normalizedKey = compactNormalized(rawKey);
        const matched = acceptedLabels.some((label) => normalizedKey === label || normalizedKey.endsWith(` ${label}`));
        if (!matched) continue;

        return line.slice(colonIndex + 1).trim();
    }

    return '';
}

function parsePositiveInteger(value, fieldName) {
    const raw = String(value || '').trim();
    if (!raw || ['-', 'nenhum', 'nenhuma'].includes(normalizeText(raw))) return 0;

    const match = raw.match(/[+-]?\s*\d[\d.,]*/);
    if (!match) {
        return { error: `${fieldName} precisa ser um número inteiro.` };
    }

    const text = match[0].replace(/\s+/g, '');
    const valueWithoutThousands = text.replace(/[.,](?=\d{3}(?:\D|$))/g, '');
    const number = Number(valueWithoutThousands.replace(',', '.'));

    if (!Number.isInteger(number)) {
        return { error: `${fieldName} precisa ser um número inteiro.` };
    }

    if (number < 0) {
        return { error: `${fieldName} não pode ser negativo na ficha de avaliação.` };
    }

    return number;
}

function parseSalaryEligibility(value, modalityKey) {
    const normalized = compactNormalized(value);
    if (['sim', 's', 'yes', '1', 'verdadeiro'].includes(normalized)) return true;
    if (['nao', 'n', 'no', '0', 'falso'].includes(normalized)) return false;
    return ['missao_auto_narrada', 'missao_desenvolvimento'].includes(modalityKey);
}

function normalizeModalityLabel(value) {
    return compactNormalized(value)
        .replace(/^tipo de treino\s*/, '')
        .replace(/^modalidade\s*/, '')
        .trim();
}

function findModality(value) {
    const normalized = normalizeModalityLabel(value);
    if (!normalized) return null;

    return MODALITIES.find((modality) => (
        modality.aliases.some((alias) => {
            const aliasText = compactNormalized(alias);
            return normalized === aliasText
                || normalized.startsWith(`${aliasText} `)
                || normalized.includes(aliasText);
        })
    )) || null;
}

function parseMarkedModalities(text) {
    const selected = [];
    const clean = getCleanText(text);
    const lines = clean.split('\n');

    for (const line of lines) {
        const checkbox = line.match(/^\s*[>\-*•]*\s*(?:[([{\u2610]\s*([xX✓✔✅☑])\s*[)\]}\u2610]?|☑)\s*(.+)$/u);
        if (!checkbox) continue;

        const label = String(checkbox[2] || '').trim();
        const modality = findModality(label);
        if (modality) selected.push(modality);
    }

    const inlinePattern = /(?:^|\s)[(\[]\s*([xX✓✔✅☑])\s*[)\]]\s*([^()[\]\n]+)/gu;
    let inlineMatch = null;
    while ((inlineMatch = inlinePattern.exec(clean)) !== null) {
        const modality = findModality(inlineMatch[2]);
        if (modality) selected.push(modality);
    }

    if (!selected.length) {
        const field = readField(text, ['Tipo de treino', 'Modalidade']);
        if (!/[([\u2610]\s*[xX✓✔✅☑ ]?\s*[)\]\u2610]/u.test(field)) {
            const direct = findModality(field);
            if (direct) selected.push(direct);
        }
    }

    const unique = [];
    for (const item of selected) {
        if (!unique.some((existing) => existing.key === item.key)) unique.push(item);
    }
    return unique;
}

function parseEvaluation(text) {
    const person = readField(text, ['Pessoa']);
    const sceneDateText = readField(text, ['Data da cena', 'Cena enviada em', 'Data']);
    const inventoryText = readField(text, ['Inventário', 'Inventario', 'Invent rio', 'Itens', 'Item']);
    let ph = parsePositiveInteger(readField(text, ['PH']), 'PH');
    const yulls = parsePositiveInteger(readField(text, ['Yulls', 'Yull', 'Dinheiro']), 'Yulls');
    const stars = parsePositiveInteger(readField(text, ['Estrelas', 'Estrela']), 'Estrelas');
    const modalities = parseMarkedModalities(text);

    const amountError = [ph, yulls, stars].find((item) => item && typeof item === 'object' && item.error);
    if (amountError) return { ok: false, error: amountError.error };

    if (modalities.length !== 1) {
        return {
            ok: false,
            error: modalities.length > 1
                ? 'Marque apenas uma modalidade de treino.'
                : 'Marque uma modalidade de treino com (x).',
        };
    }

    const modality = modalities[0];
    const salaryEligible = parseSalaryEligibility(
        readField(text, ['Conta para salário', 'Conta para salario']),
        modality.key
    );
    const requestedPh = Number(ph || 0);
    const adjustments = [];

    if (ph > 0 && ph < MIN_PH_REWARD) {
        return {
            ok: false,
            error: `PH abaixo do mínimo. Essa ficha aceita no mínimo ${MIN_PH_REWARD} PH quando houver recompensa de PH.`,
        };
    }

    if (ph > modality.maxPh) {
        adjustments.push(`PH ajustado de ${ph} para ${modality.maxPh}. ${modality.label} permite no máximo ${modality.maxPh} PH nessa ficha.`);
        ph = modality.maxPh;
    }

    return {
        ok: true,
        data: {
            person,
            ph,
            requestedPh,
            yulls,
            stars,
            inventoryText,
            sceneDateText,
            modality,
            salaryEligible,
            salaryServiceType: salaryEligible ? modality.key : null,
            adjustments,
        },
    };
}

function getMentions(m) {
    return getMessageContextInfo(m)?.mentionedJid || [];
}

function getQuotedParticipant(m) {
    return getMessageContextInfo(m)?.participant || null;
}

function getQuotedMessageKey(m, idChat) {
    const contextInfo = getMessageContextInfo(m);
    if (!contextInfo?.stanzaId) return null;

    const key = {
        remoteJid: contextInfo.remoteJid || idChat,
        id: contextInfo.stanzaId,
    };

    if (contextInfo.participant) {
        key.participant = contextInfo.participant;
    }

    return key;
}

function getQuotedEvaluationKey(m, idChat) {
    const key = getQuotedMessageKey(m, idChat);
    if (!key) return null;

    const remoteJid = normalizeJid(key.remoteJid || idChat || '');
    const participant = normalizeJid(key.participant || '');
    return `${remoteJid}:${participant}:${key.id}`;
}

function getMessageKey(m, idChat, evaluatorId) {
    const messageId = m?.key?.id || `${Date.now()}`;
    const participant = m?.key?.participant || evaluatorId || '';
    return `${idChat}:${participant}:${messageId}`;
}

async function sendReactionToKey({ sock, idChat, key, emoji }) {
    if (!key?.id) return null;

    return sock.sendMessage(idChat, {
        react: {
            text: emoji,
            key,
        },
    });
}

function getPlayerName(player) {
    return String(player?.personagem_nome || player?.nome || player?.display_name || 'Personagem').trim();
}

function mentionOf(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function jidFromDigits(digits) {
    const clean = extractDigits(digits);
    return clean ? `${clean}@s.whatsapp.net` : null;
}

function maskLogId(value) {
    const normalized = normalizeJid(value);
    const digits = extractDigits(normalized);
    if (digits.length >= 4) return `***${digits.slice(-4)}@${normalized.includes('@g.us') ? 'g.us' : 'jid'}`;
    if (!normalized) return null;
    return normalized.includes('@g.us') ? '***@g.us' : '***@jid';
}

function isEvaluationEligiblePlayer(player) {
    const ficha = normalizeText(player?.ficha_status || '');
    const historia = normalizeText(player?.historia_status || '');
    const jogo = normalizeText(player?.jogo_status || '');
    const characterName = normalizeText(player?.personagem_nome || '');

    return jogo === 'liberado'
        || historia === 'aprovada'
        || ficha === 'aprovada'
        || ficha === 'confirmada'
        || Boolean(characterName && characterName !== '-');
}

async function resolveTargetPlayer(db, m, personField) {
    const mentions = getMentions(m).filter(Boolean);
    const quoted = getQuotedParticipant(m);

    if (mentions.length > 1) {
        return { ok: false, error: 'Marque apenas uma pessoa na ficha de avaliação.' };
    }

    const result = await resolveCentralTargetPlayer(db, mentions[0] || null, personField, {
        quotedParticipant: quoted,
        playerFilter: isEvaluationEligiblePlayer,
        mechanical: true,
    });

    if (result.ok) return result;

    return {
        ok: false,
        error: result.error || 'Não encontrei a pessoa da avaliação. Use menção, responda uma mensagem ou informe os últimos dígitos.',
    };
}
async function canUseQuickEvaluation({ sock, db, idChat, evaluatorId }) {
    if (!idChat?.endsWith('@g.us')) {
        return { ok: false, error: 'Essa ficha só funciona no grupo ON.' };
    }

    if (!await isConfiguredCloverGroup(db, 'on', idChat)) {
        return { ok: false, error: 'Essa ficha só funciona no grupo ON configurado.' };
    }

    if (isOwner(evaluatorId) || await hasAccessPermission(db, evaluatorId, 'evaluation.apply')) {
        return { ok: true };
    }

    return { ok: false, error: 'Apenas avaliadores autorizados podem aplicar ficha de avaliação.' };
}

function formatLocalDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function coerceDate(value) {
    if (value instanceof Date) {
        const copy = new Date(value);
        return Number.isNaN(copy.getTime()) ? new Date() : copy;
    }

    const text = String(value || '').trim();
    if (!text) return new Date();

    const sqliteWithTime = /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?$/.test(text);
    if (sqliteWithTime) {
        const parsed = parseSqliteDate(text);
        return parsed || new Date();
    }

    const manual = parseManualSceneDate(text);
    const parsed = manual
        ? parseSqliteDate(manual)
        : parseSqliteDate(text) || new Date(text.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function getWeekKey(date = new Date()) {
    const start = coerceDate(date);
    start.setHours(0, 0, 0, 0);
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
    return formatLocalDateKey(start);
}

async function getWeeklyCommonPh(db, playerId, weekKey) {
    const row = await db.get(
        `SELECT COALESCE(SUM(ph_amount), 0) AS total
         FROM clover_quick_evaluations
         WHERE player_id = ?
           AND week_key = ?
           AND bypass_weekly_limit = 0`,
        [playerId, weekKey]
    );
    return Number(row?.total || 0);
}

async function getWeeklyModalityUses(db, playerId, weekKey, modalityKey) {
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_quick_evaluations
         WHERE player_id = ?
           AND week_key = ?
           AND modality_key = ?
           AND COALESCE(json_extract(metadata_json, '$.voided_by_correction'), 0) != 1
           AND COALESCE(json_extract(rewards_json, '$.cap'), '') != 'anulado'`,
        [playerId, weekKey, modalityKey]
    );
    return Number(row?.total || 0);
}

function renderWeeklyModalityLimitError(modality, currentUses, weekKey = null) {
    const maxUses = Number(modality?.weeklyMaxUses || 0);
    const used = Number(currentUses || 0);
    return [
        `${modality.label} já foi usado na semana da cena por este personagem (${used}/${maxUses}).`,
        weekKey ? `Semana considerada: ${weekKey}.` : null,
        'A semana reseta na segunda às 00:00.',
    ].filter(Boolean).join('\n');
}

function renderWeeklyCommonLimitError(current, weekKey) {
    return [
        `Limite semanal excedido. Este personagem já tem ${current}/${WEEKLY_COMMON_PH_LIMIT} PH comuns na semana da cena.`,
        `Semana considerada: ${weekKey}.`,
    ].join('\n');
}

async function resolveEvaluationSceneInfo({ db, m, data, quotedEvaluationKey }) {
    const evaluationSentAt = getMessageTimestamp(m);
    const scene = await resolveSceneSentAt({
        db,
        quotedMessageKey: quotedEvaluationKey,
        manualSceneDateText: data.sceneDateText,
    });
    const sceneSentAt = scene.sceneSentAt || evaluationSentAt;
    const sceneSource = scene.sceneSentAt ? scene.source : 'evaluation_fallback';

    return {
        sceneSentAt,
        sceneSource,
        evaluationSentAt,
        weekKey: getWeekKey(sceneSentAt),
    };
}

function splitInventoryItem(raw) {
    let text = String(raw || '').trim();
    text = text.replace(/^[>\-*•\s]+/, '').trim();
    if (!text || ['-', 'nenhum', 'nenhuma'].includes(normalizeText(text))) return null;

    let quantity = 1;
    const prefix = text.match(/^(\d+)\s*x\s+(.+)$/i);
    const suffix = text.match(/^(.+?)\s+x\s*(\d+)$/i);

    if (prefix) {
        quantity = Math.max(1, Number(prefix[1] || 1));
        text = prefix[2].trim();
    } else if (suffix) {
        quantity = Math.max(1, Number(suffix[2] || 1));
        text = suffix[1].trim();
    }

    const detail = text.match(/^(.+?)\s+(?:—|-)\s+(.+)$/);
    const itemName = (detail ? detail[1] : text).trim();
    const description = detail ? detail[2].trim() : null;

    if (!itemName) return null;
    return { itemName, description, quantity };
}

function parseInventoryItems(inventoryText) {
    if (!isFilled(inventoryText)) return [];

    return String(inventoryText)
        .split(/\n|;|,(?=\s*[^,]+(?:$|;|\n))/)
        .map(splitInventoryItem)
        .filter(Boolean);
}

async function insertInventoryItems(db, playerId, items, evaluationId, evaluatorId, metadata) {
    for (const [index, item] of items.entries()) {
        const idempotencyKey = `quick-evaluation:inventory:${evaluationId}:${index}`;
        const template = await getItemTemplateInTransaction(db, item.itemName);
        if (template) {
            await addCatalogItemInTransaction(db, playerId, template.key, item.quantity, {
                source: 'ficha_avaliacao',
                relatedId: `quick_eval:${evaluationId}`,
                createdBy: evaluatorId,
                forceSeparate: !template.stackable,
                idempotencyKey,
                metadata: { ...metadata, evaluation_item_text: item.itemName },
            });
            continue;
        }
        await addUncatalogedItemInTransaction(db, playerId, {
            itemName: item.itemName, description: item.description || null,
            quantity: item.quantity, kind: 'narrativo',
        }, {
            source: 'ficha_avaliacao', relatedId: `quick_eval:${evaluationId}`,
            createdBy: evaluatorId, idempotencyKey, metadata,
        });
    }
}

async function applySquadStars(db, player, stars, evaluationId, evaluatorId, metadata) {
    if (!stars) return null;
    const membership = await resolvePlayerSquadMembership(db, player.id);
    if (!membership.ok || !membership.squadKey) return null;

    const squadName = membership.squadName;
    const squadKey = membership.squadKey;

    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, historical_stars, current_stars, updated_at)
         VALUES (?, ?, 0, 0, CURRENT_TIMESTAMP)
         ON CONFLICT(squad_key) DO UPDATE SET
             name = excluded.name,
             updated_at = CURRENT_TIMESTAMP`,
        [squadKey, squadName]
    );

    await grantSquadStarsInTransaction(db, {
        squadKey,
        playerId: player.id,
        evaluationId,
        amount: stars,
        transactionKey: `quick-evaluation:squad-stars:${evaluationId}`,
        source: 'ficha_avaliacao',
        reason: 'Estrelas individuais registradas por avaliação rápida',
        relatedId: `quick_eval:${evaluationId}`,
        createdBy: evaluatorId,
        metadata,
    });

    return db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [squadKey]);
}

function hasAnyReward({ ph, yulls, stars, inventoryItems }) {
    return Number(ph || 0) > 0
        || Number(yulls || 0) > 0
        || Number(stars || 0) > 0
        || inventoryItems.length > 0;
}

function renderQuickEvaluationError(error) {
    return [
        '♧┃𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐀̃𝐎 𝐍𝐀̃𝐎 𝐀𝐏𝐋𝐈𝐂𝐀𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  revise a ficha antes de lançar recompensas  ──',
        '',
        '_`─( ! )───── 𝗔𝘃𝗶𝘀𝗼`_',
        '',
        `ⓘ ${error}`,
    ].join('\n');
}

function formatDelta(value, suffix = '') {
    const amount = Number(value || 0);
    if (!amount) return `+0${suffix}`;
    return `+${formatNumber(amount)}${suffix}`;
}

function renderInventoryApplied(items) {
    if (!items.length) return 'Nenhum item lançado.';
    const total = items.reduce((sum, item) => sum + Number(item.quantity || 1), 0);
    return `${total} ${total === 1 ? 'item lançado' : 'itens lançados'}.`;
}

function renderQuickEvaluationSuccess({ player, data, inventoryItems, phResult, weeklyAfter, squadAfter, squadSync, yullsAfter, starsAfter }) {
    const patentLabel = hasSquad(player) ? getRecommendedPatent(starsAfter) : '-';
    const lines = [
        '♧┃𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐀̃𝐎 𝐀𝐏𝐋𝐈𝐂𝐀𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫',
        '     ──  recompensas registradas no personagem  ──',
        '',
        '_`─( ✓ )───── 𝗔𝗹𝘃𝗼`_',
        '',
        `*𝐏𝐞𝐬𝐬𝐨𝐚:* ${mentionOf(player.id)}`,
        `*𝐏𝐞𝐫𝐬𝐨𝐧𝐚𝐠𝐞𝐦:* ${getPlayerName(player)}`,
        `*𝐌𝐨𝐝𝐚𝐥𝐢𝐝𝐚𝐝𝐞:* ${data.modality.label}`,
        `*𝐂𝐨𝐧𝐭𝐚 𝐩𝐚𝐫𝐚 𝐬𝐚𝐥𝐚́𝐫𝐢𝐨:* ${data.salaryEligible ? 'sim' : 'não'}`,
        '',
        '_`─( ✦ )───── 𝗥𝗲𝗰𝗼𝗺𝗽𝗲𝗻𝘀𝗮𝘀`_',
        '',
        `*𝐏𝐇:* ${formatDelta(data.ph)}`,
        `*𝐘𝐮𝐥𝐥𝐬:* ${formatDelta(data.yulls, '¥')}`,
        `*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬:* ${formatDelta(data.stars)}`,
        `*𝐈𝐧𝐯𝐞𝐧𝐭𝐚́𝐫𝐢𝐨:* ${renderInventoryApplied(inventoryItems)}`,
        '',
        '_`─( ◆ )───── 𝗦𝗮𝗹𝗱𝗼`_',
        '',
        `*𝐘𝐮𝐥𝐥𝐬:* ${formatYulls(yullsAfter)}`,
        `*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬:* ${formatStars(starsAfter)}`,
        `*𝐏𝐚𝐭𝐞𝐧𝐭𝐞:* ${patentLabel}`,
    ];

    if (phResult) {
        lines.push(
            `*𝐏𝐇 𝐝𝐢𝐬𝐩𝐨𝐧𝐢́𝐯𝐞𝐥:* ${phResult.after.phAvailable}`,
            `*𝐏𝐇 𝐚𝐜𝐮𝐦𝐮𝐥𝐚𝐝𝐨:* ${phResult.after.phAccumulated}`
        );
    }

    if (!data.modality.bypassWeeklyLimit) {
        lines.push(`*𝐋𝐢𝐦𝐢𝐭𝐞 𝐬𝐞𝐦𝐚𝐧𝐚𝐥:* ${weeklyAfter}/${WEEKLY_COMMON_PH_LIMIT} PH comuns`);
    } else {
        lines.push(`*𝐋𝐢𝐦𝐢𝐭𝐞 𝐬𝐞𝐦𝐚𝐧𝐚𝐥:* ${data.modality.label} não consome o limite comum.`);
    }

    if (squadAfter) {
        lines.push(
            '',
            '_`─( ★ )───── 𝗘𝘀𝗾𝘂𝗮𝗱𝗿𝗮̃𝗼`_',
            '',
            `*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨:* ${squadAfter.name}`,
            `*𝐄𝐬𝐭𝐫𝐞𝐥𝐚𝐬 𝐚𝐭𝐮𝐚𝐢𝐬:* ${formatStars(squadAfter.current_stars)}`,
            `*𝐇𝐢𝐬𝐭𝐨́𝐫𝐢𝐜𝐨:* ${formatStars(squadAfter.historical_stars)}`
        );
        lines.push(`*Descrição:* ${squadSync?.ok ? 'sincronizada' : 'pendente'}`);
    }

    return lines.join('\n');
}

function getAdjustmentList(data) {
    return Array.isArray(data?.adjustments)
        ? data.adjustments.filter((item) => String(item || '').trim())
        : [];
}

function withPhAdjustment(data, ph, message) {
    return {
        ...data,
        ph,
        adjustments: [
            ...getAdjustmentList(data),
            message,
        ],
    };
}

function capWeeklyCommonPh(data, currentWeekly, weekKey) {
    const ph = Number(data?.ph || 0);
    if (ph <= 0 || data?.modality?.bypassWeeklyLimit) {
        return { ok: true, data };
    }

    const used = Number(currentWeekly || 0);
    const remaining = Math.max(0, WEEKLY_COMMON_PH_LIMIT - used);
    if (ph <= remaining) {
        return { ok: true, data };
    }

    if (remaining <= 0) {
        return {
            ok: false,
            error: renderWeeklyCommonLimitError(used, weekKey),
        };
    }

    return {
        ok: true,
        data: withPhAdjustment(
            data,
            remaining,
            `PH ajustado de ${ph} para ${remaining}. Na semana da cena, o personagem já tinha ${used}/${WEEKLY_COMMON_PH_LIMIT} PH comuns.`
        ),
    };
}

function renderQuickEvaluationAdjustmentNotice({ player, data, sceneInfo }) {
    const adjustments = getAdjustmentList(data);
    if (!adjustments.length) return null;

    return [
        '♧┃AVALIAÇÃO AJUSTADA 𖥔 CLOVER MULTICOLOR',
        '     ── limite aplicado no registro da cena ──',
        '',
        '_`─( ! )───── Ajuste`_',
        '',
        ...adjustments.map((item) => `> ${item}`),
        '',
        '_`─( ✓ )───── Resultado`_',
        '',
        `*Pessoa:* ${mentionOf(player.id)}`,
        `*Personagem:* ${getPlayerName(player)}`,
        `*PH lançado:* +${formatNumber(data.ph)}`,
        `*Semana da cena:* ${sceneInfo?.weekKey || '-'}`,
    ].join('\n');
}

function renderRecruitmentValidation(result, player) {
    if (!result?.validated || result.duplicate) return null;
    const referral = result.referral || {};
    const reward = result.event?.recruitReward || {};
    return [
        '♧┃RECRUTAMENTO VALIDADO 𖥔 CLOVER MULTICOLOR',
        '',
        `*Novo player:* ${mentionOf(player.id)}`,
        `*Recrutador:* ${mentionOf(referral.recruiter_player_id)}`,
        '',
        '*Boas-vindas entregues:*',
        `> +${formatNumber(reward.phOutsideCap || 0)} PH fora do teto semanal`,
        `> +${formatYulls(reward.yulls || 0)}`,
        `> ${reward.itemQuantity || 1}x ${reward.item || 'Caixa Simples'}`,
        '',
        `*Recrutador:* +${formatNumber(result.event?.recruiterPrReward || 0)} PR`,
    ].join('\n');
}

async function applyQuickEvaluation({ db, m, idChat, evaluatorId, data, player }) {
    assertLifecycleAllowed({surface:'internal',operation:'applyQuickEvaluation',mutationClass:'CURRENT_WORLD'});

    await ensureInventoryV1(db);
    await ensureCloverQuickEvaluationsSchema(db);
    await ensureCloverSquadSchema(db);

    const inventoryItems = parseInventoryItems(data.inventoryText);
    if (!hasAnyReward({ ...data, inventoryItems })) {
        return { ok: false, error: 'Informe pelo menos uma recompensa: PH, Yulls, Estrelas ou Inventário.' };
    }

    if (data.ph > 0) {
        await ensurePhState(db, player.id);
    }

    const bypassWeeklyLimit = data.modality.bypassWeeklyLimit ? 1 : 0;
    const weeklyModalityLimit = Number(data.modality.weeklyMaxUses || 0);
    const messageKey = getMessageKey(m, idChat, evaluatorId);
    const quotedEvaluationKey = getQuotedEvaluationKey(m, idChat);
    const sceneInfo = await resolveEvaluationSceneInfo({
        db,
        m,
        data,
        quotedEvaluationKey,
    });
    const weekKey = sceneInfo.weekKey;
    const duplicateBeforeLimits = await db.get(
        'SELECT id FROM clover_quick_evaluations WHERE message_key = ?',
        [messageKey]
    );
    if (duplicateBeforeLimits) {
        return { ok: false, error: 'Essa ficha de avaliação já foi aplicada.' };
    }

    if (quotedEvaluationKey) {
        const quotedDuplicateBeforeLimits = await db.get(
            'SELECT id FROM clover_quick_evaluations WHERE quoted_message_key = ?',
            [quotedEvaluationKey]
        );
        if (quotedDuplicateBeforeLimits) {
            return { ok: false, error: 'Essa cena já foi avaliada.' };
        }
    }

    const currentWeekly = await getWeeklyCommonPh(db, player.id, weekKey);
    const weeklyCapBefore = capWeeklyCommonPh(data, currentWeekly, weekKey);
    if (!weeklyCapBefore.ok) return weeklyCapBefore;
    data = weeklyCapBefore.data;

    if (weeklyModalityLimit > 0) {
        const currentModalityUses = await getWeeklyModalityUses(db, player.id, weekKey, data.modality.key);
        if (currentModalityUses >= weeklyModalityLimit) {
            return {
                ok: false,
                error: renderWeeklyModalityLimitError(data.modality, currentModalityUses, weekKey),
            };
        }
    }

    const metadata = {
        chat_id: idChat,
        evaluator_id: evaluatorId,
        modality: data.modality.key,
        week_key: weekKey,
        scene_sent_at: sceneInfo.sceneSentAt,
        scene_source: sceneInfo.sceneSource,
        evaluated_at: sceneInfo.evaluationSentAt,
        scene_date_text: data.sceneDateText || null,
        base_ph: data.basePh,
        requested_ph: data.requestedPh,
        adjustments: getAdjustmentList(data),
        automatic_bonuses: data.automaticBonuses || [],
        quoted_message_key: quotedEvaluationKey,
        salary_eligible: Boolean(data.salaryEligible),
        salary_service_type: data.salaryServiceType || null,
    };

    await db.exec('BEGIN IMMEDIATE');
    try {
        const duplicate = await db.get(
            'SELECT id FROM clover_quick_evaluations WHERE message_key = ?',
            [messageKey]
        );
        if (duplicate) {
            await db.exec('ROLLBACK');
            return { ok: false, error: 'Essa ficha de avaliação já foi aplicada.' };
        }

        if (quotedEvaluationKey) {
            const quotedDuplicate = await db.get(
                'SELECT id FROM clover_quick_evaluations WHERE quoted_message_key = ?',
                [quotedEvaluationKey]
            );
            if (quotedDuplicate) {
                await db.exec('ROLLBACK');
                return { ok: false, error: 'Essa cena já foi avaliada.' };
            }
        }

        const weeklyInside = await getWeeklyCommonPh(db, player.id, weekKey);
        const weeklyCapInside = capWeeklyCommonPh(data, weeklyInside, weekKey);
        if (!weeklyCapInside.ok) {
            await db.exec('ROLLBACK');
            return weeklyCapInside;
        }
        data = weeklyCapInside.data;
        metadata.adjustments = getAdjustmentList(data);
        metadata.final_ph = data.ph;

        if (weeklyModalityLimit > 0) {
            const modalityInside = await getWeeklyModalityUses(db, player.id, weekKey, data.modality.key);
            if (modalityInside >= weeklyModalityLimit) {
                await db.exec('ROLLBACK');
                return {
                    ok: false,
                    error: renderWeeklyModalityLimitError(data.modality, modalityInside, weekKey),
                };
            }
        }

        const rewards = {
            ph: data.ph,
            base_ph: data.basePh,
            requested_ph: data.requestedPh,
            adjustments: getAdjustmentList(data),
            automatic_bonuses: data.automaticBonuses || [],
            yulls: data.yulls,
            stars: data.stars,
            inventory: inventoryItems,
            scene_sent_at: sceneInfo.sceneSentAt,
            scene_source: sceneInfo.sceneSource,
            evaluated_at: sceneInfo.evaluationSentAt,
            salary_eligible: Boolean(data.salaryEligible),
            salary_service_type: data.salaryServiceType || null,
        };

        const evaluation = await db.run(
            `INSERT INTO clover_quick_evaluations
             (message_key, quoted_message_key, chat_id, player_id, evaluator_id, modality_key, modality_label,
              ph_amount, yulls_amount, stars_amount, inventory_text, scene_sent_at, scene_source, evaluated_at, week_key,
              bypass_weekly_limit, salary_eligible, salary_service_type, rewards_json, created_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
            [
                messageKey,
                quotedEvaluationKey,
                idChat,
                player.id,
                evaluatorId,
                data.modality.key,
                data.modality.label,
                data.ph,
                data.yulls,
                data.stars,
                data.inventoryText || null,
                sceneInfo.sceneSentAt,
                sceneInfo.sceneSource,
                sceneInfo.evaluationSentAt,
                weekKey,
                bypassWeeklyLimit,
                data.salaryEligible ? 1 : 0,
                data.salaryServiceType || null,
                JSON.stringify(rewards),
                JSON.stringify(metadata),
            ]
        );
        const evaluationId = evaluation.lastID;

        let phResult = null;
        if (data.ph > 0) {
            phResult = await addPhInTransaction(
                db,
                player.id,
                data.ph,
                'ficha_avaliacao',
                `Avaliação rápida: ${data.modality.label}`,
                evaluatorId,
                metadata,
                `quick_eval:${evaluationId}`
            );
        }

        let yullsResult = null;
        if (data.yulls > 0) {
            yullsResult = await addYullsInTransaction(
                db,
                player.id,
                data.yulls,
                'ficha_avaliacao',
                `Avaliação rápida: ${data.modality.label}`,
                evaluatorId,
                {
                    relatedId: `quick_eval:${evaluationId}`,
                    idempotencyKey: `yulls:quick_eval:${evaluationId}`,
                    metadata,
                }
            );
        }

        if (data.stars > 0) {
            await db.run(
                `UPDATE jogadores
                 SET estrelas = COALESCE(estrelas, 0) + ?
                 WHERE id = ?`,
                [data.stars, player.id]
            );
        }

        await insertInventoryItems(db, player.id, inventoryItems, evaluationId, evaluatorId, metadata);
        const squadAfter = await applySquadStars(db, player, data.stars, evaluationId, evaluatorId, metadata);
        const updatedPlayer = await db.get('SELECT * FROM jogadores WHERE id = ?', [player.id]);
        const weeklyAfter = bypassWeeklyLimit ? currentWeekly : weeklyInside + data.ph;

        await db.exec('COMMIT');

        let returnBonus = null;
        try {
            returnBonus = await applyReturnBonusForEvaluation({
                db,
                playerId: player.id,
                evaluationId,
                evaluatorId,
                modalityKey: data.modality.key,
                quotedMessageKey: quotedEvaluationKey,
                manualSceneDateText: data.sceneDateText,
            });
        } catch (error) {
            console.log('[anti-ghost] falha ao aplicar bonus de retorno:', error?.message || error);
            returnBonus = { ok: false, applied: false, code: 'error', error };
        }

        try {
            await recordEvaluationActivity({
                db,
                playerId: player.id,
                evaluationId,
                modalityKey: data.modality.key,
                sceneSentAt: sceneInfo.sceneSentAt || returnBonus?.scene?.sceneSentAt || null,
                metadata: {
                    return_bonus: returnBonus?.applied ? returnBonus.bonus?.id : null,
                    scene_source: sceneInfo.sceneSource,
                    week_key: weekKey,
                    evaluated_at: sceneInfo.evaluationSentAt,
                },
            });
        } catch (error) {
            console.log('[anti-ghost] falha ao registrar atividade por avaliacao:', error?.message || error);
        }

        try {
            await recordEvaluationService(db, {
                evaluatorId,
                evaluationId,
                targetPlayerId: player.id,
                modalityKey: data.modality.key,
                modalityLabel: data.modality.label,
                sceneWeekKey: weekKey,
                sceneSentAt: sceneInfo.sceneSentAt,
                evaluatedAt: sceneInfo.evaluationSentAt,
                chatId: idChat,
                metadata: {
                    player_id: player.id,
                    quick_evaluation: true,
                },
            });
        } catch (error) {
            console.log('[servico-adm] falha ao registrar avaliacao:', error?.message || error);
        }

        let recruitmentResult = null;
        try {
            recruitmentResult = await tryValidateReferralFromEvaluation(db, {
                playerId: player.id,
                evaluationId,
                actorId: evaluatorId,
            });
        } catch (error) {
            console.log('[recrutamento] falha ao validar indicação pelo UP:', error?.message || error);
            recruitmentResult = { ok: false, validated: false, error };
        }

        return {
            ok: true,
            player: updatedPlayer,
            data,
            inventoryItems,
            phResult,
            yullsResult,
            weeklyAfter,
            squadAfter,
            sceneInfo,
            yullsAfter: Number(updatedPlayer.dinheiro || 0),
            starsAfter: Number(updatedPlayer.estrelas || 0),
            returnBonus,
            recruitmentResult,
        };
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function tryHandleQuickEvaluation({ sock, db, m, idChat, evaluatorId, text }) {
    if (lifecycleSkip({surface:'interceptor',operation:'tryHandleQuickEvaluation',mutationClass:'CURRENT_WORLD'})) return false;

    if (!looksLikeQuickEvaluation(text)) return false;

    const trace = {
        chatId: maskLogId(idChat),
        evaluatorId: maskLogId(evaluatorId),
        messageId: m?.key?.id || null,
        length: String(text || '').length,
    };
    console.log('[quick-eval] ficha detectada:', trace);

    if (!idChat?.endsWith('@g.us')) {
        console.log('[quick-eval] ignorada: fora de grupo', trace);
        return false;
    }
    if (!await isConfiguredCloverGroup(db, 'on', idChat)) {
        console.log('[quick-eval] ignorada: grupo nao configurado como ON', trace);
        return false;
    }

    const permission = await canUseQuickEvaluation({ sock, db, idChat, evaluatorId });
    if (!permission.ok) {
        console.log('[quick-eval] rejeitada por permissao:', { ...trace, error: permission.error });
        await sendReply({ sock, idChat, m, text: renderQuickEvaluationError(permission.error) });
        return true;
    }

    const parsed = parseEvaluation(text);
    if (!parsed.ok) {
        console.log('[quick-eval] rejeitada pelo parser:', { ...trace, error: parsed.error });
        await sendReply({ sock, idChat, m, text: renderQuickEvaluationError(parsed.error) });
        return true;
    }

    const target = await resolveTargetPlayer(db, m, parsed.data.person);
    if (!target.ok) {
        console.log('[quick-eval] rejeitada por alvo:', { ...trace, error: target.error });
        await sendReply({ sock, idChat, m, text: renderQuickEvaluationError(target.error) });
        return true;
    }

    try {
        const dataWithBonuses = applyAutomaticEvaluationBonuses(target.player, parsed.data);
        const result = await applyQuickEvaluation({
            db,
            m,
            idChat,
            evaluatorId,
            data: dataWithBonuses,
            player: target.player,
        });

        if (!result.ok) {
            console.log('[quick-eval] rejeitada na aplicacao:', { ...trace, error: result.error });
            await sendReply({ sock, idChat, m, text: renderQuickEvaluationError(result.error) });
            return true;
        }

        if (result.squadAfter?.squad_key) {
            result.squadSync = await syncSquadGroupDescription({
                sock,
                db,
                squadKey: result.squadAfter.squad_key,
            });
        }

        console.log('[quick-eval] aplicada no banco:', {
            ...trace,
            playerId: maskLogId(result.player?.id),
            playerName: getPlayerName(result.player),
            modality: result.data?.modality?.key || null,
            ph: Number(result.data?.ph || 0),
            weeklyAfter: Number(result.weeklyAfter || 0),
        });

        const receipt = await sendReply({
            sock,
            idChat,
            m,
            text: renderQuickEvaluationSuccess(result),
            mentions: [result.player.id],
        });
        console.log('[quick-eval] recibo processado:', {
            ...trace,
            playerId: maskLogId(result.player?.id),
            messageId: receipt?.key?.id || null,
            skipped: receipt?.skipped === true,
            reason: receipt?.reason || null,
        });

        await sendReaction({ sock, idChat, m, emoji: '✅' }).catch(() => null);
        const quotedKey = getQuotedMessageKey(m, idChat);
        if (quotedKey) {
            await sendReactionToKey({ sock, idChat, key: quotedKey, emoji: '✅' }).catch(() => null);
        }
        const returnBonusText = renderReturnBonusResult(result.returnBonus);
        if (returnBonusText) {
            await sendReply({ sock, idChat, m, text: returnBonusText });
        }
        const adjustmentText = renderQuickEvaluationAdjustmentNotice(result);
        if (adjustmentText) {
            await sendReply({ sock, idChat, m, text: adjustmentText });
        }
        const recruitmentText = renderRecruitmentValidation(result.recruitmentResult, result.player);
        if (recruitmentText) {
            await sendReply({
                sock,
                idChat,
                m,
                text: recruitmentText,
                mentions: [
                    result.player.id,
                    result.recruitmentResult.referral?.recruiter_player_id,
                ].filter(Boolean),
            });
        }
        return true;
    } catch (error) {
        console.error('[quick-eval] erro apos deteccao:', {
            ...trace,
            error: error?.stack || error?.message || error,
        });
        await sendReply({
            sock,
            idChat,
            m,
            text: renderQuickEvaluationError('Não consegui aplicar a avaliação agora. Nenhuma recompensa foi lançada.'),
        });
        return true;
    }
}
module.exports = {
    MODALITIES,
    WEEKLY_COMMON_PH_LIMIT,
    canUseQuickEvaluation,
    getWeekKey,
    looksLikeQuickEvaluation,
    parseEvaluation,
    renderQuickEvaluationSuccess,
    tryHandleQuickEvaluation,
};
