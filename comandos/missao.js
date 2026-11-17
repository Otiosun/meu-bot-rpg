'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const { getPublicMission } = require('../helpers/clover/playerMissionBoardService');
const { renderMissionDetail } = require('../helpers/clover/playerMissionBoardMessages');
const { getMyMission, joinMission, startMission, submitMission } = require('../helpers/clover/playerMissionLifecycleService');

const STATUS_LABELS = {
    registered: 'Inscrito', in_progress: 'Em andamento', submitted: 'Aguardando avaliação',
    changes_requested: 'Ajustes solicitados', approved: 'Aprovado e recompensado',
    rejected: 'Reprovado',
};
function usage() {
    return [
        'Uso:',
        COMMAND_PREFIX + 'missao <código>',
        COMMAND_PREFIX + 'missao <código> aceitar',
        COMMAND_PREFIX + 'missao <código> iniciar',
        COMMAND_PREFIX + 'missao <código> entregar | <relato>',
        COMMAND_PREFIX + 'missao <código> status',
    ].join('\n');
}
function resultMessage(result, action) {
    const record = result.participation;
    const lines = [
        '*♧┃MISSÃO · ' + (STATUS_LABELS[record.status] || record.status) + '*',
        '*' + record.title + '*',
        '> Código: ' + record.missionKey,
    ];
    if (action === 'aceitar') lines.push('> Sua inscrição está registrada no sistema.');
    if (action === 'iniciar') lines.push('> Início registrado. Siga os objetivos definidos pelo ADM.');
    if (action === 'entregar') lines.push('> Entrega registrada para avaliação humana da equipe.');
    if (action === 'status') {
        lines.push('> Situação: ' + (STATUS_LABELS[record.status] || record.status));
        if (record.reviewReason) lines.push('> Motivo: ' + String(record.reviewReason).replace(/[\r\n]/g, ' ').slice(0, 400));
    }
    if (record.status === 'approved') {
        lines.push('> Recompensa-base: ' + record.reward.ph + ' PH · ' +
            record.reward.yulls + ' Yulls · ' + record.reward.stars + ' Estrelas');
    } else if (record.status === 'changes_requested') {
        lines.push('> Corrija a entrega e reenvie: ' + COMMAND_PREFIX + 'missao ' + record.missionKey + ' entregar | <relato>');
    } else if (record.status === 'registered') {
        lines.push('> Próximo: ' + COMMAND_PREFIX + 'missao ' + record.missionKey + ' iniciar');
    } else if (record.status === 'in_progress') {
        lines.push('> Próximo: ' + COMMAND_PREFIX + 'missao ' + record.missionKey + ' entregar | <relato>');
    } else if (record.status === 'submitted') {
        lines.push('> Aguarde avaliação ADM; consulte o status neste comando.');
    }
    return lines.join('\n');
}
module.exports = {
    nome: COMMAND_PREFIX + 'missao',
    aliases: [COMMAND_PREFIX + 'missão'],
    descricao: 'Consulte, aceite, inicie e entregue uma missão autoral; acompanhe sua avaliação.',
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const reply = (text) => sendReply({ sock, m, idChat, text });
        const phase = await getPlayerPhase(db, idJogador);
        if (!phase.canPlay) { await reply(renderGameBlockedMessage()); return; }

        const input = String(body || '').trim();
        const match = input.match(/^(\S+)(?:\s+(aceitar|iniciar|entregar|status)(?:\s*\|\s*([\s\S]+))?)?$/i);
        if (!match) { await reply(usage()); return; }
        const [, missionKey, rawAction, report] = match;
        const action = String(rawAction || '').toLowerCase();

        try {
            if (!action) {
                const mission = await getPublicMission(db, missionKey);
                await reply(renderMissionDetail(mission));
                return;
            }
            if (action === 'status') {
                const participation = await getMyMission(db, missionKey, idJogador);
                await reply(participation
                    ? resultMessage({ participation }, 'status')
                    : '> Você ainda não está inscrito nesta missão.\n' + usage());
                return;
            }
            if (action === 'entregar' && !report) { await reply(usage()); return; }
            const result = action === 'aceitar'
                ? await joinMission(db, { missionKey, playerId: idJogador })
                : action === 'iniciar'
                    ? await startMission(db, { missionKey, playerId: idJogador })
                    : await submitMission(db, { missionKey, playerId: idJogador, text: report });
            await reply(resultMessage(result, action));
        } catch (error) {
            if (!error?.code || !error?.status) throw error;
            await reply('> ' + error.message + '\n> Consulte ' + COMMAND_PREFIX + 'missoes para encontrar missões disponíveis.');
        }
    },
    usage,
    resultMessage,
};