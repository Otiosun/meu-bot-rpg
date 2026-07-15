'use strict';

const { COMMAND_PREFIX } = require('../../config/bot');
const { sendReply } = require('../chatReply');
const { resolveServiceEvaluatorId } = require('./adminService');
const base = require('./paCommandService');
const { getPaShopState } = require('./paShopService');

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

function normalizeAction(body) {
    return String(body || '')
        .trim()
        .split(/\s+/)[0]
        ?.normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '') || '';
}

function formatUsage(item) {
    const suffix = item.limitMode === 'common_ph' ? ' PH comuns' : '';
    return `${item.used}/${item.limit}${suffix}`;
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
        lines.push(
            `*${item.id}. ${DISPLAY_NAMES[item.key] || item.name}*`,
            `> 𝐂𝐮𝐬𝐭𝐨: ${item.unitPaCost} PA${unit}.`,
            `> 𝐑𝐞𝐜𝐨𝐦𝐩𝐞𝐧𝐬𝐚: ${item.rewardLabel}.`,
            `> 𝐔𝐬𝐨 𝐬𝐞𝐦𝐚𝐧𝐚𝐥: ${formatUsage(item)}${blocked}.`,
            ''
        );
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

async function executePaCommand(args) {
    const action = normalizeAction(args.body);
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
    return base.executePaCommand(args);
}

module.exports = {
    ...base,
    executePaCommand,
    renderShop,
};