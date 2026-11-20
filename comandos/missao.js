'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { getPlayerPhase, renderGameBlockedMessage } = require('../helpers/clover/playerPhase');
const { getPublicMission } = require('../helpers/clover/playerMissionBoardService');
const { renderMissionDetail, renderParticipation } = require('../helpers/clover/playerMissionBoardMessages');
const { getMyMission, joinMission, startMission, submitMission } = require('../helpers/clover/playerMissionLifecycleService');

const { getMessageContextInfo, getQuotedText } = require('../helpers/messageContext');
const { isSameUser } = require('../helpers/groupAccess');
const { quotedSceneKey } = require('../helpers/clover/missionSceneClaims');

function usage() {
    return [
        '♧┃𝐌𝐈𝐒𝐒𝐎̃𝐄𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫',
        '',
        'Uso:',
        '*̣' + COMMAND_PREFIX + 'missoes*',
        '> Mural de missões.',
        '*̣' + COMMAND_PREFIX + 'minhasmissoes*',
        '> Suas participações.',
        '*̣' + COMMAND_PREFIX + 'missao <código>*',
        '> Consultar e participar.',
    ].join('\n');
}
function resultMessage(result) {
    return renderParticipation(result.participation, result.duplicate);
}
function quotedOwnReport(message, actorId) {
    const context = getMessageContextInfo(message);
    if (!context?.quotedMessage || !context.participant || !isSameUser(context.participant, actorId)) return '';
    return String(getQuotedText(message) || '').trim();
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
                    ? resultMessage({ participation })
                    : '> Você ainda não está inscrito nesta missão.\n' + usage());
                return;
            }
            const submission = action === 'entregar' ? (report || quotedOwnReport(m, idJogador)) : null;
            if (action === 'entregar' && !submission) {
                await reply('> Responda à mensagem da sua própria atuação com este comando ou envie o relato após |.');
                return;
            }
            if (report && action !== 'entregar') { await reply(usage()); return; }
            const sourceSceneKey = action === 'entregar' && !report ? quotedSceneKey(m, idChat) : null;
            const result = action === 'aceitar'
                ? await joinMission(db, { missionKey, playerId: idJogador })
                : action === 'iniciar'
                    ? await startMission(db, { missionKey, playerId: idJogador })
                    : await submitMission(db, { missionKey, playerId: idJogador, text: submission, ...(sourceSceneKey ? { sourceSceneKey } : {}) });
            await reply(resultMessage(result));
        } catch (error) {
            if (!error?.code || !error?.status) throw error;
            await reply('> ' + error.message + '\n> Consulte ' + COMMAND_PREFIX + 'missoes para encontrar missões disponíveis.');
        }
    },
    usage,
    resultMessage,
    quotedOwnReport,
};