const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { normalizeText } = require('../helpers/textUtils');
const { canManagePlayer, formatTargetErrorDetails } = require('../helpers/clover/commandTargetUtils');
const { applySimulation } = require('../helpers/clover/cloverScriptService');
const {
    applyLifecycleSimulation,
    isLifecycleSimulationCode,
    shouldHandleLifecycleApply,
} = require('../helpers/clover/cloverScriptLifecycleService');
const {
    applyUndoSimulation,
    isUndoSimulationCode,
    shouldHandleUndoApply,
} = require('../helpers/clover/cloverScriptUndoService');
const {
    applyMemberSimulation,
    isMemberSimulationCode,
    shouldHandleMemberApply,
} = require('../helpers/clover/cloverScriptMemberService');
const {
    applyResetSimulation,
    isResetSimulationCode,
    shouldHandleResetApply,
} = require('../helpers/clover/cloverScriptResetService');
const {
    enqueueCloverScriptJob,
    inspectSimulationForJob,
    processCloverScriptJob,
    renderJobReceived,
    renderJobStatus,
} = require('../helpers/clover/cloverScriptJobService');

function parseKv(text) {
    const kv = {};
    const regex = /([A-Za-zÀ-ÿ0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    while ((match = regex.exec(String(text || '')))) {
        const value = String(match[2] || '').trim();
        kv[normalizeText(match[1]).replace(/[^a-z0-9_]+/g, '_')] = value.replace(/^["']|["']$/g, '');
    }
    return kv;
}

function truthy(value) {
    return ['true', 'sim', 'yes', '1', 'on'].includes(normalizeText(String(value || '')));
}

function extractCode(rest) {
    const kv = parseKv(rest);
    const explicit = kv.codigo || kv.code || null;
    if (explicit) return String(explicit).trim().toUpperCase();
    const tokens = String(rest || '').trim().split(/\s+/).filter(Boolean);
    const found = tokens.find((token) => /^(CS|CSL|CSU|CSM|CSR|CSRR)-/i.test(token));
    return found ? found.trim().toUpperCase() : null;
}

function renderError(error) {
    const detailLines = error?.details ? formatTargetErrorDetails(error.details) : [];
    const conflicts = Array.isArray(error?.details?.conflicts)
        ? error.details.conflicts
        : Array.isArray(error?.conflicts)
            ? error.conflicts
            : [];
    return [
        '*♧┃CLOVERSCRIPT RECUSADO 𖥔 CLOVER MULTICOLOR*',
        '     ── nada novo foi aplicado ──',
        '',
        '_`─( ! )───── Erro`_',
        '',
        error?.line ? `*Linha:* ${error.line}` : null,
        `> ${error?.message || String(error)}`,
        conflicts.length ? '' : null,
        ...conflicts.slice(0, 6).map((conflict) => `> Conflito: ${conflict.type}${conflict.occupiedBy ? ` · ocupado por ${conflict.occupiedBy}` : ''}`),
        detailLines.length ? '' : null,
        ...detailLines.map((line) => `> ${line.replace(/\*/g, '')}`),
    ].filter(Boolean).join('\n');
}

function startJobDetached({ db, sock, jobCode }) {
    setImmediate(() => {
        processCloverScriptJob(db, jobCode, { sock }).catch((error) => {
            console.log(`[cloverscript-job] falha inesperada em ${jobCode}:`, error?.message || error);
        });
    });
}

module.exports = {
    nome: `${COMMAND_PREFIX}clover aplicar`,
    aliases: [
        `${COMMAND_PREFIX}cs aplicar`,
        `${COMMAND_PREFIX}script aplicar`,
        `${COMMAND_PREFIX}cloverscript aplicar`,
        `${COMMAND_PREFIX}clover confirmar`,
        `${COMMAND_PREFIX}cs confirmar`,
    ],
    descricao: 'Aplica uma simulação CloverScript pelo código conferido.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode aplicar CloverScript.' });
            return;
        }

        const kv = parseKv(body);
        const code = extractCode(body);
        const forceJob = truthy(kv.job || kv.tarefa || kv.async || kv.assincrono);

        try {
            const undo = isUndoSimulationCode(code)
                || await shouldHandleUndoApply(db, {
                    code: code || null,
                    actorId: idJogador,
                    chatId: idChat,
                });
            if (undo) {
                if (forceJob) throw new Error('DESFAZER não entra em JOB. Aplique o código CSU diretamente.');
                const result = await applyUndoSimulation(db, {
                    code: code || null,
                    actorId: idJogador,
                    chatId: idChat,
                    sock,
                });
                await sendReply({ sock, idChat, m, text: result.text });
                return;
            }

            const member = isMemberSimulationCode(code)
                || await shouldHandleMemberApply(db, {
                    code: code || null,
                    actorId: idJogador,
                    chatId: idChat,
                });
            if (member) {
                if (forceJob) throw new Error('MEMBRO remover não entra em JOB. Aplique o código CSM diretamente.');
                const result = await applyMemberSimulation(db, {
                    code: code || null,
                    actorId: idJogador,
                    chatId: idChat,
                    sock,
                });
                await sendReply({ sock, idChat, m, text: result.text });
                return;
            }

            const reset = isResetSimulationCode(code)
                || await shouldHandleResetApply(db, {
                    code: code || null,
                    actorId: idJogador,
                    chatId: idChat,
                });
            if (reset) {
                if (forceJob) throw new Error('PLAYER resetar/DESFAZER_RESET não entram em JOB. Aplique o código CSR/CSRR diretamente.');
                const result = await applyResetSimulation(db, {
                    code: code || null,
                    actorId: idJogador,
                    chatId: idChat,
                    sock,
                });
                await sendReply({ sock, idChat, m, text: result.text });
                return;
            }

            const inspection = await inspectSimulationForJob(db, {
                code: code || null,
                actorId: idJogador,
                chatId: idChat,
                force: forceJob,
            });
            if (inspection.ok && inspection.shouldQueue) {
                const queued = await enqueueCloverScriptJob(db, {
                    code: code || null,
                    actorId: idJogador,
                    chatId: idChat,
                    force: forceJob,
                });
                if (!queued.ok) throw new Error(queued.error || 'Não consegui criar a tarefa CloverScript.');
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: queued.duplicate && queued.job.status !== 'queued'
                        ? renderJobStatus(queued.job)
                        : renderJobReceived(queued.job),
                });
                if (queued.job.status === 'queued') {
                    startJobDetached({ db, sock, jobCode: queued.job.code });
                }
                return;
            }

            const lifecycle = isLifecycleSimulationCode(code)
                || await shouldHandleLifecycleApply(db, {
                    code: code || null,
                    actorId: idJogador,
                    chatId: idChat,
                });
            const result = lifecycle
                ? await applyLifecycleSimulation(db, {
                    code: code || null,
                    actorId: idJogador,
                    chatId: idChat,
                    sock,
                })
                : await applySimulation(db, {
                    code: code || null,
                    actorId: idJogador,
                    chatId: idChat,
                    sock,
                });
            await sendReply({ sock, idChat, m, text: result.text });
        } catch (error) {
            await sendReply({ sock, idChat, m, text: renderError(error) });
        }
    },
};
