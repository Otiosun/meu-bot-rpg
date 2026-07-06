const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { normalizeText } = require('../helpers/textUtils');
const {
    canManagePlayer,
    formatTargetErrorDetails,
    getMentions,
    getQuotedParticipant,
} = require('../helpers/clover/commandTargetUtils');
const {
    CloverScriptError,
    applySimulation,
    createSimulation,
} = require('../helpers/clover/cloverScriptService');

function parseKeyValues(text) {
    const kv = {};
    const regex = /([A-Za-z0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    while ((match = regex.exec(String(text || '')))) {
        const key = normalizeText(match[1]).replace(/[^a-z0-9_]+/g, '_');
        const value = String(match[2] || '').trim().replace(/^["']|["']$/g, '');
        if (key) kv[key] = value;
    }
    return kv;
}

function stripMentionTokens(body) {
    return String(body || '').replace(/@\S+/g, '').trim();
}

function quote(value) {
    return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function normalizeAction(body) {
    const first = normalizeText(String(body || '').trim().split(/\s+/)[0] || '').replace(/[^a-z0-9]+/g, '');
    if (['aplicar', 'confirmar', 'apply'].includes(first)) return 'apply';
    return 'simulate';
}

function parseReward(body) {
    const clean = stripMentionTokens(body);
    const kv = parseKeyValues(clean);
    const amount = Number(kv.ph || kv.valor || kv.amount || clean.match(/(?:^|\s)([+-]?\d+)(?:\s|$)/)?.[1] || 0);
    const source = String(kv.fonte || kv.source || 'recompensa').trim();
    const list = String(kv.lista || kv.list || '').trim();
    const bonus = String(kv.bonus || kv['bônus'] || '').trim();
    let reason = String(kv.motivo || kv.reason || '').trim();

    if (!reason) {
        reason = clean
            .replace(/([A-Za-z0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g, '')
            .replace(/(?:^|\s)[+-]?\d+(?:\s|$)/, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    return { amount, source, list, bonus, reason };
}

function uniqueIds(ids) {
    const seen = new Set();
    const result = [];
    for (const id of ids.filter(Boolean)) {
        const key = String(id).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(id);
    }
    return result;
}

function buildRewardScript({ reward, targets = [] }) {
    const lines = [
        `LOTE id=${quote(`recompensa-${Date.now()}`)} nome=${quote(reward.reason || 'Recompensa')} modo=rigido`,
        '',
    ];
    if (reward.list) {
        lines.push(`ALVOS lista=${quote(reward.list)}`);
    } else {
        lines.push(`ALVOS ${targets.map((id) => quote(id)).join(' ')}`);
    }
    if (reward.amount) {
        lines.push(`PH ${reward.amount > 0 ? `+${reward.amount}` : reward.amount} fonte=${quote(reward.source)} teto=fora motivo=${quote(reward.reason)}`);
    }
    if (reward.bonus) {
        lines.push(`BONUS adicionar nome=${quote(reward.bonus)} tipo=mecanico valor=${quote(reward.bonus)} motivo=${quote(reward.reason)}`);
    }
    lines.push('FIM');
    return lines.join('\n');
}

function renderUsage() {
    return [
        '*♧┃RECOMPENSA 𖥔 CLOVER MULTICOLOR*',
        '     ── simulação segura ──',
        '',
        '_`─( ✓ )───── Uso`_',
        '',
        `> ${COMMAND_PREFIX}recompensa @A @B ph=40 motivo="Segundo exame"`,
        `> ${COMMAND_PREFIX}recompensa lista=copa-30-bonus ph=30 bonus="-5% gasto de mana" motivo="Aposta da Copa"`,
        `> ${COMMAND_PREFIX}recompensa aplicar codigo=CS-XXXXXX`,
        '',
        '> Nada é aplicado antes da simulação ser confirmada.',
    ].join('\n');
}

function renderScriptError(error) {
    const details = error?.details ? formatTargetErrorDetails(error.details) : [];
    return [
        '*♧┃RECOMPENSA RECUSADA 𖥔 CLOVER MULTICOLOR*',
        '     ── nada foi aplicado ──',
        '',
        error?.line ? `*Linha:* ${error.line}` : null,
        `> ${error?.message || String(error)}`,
        details.length ? '' : null,
        ...details.map((line) => `> ${line.replace(/\*/g, '')}`),
    ].filter(Boolean).join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}recompensa`,
    aliases: [
        `${COMMAND_PREFIX}reward`,
        `${COMMAND_PREFIX}recompensar`,
        `${COMMAND_PREFIX}darphmarcados`,
    ],
    descricao: 'Simula e aplica recompensas por marcados ou lista privada.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode usar esse comando.' });
            return;
        }

        const action = normalizeAction(body);
        if (action === 'apply') {
            const kv = parseKeyValues(body);
            const code = String(kv.codigo || kv.code || '').trim().toUpperCase();
            if (!code) {
                await sendReply({ sock, idChat, m, text: renderUsage() });
                return;
            }
            const result = await applySimulation(db, { code, actorId: idJogador, chatId: idChat, sock });
            await sendReply({ sock, idChat, m, text: result.text });
            return;
        }

        const reward = parseReward(body);
        const targets = uniqueIds([
            ...getMentions(m),
            getQuotedParticipant(m),
        ]);

        if (!reward.list && !targets.length) {
            await sendReply({ sock, idChat, m, text: renderUsage() });
            return;
        }
        if ((!Number.isInteger(reward.amount) || reward.amount === 0) && !reward.bonus) {
            await sendReply({ sock, idChat, m, text: renderUsage() });
            return;
        }
        if (!reward.reason || reward.reason.length < 3) {
            await sendReply({ sock, idChat, m, text: renderUsage() });
            return;
        }

        try {
            const script = buildRewardScript({ reward, targets });
            const result = await createSimulation(db, script, {
                actorId: idJogador,
                chatId: idChat,
                mentions: getMentions(m),
                quotedParticipant: getQuotedParticipant(m),
                source: 'recompensa',
            });
            await sendReply({
                sock,
                idChat,
                m,
                mentions: result.plan.blocks.flatMap((block) => block.targets.map((target) => target.id)),
                text: result.text.replace(
                    `Use *${COMMAND_PREFIX}clover aplicar`,
                    `Use *${COMMAND_PREFIX}recompensa aplicar`
                ),
            });
        } catch (error) {
            await sendReply({
                sock,
                idChat,
                m,
                text: error instanceof CloverScriptError ? renderScriptError(error) : renderScriptError(error),
            });
        }
    },
};
