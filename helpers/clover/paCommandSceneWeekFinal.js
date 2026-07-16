'use strict';

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
    normalizeWeekInput,
    resolveServiceEvaluatorId,
} = require('./adminService');
const { getPaShopItem } = require('./paShopCatalog');
const { getPaShopState, resolvePaShopPlayer } = require('./paShopService');
const base = require('./paCommandItemsFinal');
const {
    auditPaSceneWeeks,
    getPaOriginSummary,
    payPaBySceneWeek,
    purchasePhBySceneWeek,
} = require('./paSceneWeekService');

const STATUS_ACTIONS = new Set(['', 'status', 'saldo', 'carteira', 'meu', 'meus']);
const SHOP_ACTIONS = new Set(['loja', 'shop', 'recompensas']);
const BUY_ACTIONS = new Set(['comprar', 'compra', 'buy']);
const REDEEM_ACTIONS = new Set(['resgatar', 'sacar', 'usar']);
const PAY_ACTIONS = new Set(['pagar', 'pagamento', 'pay']);
const ORIGIN_ACTIONS = new Set(['origens', 'origem', 'semanaspa', 'semanasdopa']);
const AUDIT_ACTIONS = new Set(['auditar', 'auditoria']);

const DISPLAY_NAMES = Object.freeze({
    ph: '𝐏𝐇 𝐝𝐞 𝐬𝐞𝐫𝐯𝐢𝐜̧𝐨',
    yulls: '𝐘𝐮𝐥𝐥𝐬 𝐝𝐞 𝐬𝐞𝐫𝐯𝐢𝐜̧𝐨',
    caixa_simples: '𝐂𝐚𝐢𝐱𝐚 𝐬𝐢𝐦𝐩𝐥𝐞𝐬',
    cupom_prioridade: '𝐂𝐮𝐩𝐨𝐦 𝐝𝐞 𝐩𝐫𝐢𝐨𝐫𝐢𝐝𝐚𝐝𝐞',
    estrela_esquadrao: '𝐄𝐬𝐭𝐫𝐞𝐥𝐚 𝐝𝐞 𝐞𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨',
});

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

function displayName(player, fallback) {
    return [player?.personagem_nome, player?.display_name, player?.nome]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-')
        || formatMention(fallback);
}

function displayItemName(item) {
    return DISPLAY_NAMES[item?.key] || item?.name || item?.key || 'Item';
}

function formatBucket(bucket) {
    return `*${bucket.weekKey}:* ${bucket.pendingPa} PA · teto ${bucket.usedPh}/30 · PH possível ${bucket.purchasablePh}`;
}

function bucketLines(summary, limit = 6) {
    if (!summary?.buckets?.length) return ['> Nenhum PA pendente com semana de origem.'];
    const lines = summary.buckets.slice(0, limit).map(formatBucket);
    if (summary.buckets.length > limit) lines.push(`> … e mais ${summary.buckets.length - limit} semana(s).`);
    return lines;
}

async function resolveEvaluatorTarget(db, rest, m, fallbackId) {
    const mentions = getMentions(m);
    if (mentions.length) return resolveServiceEvaluatorId(db, mentions[0]);

    const quoted = getQuotedParticipant(m);
    if (quoted) return resolveServiceEvaluatorId(db, quoted);

    const clean = stripMentionTokens((rest || []).join(' '));
    const token = clean.split(/\s+/).find((item) => jidFromToken(item));
    const jid = token ? jidFromToken(token) : null;
    return resolveServiceEvaluatorId(db, jid || fallbackId);
}

async function getSummaryForEvaluator(db, evaluatorId, options = {}) {
    const playerResult = await resolvePaShopPlayer(db, evaluatorId);
    if (!playerResult.ok) return { playerResult, summary: null };
    return {
        playerResult,
        summary: await getPaOriginSummary(db, evaluatorId, playerResult.player.id, options),
    };
}

async function renderOriginStatus(db, evaluatorId) {
    const { playerResult, summary } = await getSummaryForEvaluator(db, evaluatorId);
    if (!playerResult.ok) {
        return [
            '*♧┃𝐎𝐑𝐈𝐆𝐄𝐌 𝐃𝐎 𝐏𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '',
            '> Não encontrei um personagem completo vinculado a esse avaliador.',
        ].join('\n');
    }

    return [
        '*♧┃𝐎𝐑𝐈𝐆𝐄𝐌 𝐃𝐎 𝐏𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  cada lote respeita a semana da cena  ──',
        '',
        section('✓', '𝗔𝘃𝗮𝗹𝗶𝗮𝗱𝗼𝗿'),
        '',
        `*𝐍𝐨𝐦𝐞:* ${displayName(playerResult.player, evaluatorId)}`,
        `*𝐏𝐀 𝐩𝐞𝐧𝐝𝐞𝐧𝐭𝐞:* ${summary.pendingPa}`,
        `*𝐏𝐇 𝐜𝐨𝐧𝐯𝐞𝐫𝐬𝐢́𝐯𝐞𝐥:* ${summary.purchasablePh}`,
        `*𝐏𝐀 𝐛𝐥𝐨𝐪𝐮𝐞𝐚𝐝𝐨 𝐩𝐨𝐫 𝐭𝐞𝐭𝐨:* ${summary.blockedPa}`,
        '',
        section('✦', '𝗦𝗲𝗺𝗮𝗻𝗮𝘀 𝗱𝗲 𝗢𝗿𝗶𝗴𝗲𝗺'),
        '',
        ...bucketLines(summary),
        '',
        '> PA bloqueado para PH continua disponível para os outros itens da loja.',
    ].join('\n');
}

async function renderStatus(db, evaluatorId) {
    const baseText = await base.renderStatus(db, evaluatorId);
    const { summary } = await getSummaryForEvaluator(db, evaluatorId);
    if (!summary) return baseText;

    return [
        baseText.replace(
            '> PH comprado usa o mesmo teto comum de treino e avaliação.',
            '> PH comprado usa o teto da semana da cena que gerou o PA.'
        ),
        '',
        section('◈', '𝗣𝗔 𝗽𝗼𝗿 𝗦𝗲𝗺𝗮𝗻𝗮 𝗱𝗮 𝗖𝗲𝗻𝗮'),
        '',
        `*𝐏𝐇 𝐜𝐨𝐧𝐯𝐞𝐫𝐬𝐢́𝐯𝐞𝐥 𝐚𝐠𝐨𝐫𝐚:* ${summary.purchasablePh}`,
        ...bucketLines(summary, 4),
        '',
        `> Detalhes: ${COMMAND_PREFIX}pa origens`,
    ].join('\n');
}

async function renderSceneWeekShop(db, evaluatorId) {
    const state = await getPaShopState(db, evaluatorId);
    const { summary } = await getSummaryForEvaluator(db, evaluatorId);
    const lines = [
        '*♧┃𝐋𝐎𝐉𝐀 𝐃𝐄 𝐏𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  recompensas da staff  ──',
        '',
        section('✓', '𝗖𝗮𝗿𝘁𝗲𝗶𝗿𝗮'),
        '',
        `*𝐏𝐀 𝐝𝐢𝐬𝐩𝐨𝐧𝐢́𝐯𝐞𝐥:* ${state.availablePa}`,
        `*𝐏𝐇 𝐜𝐨𝐧𝐯𝐞𝐫𝐬𝐢́𝐯𝐞𝐥:* ${summary?.purchasablePh || 0}`,
        '',
        section('✦', '𝗥𝗲𝗰𝗼𝗺𝗽𝗲𝗻𝘀𝗮𝘀'),
        '',
    ];

    const ph = state.items.find((item) => item.key === 'ph');
    lines.push(
        `*1. ${displayItemName(ph)}*`,
        '> 𝐂𝐮𝐬𝐭𝐨: 1 PA por PH.',
        `> 𝐃𝐢𝐬𝐩𝐨𝐧𝐢́𝐯𝐞𝐥 𝐩𝐞𝐥𝐚𝐬 𝐨𝐫𝐢𝐠𝐞𝐧𝐬: +${summary?.purchasablePh || 0} PH.`,
        '> Cada PH entra no teto da semana da cena que gerou o PA.',
        ''
    );

    for (const item of state.items.filter((entry) => entry.key !== 'ph')) {
        const blocked = item.blockedCode === 'no_squad'
            ? ' · requer esquadrão'
            : item.blockedCode === 'no_character'
                ? ' · requer personagem'
                : '';
        const unit = item.quantityMode === 'single' ? '' : ' por unidade';
        lines.push(
            `*${item.id}. ${displayItemName(item)}*`,
            `> 𝐂𝐮𝐬𝐭𝐨: ${item.unitPaCost} PA${unit}.`,
            `> 𝐑𝐞𝐜𝐨𝐦𝐩𝐞𝐧𝐬𝐚: ${item.rewardLabel}.`,
            `> 𝐔𝐬𝐨 𝐬𝐞𝐦𝐚𝐧𝐚𝐥: ${item.used}/${item.limit}${blocked}.`,
            ''
        );
    }

    lines.push(
        section('◆', '𝗖𝗼𝗺𝗽𝗿𝗮'),
        '',
        `> ${COMMAND_PREFIX}pa comprar <id> [quantidade]`,
        `> ${COMMAND_PREFIX}pa origens`,
        '',
        section('◇', '𝗨𝘀𝗼 𝗱𝗼𝘀 𝗜𝘁𝗲𝗻𝘀'),
        '',
        `> ${COMMAND_PREFIX}pa abrir`,
        `> ${COMMAND_PREFIX}pa prioridade`,
        '',
        '> PA de uma semana lotada não desaparece e pode comprar os outros itens.',
    );

    return lines.join('\n');
}

function renderPhPurchase(result) {
    if (!result?.ok) {
        const message = result.code === 'weekly_ph_limit'
            ? `As semanas de origem comportam apenas ${Number(result.available || 0)} PH agora. Nenhum PA foi consumido.`
            : result.code === 'insufficient_pa'
                ? `PA insuficiente. Disponível: ${Number(result.availablePa || 0)}; custo: ${Number(result.paCost || 0)}.`
                : result.code === 'quantity_required'
                    ? `Informe a quantidade. Exemplo: ${COMMAND_PREFIX}pa comprar 1 10.`
                    : result.code === 'duplicate'
                        ? 'Essa compra já foi processada. Nenhum PA foi retirado novamente.'
                        : result.code === 'no_character' || result.code === 'no_player'
                            ? 'A compra de PH exige um personagem completo vinculado.'
                            : 'A compra não foi aplicada.';
        return [
            '*♧┃𝐂𝐎𝐌𝐏𝐑𝐀 𝐍𝐀̃𝐎 𝐀𝐏𝐋𝐈𝐂𝐀𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '     ──  seu PA continua protegido  ──',
            '',
            section('!', '𝗔𝘃𝗶𝘀𝗼'),
            '',
            `> ${message}`,
        ].join('\n');
    }

    return [
        '*♧┃𝐂𝐎𝐌𝐏𝐑𝐀 𝐂𝐎𝐍𝐂𝐋𝐔𝐈́𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  PH registrado pela origem do PA  ──',
        '',
        section('✓', '𝗥𝗲𝘀𝘂𝗹𝘁𝗮𝗱𝗼'),
        '',
        `*𝐏𝐇 𝐞𝐧𝐭𝐫𝐞𝐠𝐮𝐞:* ${result.quantity}`,
        `*𝐏𝐀 𝐜𝐨𝐧𝐬𝐮𝐦𝐢𝐝𝐨:* ${result.paCost}`,
        `*𝐏𝐀 𝐫𝐞𝐬𝐭𝐚𝐧𝐭𝐞:* ${result.availablePaAfter}`,
        '',
        section('✦', '𝗦𝗲𝗺𝗮𝗻𝗮 𝗱𝗼 𝗣𝗛'),
        '',
        ...(result.originAllocations || []).map((item) => (
            `*${item.weekKey}:* +${item.amount} PH · teto ${item.usedBefore}/30 → ${item.usedAfter}/30`
        )),
    ].join('\n');
}

function parsePayOptions(rest) {
    const joined = (rest || []).join(' ');
    const weekMatch = joined.match(/(?:^|\s)(?:semana|week)=([^\s]+)/i);
    const serviceWeekKey = weekMatch ? normalizeWeekInput(weekMatch[1]) : null;
    const cleaned = joined
        .replace(/(?:^|\s)(?:semana|week)=[^\s]+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const pointToken = cleaned.split(/\s+/).find((token) => /^\d{1,4}$/.test(token));
    const points = pointToken ? Number(pointToken) : null;
    const payAll = (rest || []).some((token) => normalizeAction(token) === 'todos');
    return { serviceWeekKey, points, payAll };
}

function renderAdminPayout(result, evaluatorId) {
    if (!result?.ok) {
        const message = result?.code === 'no_pending'
            ? 'Esse avaliador não possui PA disponível nesse recorte.'
            : result?.code === 'weekly_cap'
                ? 'Nenhuma semana de origem possui espaço no teto comum. O PA continua guardado.'
                : 'A conversão administrativa não foi aplicada.';
        return [
            '*♧┃𝐂𝐎𝐍𝐕𝐄𝐑𝐒𝐀̃𝐎 𝐃𝐄 𝐏𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '',
            `> ${message}`,
        ].join('\n');
    }

    return [
        '*♧┃𝐂𝐎𝐍𝐕𝐄𝐑𝐒𝐀̃𝐎 𝐃𝐄 𝐏𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  PH lançado nas semanas das cenas  ──',
        '',
        section('✓', '𝗥𝗲𝘀𝘂𝗹𝘁𝗮𝗱𝗼'),
        '',
        `*𝐀𝐯𝐚𝐥𝐢𝐚𝐝𝐨𝐫:* ${displayName(result.player, evaluatorId)}`,
        `*𝐏𝐀/𝐏𝐇 𝐜𝐨𝐧𝐯𝐞𝐫𝐭𝐢𝐝𝐨:* ${result.pointsPaid}`,
        result.partialByCap ? '> Conversão parcial: o restante continua como PA.' : null,
        '',
        section('✦', '𝗗𝗶𝘃𝗶𝘀𝗮̃𝗼'),
        '',
        ...(result.allocations || []).map((item) => (
            `*${item.weekKey}:* +${item.amount} PH · teto ${item.usedBefore}/30 → ${item.usedAfter}/30`
        )),
    ].filter(Boolean).join('\n');
}

async function executeAdminPayout(args, rest) {
    if (!isOwner(args.idJogador)) {
        await sendReply({ sock: args.sock, idChat: args.idChat, m: args.m, text: 'Apenas o dono pode converter PA administrativamente.' });
        return;
    }

    const options = parsePayOptions(rest);
    if (options.payAll) {
        const evaluators = await getEvaluatorsWithPending(args.db);
        const results = [];
        for (const evaluator of evaluators) {
            const result = await payPaBySceneWeek(args.db, evaluator.evaluator_id, {
                createdBy: args.idJogador,
                reason: 'Conversão administrativa em lote',
                weekKey: options.serviceWeekKey,
                points: options.points,
            });
            results.push(result);
        }
        const paid = results.filter((result) => result.ok);
        await sendReply({
            sock: args.sock,
            idChat: args.idChat,
            m: args.m,
            text: [
                '*♧┃𝐏𝐀𝐆𝐀𝐌𝐄𝐍𝐓𝐎 𝐄𝐌 𝐋𝐎𝐓𝐄 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
                '',
                `*𝐀𝐯𝐚𝐥𝐢𝐚𝐝𝐨𝐫𝐞𝐬 𝐩𝐚𝐠𝐨𝐬:* ${paid.length}`,
                `*𝐏𝐀/𝐏𝐇 𝐜𝐨𝐧𝐯𝐞𝐫𝐭𝐢𝐝𝐨:* ${paid.reduce((sum, result) => sum + Number(result.pointsPaid || 0), 0)}`,
                `*𝐈𝐠𝐧𝐨𝐫𝐚𝐝𝐨𝐬:* ${results.length - paid.length}`,
            ].join('\n'),
        });
        return;
    }

    const evaluatorId = await resolveEvaluatorTarget(args.db, rest, args.m, null);
    if (!evaluatorId) {
        await sendReply({ sock: args.sock, idChat: args.idChat, m: args.m, text: `Informe o avaliador. Exemplo: ${COMMAND_PREFIX}pa pagar @avaliador 10` });
        return;
    }
    const result = await payPaBySceneWeek(args.db, evaluatorId, {
        createdBy: args.idJogador,
        reason: 'Conversão administrativa de PA',
        weekKey: options.serviceWeekKey,
        points: options.points,
    });
    await sendReply({ sock: args.sock, idChat: args.idChat, m: args.m, text: renderAdminPayout(result, evaluatorId) });
}

function renderAudit(report) {
    const lines = [
        '*♧┃𝐀𝐔𝐃𝐈𝐓𝐎𝐑𝐈𝐀 𝐃𝐄 𝐒𝐄𝐌𝐀𝐍𝐀𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  relatório somente leitura  ──',
        '',
        section('✓', '𝗥𝗲𝘀𝘂𝗺𝗼'),
        '',
        `*𝐏𝐚𝐠𝐚𝐦𝐞𝐧𝐭𝐨𝐬 𝐥𝐢𝐝𝐨𝐬:* ${report.checkedPayouts}`,
        `*𝐑𝐞𝐠𝐢𝐬𝐭𝐫𝐨𝐬 𝐬𝐮𝐬𝐩𝐞𝐢𝐭𝐨𝐬:* ${report.mismatchCount}`,
        `*𝐏𝐇 𝐞𝐦 𝐬𝐞𝐦𝐚𝐧𝐚 𝐝𝐢𝐟𝐞𝐫𝐞𝐧𝐭𝐞:* ${report.wrongPh}`,
        '',
    ];

    if (!report.mismatches.length) {
        lines.push('> Nenhum pagamento rastreável apresentou divergência de semana.');
    } else {
        lines.push(section('!', '𝗗𝗶𝘃𝗲𝗿𝗴𝗲̂𝗻𝗰𝗶𝗮𝘀'), '');
        for (const item of report.mismatches.slice(0, 10)) {
            const expected = item.expected.map((entry) => `${entry.amount} em ${entry.weekKey}`).join(' + ');
            lines.push(
                `*#${item.payoutId} · ${formatMention(item.evaluatorId)}*`,
                `> Registrado: ${item.phPaid} PH em ${item.recordedWeekKey}.`,
                `> Pela origem: ${expected}.`,
                ''
            );
        }
        if (report.mismatches.length > 10) lines.push(`> … e mais ${report.mismatches.length - 10} divergência(s).`);
    }

    lines.push('', '> Nada foi corrigido automaticamente.');
    return lines.join('\n');
}

async function executePaCommand(args) {
    const { action, rest } = splitBody(args.body);
    const selfId = await resolveServiceEvaluatorId(args.db, args.idJogador);

    if (STATUS_ACTIONS.has(action) && rest.length === 0) {
        await sendReply({ sock: args.sock, idChat: args.idChat, m: args.m, text: await renderStatus(args.db, selfId) });
        return;
    }

    if (SHOP_ACTIONS.has(action)) {
        await sendReply({ sock: args.sock, idChat: args.idChat, m: args.m, text: await renderSceneWeekShop(args.db, selfId) });
        return;
    }

    if (ORIGIN_ACTIONS.has(action)) {
        const targetId = isOwner(args.idJogador)
            ? await resolveEvaluatorTarget(args.db, rest, args.m, selfId)
            : selfId;
        await sendReply({ sock: args.sock, idChat: args.idChat, m: args.m, text: await renderOriginStatus(args.db, targetId) });
        return;
    }

    if (AUDIT_ACTIONS.has(action)) {
        if (!isOwner(args.idJogador)) {
            await sendReply({ sock: args.sock, idChat: args.idChat, m: args.m, text: 'Apenas o dono pode executar a auditoria de semanas.' });
            return;
        }
        const targetId = rest.length ? await resolveEvaluatorTarget(args.db, rest, args.m, null) : null;
        const report = await auditPaSceneWeeks(args.db, { evaluatorId: targetId });
        await sendReply({ sock: args.sock, idChat: args.idChat, m: args.m, text: renderAudit(report) });
        return;
    }

    if (PAY_ACTIONS.has(action)) {
        await executeAdminPayout(args, rest);
        return;
    }

    if (BUY_ACTIONS.has(action) || REDEEM_ACTIONS.has(action)) {
        const redeem = REDEEM_ACTIONS.has(action);
        const itemInput = redeem ? 'ph' : (rest[0] || '');
        const item = getPaShopItem(itemInput);
        if (item?.key === 'ph') {
            const quantity = redeem ? (rest[0] || null) : (rest[1] || null);
            const result = await purchasePhBySceneWeek(args.db, selfId, {
                quantity,
                createdBy: args.idJogador,
                idempotencyKey: base.buildIdempotencyKey(args, selfId),
            });
            await sendReply({ sock: args.sock, idChat: args.idChat, m: args.m, text: renderPhPurchase(result) });
            return;
        }
    }

    return base.executePaCommand(args);
}

module.exports = {
    ...base,
    executePaCommand,
    renderAdminPayout,
    renderAudit,
    renderOriginStatus,
    renderPhPurchase,
    renderSceneWeekShop,
    renderStatus,
};