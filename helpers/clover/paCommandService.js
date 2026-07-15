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
const { getCanonicalPlayer } = require('./targetResolver');
const {
    SERVICE_WEIGHTS,
    WEEKLY_COMMON_PH_LIMIT,
    addManualServicePoints,
    getEvaluatorPendingWeeks,
    getEvaluatorsWithPending,
    getServiceSummary,
    getWeeklyServiceRanking,
    listRecentServiceEntries,
    listServiceWeeks,
    normalizeWeekInput,
    payService,
    resolveServiceEvaluatorId,
    syncExistingEvaluations,
} = require('./adminService');
const { getPaShopItem } = require('./paShopCatalog');
const {
    getPaShopState,
    listPaShopPurchases,
    purchasePaShopItem,
} = require('./paShopService');
const { syncSquadGroupDescription } = require('./squadService');

function normalizeToken(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function splitAction(body) {
    const text = String(body || '').trim();
    if (!text) return { action: 'status', rest: '' };
    const [first, ...tail] = text.split(/\s+/);
    const normalized = normalizeToken(first);
    const actions = {
        status: 'status', saldo: 'status', carteira: 'status', meu: 'status',
        loja: 'shop', shop: 'shop', recompensas: 'shop',
        comprar: 'buy', compra: 'buy', buy: 'buy',
        resgatar: 'redeem', sacar: 'redeem', usar: 'redeem',
        extrato: 'history', historico: 'history', histórico: 'history', hist: 'history',
        semanas: 'weeks',
        ranking: 'ranking', semana: 'ranking',
        config: 'config', pesos: 'config',
        pagar: 'pay', pagamento: 'pay',
        bonus: 'bonus', bônus: 'bonus',
        ajustar: 'adjust', ajuste: 'adjust',
        sincronizar: 'sync', sync: 'sync', importar: 'sync',
        ajuda: 'help', help: 'help',
    };
    if (!actions[normalized]) return { action: 'status', rest: text };
    return { action: actions[normalized], rest: tail.join(' ').trim() };
}

function parseKeyValues(text) {
    const result = {};
    const regex = /([A-Za-z0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    while ((match = regex.exec(String(text || '')))) {
        const key = normalizeToken(match[1]);
        const value = String(match[2] || '').trim().replace(/^["']|["']$/g, '');
        if (key) result[key] = value;
    }
    return result;
}

function firstInteger(text) {
    const match = String(text || '').match(/(?:^|\s)([+-]?\d+)(?=\s|$)/);
    return match ? Number(match[1]) : null;
}

function removeFirstInteger(text) {
    return String(text || '')
        .replace(/(?:^|\s)[+-]?\d+(?=\s|$)/, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanReason(text) {
    return String(text || '')
        .replace(/([A-Za-z0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function title(subtitle) {
    return [
        '*♧┃𝐏𝐀 · 𝐏𝐎𝐍𝐓𝐎𝐒 𝐃𝐄 𝐀𝐕𝐀𝐋𝐈𝐀𝐂̧𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        `     ──  ${subtitle}  ──`,
    ];
}

function section(symbol, name) {
    return `_` + '`' + `─( ${symbol} )───── ${name}` + '`' + `_`;
}

function playerName(player, fallbackId) {
    return [player?.personagem_nome, player?.display_name, player?.nome]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-')
        || formatMention(fallbackId);
}

function formatShortDate(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return match ? `${match[3]}/${match[2]} ${match[4]}:${match[5]}` : text || '-';
}

async function resolveTarget(db, rest, m, fallbackId) {
    const mentions = getMentions(m);
    if (mentions.length) {
        return {
            targetId: await resolveServiceEvaluatorId(db, mentions[0]),
            rest: stripMentionTokens(rest),
        };
    }
    const quoted = getQuotedParticipant(m);
    if (quoted && !String(rest || '').trim()) {
        return { targetId: await resolveServiceEvaluatorId(db, quoted), rest: '' };
    }
    const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length) {
        const jid = jidFromToken(parts[0]);
        if (jid) {
            return {
                targetId: await resolveServiceEvaluatorId(db, jid),
                rest: parts.slice(1).join(' '),
            };
        }
    }
    return {
        targetId: await resolveServiceEvaluatorId(db, fallbackId),
        rest: String(rest || '').trim(),
    };
}

function renderUsage(owner) {
    const lines = [
        ...title('carteira, loja e recompensas da staff'),
        '',
        section('✓', '𝗖𝗼𝗺𝗮𝗻𝗱𝗼𝘀'),
        '',
        `*${COMMAND_PREFIX}pa*`,
        '> Mostra sua carteira de PA.',
        `*${COMMAND_PREFIX}pa loja*`,
        '> Abre a loja semanal.',
        `*${COMMAND_PREFIX}pa comprar 1 10*`,
        '> Compra 10 PH, caso haja PA e espaço no teto.',
        `*${COMMAND_PREFIX}pa comprar 2 3*`,
        '> Compra 3 unidades de Yulls.',
        `*${COMMAND_PREFIX}pa comprar 3*`,
        '> Compra a Caixa simples.',
        `*${COMMAND_PREFIX}pa extrato*`,
        '> Mostra PA ganho e compras recentes.',
        `*${COMMAND_PREFIX}pa semanas*`,
        '> Mostra o histórico semanal de PA.',
    ];

    if (owner) {
        lines.push(
            '',
            section('◆', '𝗔𝗱𝗺𝗶𝗻𝗶𝘀𝘁𝗿𝗮𝗰̧𝗮̃𝗼'),
            '',
            `*${COMMAND_PREFIX}pa status @avaliador*`,
            '> Consulta a carteira de outro avaliador.',
            `*${COMMAND_PREFIX}pa ranking*`,
            '> Mostra o ranking da semana.',
            `*${COMMAND_PREFIX}pa bonus @avaliador 5 motivo*`,
            '> Adiciona PA manual.',
            `*${COMMAND_PREFIX}pa ajustar @avaliador -3 motivo*`,
            '> Remove PA disponível.',
            `*${COMMAND_PREFIX}pa sincronizar*`,
            '> Importa avaliações antigas sem duplicar.',
            `*${COMMAND_PREFIX}pa pagar @avaliador 10*`,
            '> Conversão administrativa emergencial de PA em PH.'
        );
    }

    return lines.join('\n');
}

async function renderStatus(db, evaluatorId) {
    const [state, service] = await Promise.all([
        getPaShopState(db, evaluatorId),
        getServiceSummary(db, evaluatorId),
    ]);
    const player = state.player;
    return [
        ...title('mérito acumulado por avaliações e serviço'),
        '',
        section('✓', '𝗖𝗮𝗿𝘁𝗲𝗶𝗿𝗮'),
        '',
        `*𝐀𝐯𝐚𝐥𝐢𝐚𝐝𝐨𝐫:* ${playerName(player, evaluatorId)}`,
        `*𝐏𝐀 𝐝𝐢𝐬𝐩𝐨𝐧𝐢́𝐯𝐞𝐥:* ${state.availablePa}`,
        `*𝐏𝐀 𝐫𝐞𝐠𝐢𝐬𝐭𝐫𝐚𝐝𝐨:* ${state.earnedPa}`,
        `*𝐏𝐀 𝐠𝐚𝐬𝐭𝐨 𝐧𝐚 𝐥𝐨𝐣𝐚:* ${state.spentPa}`,
        `*𝐏𝐇 𝐜𝐨𝐧𝐯𝐞𝐫𝐭𝐢𝐝𝐨:* ${service.phPaid}`,
        `*𝐀𝐯𝐚𝐥𝐢𝐚𝐜̧𝐨̃𝐞𝐬 𝐜𝐨𝐧𝐭𝐚𝐝𝐚𝐬:* ${service.evaluations}`,
        '',
        section('✦', '𝗦𝗲𝗺𝗮𝗻𝗮 𝗔𝘁𝘂𝗮𝗹'),
        '',
        `*𝐒𝐞𝐦𝐚𝐧𝐚:* ${state.weekKey}`,
        `*𝐏𝐇 𝐜𝐨𝐦𝐮𝐦:* ${state.commonPhUsed}/${WEEKLY_COMMON_PH_LIMIT}`,
        `*𝐏𝐇 𝐝𝐢𝐬𝐩𝐨𝐧𝐢́𝐯𝐞𝐥:* ${Math.max(0, WEEKLY_COMMON_PH_LIMIT - state.commonPhUsed)}`,
        '',
        section('!', '𝗥𝗲𝗴𝗿𝗮'),
        '',
        '> PA pode acumular livremente.',
        '> O limite semanal fica em cada recompensa da loja.',
        '> PH comprado usa o mesmo teto comum de treino e avaliação.',
    ].join('\n');
}

function usageLabel(item) {
    return `${item.used}/${item.limit}`;
}

async function renderShop(db, evaluatorId) {
    const state = await getPaShopState(db, evaluatorId);
    const lines = [
        '*♧┃𝐋𝐎𝐉𝐀 𝐃𝐄 𝐏𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  recompensas semanais da staff  ──',
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
        lines.push(
            `*${item.id}. 𝐌${item.name.slice(1)}*`,
            `> 𝐂𝐮𝐬𝐭𝐨: ${item.unitPaCost} PA${item.quantityMode !== 'single' ? ' por unidade' : ''}.`,
            `> 𝐑𝐞𝐜𝐨𝐦𝐩𝐞𝐧𝐬𝐚: ${item.rewardLabel}.`,
            `> 𝐔𝐬𝐨 𝐬𝐞𝐦𝐚𝐧𝐚𝐥: ${usageLabel(item)}${blocked}.`,
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
        '> PA acumula. Recompensa não ultrapassa o limite semanal.',
    );
    return lines.join('\n');
}

function parseBuyRequest(rest, redeem = false) {
    const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
    if (redeem) {
        return { itemInput: 'ph', quantity: parts[0] || null };
    }
    return {
        itemInput: parts[0] || '',
        quantity: parts[1] || null,
    };
}

function purchaseErrorMessage(result) {
    const messages = {
        unknown_item: 'Item não encontrado. Use `pa loja` para ver os IDs.',
        quantity_required: 'Informe quantos PH deseja comprar. Exemplo: `pa comprar 1 10`.',
        single_only: 'Esse item só aceita uma unidade por compra.',
        insufficient_pa: `PA insuficiente. Disponível: ${result.availablePa || 0}; custo: ${result.paCost || 0}.`,
        weekly_ph_limit: `O teto de PH não comporta essa compra. Disponível agora: ${result.available || 0} PH.`,
        weekly_item_limit: `Limite semanal atingido. Uso atual: ${result.used || 0}/${result.limit || 0}.`,
        no_player: 'Não encontrei um personagem vinculado a esse avaliador.',
        no_character: 'O PA fica guardado, mas a compra exige um personagem completo vinculado.',
        no_squad: 'A Estrela de esquadrão exige um esquadrão registrado no personagem.',
        duplicate: 'Essa mesma compra já foi processada.',
    };
    return messages[result.code] || 'A compra não foi aplicada.';
}

function renderPurchaseResult(result) {
    if (!result.ok) {
        return [
            ...title('compra não aplicada'),
            '',
            section('!', '𝗔𝘃𝗶𝘀𝗼'),
            '',
            `> ${purchaseErrorMessage(result)}`,
        ].join('\n');
    }

    let reward = result.item.rewardLabel;
    if (result.item.key === 'ph') reward = `${result.quantity} PH`;
    if (result.item.key === 'yulls') reward = `${result.quantity * 500}¥`;

    return [
        ...title('compra concluída'),
        '',
        section('✓', '𝗥𝗲𝗰𝗼𝗺𝗽𝗲𝗻𝘀𝗮'),
        '',
        `*𝐈𝐭𝐞𝐦:* ${result.item.name}`,
        `*𝐐𝐮𝐚𝐧𝐭𝐢𝐝𝐚𝐝𝐞:* ${result.quantity}`,
        `*𝐑𝐞𝐜𝐨𝐦𝐩𝐞𝐧𝐬𝐚:* ${reward}`,
        `*𝐂𝐮𝐬𝐭𝐨:* ${result.paCost} PA`,
        `*𝐏𝐀 𝐫𝐞𝐬𝐭𝐚𝐧𝐭𝐞:* ${result.availablePaAfter}`,
        `*𝐔𝐬𝐨 𝐬𝐞𝐦𝐚𝐧𝐚𝐥:* ${result.usedBefore + result.quantity}/${result.limit}`,
    ].join('\n');
}

async function renderHistory(db, evaluatorId) {
    const [entries, purchases] = await Promise.all([
        listRecentServiceEntries(db, evaluatorId, 8),
        listPaShopPurchases(db, evaluatorId, { limit: 8 }),
    ]);
    const lines = [
        ...title('entradas e compras recentes'),
        '',
        section('✦', '𝗣𝗔 𝗚𝗮𝗻𝗵𝗼'),
        '',
    ];
    if (!entries.length) lines.push('> Nenhuma entrada registrada.');
    for (const entry of entries) {
        const open = Math.max(0, Number(entry.points || 0) - Number(entry.paid_points || 0));
        lines.push(`*${entry.modality_label}:* ${entry.points} PA`, `> Disponível: ${open} · ${formatShortDate(entry.created_at)}`);
    }
    lines.push('', section('◆', '𝗖𝗼𝗺𝗽𝗿𝗮𝘀'), '');
    if (!purchases.length) lines.push('> Nenhuma compra registrada.');
    for (const purchase of purchases) {
        const item = getPaShopItem(purchase.item_key);
        lines.push(
            `*${item?.name || purchase.item_key}:* -${purchase.pa_cost} PA`,
            `> Quantidade: ${purchase.quantity} · Semana ${purchase.week_key}`
        );
    }
    return lines.join('\n');
}

async function renderWeeks(db, evaluatorId) {
    const weeks = await listServiceWeeks(db, evaluatorId, { limit: 10 });
    const player = await getCanonicalPlayer(db, evaluatorId).catch(() => null);
    const lines = [...title('histórico semanal do avaliador'), '', section('◆', '𝗦𝗲𝗺𝗮𝗻𝗮𝘀'), ''];
    if (!weeks.length) return [...lines, '> Nenhum PA registrado.'].join('\n');
    for (const week of weeks) {
        lines.push(
            `*${week.weekKey}:* ${week.pendingPoints} PA disponível`,
            `> Ganho: ${week.earnedPoints} · Consumido: ${week.settledPoints} · Avaliações: ${week.evaluations}`
        );
    }
    if (player) lines.push('', `> Personagem vinculado: ${playerName(player, evaluatorId)}.`);
    return lines.join('\n');
}

function renderConfig() {
    const groups = [
        ['Peso 1', ['treino_solo', 'cena_vinculo', 'missao_auto_narrada', 'diario']],
        ['Peso 2', ['cena_interativa', 'treino_duo', 'cena_consequencia']],
        ['Peso 3', ['spin_off']],
        ['Peso 4', ['missao_desenvolvimento']],
    ];
    const lines = [...title('PA recebido por modalidade'), ''];
    for (const [label, keys] of groups) {
        const rule = SERVICE_WEIGHTS[keys[0]];
        lines.push(`*${label}:* ${rule.points} PA`, `> ${keys.join(', ')}`);
    }
    return lines.join('\n');
}

async function renderRanking(db, weekKey) {
    const rows = await getWeeklyServiceRanking(db, weekKey);
    const lines = [...title('ranking semanal da staff'), '', `*𝐒𝐞𝐦𝐚𝐧𝐚:* ${weekKey}`, '', section('★', '𝗥𝗮𝗻𝗸𝗶𝗻𝗴'), ''];
    if (!rows.length) return [...lines, '> Nenhum PA registrado.'].join('\n');
    let index = 1;
    for (const row of rows.slice(0, 15)) {
        const player = await getCanonicalPlayer(db, row.evaluator_id).catch(() => null);
        lines.push(`*${index}. ${playerName(player, row.evaluator_id)}:* ${row.points} PA`, `> Avaliações: ${row.evaluations}`);
        index += 1;
    }
    return lines.join('\n');
}

function renderAdminPay(result, evaluatorId) {
    if (!result.ok) {
        return [...title('conversão administrativa pendente'), '', `> ${result.code || 'não aplicada'}.`].join('\n');
    }
    return [
        ...title('conversão administrativa aplicada'),
        '',
        `*𝐀𝐯𝐚𝐥𝐢𝐚𝐝𝐨𝐫:* ${formatMention(evaluatorId)}`,
        `*𝐏𝐀 𝐜𝐨𝐧𝐬𝐮𝐦𝐢𝐝𝐨:* ${result.pointsPaid}`,
        `*𝐏𝐇 𝐞𝐧𝐭𝐫𝐞𝐠𝐮𝐞:* ${result.phPaid}`,
    ].join('\n');
}

async function executePaCommand({ sock, m, idChat, idJogador, db, body }) {
    const owner = isOwner(idJogador);
    const { action, rest } = splitAction(body);
    const selfId = await resolveServiceEvaluatorId(db, idJogador);

    if (action === 'help') {
        await sendReply({ sock, idChat, m, text: renderUsage(owner) });
        return;
    }
    if (action === 'config') {
        await sendReply({ sock, idChat, m, text: renderConfig() });
        return;
    }
    if (action === 'shop') {
        await sendReply({ sock, idChat, m, text: await renderShop(db, selfId) });
        return;
    }
    if (action === 'buy' || action === 'redeem') {
        const request = parseBuyRequest(rest, action === 'redeem');
        const idempotencyKey = `pa_shop:${idChat}:${m?.key?.id || 'sem-id'}:${selfId}`;
        const result = await purchasePaShopItem(db, selfId, request.itemInput, {
            quantity: request.quantity,
            createdBy: idJogador,
            idempotencyKey,
        });
        let squadSync = null;
        if (result.ok && result.reward?.squadKey) {
            squadSync = await syncSquadGroupDescription({ sock, db, squadKey: result.reward.squadKey }).catch(() => null);
        }
        const text = [
            renderPurchaseResult(result),
            result.ok && result.reward?.squadKey
                ? `\n> Descrição do esquadrão: ${squadSync?.ok ? 'sincronizada' : 'pendente'}.`
                : null,
        ].filter(Boolean).join('');
        await sendReply({ sock, idChat, m, text });
        return;
    }
    if (action === 'history') {
        await sendReply({ sock, idChat, m, text: await renderHistory(db, selfId) });
        return;
    }
    if (action === 'weeks') {
        const target = owner ? await resolveTarget(db, rest, m, idJogador) : { targetId: selfId };
        await sendReply({ sock, idChat, m, text: await renderWeeks(db, target.targetId) });
        return;
    }
    if (action === 'ranking') {
        if (!owner) {
            await sendReply({ sock, idChat, m, text: 'Apenas o dono pode abrir o ranking geral de PA.' });
            return;
        }
        const kv = parseKeyValues(rest);
        const weekKey = normalizeWeekInput(kv.semana || kv.week || rest);
        await sendReply({ sock, idChat, m, text: await renderRanking(db, weekKey) });
        return;
    }
    if (action === 'sync') {
        if (!owner) {
            await sendReply({ sock, idChat, m, text: 'Apenas o dono pode sincronizar avaliações antigas.' });
            return;
        }
        const kv = parseKeyValues(rest);
        const weekKey = kv.semana || kv.week ? normalizeWeekInput(kv.semana || kv.week) : null;
        const result = await syncExistingEvaluations(db, { weekKey });
        await sendReply({
            sock, idChat, m,
            text: [...title('sincronização concluída'), '', `*𝐋𝐢𝐝𝐚𝐬:* ${result.checked}`, `*𝐂𝐫𝐢𝐚𝐝𝐚𝐬:* ${result.inserted}`, `*𝐈𝐠𝐧𝐨𝐫𝐚𝐝𝐚𝐬:* ${result.skipped}`].join('\n'),
        });
        return;
    }
    if (action === 'bonus' || action === 'adjust') {
        if (!owner) {
            await sendReply({ sock, idChat, m, text: 'Apenas o dono pode ajustar PA.' });
            return;
        }
        const target = await resolveTarget(db, rest, m, idJogador);
        const amount = firstInteger(target.rest);
        const reason = cleanReason(removeFirstInteger(target.rest));
        if (!Number.isInteger(amount) || amount === 0 || reason.length < 3) {
            await sendReply({ sock, idChat, m, text: renderUsage(owner) });
            return;
        }
        const result = await addManualServicePoints(db, target.targetId, {
            points: amount,
            createdBy: idJogador,
            reason,
            source: action === 'bonus' ? 'manual_bonus' : 'manual_adjustment',
        });
        await sendReply({
            sock, idChat, m,
            text: [...title('ajuste registrado'), '', `*𝐀𝐯𝐚𝐥𝐢𝐚𝐝𝐨𝐫:* ${formatMention(target.targetId)}`, `*𝐏𝐀:* ${result.points || amount}`, `*𝐌𝐨𝐭𝐢𝐯𝐨:* ${reason}`].join('\n'),
        });
        return;
    }
    if (action === 'pay') {
        if (!owner) {
            await sendReply({ sock, idChat, m, text: 'Apenas o dono pode aplicar conversão administrativa.' });
            return;
        }
        const target = await resolveTarget(db, rest, m, idJogador);
        const kv = parseKeyValues(target.rest);
        const weekKey = kv.semana || kv.week ? normalizeWeekInput(kv.semana || kv.week) : null;
        const points = firstInteger(target.rest);
        const result = await payService(db, target.targetId, {
            createdBy: idJogador,
            reason: 'Conversão administrativa de PA',
            weekKey,
            points: Number.isInteger(points) && points > 0 ? points : null,
        });
        await sendReply({ sock, idChat, m, text: renderAdminPay(result, target.targetId) });
        return;
    }

    const target = owner && rest ? await resolveTarget(db, rest, m, idJogador) : { targetId: selfId };
    await sendReply({ sock, idChat, m, text: await renderStatus(db, target.targetId) });
}

module.exports = {
    executePaCommand,
    renderHistory,
    renderPurchaseResult,
    renderShop,
    renderStatus,
    renderUsage,
};