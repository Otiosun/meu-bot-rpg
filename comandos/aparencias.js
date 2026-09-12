const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { formatPlayerTag } = require('../helpers/clover/archiveManager');
const { getAdminActorAccess } = require('../helpers/clover/adminAccessService');
const { ADMIN_CAPABILITIES } = require('../helpers/clover/adminOperationContract');

function formatMention(jid) {
    return `@${String(jid || '').split('@')[0]}`;
}

function display(value, fallback = '-') {
    const text = String(value ?? '').trim();
    return text && text !== '-' ? text : fallback;
}

function statusLabel(value) {
    const status = String(value || '').trim().toLowerCase();
    if (['approved', 'aprovada'].includes(status)) return 'Aprovada';
    if (['rejected', 'negada', 'reprovada'].includes(status)) return 'Negada';
    return 'Pendente';
}

function gameLabel(value) {
    return String(value || '').trim().toLowerCase() === 'liberado' ? 'Liberado' : 'Bloqueado';
}

async function canViewAppearanceList(db, playerId) {
    const access = await getAdminActorAccess(db, playerId);
    if (!access.ok) return false;
    return access.actor.capabilities.includes(ADMIN_CAPABILITIES.PLAYER_MANAGE);
}

function renderAppearanceList(rows) {
    if (!rows.length) {
        return [
            '♧ 𝐀𝐏𝐀𝐑𝐄̂𝐍𝐂𝐈𝐀𝐒 𝐄𝐌 𝐔𝐒𝐎',
            '     ──  clovᥱr rpg · rᥱgıstro vısuαl  ──',
            '',
            'Nα̃o ᥱncontrᥱı αpαrᥱ̂ncıαs rᥱgıstrαdαs.',
        ].join('\n');
    }

    const lines = [
        '♧ 𝐀𝐏𝐀𝐑𝐄̂𝐍𝐂𝐈𝐀𝐒 𝐄𝐌 𝐔𝐒𝐎',
        '     ──  clovᥱr rpg · rᥱgıstro vısuαl  ──',
        '',
        `*Total:* ${rows.length}`,
        '',
    ];

    rows.forEach((row, index) => {
        if (index > 0) lines.push('');
        lines.push(
            `${formatPlayerTag(row.id)} ${formatMention(row.id)}`,
            `> *Jogador:* ${display(row.nome_real || row.display_name || row.nome)}`,
            `> *Personagem:* ${display(row.personagem_nome)}`,
            `> *Aparência:* ${display(row.personagem_aparencia)}`,
            `> *Status:* ${statusLabel(row.personagem_aparencia_status)}`,
            `> *Jogo:* ${gameLabel(row.jogo_status)}`
        );
    });

    return lines.join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}aparencias`,
    aliases: [
        `${COMMAND_PREFIX}aparências`,
        `${COMMAND_PREFIX}listaaparencias`,
        `${COMMAND_PREFIX}lista aparencias`,
        `${COMMAND_PREFIX}lista aparências`,
    ],
    descricao: 'Lista aparencias em uso e quem usa.',
    oculto: true,
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db }) => {
        if (!await canViewAppearanceList(db, idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: '*Esse comando exige permissão administrativa de gestão de jogador.*',
            });
            return;
        }

        const rows = await db.all(
            `SELECT id,
                    nome,
                    nome_real,
                    display_name,
                    personagem_nome,
                    personagem_aparencia,
                    personagem_aparencia_status,
                    jogo_status
             FROM jogadores
             WHERE personagem_aparencia IS NOT NULL
               AND TRIM(personagem_aparencia) NOT IN ('', '-')
             ORDER BY personagem_aparencia_normalizada COLLATE NOCASE ASC,
                      personagem_nome COLLATE NOCASE ASC`
        );

        await sendReply({
            sock,
            idChat,
            m,
            mentions: rows.map((row) => row.id),
            text: renderAppearanceList(rows),
        });
    },
    canViewAppearanceList,
};
