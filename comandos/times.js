'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    isPerformanceTeamAdmin,
    joinPerformanceTeams,
    normalizeAction,
    readPerformanceTeamStatus,
    renderAdminHelp,
    renderCommands,
    renderJoinResult,
    renderMyStatus,
    renderSystem,
} = require('../helpers/clover/performanceTeamService');

function firstToken(body) {
    return normalizeAction(body).split(' ')[0] || '';
}

module.exports = {
    nome: `${COMMAND_PREFIX}times`,
    aliases: [
        `${COMMAND_PREFIX}time`,
        `${COMMAND_PREFIX}meutime`,
    ],
    descricao: 'Mostra e gerencia Times de Performance para novatos sem esquadrao.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        const prefix = COMMAND_PREFIX;
        const commandName = normalizeAction(matchedCommand || '');
        const action = normalizeAction(body);
        const token = firstToken(body);
        const admin = await isPerformanceTeamAdmin(db, idJogador);

        if (commandName.endsWith('meutime') || token === 'meu') {
            const status = await readPerformanceTeamStatus(db, idJogador);
            await sendReply({ sock, idChat, m, text: renderMyStatus(status) });
            return;
        }

        if (!action || ['sistema', 'info', 'ver'].includes(token)) {
            await sendReply({ sock, idChat, m, text: renderSystem(prefix) });
            return;
        }

        if (['comandos', 'ajuda', 'help'].includes(token)) {
            await sendReply({ sock, idChat, m, text: renderCommands(prefix, admin) });
            return;
        }

        if (['participar', 'entrar', 'inscrever', 'inscrever se'].includes(action)) {
            const result = await joinPerformanceTeams(db, idJogador);
            await sendReply({ sock, idChat, m, text: renderJoinResult(result) });
            return;
        }

        if (token === 'admin') {
            await sendReply({
                sock,
                idChat,
                m,
                text: admin
                    ? renderAdminHelp(prefix)
                    : 'Apenas Owner ou Administrador pode usar os controles administrativos dos Times.',
            });
            return;
        }

        if ([
            'ciclo',
            'elegiveis',
            'sortear',
            'publicar',
            'criar',
            'adicionar',
            'remover',
            'transferir',
            'substituir',
            'representante',
            'monitor',
            'fechar',
        ].includes(token)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: admin
                    ? 'Controle administrativo dos Times reconhecido. Use .#times admin para o mapa completo; a execucao operacional sera consolidada no proximo passo.'
                    : 'Apenas Owner ou Administrador pode alterar Times de Performance.',
            });
            return;
        }

        await sendReply({ sock, idChat, m, text: renderCommands(prefix, admin) });
    },
};
