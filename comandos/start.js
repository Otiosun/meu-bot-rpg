const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { findImagePath, renderStartMessage } = require('../helpers/onboardingFlow');
const { ensurePlayerRecord, getOnboardingState, updateOnboardingStep } = require('../helpers/playerRegistry');
const { getPlayerRollCount } = require('../helpers/rollManager');

function emphasizeTitle(text) {
    const lines = String(text || '').split('\n');
    const firstContentLine = lines.findIndex((line) => line.trim());
    if (firstContentLine < 0) return text;

    const title = lines[firstContentLine].trim();
    if (!title.startsWith('*') || !title.endsWith('*')) {
        lines[firstContentLine] = `*${title}*`;
    }
    return lines.join('\n');
}

function appendSacrificeGuidance(text) {
    const rendered = emphasizeTitle(text);
    if (rendered.includes(`${COMMAND_PREFIX}sacrificar`)) return rendered;

    return [
        rendered.trimEnd(),
        '',
        '     *──  𝐒𝐀𝐂𝐑𝐈𝐅𝐈́𝐂𝐈𝐎 𝐃𝐄 𝐑𝐎𝐋𝐋𝐒  ──*',
        '',
        'Depois de completar os *𝟦 rolls*, você também pode trocar todos eles por um único roll final, com chance melhorada e proteção contra azar.',
        '',
        `> ⤷ Consulte com *${COMMAND_PREFIX}sacrificar* antes de decidir.`,
    ].join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}start`,
    aliases: [
        `${COMMAND_PREFIX}iniciar`,
        `${COMMAND_PREFIX}inicio`,
        `${COMMAND_PREFIX}início`,
        `${COMMAND_PREFIX}comecar`,
        `${COMMAND_PREFIX}começar`,
        `${COMMAND_PREFIX}comeco`,
        `${COMMAND_PREFIX}começo`,
    ],
    descricao: 'Mostra o fluxo principal para comecar no bot.',
    executar: async ({ sock, m, idChat, idJogador, nomeUsuario, db }) => {
        await ensurePlayerRecord(db, idJogador, nomeUsuario);
        const onboarding = await getOnboardingState(db, idJogador);
        const rollCount = await getPlayerRollCount(db, idJogador);

        await updateOnboardingStep(
            db,
            idJogador,
            rollCount > 0 ? onboarding.current_step || 'roll_gerado' : onboarding.current_step || 'recepcao',
            { last_message: 'start', roll_count: rollCount }
        );

        await sendReply({
            sock,
            idChat,
            mentions: [idJogador],
            imagePath: findImagePath('start'),
            text: appendSacrificeGuidance(renderStartMessage(idJogador, rollCount)),
        });
    },
};