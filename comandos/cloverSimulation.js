const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { normalizeText } = require('../helpers/textUtils');
const {
    canManagePlayer,
    formatTargetErrorDetails,
    getMentions,
    getQuotedParticipant,
} = require('../helpers/clover/commandTargetUtils');
const { ensureTargetResolverSchema } = require('../helpers/clover/targetResolver');
const { ensureTargetResolverTables } = require('../helpers/clover/targetResolverSchemaGuard');
const {
    CloverScriptError,
    createSimulation,
} = require('../helpers/clover/cloverScriptService');
const {
    createLifecycleSimulation,
    looksLikeLifecycleScript,
} = require('../helpers/clover/cloverScriptLifecycleService');
const {
    createUndoSimulation,
    looksLikeUndoScript,
} = require('../helpers/clover/cloverScriptUndoService');
const {
    createMemberSimulation,
    looksLikeMemberScript,
} = require('../helpers/clover/cloverScriptMemberService');
const {
    createResetSimulation,
    looksLikeResetScript,
} = require('../helpers/clover/cloverScriptResetService');
const {
    expandSelectorScript,
    hasSelectorTargets,
} = require('../helpers/clover/cloverScriptSelectorService');

function compact(value) {
    return normalizeText(String(value || '')).replace(/[^a-z0-9]+/g, '');
}

function isValidateCommand(matchedCommand) {
    return compact(matchedCommand).includes('validar') || compact(matchedCommand).includes('validate');
}

function detectLikelyMissingFim(scriptText) {
    const lines = String(scriptText || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((raw, index) => ({ text: raw.trim(), line: index + 1 }))
        .filter((item) => item.text && !item.text.startsWith('//'));

    let blockOpen = false;
    let longBlockEnd = null;
    for (const item of lines) {
        const normalized = normalizeText(item.text);
        const first = normalized.split(/\s+/)[0];
        if (longBlockEnd) {
            if (normalized === longBlockEnd) longBlockEnd = null;
            continue;
        }
        if (normalized === 'ficha') {
            longBlockEnd = 'fim_ficha';
            continue;
        }
        if (normalized === 'desc') {
            longBlockEnd = 'fim_desc';
            continue;
        }
        if (first === 'alvo' || first === 'alvos' || first === 'todos') {
            if (blockOpen) {
                throw new CloverScriptError(
                    'ALVO encontrado dentro de um bloco aberto. Provavelmente faltou FIM antes desta linha.',
                    item.line,
                    'missing_fim'
                );
            }
            blockOpen = true;
            continue;
        }
        if (normalized === 'fim') blockOpen = false;
    }
    if (blockOpen) {
        throw new CloverScriptError('Bloco sem FIM.', lines[lines.length - 1]?.line || null, 'missing_fim');
    }
}

function renderModel() {
    return [
        '*♧┃SIMULAÇÃO CLOVER 𖥔 CLOVER MULTICOLOR*',
        '',
        'Envie o script abaixo do comando.',
        '',
        '```txt',
        `${COMMAND_PREFIX}clover simular`,
        'ALVO nome="Personagem" confirmar=true',
        'PH +10 fonte=evento teto=fora motivo="Recompensa"',
        'FIM',
        '```',
        '',
        '*Seletor Owner:*',
        '> ALVOS onde jogo=liberado esquadrao="Touros Negros" confirmar=true',
        '',
        '*Remoção protegida de grupo:*',
        '> MEMBRO remover grupo=comunidade motivo="..." confirmar=true',
        '',
        '*Reset seguro do personagem:*',
        '> PLAYER resetar escopo=personagem preservar_identidade=true motivo="..." confirmar=true',
        '> DESFAZER_RESET codigo=RS-... motivo="..." confirmar=true',
    ].join('\n');
}

function renderScriptError(error) {
    const target = error?.details?.target || error?.target || null;
    const detailLines = error?.details ? formatTargetErrorDetails(error.details) : [];
    const excluded = error?.details?.excluded && typeof error.details.excluded === 'object'
        ? Object.entries(error.details.excluded)
        : [];
    const conflicts = Array.isArray(error?.details?.conflicts)
        ? error.details.conflicts
        : Array.isArray(error?.conflicts)
            ? error.conflicts
            : [];
    return [
        '*♧┃CLOVERSCRIPT RECUSADO 𖥔 CLOVER MULTICOLOR*',
        '     ── nada foi aplicado ──',
        '',
        '_`─( ! )───── Erro`_',
        '',
        error?.line ? `*Linha:* ${error.line}` : null,
        target ? `*Alvo:* ${target}` : null,
        `> ${error?.message || String(error)}`,
        conflicts.length ? '' : null,
        ...conflicts.slice(0, 6).map((conflict) => `> Conflito: ${conflict.type}${conflict.occupiedBy ? ` · ocupado por ${conflict.occupiedBy}` : ''}`),
        excluded.length ? '' : null,
        ...excluded.slice(0, 6).map(([reason, total]) => `> Excluídos por ${reason}: ${total}`),
        detailLines.length ? '' : null,
        ...detailLines.map((line) => `> ${line.replace(/\*/g, '')}`),
    ].filter(Boolean).join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}clover simular`,
    aliases: [
        `${COMMAND_PREFIX}cs simular`,
        `${COMMAND_PREFIX}script simular`,
        `${COMMAND_PREFIX}cloverscript simular`,
        `${COMMAND_PREFIX}clover validar`,
        `${COMMAND_PREFIX}cs validar`,
        `${COMMAND_PREFIX}script validar`,
        `${COMMAND_PREFIX}cloverscript validar`,
    ],
    descricao: 'Simula CloverScript e expande seletores Owner de forma determinística.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body, matchedCommand }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode usar CloverScript.' });
            return;
        }
        if (!String(body || '').trim()) {
            await sendReply({ sock, idChat, m, text: renderModel() });
            return;
        }

        try {
            detectLikelyMissingFim(body);
            const selectorResult = hasSelectorTargets(body)
                ? await expandSelectorScript(db, body, {
                    actorId: idJogador,
                    now: new Date(),
                })
                : { expanded: false, scriptText: body, summaryText: '' };
            const scriptText = selectorResult.scriptText;
            const options = {
                actorId: idJogador,
                chatId: idChat,
                mentions: getMentions(m),
                quotedParticipant: getQuotedParticipant(m),
                source: isValidateCommand(matchedCommand) ? 'validate' : 'simulate',
                sock,
            };

            const undoScript = looksLikeUndoScript(scriptText);
            const memberScript = !undoScript && looksLikeMemberScript(scriptText);
            const resetScript = !undoScript && !memberScript && looksLikeResetScript(scriptText);
            const lifecycleScript = !undoScript && !memberScript && !resetScript && looksLikeLifecycleScript(scriptText);
            if (memberScript || resetScript || lifecycleScript) {
                await ensureTargetResolverTables(db);
                await ensureTargetResolverSchema(db);
            }
            const result = undoScript
                ? await createUndoSimulation(db, scriptText, options)
                : memberScript
                    ? await createMemberSimulation(db, scriptText, options)
                    : resetScript
                        ? await createResetSimulation(db, scriptText, options)
                        : lifecycleScript
                            ? await createLifecycleSimulation(db, scriptText, options)
                            : await createSimulation(db, scriptText, options);
            const text = selectorResult.expanded
                ? `${selectorResult.summaryText}\n\n${result.text}`
                : result.text;

            await sendReply({
                sock,
                idChat,
                m,
                mentions: [...new Set(result.plan.blocks.flatMap((block) => block.targets.map((target) => target.id)))],
                text,
            });
        } catch (error) {
            await sendReply({ sock, idChat, m, text: renderScriptError(error) });
        }
    },
};
