const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { normalizeText } = require('../helpers/textUtils');
const {
    canManagePlayer,
    formatTargetErrorDetails,
    getMentions,
    getQuotedParticipant,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const { ensureTargetResolverSchema } = require('../helpers/clover/targetResolver');
const {
    CloverScriptError,
    applySimulation,
    cancelSimulation,
    createSimulation,
    getScriptHistory,
    renderCloverScriptResources,
    renderHistory,
} = require('../helpers/clover/cloverScriptService');
const {
    applyLifecycleSimulation,
    createLifecycleSimulation,
    isLifecycleSimulationCode,
    looksLikeLifecycleScript,
    shouldHandleLifecycleApply,
} = require('../helpers/clover/cloverScriptLifecycleService');

function splitAction(body) {
    const text = String(body || '').trim();
    const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    return {
        action: normalizeText(match?.[1] || '').replace(/[^a-z0-9]+/g, ''),
        rest: String(match?.[2] || '').trim(),
    };
}

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

function normalizeAction(action) {
    if (['simular', 'sim', 'preview', 'prever'].includes(action)) return 'simulate';
    if (['aplicar', 'confirmar', 'apply'].includes(action)) return 'apply';
    if (['cancelar', 'cancel'].includes(action)) return 'cancel';
    if (['validar', 'validate'].includes(action)) return 'validate';
    if (['historico', 'histórico', 'log'].includes(action)) return 'history';
    if (['guia', 'help', 'ajuda'].includes(action)) return 'help';
    if (['modelo', 'modelos'].includes(action)) return 'model';
    if (['recursos', 'acoes', 'ações', 'aÃ§Ãµes', 'suporte'].includes(action)) return 'resources';
    return null;
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
        const last = lines[lines.length - 1];
        throw new CloverScriptError('Bloco sem FIM.', last?.line || null, 'missing_fim');
    }
}

function renderHelp() {
    return [
        '*♧┃CLOVERSCRIPT 𖥔 CLOVER MULTICOLOR*',
        '     ── linguagem administrativa rígida ──',
        '',
        '_`─( ✓ )───── Fluxo`_',
        '',
        `*${COMMAND_PREFIX}clover simular*`,
        '> Valida e mostra o que será aplicado.',
        `*${COMMAND_PREFIX}clover aplicar codigo=CS-XXXXXX*`,
        '> Aplica uma simulação conferida.',
        `*${COMMAND_PREFIX}clover cancelar*`,
        '> Cancela sua última simulação.',
        '',
        '_`─( ◆ )───── Exemplo`_',
        '',
        '```txt',
        `${COMMAND_PREFIX}clover simular`,
        'LOTE id="evento-2026-06-24" nome="Evento" modo=rigido data=2026-06-24',
        '',
        'ALVOS @Player1 @Player2',
        'PH +30 fonte=evento teto=fora motivo="Participação no evento"',
        'YULLS +300 motivo="Pagamento do evento"',
        'FIM',
        '```',
        '',
        '_`─( ! )───── Ciclo de vida protegido`_',
        '',
        '> Owner, um player por simulação:',
        '> PLAYER arquivar motivo="..." confirmar=true',
        '> PLAYER reativar motivo="..." confirmar=true',
    ].join('\n');
}

function renderModel() {
    return [
        '*♧┃MODELOS CLOVERSCRIPT 𖥔 CLOVER MULTICOLOR*',
        '     ── copie, ajuste e simule ──',
        '',
        '_`─( ✓ )───── Recompensa em lote`_',
        '',
        '```txt',
        `${COMMAND_PREFIX}clover simular`,
        'LOTE id="raid-codigo-data" nome="Nome da Raid" modo=rigido data=2026-06-24',
        '',
        'ALVOS @A @B @C',
        'PH +30 fonte=evento teto=fora motivo="Participação"',
        'YULLS +300 motivo="Pagamento"',
        'FIM',
        '',
        'ALVO @MVP',
        'PH +20 fonte=evento teto=fora motivo="MVP"',
        'ITEM dar nome="Medalha da Raid" qtd=1 tipo=evento motivo="MVP"',
        'FIM',
        '```',
        '',
        '_`─( ! )───── Arquivar player`_',
        '',
        '```txt',
        `${COMMAND_PREFIX}clover simular`,
        'LOTE id="arquivar-player-data" nome="Arquivamento seguro" modo=rigido',
        '',
        'ALVO nome="Nome do Personagem" confirmar=true',
        'PLAYER arquivar motivo="Saiu da comunidade" confirmar=true',
        'FIM',
        '```',
        '',
        '_`─( ✦ )───── Reativar player`_',
        '',
        '```txt',
        `${COMMAND_PREFIX}clover simular`,
        'ALVO nome="Nome do Personagem" confirmar=true',
        'PLAYER reativar motivo="Retorno aprovado" confirmar=true',
        'FIM',
        '```',
    ].join('\n');
}

function renderScriptError(error) {
    const target = error?.details?.target || error?.target || null;
    const detailLines = error?.details ? formatTargetErrorDetails(error.details) : [];
    return [
        '*♧┃CLOVERSCRIPT RECUSADO 𖥔 CLOVER MULTICOLOR*',
        '     ── nada foi aplicado ──',
        '',
        '_`─( ! )───── Erro`_',
        '',
        error?.line ? `*Linha:* ${error.line}` : null,
        target ? `*Alvo:* ${target}` : null,
        `> ${error?.message || String(error)}`,
        detailLines.length ? '' : null,
        ...detailLines.map((line) => `> ${line.replace(/\*/g, '')}`),
    ].filter(Boolean).join('\n');
}

async function resolveHistoryTarget(db, rest, m) {
    const { targetId, targetText } = resolveTargetAndRest(rest, m);
    if (!targetId && !targetText) return null;
    const resolved = await resolveTargetPlayer(db, targetId, targetText);
    return resolved.ok ? resolved.player : null;
}

module.exports = {
    nome: `${COMMAND_PREFIX}clover`,
    aliases: [
        `${COMMAND_PREFIX}cs`,
        `${COMMAND_PREFIX}script`,
        `${COMMAND_PREFIX}cloverscript`,
    ],
    descricao: 'Simula e aplica ações administrativas em CloverScript.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!await canManagePlayer(sock, idChat, idJogador)) {
            await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode usar CloverScript.' });
            return;
        }

        const { action: rawAction, rest } = splitAction(body);
        const action = normalizeAction(rawAction);
        if (!action) {
            await sendReply({ sock, idChat, m, text: renderHelp() });
            return;
        }

        try {
            if (action === 'help') {
                await sendReply({ sock, idChat, m, text: renderHelp() });
                return;
            }

            if (action === 'model') {
                await sendReply({ sock, idChat, m, text: renderModel() });
                return;
            }

            if (action === 'resources') {
                const baseResources = renderCloverScriptResources();
                const lifecycleResources = [
                    '',
                    '_`─( ✓ )───── Ciclo de vida protegido`_',
                    '',
                    '> PLAYER arquivar — Owner, confirmar=true, um player por simulação.',
                    '> PLAYER reativar — restaura vínculos seguros e bloqueia o jogo se houver conflito de vaga.',
                    '> Arquivamento não apaga PH, inventário, grimório, personagem ou histórico.',
                ].join('\n');
                await sendReply({ sock, idChat, m, text: `${baseResources}${lifecycleResources}` });
                return;
            }

            if (action === 'simulate' || action === 'validate') {
                if (!rest) {
                    await sendReply({ sock, idChat, m, text: renderModel() });
                    return;
                }

                detectLikelyMissingFim(rest);
                const simulationOptions = {
                    actorId: idJogador,
                    chatId: idChat,
                    mentions: getMentions(m),
                    quotedParticipant: getQuotedParticipant(m),
                    source: action === 'validate' ? 'validate' : 'simulate',
                };
                const lifecycleScript = looksLikeLifecycleScript(rest);
                if (lifecycleScript) await ensureTargetResolverSchema(db);
                const result = lifecycleScript
                    ? await createLifecycleSimulation(db, rest, simulationOptions)
                    : await createSimulation(db, rest, simulationOptions);

                await sendReply({
                    sock,
                    idChat,
                    m,
                    mentions: [...new Set(result.plan.blocks.flatMap((block) => block.targets.map((target) => target.id)))],
                    text: result.text,
                });
                return;
            }

            if (action === 'apply') {
                const kv = parseKv(rest);
                const code = (kv.codigo || kv.code || rest || '').trim().toUpperCase() || null;
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
                return;
            }

            if (action === 'cancel') {
                const result = await cancelSimulation(db, { actorId: idJogador, chatId: idChat });
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: result.ok
                        ? '*♧┃CLOVERSCRIPT CANCELADO 𖥔 CLOVER MULTICOLOR*\n\n> Simulação pendente cancelada.'
                        : '*♧┃CLOVERSCRIPT 𖥔 CLOVER MULTICOLOR*\n\n> Nenhuma simulação pendente para cancelar.',
                });
                return;
            }

            if (action === 'history') {
                const target = await resolveHistoryTarget(db, rest, m);
                const rows = await getScriptHistory(db, { playerId: target?.id || null, limit: 10 });
                await sendReply({ sock, idChat, m, text: renderHistory(rows) });
            }
        } catch (error) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderScriptError(error),
            });
        }
    },
};
