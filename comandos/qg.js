'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { normalizeText } = require('../helpers/textUtils');
const {
    CATEGORY_DEFINITIONS,
    SQUAD_UPGRADES,
    getSquadUpgrade,
    listUpgradeCategories,
    normalizeLookup,
} = require('../helpers/clover/squadUpgradeCatalog');
const {
    canManageSquadUpgrade,
    getSquadUpgradeState,
    listSquadUpgradeHistory,
    purchaseSquadUpgrade,
    resolveSquadForContext,
} = require('../helpers/clover/squadUpgradeService');

const STATUS_ACTIONS = new Set(['', 'status', 'estado', 'resumo']);
const CATALOG_ACTIONS = new Set(['catalogo', 'catálogo', 'loja', 'melhorias']);
const DETAIL_ACTIONS = new Set(['detalhe', 'item', 'ver']);
const BUY_ACTIONS = new Set(['comprar', 'adquirir', 'construir', 'melhorar']);
const HISTORY_ACTIONS = new Set(['historico', 'histórico', 'log', 'gastos']);

function normalizeAction(value) {
    return normalizeText(value || '').replace(/[^a-z0-9]+/g, '');
}

function splitBody(body) {
    const parts = String(body || '').trim().split(/\s+/).filter(Boolean);
    return {
        action: normalizeAction(parts.shift() || ''),
        rest: parts.join(' ').trim(),
    };
}

function section(symbol, title) {
    return `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;
}

function formatStars(value) {
    const amount = Number(value || 0);
    return `${amount} ${amount === 1 ? 'Estrela' : 'Estrelas'}`;
}

function activationLabel(item) {
    if (item.requiresApproval) return 'Exige aprovação no uso relevante';
    if (item.activation === 'weekly_review') return 'Uso contextual · controle semanal';
    if (item.activation === 'passive_narrative') return 'Passiva narrativa';
    return 'Uso contextual em cena';
}

function resolveCategory(value) {
    const text = String(value || '').trim();
    const categories = listUpgradeCategories();
    if (!text) return null;
    if (/^\d{1,2}$/.test(text)) return categories[Number(text) - 1] || null;
    const normalized = normalizeLookup(text);
    return categories.find((category) => (
        normalizeLookup(category.key) === normalized
        || normalizeLookup(category.label) === normalized
        || normalizeLookup(category.label).includes(normalized)
    )) || null;
}

function itemStateLabel(item) {
    if (item.owned) return 'adquirida';
    if (item.blockedCodes.includes('grade')) return `requer Grau ${item.requiredGrade}`;
    if (item.blockedCodes.includes('prerequisite')) return 'falta pré-requisito';
    if (item.blockedCodes.includes('stars')) return 'Estrelas insuficientes';
    return 'disponível';
}

function renderHeadquartersState(state) {
    if (!state?.ok) {
        return [
            '*♧┃𝐐𝐆 𝐃𝐎 𝐄𝐒𝐐𝐔𝐀𝐃𝐑𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '',
            '> Não encontrei o esquadrão deste grupo ou personagem.',
        ].join('\n');
    }

    const lines = [
        '*♧┃𝐐𝐆 𝐃𝐎 𝐄𝐒𝐐𝐔𝐀𝐃𝐑𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  estrutura e recursos disponíveis  ──',
        '',
        `*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨:* ${state.squad.name}`,
        `*𝐑𝐞𝐧𝐨𝐦𝐞:* Grau ${state.renownGrade} · ${state.historicalStars} Estrelas no Histórico`,
        `*𝐑𝐞𝐜𝐮𝐫𝐬𝐨𝐬:* ${formatStars(state.currentStars)} Atuais`,
        `*𝐁𝐞𝐧𝐟𝐞𝐢𝐭𝐨𝐫𝐢𝐚𝐬:* ${state.ownedCount}/${state.totalCount}`,
        '',
        section('⌂', '𝗦𝗲𝘁𝗼𝗿𝗲𝘀'),
        '',
    ];

    state.categories.forEach((category, index) => {
        lines.push(`*${index + 1}. ${category.label}* · ${category.owned}/${category.total}`);
    });

    lines.push(
        '',
        section('◆', '𝗔𝗯𝗿𝗶𝗿'),
        '',
        `> ${COMMAND_PREFIX}qg catalogo`,
        `> ${COMMAND_PREFIX}qg catalogo <categoria>`,
        `> ${COMMAND_PREFIX}qg detalhe <id>`,
        `> ${COMMAND_PREFIX}qg historico`,
    );
    return lines.join('\n');
}

function renderCategoryIndex(state) {
    const lines = [
        '*♧┃𝐂𝐀𝐓𝐀́𝐋𝐎𝐆𝐎 𝐃𝐎 𝐐𝐆 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  benfeitorias oficiais por setor  ──',
        '',
        `*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨:* ${state.squad.name}`,
        `*𝐒𝐚𝐥𝐝𝐨:* ${formatStars(state.currentStars)} Atuais`,
        `*𝐆𝐫𝐚𝐮:* ${state.renownGrade}`,
        '',
        section('⌂', '𝗖𝗮𝘁𝗲𝗴𝗼𝗿𝗶𝗮𝘀'),
        '',
    ];
    state.categories.forEach((category, index) => {
        lines.push(
            `*${index + 1}. ${category.symbol} ${category.label}*`,
            `> ${category.owned}/${category.total} adquiridas · ${category.available} disponíveis agora.`
        );
    });
    lines.push('', `> ${COMMAND_PREFIX}qg catalogo <1–7>`);
    return lines.join('\n');
}

function renderCategory(state, category) {
    if (!category) {
        return [
            '*♧┃𝐂𝐀𝐓𝐀́𝐋𝐎𝐆𝐎 𝐃𝐎 𝐐𝐆 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '',
            '> Categoria não encontrada. Use `.#qg catalogo` para listar os setores.',
        ].join('\n');
    }
    const items = state.items.filter((item) => item.categoryKey === category.key);
    const lines = [
        `*♧┃${category.symbol} 𝐐𝐆 · ${category.label.toUpperCase()} 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*`,
        '',
        `*𝐒𝐚𝐥𝐝𝐨:* ${formatStars(state.currentStars)} · *𝐆𝐫𝐚𝐮:* ${state.renownGrade}`,
        '',
    ];
    items.forEach((item) => {
        lines.push(
            `*${item.id}. ${item.name}*`,
            `> ${item.cost} ★ · Grau ${item.requiredGrade} · ${itemStateLabel(item)}`
        );
    });
    lines.push(
        '',
        `> ${COMMAND_PREFIX}qg detalhe <id>`,
        `> ${COMMAND_PREFIX}qg comprar <id>`,
    );
    return lines.join('\n');
}

function renderUpgradeDetail(state, item) {
    if (!item) {
        return [
            '*♧┃𝐁𝐄𝐍𝐅𝐄𝐈𝐓𝐎𝐑𝐈𝐀 𝐍𝐀̃𝐎 𝐄𝐍𝐂𝐎𝐍𝐓𝐑𝐀𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '',
            '> Use o número mostrado em `.#qg catalogo <categoria>`.',
        ].join('\n');
    }
    const prerequisites = item.prerequisites.length
        ? item.prerequisites.map((key) => getSquadUpgrade(key)?.name || key).join(', ')
        : 'Nenhum';
    const missing = item.missingPrerequisites.length
        ? item.missingPrerequisites.map((key) => getSquadUpgrade(key)?.name || key).join(', ')
        : 'Nenhum';
    return [
        '*♧┃𝐁𝐄𝐍𝐅𝐄𝐈𝐓𝐎𝐑𝐈𝐀 𝐃𝐎 𝐐𝐆 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  regra oficial registrada  ──',
        '',
        `*𝐈𝐃:* ${item.id}`,
        `*𝐍𝐨𝐦𝐞:* ${item.name}`,
        `*𝐒𝐞𝐭𝐨𝐫:* ${item.categoryLabel}`,
        `*𝐂𝐮𝐬𝐭𝐨:* ${formatStars(item.cost)}`,
        `*𝐑𝐞𝐪𝐮𝐢𝐬𝐢𝐭𝐨:* Grau ${item.requiredGrade} · ${item.requiredHistoricalStars}+ no Histórico`,
        `*𝐏𝐫𝐞́-𝐫𝐞𝐪𝐮𝐢𝐬𝐢𝐭𝐨𝐬:* ${prerequisites}`,
        `*𝐒𝐢𝐭𝐮𝐚𝐜̧𝐚̃𝐨:* ${itemStateLabel(item)}`,
        item.missingPrerequisites.length ? `*𝐅𝐚𝐥𝐭𝐚:* ${missing}` : null,
        '',
        section('◆', '𝗘𝗳𝗲𝗶𝘁𝗼'),
        '',
        `> ${item.effect}`,
        '',
        section('!', '𝗔𝗽𝗹𝗶𝗰𝗮𝗰̧𝗮̃𝗼'),
        '',
        `> ${activationLabel(item)}.`,
        '> A benfeitoria cria fundamento narrativo; não concede vitória ou bônus automático fora do contexto.',
        '',
        `> ${COMMAND_PREFIX}qg comprar ${item.id}`,
    ].filter(Boolean).join('\n');
}

function purchaseError(result) {
    if (result.code === 'unknown_upgrade') return 'Benfeitoria não encontrada.';
    if (result.code === 'squad_not_found') return 'Esquadrão não encontrado.';
    if (result.code === 'already_owned') return 'O esquadrão já possui essa benfeitoria.';
    if (result.code === 'grade_required') return `Renome insuficiente. Exige Grau ${result.requiredGrade}; atual: Grau ${result.renownGrade}.`;
    if (result.code === 'missing_prerequisites') {
        const names = result.missingPrerequisites.map((key) => getSquadUpgrade(key)?.name || key).join(', ');
        return `Pré-requisito ausente: ${names}.`;
    }
    if (result.code === 'insufficient_stars') return `Estrelas Atuais insuficientes. Saldo: ${result.currentStars}; custo: ${result.upgrade?.cost || 0}.`;
    if (result.code === 'forbidden') return 'Somente Owner, ADM do grupo, Capitão ou Vice deste esquadrão pode comprar benfeitorias.';
    return 'A compra não foi aplicada.';
}

function renderPurchase(result) {
    if (!result?.ok) {
        return [
            '*♧┃𝐁𝐄𝐍𝐅𝐄𝐈𝐓𝐎𝐑𝐈𝐀 𝐍𝐀̃𝐎 𝐀𝐃𝐐𝐔𝐈𝐑𝐈𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '',
            `> ${purchaseError(result)}`,
        ].join('\n');
    }
    return [
        '*♧┃𝐁𝐄𝐍𝐅𝐄𝐈𝐓𝐎𝐑𝐈𝐀 𝐀𝐃𝐐𝐔𝐈𝐑𝐈𝐃𝐀 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  estrutura registrada no QG  ──',
        '',
        `*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨:* ${result.squad.name}`,
        `*𝐁𝐞𝐧𝐟𝐞𝐢𝐭𝐨𝐫𝐢𝐚:* ${result.upgrade.name}`,
        `*𝐒𝐞𝐭𝐨𝐫:* ${result.upgrade.categoryLabel}`,
        `*𝐂𝐮𝐬𝐭𝐨:* ${formatStars(result.upgrade.cost)}`,
        `*𝐒𝐚𝐥𝐝𝐨:* ${result.starsBefore} → ${result.starsAfter} Estrelas Atuais`,
        '',
        `> ${result.upgrade.effect}`,
        result.upgrade.requiresApproval ? '> Uso relevante continua sujeito à aprovação.' : null,
    ].filter(Boolean).join('\n');
}

function renderHistory(state, events) {
    const lines = [
        '*♧┃𝐇𝐈𝐒𝐓𝐎́𝐑𝐈𝐂𝐎 𝐃𝐎 𝐐𝐆 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨:* ${state.squad.name}`,
        `*𝐒𝐚𝐥𝐝𝐨 𝐚𝐭𝐮𝐚𝐥:* ${formatStars(state.currentStars)}`,
        '',
    ];
    if (!events.length) {
        lines.push('> Nenhuma aquisição registrada.');
        return lines.join('\n');
    }
    events.forEach((event) => {
        const item = getSquadUpgrade(event.upgrade_key);
        lines.push(
            `*${item?.name || event.upgrade_key}*`,
            `> ${event.action === 'purchased' ? 'Adquirida' : 'Removida'} · ${event.stars_delta} ★`
        );
    });
    return lines.join('\n');
}

async function resolveCurrentSquad(db, idChat, idJogador) {
    return resolveSquadForContext(db, {
        groupId: idChat?.endsWith('@g.us') ? idChat : null,
        playerId: idJogador,
    });
}

module.exports = {
    nome: `${COMMAND_PREFIX}qg`,
    aliases: [
        `${COMMAND_PREFIX}quartel`,
        `${COMMAND_PREFIX}quartelgeneral`,
        `${COMMAND_PREFIX}sedeesquadrao`,
        `${COMMAND_PREFIX}sedeesquadrão`,
    ],
    descricao: 'Mostra e administra as benfeitorias do QG do esquadrão.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const squad = await resolveCurrentSquad(db, idChat, idJogador);
        if (!squad) {
            await sendReply({ sock, idChat, m, text: renderHeadquartersState({ ok: false }) });
            return;
        }
        const state = await getSquadUpgradeState(db, squad);
        const { action, rest } = splitBody(body);

        if (STATUS_ACTIONS.has(action)) {
            await sendReply({ sock, idChat, m, text: renderHeadquartersState(state) });
            return;
        }
        if (CATALOG_ACTIONS.has(action)) {
            const category = resolveCategory(rest);
            await sendReply({
                sock,
                idChat,
                m,
                text: rest ? renderCategory(state, category) : renderCategoryIndex(state),
            });
            return;
        }
        if (DETAIL_ACTIONS.has(action)) {
            const catalog = getSquadUpgrade(rest);
            const item = catalog ? state.items.find((entry) => entry.key === catalog.key) : null;
            await sendReply({ sock, idChat, m, text: renderUpgradeDetail(state, item) });
            return;
        }
        if (HISTORY_ACTIONS.has(action)) {
            const events = await listSquadUpgradeHistory(db, squad.squad_key, 20);
            await sendReply({ sock, idChat, m, text: renderHistory(state, events) });
            return;
        }
        if (BUY_ACTIONS.has(action)) {
            const permission = await canManageSquadUpgrade({ sock, idChat, actorId: idJogador, squad });
            if (!permission.ok) {
                await sendReply({ sock, idChat, m, text: renderPurchase({ ok: false, code: 'forbidden' }) });
                return;
            }
            const result = await purchaseSquadUpgrade(db, squad, rest, {
                purchasedBy: idJogador,
                reason: `Compra pelo comando ${COMMAND_PREFIX}qg`,
                metadata: { permission: permission.code, chat_id: idChat },
            });
            await sendReply({ sock, idChat, m, text: renderPurchase(result) });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                '*♧┃𝐐𝐆 𝐃𝐎 𝐄𝐒𝐐𝐔𝐀𝐃𝐑𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
                '',
                `> ${COMMAND_PREFIX}qg`,
                `> ${COMMAND_PREFIX}qg catalogo`,
                `> ${COMMAND_PREFIX}qg detalhe <id>`,
                `> ${COMMAND_PREFIX}qg comprar <id>`,
                `> ${COMMAND_PREFIX}qg historico`,
            ].join('\n'),
        });
    },
    activationLabel,
    itemStateLabel,
    renderCategory,
    renderCategoryIndex,
    renderHeadquartersState,
    renderHistory,
    renderPurchase,
    renderUpgradeDetail,
    resolveCategory,
    splitBody,
};
