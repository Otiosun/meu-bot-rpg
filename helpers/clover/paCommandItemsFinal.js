'use strict';

const { COMMAND_PREFIX } = require('../../config/bot');
const { sendReply } = require('../chatReply');
const { resolveServiceEvaluatorId } = require('./adminService');
const base = require('./paCommandPresentationFinal');
const {
    activatePriorityCoupon,
    openSimplePaBox,
} = require('./paItemUseService');

const OPEN_ACTIONS = new Set(['abrir', 'abrircaixa', 'abrircaixasimples']);
const PRIORITY_ACTIONS = new Set(['prioridade', 'usarcupom', 'ativarprioridade']);
const SHOP_ACTIONS = new Set(['loja', 'shop', 'recompensas']);

function normalizeAction(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function readAction(body) {
    return normalizeAction(String(body || '').trim().split(/\s+/)[0] || '');
}

function section(symbol, title) {
    return `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;
}

function itemUseError(result = {}, action = 'use') {
    const messages = {
        no_player: 'Não encontrei um personagem vinculado a esse avaliador.',
        no_character: 'O item exige um personagem completo vinculado ao avaliador.',
        no_box: 'Você não possui uma Caixa Simples de Serviço no inventário.',
        no_coupon: 'Você não possui um Cupom de Prioridade no inventário.',
        not_in_queue: `Entre primeiro na fila com *${COMMAND_PREFIX}entrarfila*.` ,
        already_called: 'Você já foi chamado. O cupom não pode ultrapassar quem está em atendimento.',
        already_priority: 'Sua entrada já está com prioridade. Nenhum cupom foi consumido.',
        duplicate: 'Esse uso já foi processado. Nenhum item foi consumido novamente.',
    };
    return messages[result.code] || (action === 'box'
        ? 'A Caixa Simples não foi aberta.'
        : 'A prioridade não foi ativada.');
}

function renderBoxResult(result) {
    if (!result?.ok) {
        return [
            '*♧┃𝐂𝐀𝐈𝐗𝐀 𝐍𝐀̃𝐎 𝐀𝐁𝐄𝐑𝐓𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '     ──  nenhum item foi consumido  ──',
            '',
            section('!', '𝗔𝘃𝗶𝘀𝗼'),
            '',
            `> ${itemUseError(result, 'box')}`,
        ].join('\n');
    }

    const reward = result.reward || {};
    const rewardLabel = reward.label
        || (reward.type === 'yulls' ? `${Number(reward.amount || 0)}¥` : reward.itemName)
        || '-';
    return [
        '*♧┃𝐂𝐀𝐈𝐗𝐀 𝐀𝐁𝐄𝐑𝐓𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  recompensa comum registrada  ──',
        '',
        section('✓', '𝗥𝗲𝗰𝗼𝗺𝗽𝗲𝗻𝘀𝗮'),
        '',
        `*𝐑𝐞𝐬𝐮𝐥𝐭𝐚𝐝𝐨:* ${rewardLabel}`,
        reward.type === 'yulls' ? '*𝐃𝐞𝐬𝐭𝐢𝐧𝐨:* carteira de Yulls' : '*𝐃𝐞𝐬𝐭𝐢𝐧𝐨:* inventário',
        '',
        section('■', '𝗖𝗮𝗶𝘅𝗮𝘀'),
        '',
        `*𝐑𝐞𝐬𝐭𝐚𝐧𝐭𝐞𝐬:* ${result.remainingBoxes}`,
        '',
        '> A Caixa Simples nunca entrega vantagem rara ou permanente.',
    ].join('\n');
}

function renderPriorityResult(result) {
    if (!result?.ok) {
        return [
            '*♧┃𝐏𝐑𝐈𝐎𝐑𝐈𝐃𝐀𝐃𝐄 𝐍𝐀̃𝐎 𝐀𝐓𝐈𝐕𝐀𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '     ──  nenhum cupom foi consumido  ──',
            '',
            section('!', '𝗔𝘃𝗶𝘀𝗼'),
            '',
            `> ${itemUseError(result, 'priority')}`,
        ].join('\n');
    }

    return [
        '*♧┃𝐏𝐑𝐈𝐎𝐑𝐈𝐃𝐀𝐃𝐄 𝐀𝐓𝐈𝐕𝐀𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  cupom consumido na fila de feitiços  ──',
        '',
        section('✓', '𝗙𝗶𝗹𝗮'),
        '',
        `*𝐏𝐨𝐬𝐢𝐜̧𝐚̃𝐨 𝐚𝐭𝐮𝐚𝐥:* ${result.position || 1}`,
        '*𝐒𝐭𝐚𝐭𝐮𝐬:* prioridade ativa',
        `*𝐂𝐮𝐩𝐨𝐧𝐬 𝐫𝐞𝐬𝐭𝐚𝐧𝐭𝐞𝐬:* ${result.remainingCoupons}`,
        '',
        section('!', '𝗟𝗶𝗺𝗶𝘁𝗲'),
        '',
        '> Você fica atrás de quem já foi chamado e antes da fila comum.',
        '> Se o ADM pular sua vez, a prioridade continua ativa enquanto sua entrada permanecer na fila.',
    ].join('\n');
}

async function renderShopWithItemUse(db, evaluatorId) {
    const shop = await base.renderShop(db, evaluatorId);
    return [
        shop,
        '',
        section('◇', '𝗨𝘀𝗼 𝗱𝗼𝘀 𝗜𝘁𝗲𝗻𝘀'),
        '',
        `> ${COMMAND_PREFIX}pa abrir`,
        '> Abre uma Caixa Simples do inventário.',
        `> ${COMMAND_PREFIX}pa prioridade`,
        '> Consome um Cupom enquanto você aguarda na fila de feitiços.',
    ].join('\n');
}

async function executePaCommand(args) {
    const action = readAction(args.body);
    const evaluatorId = await resolveServiceEvaluatorId(args.db, args.idJogador);

    if (SHOP_ACTIONS.has(action)) {
        await sendReply({
            sock: args.sock,
            idChat: args.idChat,
            m: args.m,
            text: await renderShopWithItemUse(args.db, evaluatorId),
        });
        return;
    }

    if (OPEN_ACTIONS.has(action)) {
        const result = await openSimplePaBox(args.db, evaluatorId, {
            createdBy: args.idJogador,
            idempotencyKey: base.buildIdempotencyKey(args, evaluatorId),
        });
        await sendReply({
            sock: args.sock,
            idChat: args.idChat,
            m: args.m,
            text: renderBoxResult(result),
        });
        return;
    }

    if (PRIORITY_ACTIONS.has(action)) {
        const result = await activatePriorityCoupon(args.db, evaluatorId, {
            createdBy: args.idJogador,
            idempotencyKey: base.buildIdempotencyKey(args, evaluatorId),
        });
        await sendReply({
            sock: args.sock,
            idChat: args.idChat,
            m: args.m,
            text: renderPriorityResult(result),
        });
        return;
    }

    return base.executePaCommand(args);
}

module.exports = {
    ...base,
    executePaCommand,
    itemUseError,
    renderBoxResult,
    renderPriorityResult,
    renderShopWithItemUse,
};
