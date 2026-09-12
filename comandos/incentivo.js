const { COMMAND_PREFIX } = require('../config/bot');
const { sendPrivateText, sendReply } = require('../helpers/chatReply');
const {
    canManagePlayer,
    formatMention,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const {
    createReturnBonus,
    getReturnBonuses,
    renderReturnBonusOffer,
} = require('../helpers/clover/antiGhostService');

function normalizeAction(value) {
    const text = String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (['criar', 'enviar', 'dar', 'retorno'].includes(text)) return 'create';
    if (['listar', 'lista', 'ver'].includes(text)) return 'list';
    return text || 'help';
}

function splitAction(body) {
    const parts = String(body || '').trim().split(/\s+/).filter(Boolean);
    return {
        action: normalizeAction(parts.shift()),
        rest: parts.join(' '),
    };
}

async function resolveTarget({ db, body, m }) {
    const targetData = resolveTargetAndRest(body, m);
    if (targetData.source === 'none') return { ok: false, error: 'Informe @player, responda a pessoa ou use os últimos 4 dígitos.' };
    const resolved = await resolveTargetPlayer(db, targetData.targetId, targetData.targetText);
    return { ...resolved, rest: targetData.rest || '' };
}

function parseCreateArgs(rest) {
    const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
    let ph = 5;
    let hours = 72;

    if (parts[0] && /^\d+$/.test(parts[0])) {
        ph = Number(parts.shift());
    }
    if (parts[0]) {
        const match = parts[0].match(/^(\d+)(h|hora|horas|d|dia|dias)?$/i);
        if (match) {
            const amount = Number(match[1]);
            const unit = String(match[2] || 'h').toLowerCase();
            hours = unit.startsWith('d') ? amount * 24 : amount;
            parts.shift();
        }
    }

    return {
        ph,
        hours,
        condition: parts.join(' ').trim() || 'Cena de UP aprovada dentro do prazo.',
    };
}

function renderBonusList(rows) {
    if (!rows.length) {
        return [
            '*♧┃INCENTIVOS 𖥔 CLOVER MULTICOLOR*',
            '     ── bônus de retorno ──',
            '',
            'Nenhum bônus encontrado.',
        ].join('\n');
    }
    return [
        '*♧┃INCENTIVOS 𖥔 CLOVER MULTICOLOR*',
        '     ── bônus de retorno ──',
        '',
        ...rows.map((row) => [
            `#${row.id} - ${formatMention(row.player_id)}`,
            `> Status: ${row.status}`,
            `> Bônus: ${row.bonus_label}`,
            `> Prazo: ${row.expires_at}`,
        ].join('\n')),
    ].join('\n\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}incentivo`,
    aliases: [
        `${COMMAND_PREFIX}bonusretorno`,
        `${COMMAND_PREFIX}bônusretorno`,
    ],
    descricao: 'Cria e lista bônus de retorno para players inativos.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode mexer em incentivos.' });
            return;
        }

        const { action, rest } = splitAction(body);

        if (action === 'list') {
            const target = await resolveTarget({ db, body: rest, m }).catch(() => null);
            const rows = await getReturnBonuses(db, target?.ok ? target.player.id : null, 20);
            await sendReply({
                sock,
                idChat,
                m,
                mentions: rows.map((row) => row.player_id),
                text: renderBonusList(rows),
            });
            return;
        }

        if (action === 'create') {
            const target = await resolveTarget({ db, body: rest, m });
            if (!target.ok) {
                await sendReply({ sock, idChat, m, text: target.error });
                return;
            }

            const parsed = parseCreateArgs(target.rest);
            const result = await createReturnBonus({
                db,
                playerId: target.player.id,
                bonusPh: parsed.ph,
                hours: parsed.hours,
                createdBy: idJogador,
                source: 'manual',
                conditionText: parsed.condition,
                metadata: { created_from_command: true },
            });

            if (!result.ok) {
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: result.code === 'already_active'
                        ? 'Esse player já tem um bônus de retorno ativo.'
                        : 'Não consegui criar o bônus de retorno.',
                });
                return;
            }

            let sent = true;
            try {
                const privateResult = await sendPrivateText({
                    sock,
                    playerId: target.player.id,
                    text: renderReturnBonusOffer(result.bonus),
                });
                if (privateResult?.skipped) sent = false;
            } catch {
                sent = false;
            }

            await sendReply({
                sock,
                idChat,
                m,
                mentions: [target.player.id],
                text: [
                    '*♧┃INCENTIVO CRIADO 𖥔 CLOVER MULTICOLOR*',
                    '     ── bônus de retorno ──',
                    '',
                    `*Player:* ${playerDisplayName(target.player, target.player.id)} (${formatMention(target.player.id)})`,
                    `*Bônus:* ${result.bonus.bonus_label}`,
                    `*Prazo:* ${result.bonus.expires_at}`,
                    `*PV:* ${sent ? 'enviado' : 'falhou'}`,
                ].join('\n'),
            });
            return;
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: [
                '*♧┃INCENTIVO 𖥔 CLOVER MULTICOLOR*',
                '     ── comandos ──',
                '',
                `*${COMMAND_PREFIX}incentivo criar @player 10 72h Cena de UP aprovada*`,
                '> Cria bônus de retorno manual.',
                '',
                `*${COMMAND_PREFIX}incentivo listar*`,
                '> Lista últimos bônus.',
            ].join('\n'),
        });
    },
};
