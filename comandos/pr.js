'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    getReturnPointsBalance,
    getReturnPointsLedger,
} = require('../helpers/clover/returnPointsService');
const { getPhLedgerAuthoritySnapshot } = require('../helpers/clover/phService');
const {
    getJidCandidatesForPhone,
    getPlayerPhoneDigits,
} = require('../helpers/clover/siteAuthService');

const GLOBAL_RETURN_POINTS_BONUS = 100;
const INDIVIDUAL_RETURN_POINTS_BONUS_BY_PHONE = Object.freeze({
    '558888363447': 100,
    '554898572956': 300,
    '558293056849': 400,
    '5519998150325': 100,
    '558599136380': 100,
    '559391047134': 400,
    '5521975832436': 220,
    '447459589445': 220,
    '5511959362194': 300,
    '558494762790': 500,
});

function formatPr(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
    });
}

function formatLedgerKind(kind) {
    const labels = {
        credit: '+',
        debit: '-',
        refund: '+',
        compensation: '+',
    };
    return labels[String(kind || '').toLowerCase()] || '•';
}

async function getAvailablePa(db, playerId, phoneDigits) {
    const identityIds = new Set([String(playerId || '').trim()].filter(Boolean));
    if (phoneDigits) {
        for (const candidate of getJidCandidatesForPhone(phoneDigits)) {
            if (candidate) identityIds.add(String(candidate));
        }
    }

    const ids = Array.from(identityIds);
    if (!ids.length) return 0;

    const placeholders = ids.map(() => '?').join(', ');
    const row = await db.get(
        `SELECT COALESCE(SUM(
                    CASE
                        WHEN points > paid_points THEN points - paid_points
                        ELSE 0
                    END
                ), 0) AS available
         FROM clover_quick_evaluations
         WHERE target_player_id IN (${placeholders})
           AND status <> 'void'`,
        ids
    );

    return Math.max(0, Number(row?.available || 0));
}

async function getProjectedReturnPoints(db, playerId) {
    const phoneDigits = getPlayerPhoneDigits(playerId);
    const [phSnapshot, paAvailable] = await Promise.all([
        getPhLedgerAuthoritySnapshot(db, playerId),
        getAvailablePa(db, playerId, phoneDigits),
    ]);

    const phAvailable = Math.max(0, Number(phSnapshot?.available || 0));
    const individualBonus = Number(INDIVIDUAL_RETURN_POINTS_BONUS_BY_PHONE[phoneDigits] || 0);
    const bonus = GLOBAL_RETURN_POINTS_BONUS + individualBonus;
    const projected = phAvailable + paAvailable + bonus;

    return {
        projected,
        phAvailable,
        paAvailable,
        globalBonus: GLOBAL_RETURN_POINTS_BONUS,
        individualBonus,
        bonus,
    };
}

function renderSummary(summary) {
    const lines = [
        '*♧┃𝐏𝐎𝐍𝐓𝐎𝐒 𝐃𝐄 𝐑𝐄𝐓𝐎𝐑𝐍𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*PR para a Loja:* ${formatPr(summary.projected)} PR`,
        '',
        `PH disponível: ${formatPr(summary.phAvailable)} PR`,
        `PA disponível: ${formatPr(summary.paAvailable)} PR`,
        `Bônus global: +${formatPr(summary.globalBonus)} PR`,
    ];

    if (summary.individualBonus > 0) {
        lines.push(`Bônus individual: +${formatPr(summary.individualBonus)} PR`);
    }

    lines.push(
        '',
        '_Valor calculado para a Loja de Retorno. O extrato abaixo continua mostrando apenas lançamentos já creditados._',
        '',
        `Use *${COMMAND_PREFIX}pr extrato* para ver os últimos lançamentos.`
    );

    return lines.join('\n');
}

function renderLedger(balance, rows) {
    const lines = [
        '*♧┃𝐄𝐗𝐓𝐑𝐀𝐓𝐎 𝐃𝐄 𝐏𝐎𝐍𝐓𝐎𝐒 𝐃𝐄 𝐑𝐄𝐓𝐎𝐑𝐍𝐎*',
        '',
        `*Saldo creditado:* ${formatPr(balance)} PR`,
        '',
    ];

    if (!rows.length) {
        lines.push('_Nenhum lançamento de Pontos de Retorno ainda._');
        return lines.join('\n');
    }

    for (const row of rows) {
        const amount = Math.abs(Number(row.amount || 0));
        const sign = Number(row.amount || 0) < 0 ? '-' : formatLedgerKind(row.entry_kind);
        const reason = String(row.reason || row.source || 'Movimentação').trim();
        lines.push(`*${sign}${formatPr(amount)} PR* — ${reason}`);
    }
    return lines.join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}pr`,
    aliases: [
        `${COMMAND_PREFIX}pontosretorno`,
        `${COMMAND_PREFIX}pontos retorno`,
    ],
    descricao: 'Consulta seus Pontos de Retorno.',
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const action = String(body || '').trim().toLowerCase();

        if (['extrato', 'historico', 'histórico'].includes(action)) {
            const [balance, rows] = await Promise.all([
                getReturnPointsBalance(db, idJogador),
                getReturnPointsLedger(db, idJogador, 10),
            ]);
            await sendReply({ sock, idChat, m, text: renderLedger(balance, rows) });
            return;
        }

        const summary = await getProjectedReturnPoints(db, idJogador);
        await sendReply({ sock, idChat, m, text: renderSummary(summary) });
    },
};
