'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const {
    cancelPerformanceTeamApplication,
    confirmPerformanceTeamApplication,
    isPerformanceTeamAdmin,
    joinPerformanceTeams,
    listPerformanceTeamApplications,
    normalizeAction,
    readPerformanceTeamStatus,
    renderAdminHelp,
    renderApplicationList,
    renderCancelResult,
    renderCommands,
    renderConfirmResult,
    renderJoinResult,
    renderMyStatus,
    renderPhaseTwo,
    renderSystem,
    renderUnknownCommand,
} = require('../helpers/clover/performanceTeamService');

function firstToken(body) {
    return normalizeAction(body).split(' ')[0] || '';
}

function restAfterFirstToken(body) {
    return String(body || '').trim().split(/\s+/).slice(1).join(' ').trim();
}

async function resolveAdminTarget(db, body, m) {
    const parsed = resolveTargetAndRest(restAfterFirstToken(body), m);
    if (!parsed.targetId && !parsed.targetText) return null;
    const resolved = await resolveTargetPlayer(db, parsed.targetId, parsed.targetText, { mechanical: true });
    if (!resolved.ok) return { ok: false, message: resolved.error || 'Nao encontrei esse player.' };
    return { ok: true, player: resolved.player, rest: parsed.rest };
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

        if (['lista', 'listar', 'fila', 'inscritos', 'elegiveis'].includes(token)) {
            if (!admin) {
                await sendReply({ sock, idChat, m, text: 'Apenas Owner ou Administrador pode ver a fila dos Times.' });
                return;
            }
            const list = await listPerformanceTeamApplications(db);
            await sendReply({ sock, idChat, m, text: renderApplicationList(list) });
            return;
        }

        if (token === 'confirmar') {
            let targetId = idJogador;
            if (admin) {
                const target = await resolveAdminTarget(db, body, m);
                if (target?.ok) targetId = target.player.id;
                if (target && !target.ok) {
                    await sendReply({ sock, idChat, m, text: target.message });
                    return;
                }
            }
            const result = await confirmPerformanceTeamApplication(db, targetId, {
                actorId: idJogador,
                source: targetId === idJogador ? 'bot_self_confirm' : 'bot_admin_confirm',
            });
            await sendReply({ sock, idChat, m, text: renderConfirmResult(result) });
            return;
        }

        if (['sair', 'cancelar', 'desistir'].includes(token)) {
            let targetId = idJogador;
            let reason = restAfterFirstToken(body);
            if (admin) {
                const target = await resolveAdminTarget(db, body, m);
                if (target?.ok) {
                    targetId = target.player.id;
                    reason = target.rest;
                }
                if (target && !target.ok) {
                    await sendReply({ sock, idChat, m, text: target.message });
                    return;
                }
            }
            const result = await cancelPerformanceTeamApplication(db, targetId, {
                actorId: idJogador,
                reason,
                source: targetId === idJogador ? 'bot_self_cancel' : 'bot_admin_cancel',
            });
            await sendReply({ sock, idChat, m, text: renderCancelResult(result) });
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
            'votar',
            'ausencia',
            'historico',
        ].includes(token)) {
            if (!admin && !['votar', 'ausencia', 'historico'].includes(token)) {
                await sendReply({ sock, idChat, m, text: 'Apenas Owner ou Administrador pode alterar Times de Performance.' });
                return;
            }
            await sendReply({
                sock,
                idChat,
                m,
                text: renderPhaseTwo(prefix, `${prefix}time ${action || token}`),
            });
            return;
        }

        await sendReply({ sock, idChat, m, text: renderUnknownCommand(prefix) });
    },
};
