'use strict';

const crypto = require('crypto');
const { COMMAND_PREFIX } = require('../../config/bot');
const { sendReply } = require('../chatReply');
const { isOwner } = require('../groupAccess');
const {
    formatMention,
    getMentions,
    getQuotedParticipant,
    jidFromToken,
    stripMentionTokens,
} = require('./commandTargetUtils');
const {
    getEvaluatorsWithPending,
    getServiceSummary,
    normalizeWeekInput,
    resolveServiceEvaluatorId,
} = require('./adminService');
const { payPaAsPhSafely } = require('./paAdminPayoutService');
const base = require('./paCommandService');
const { getPaShopState, purchasePaShopItem } = require('./paShopService');
const { syncSquadGroupDescription } = require('./squadService');

const DISPLAY_NAMES = Object.freeze({
    ph: '𝐏𝐇 𝐝𝐞 𝐬𝐞𝐫𝐯𝐢𝐜̧𝐨',
    yulls: '𝐘𝐮𝐥𝐥𝐬 𝐝𝐞 𝐬𝐞𝐫𝐯𝐢𝐜̧𝐨',
    caixa_simples: '𝐂𝐚𝐢𝐱𝐚 𝐬𝐢𝐦𝐩𝐥𝐞𝐬',
    cupom_prioridade: '𝐂𝐮𝐩𝐨𝐦 𝐝𝐞 𝐩𝐫𝐢𝐨𝐫𝐢𝐝𝐚𝐝𝐞',
    estrela_esquadrao: '𝐄𝐬𝐭𝐫𝐞𝐥𝐚 𝐝𝐞 𝐞𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨',
});

const BUY_ACTIONS = new Set(['comprar', 'compra', 'buy']);
const REDEEM_ACTIONS = new Set(['resgatar', 'sacar', 'usar']);
const PAY_ACTIONS = new Set(['pagar', 'pagamento', 'pay']);
const SELF_STATUS_ACTIONS = new Set(['', 'status', 'saldo', 'carteira', 'meu', 'meus']);

function section(symbol, title) {
    return `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;
}

function normalizeAction(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function splitBody(body) {
    const parts = String(body || '').trim().split(/\s+/).filter(Boolean);
    return {
        action: normalizeAction(parts.shift() || ''),
        rest: parts,
    };
}

function formatUsage(item) {
    const suffix = item.limitMode === 'common_ph' ? ' PH comuns' : '';
    return `${item.used}/${item.limit}${suffix}`;
}

function displayItemName(item) {
    if (!item) return 'Item da Loja de PA';
    return DISPLAY_NAMES[item.key] || item.name || item.key || 'Item da Loja de PA';
}

function displayEvaluatorName(player, evaluatorId) {
    return [player?.personagem_nome, player?.display_name, player?.nome]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-')
        || String(evaluatorId || 'Avaliador');
}

function purchaseRewardLabel(result) {
    if (!result?.item) return '-';
    if (result.item.key === 'ph') return `${result.quantity} PH`;
    if (result.item.key === 'yulls') return `${Number(result.quantity || 0) * 500}¥`;
    return result.item.rewardLabel || '-';
}

function purchaseErrorMessage(result = {}) {
    const messages = {
        unknown_item: 'Item não encontrado. Abra a loja para conferir os IDs.',
        quantity_required: 'Informe a quantidade de PH. Exemplo: `pa comprar 1 10`.',
        single_only: 'Esse item aceita somente uma unidade por compra.',
        insufficient_pa: `PA insuficiente. Disponível: ${Number(result.availablePa || 0)}; custo: ${Number(result.paCost || 0)}.`,
        weekly_ph_limit: `O teto comum não comporta essa compra. Disponível agora: ${Number(result.available || 0)} PH.`,
        weekly_item_limit: `Limite semanal atingido. Uso atual: ${Number(result.used || 0)}/${Number(result.limit || 0)}.`,
        no_player: 'Não encontrei um personagem vinculado a esse avaliador.',
        no_character: 'O PA fica guardado, mas a compra exige um personagem completo vinculado.',
        no_squad: 'A Estrela de esquadrão exige um esquadrão registrado no personagem.',
        duplicate: 'Essa compra já foi processada. Nenhum PA foi retirado novamente.',
    };
    return messages[result.code] || 'A compra não foi aplicada.';
}

function renderPurchaseResult(result, { squadSync = null } = {}) {
    if (!result?.ok) {
        return [
            '*♧┃𝐂𝐎𝐌𝐏𝐑𝐀 𝐍𝐀̃𝐎 𝐀𝐏𝐋𝐈𝐂𝐀𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '     ──  seu PA continua protegido  ──',
            '',
            section('!', '𝗔𝘃𝗶𝘀𝗼'),
            '',
            `> ${purchaseErrorMessage(result)}`,
        ].join('\n');
    }

    const lines = [
        '*♧┃𝐂𝐎𝐌𝐏𝐑𝐀 𝐂𝐎𝐍𝐂𝐋𝐔𝐈́𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  recompensa registrada no personagem  ──',
        '',
        section('✓', '𝗥𝗲𝗰𝗼𝗺𝗽𝗲𝗻𝘀𝗮'),
        '',
        `*𝐈𝐭𝐞𝐦:* ${displayItemName(result.item)}`,
        `*𝐐𝐮𝐚𝐧𝐭𝐢𝐝𝐚𝐝𝐞:* ${result.quantity}`,
        `*𝐑𝐞𝐜𝐨𝐦𝐩𝐞𝐧𝐬𝐚:* ${purchaseRewardLabel(result)}`,
        '',
        section('✦', '𝗖𝗮𝗿𝘁𝗲𝗶𝗿𝗮'),
        '',
        `*𝐂𝐮𝐬𝐭𝐨:* ${result.paCost} PA`,
        `*𝐏𝐀 𝐫𝐞𝐬𝐭𝐚𝐧𝐭𝐞:* ${result.availablePaAfter}`,
        `*𝐔𝐬𝐨 𝐬𝐞𝐦𝐚𝐧𝐚𝐥:* ${Number(result.usedBefore || 0) + Number(result.quantity || 0)}/${result.limit}`,
    ];

    if (result.reward?.squadKey) {
        lines.push(
            '',
            section('★', '𝗘𝘀𝗾𝘂𝗮𝗱𝗿𝗮̃𝗼'),
            '',
            `*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨:* ${result.reward.squadName || result.reward.squadKey}`,
            `*𝐃𝐞𝐬𝐜𝐫𝐢𝐜̧𝐚̃𝐨:* ${squadSync?.ok ? 'sincronizada' : 'pendente'}`
        );
    }

    return lines.join('\n');
}

function buildIdempotencyKey(args, evaluatorId) {
    const messageId = String(args?.m?.key?.id || '').trim();
    const timestamp = String(args?.m?.messageTimestamp || args?.m?.message?.messageTimestamp || '').trim();
    const body = String(args?.body || '').trim();
    const raw = [args?.idChat, evaluatorId, messageId || timestamp || 'sem-metadata', body].join('|');
    const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
    return `pa_shop:${digest}`;
}

async function renderStatus(db, evaluatorId) {
    const [state, service] = await Promise.all([
        getPaShopState(db, evaluatorId),
        getServiceSummary(db, evaluatorId),
    ]);
    const remainingPh = Math.max(0, 30 - Number(state.commonPhUsed || 0));

    return [
        '*♧┃𝐏𝐀 · 𝐏𝐎𝐍𝐓𝐎𝐒 𝐃𝐄 𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  mᥱ́rıto αcumυlαdo por αvαlıαçõᥱs  ──',
        '',
        section('✓', '𝗖𝗮𝗿𝘁𝗲𝗶𝗿𝗮'),
        '',
        `*𝐀𝐯𝐚𝐥𝐢𝐚𝐝𝐨𝐫:* ${displayEvaluatorName(state.player, evaluatorId)}`,
        `*𝐏𝐀 𝐝𝐢𝐬𝐩𝐨𝐧𝐢́𝐯𝐞𝐥:* ${state.availablePa}`,
        `*𝐏𝐀 𝐫𝐞𝐠𝐢𝐬𝐭𝐫𝐚𝐝𝐨:* ${state.earnedPa}`,
        `*𝐏𝐀 𝐠𝐚𝐬𝐭𝐨 𝐧𝐚 𝐥𝐨𝐣𝐚:* ${state.spentPa}`,
        `*𝐏𝐇 𝐜𝐨𝐧𝐯𝐞𝐫𝐭𝐢𝐝𝐨:* ${service.phPaid}`,
        `*𝐀𝐯𝐚𝐥𝐢𝐚𝐜̧𝐨̃𝐞𝐬 𝐜𝐨𝐧𝐭𝐚𝐝𝐚𝐬:* ${service.evaluations}`,
        '',
        section('✦', '𝗦𝗲𝗺𝗮𝗻𝗮 𝗔𝘁𝘂𝗮𝗹'),
        '',
        `*𝐒𝐞𝐦𝐚𝐧𝐚:* ${state.weekKey}`,
        `*𝐏𝐇 𝐜𝐨𝐦𝐮𝐦:* ${state.commonPhUsed}/30`,
        `*𝐏𝐇 𝐝𝐢𝐬𝐩𝐨𝐧𝐢́𝐯𝐞𝐥:* ${remainingPh}`,
        '',
        section('!', '𝗥𝗲𝗴𝗿𝗮'),
        '',
        '> PA pode acumular livremente.',
        '> O limite semanal fica em cada recompensa da loja.',
        '> PH comprado usa o mesmo teto comum de treino e avaliação.',
    ].join('\n');
}

async function renderShop(db, evaluatorId) {
    const state = await getPaShopState(db, evaluatorId);
    const lines = [
        '*♧┃𝐋𝐎𝐉𝐀 𝐃𝐄 𝐏𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  rᥱcompᥱnsαs sᥱmαnαıs dα stαff  ──',
        '',
        section('✓', '𝗖𝗮𝗿𝘁𝗲𝗶𝗿𝗮'),
        '',
        `*𝐏𝐀 𝐝𝐢𝐬𝐩𝐨𝐧𝐢́𝐯𝐞𝐥:* ${state.availablePa}`,
        `*𝐒𝐞𝐦𝐚𝐧𝐚:* ${state.weekKey}`,
        '',
        section('✦', '𝗥𝗲𝗰𝗼𝗺𝗽𝗲𝗻𝘀𝗮𝘀'),
        '',
    ];

    for (const item of state.items) {
        const blocked = item.blockedCode === 'no_squad'
            ? ' · requer esquadrão'
            : item.blockedCode === 'no_character'
                ? ' · requer personagem'
                : '';
        const unit = item.quantityMode === 'single' ? '' : ' por unidade';
        const details = [
            `*${item.id}. ${displayItemName(item)}*`,
            `> 𝐂𝐮𝐬𝐭𝐨: ${item.unitPaCost} PA${unit}.`,
            `> 𝐑𝐞𝐜𝐨𝐦𝐩𝐞𝐧𝐬𝐚: ${item.rewardLabel}.`,
            `> 𝐔𝐬𝐨 𝐬𝐞𝐦𝐚𝐧𝐚𝐥: ${formatUsage(item)}${blocked}.`,
        ];
        if (item.limitMode === 'common_ph') {
            details.push(`> 𝐃𝐢𝐬𝐩𝐨𝐧𝐢́𝐯𝐞𝐥 𝐚𝐠𝐨𝐫𝐚: +${item.available} PH.`);
        }
        lines.push(...details, '');
    }

    lines.push(
        section('◆', '𝗖𝗼𝗺𝗽𝗿𝗮'),
        '',
        `> ${COMMAND_PREFIX}pa comprar <id> [quantidade]`,
        `> Exemplo: ${COMMAND_PREFIX}pa comprar 1 10`,
        '',
        section('!', '𝗥𝗲𝗴𝗿𝗮'),
        '',
        '> PA pode acumular livremente.',
        '> O limite fica em cada recompensa da loja.',
        '> PH comprado conta junto com treino e avaliação.',
    );

    return lines.join('\n');
}

function parsePayOptions(rest) {
    const joined = rest.join(' ');
    const weekMatch = joined.match(/(?:^|\s)(?:semana|week)=([^\s]+)/i);
    const serviceWeekKey = weekMatch ? normalizeWeekInput(weekMatch[1]) : null;
    const cleaned = joined
        .replace(/(?:^|\s)(?:semana|week)=[^\s]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const pointToken = cleaned.split(/\s+/).find((token) => /^\d{1,4}$/.test(token));
    const points = pointToken ? Number(pointToken) : null;
    const payAll = rest.some((token) => normalizeAction(token) === 'todos');
    return { serviceWeekKey, points, payAll };
}

async function resolvePayTarget(db, rest, m) {
    const mentions = getMentions(m);
    if (mentions.length) return resolveServiceEvaluatorId(db, mentions[0]);

    const quoted = getQuotedParticipant(m);
    if (quoted) return resolveServiceEvaluatorId(db, quoted);

    const clean = stripMentionTokens(rest.join(' '));
    const token = clean.split(/\s+/).find((item) => jidFromToken(item));
    const jid = token ? jidFromToken(token) : null;
    return jid ? resolveServiceEvaluatorId(db, jid) : null;
}

function payoutErrorMessage(result = {}) {
    const messages = {
        no_pending: 'Esse avaliador não possui PA disponível nesse recorte.',
        weekly_cap: 'O personagem já atingiu o teto semanal comum de PH.',
        no_player: 'Não encontrei personagem vinculado ao avaliador.',
        no_character: 'O avaliador existe, mas ainda não possui personagem completo.',
    };
    return messages[result.code] || 'A conversão administrativa não foi aplicada.';
}

function renderAdminPayout(result, evaluatorId) {
    if (!result?.ok) {
        return [
            '*♧┃𝐂𝐎𝐍𝐕𝐄𝐑𝐒𝐀̃𝐎 𝐃𝐄 𝐏𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '     ──  pagamento administrativo não aplicado  ──',
            '',
            section('!', '𝗔𝘃𝗶𝘀𝗼'),
            '',
            `> ${payoutErrorMessage(result)}`,
        ].join('\n');
    }

    return [
        '*♧┃𝐂𝐎𝐍𝐕𝐄𝐑𝐒𝐀̃𝐎 𝐃𝐄 𝐏𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  pagamento administrativo concluído  ──',
        '',
        section('✓', '𝗥𝗲𝘀𝘂𝗹𝘁𝗮𝗱𝗼'),
        '',
        `*𝐀𝐯𝐚𝐥𝐢𝐚𝐝𝐨𝐫:* ${displayEvaluatorName(result.player, evaluatorId)}`,
        `*𝐏𝐀 𝐜𝐨𝐧𝐬𝐮𝐦𝐢𝐝𝐨:* ${result.pointsPaid}`,
        `*𝐏𝐇 𝐞𝐧𝐭𝐫𝐞𝐠𝐮𝐞:* ${result.phPaid}`,
        `*𝐒𝐞𝐦𝐚𝐧𝐚 𝐝𝐨 𝐏𝐇:* ${result.payoutWeekKey}`,
        result.serviceWeekKey ? `*𝐎𝐫𝐢𝐠𝐞𝐦 𝐝𝐨 𝐏𝐀:* ${result.serviceWeekKey}` : null,
        `*𝐓𝐞𝐭𝐨 𝐚𝐧𝐭𝐞𝐬:* ${result.usedThisWeek}/30`,
    ].filter(Boolean).join('\n');
}

async function executeAdminPayout(args, rest) {
    if (!isOwner(args.idJogador)) {
        await sendReply({
            sock: args.sock,
            idChat: args.idChat,
            m: args.m,
            text: 'Apenas o dono pode aplicar conversão administrativa de PA.',
        });
        return;
    }

    const options = parsePayOptions(rest);
    if (options.payAll) {
        const evaluators = await getEvaluatorsWithPending(args.db);
        const results = [];
        for (const evaluator of evaluators) {
            const result = await payPaAsPhSafely(args.db, evaluator.evaluator_id, {
                createdBy: args.idJogador,
                reason: 'Conversão administrativa em lote',
                weekKey: options.serviceWeekKey,
                points: options.points,
            });
            results.push({ evaluatorId: evaluator.evaluator_id, result });
        }
        const paid = results.filter((item) => item.result.ok);
        const totalPa = paid.reduce((sum, item) => sum + Number(item.result.pointsPaid || 0), 0);
        await sendReply({
            sock: args.sock,
            idChat: args.idChat,
            m: args.m,
            text: [
                '*♧┃𝐏𝐀𝐆𝐀𝐌𝐄𝐍𝐓𝐎 𝐄𝐌 𝐋𝐎𝐓𝐄 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
                '     ──  conversão administrativa da staff  ──',
                '',
                section('✓', '𝗥𝗲𝘀𝘂𝗺𝗼'),
                '',
                `*𝐀𝐯𝐚𝐥𝐢𝐚𝐝𝐨𝐫𝐞𝐬 𝐩𝐚𝐠𝐨𝐬:* ${paid.length}`,
                `*𝐀𝐯𝐚𝐥𝐢𝐚𝐝𝐨𝐫𝐞𝐬 𝐢𝐠𝐧𝐨𝐫𝐚𝐝𝐨𝐬:* ${results.length - paid.length}`,
                `*𝐏𝐀/𝐏𝐇 𝐜𝐨𝐧𝐯𝐞𝐫𝐭𝐢𝐝𝐨:* ${totalPa}`,
                options.serviceWeekKey ? `*𝐎𝐫𝐢𝐠𝐞𝐦 𝐝𝐨 𝐏𝐀:* ${options.serviceWeekKey}` : null,
            ].filter(Boolean).join('\n'),
        });
        return;
    }

    const evaluatorId = await resolvePayTarget(args.db, rest, args.m);
    if (!evaluatorId) {
        await sendReply({
            sock: args.sock,
            idChat: args.idChat,
            m: args.m,
            text: `Informe o avaliador. Exemplo: ${COMMAND_PREFIX}pa pagar @avaliador 10`,
        });
        return;
    }

    const result = await payPaAsPhSafely(args.db, evaluatorId, {
        createdBy: args.idJogador,
        reason: 'Conversão administrativa de PA',
        weekKey: options.serviceWeekKey,
        points: options.points,
    });
    await sendReply({
        sock: args.sock,
        idChat: args.idChat,
        m: args.m,
        text: renderAdminPayout(result, evaluatorId),
    });
}

async function executePurchase(args, { redeem = false } = {}) {
    const { rest } = splitBody(args.body);
    const evaluatorId = await resolveServiceEvaluatorId(args.db, args.idJogador);
    const itemInput = redeem ? 'ph' : (rest[0] || '');
    const quantity = redeem ? (rest[0] || null) : (rest[1] || null);
    const result = await purchasePaShopItem(args.db, evaluatorId, itemInput, {
        quantity,
        createdBy: args.idJogador,
        idempotencyKey: buildIdempotencyKey(args, evaluatorId),
    });

    let squadSync = null;
    if (result.ok && result.reward?.squadKey) {
        squadSync = await syncSquadGroupDescription({
            sock: args.sock,
            db: args.db,
            squadKey: result.reward.squadKey,
        }).catch(() => null);
    }

    await sendReply({
        sock: args.sock,
        idChat: args.idChat,
        m: args.m,
        text: renderPurchaseResult(result, { squadSync }),
    });
}

async function executePaCommand(args) {
    const { action, rest } = splitBody(args.body);
    if (SELF_STATUS_ACTIONS.has(action) && rest.length === 0) {
        const evaluatorId = await resolveServiceEvaluatorId(args.db, args.idJogador);
        await sendReply({
            sock: args.sock,
            idChat: args.idChat,
            m: args.m,
            text: await renderStatus(args.db, evaluatorId),
        });
        return;
    }
    if (['loja', 'shop', 'recompensas'].includes(action)) {
        const evaluatorId = await resolveServiceEvaluatorId(args.db, args.idJogador);
        await sendReply({
            sock: args.sock,
            idChat: args.idChat,
            m: args.m,
            text: await renderShop(args.db, evaluatorId),
        });
        return;
    }
    if (BUY_ACTIONS.has(action)) {
        await executePurchase(args);
        return;
    }
    if (REDEEM_ACTIONS.has(action)) {
        await executePurchase(args, { redeem: true });
        return;
    }
    if (PAY_ACTIONS.has(action)) {
        await executeAdminPayout(args, rest);
        return;
    }
    return base.executePaCommand(args);
}

module.exports = {
    ...base,
    buildIdempotencyKey,
    executePaCommand,
    renderAdminPayout,
    renderPurchaseResult,
    renderShop,
    renderStatus,
};