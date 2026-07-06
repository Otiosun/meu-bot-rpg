const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { normalizeJid } = require('../helpers/groupAccess');
const { normalizeText } = require('../helpers/textUtils');
const {
    canManagePlayer,
    formatMention,
    getMentions,
    getQuotedParticipant,
} = require('../helpers/clover/commandTargetUtils');
const {
    addParticipants,
    applyRaidRewards,
    createRaid,
    ensureRaidSchema,
    generateRaidScript,
    getRaidView,
    markParticipants,
    parseKv,
    parseRaidLongForm,
    removeParticipant,
    renderRaidCreated,
    renderRaidView,
    setRaidRewards,
    simulateRaidRewards,
    tokenize,
    updateRaidStatus,
} = require('../helpers/clover/raidService');

const PARTICIPANT_STATUSES = new Set(['inscrito', 'espera', 'presente', 'ausente', 'desistiu', 'removido']);

function compact(value) {
    return normalizeText(value).replace(/[^a-z0-9]+/g, '');
}

function splitAction(body) {
    const text = String(body || '').trim();
    const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    return {
        action: compact(match?.[1] || ''),
        rest: String(match?.[2] || '').trim(),
    };
}

function normalizeAction(action) {
    if (['criar', 'novo', 'nova', 'create'].includes(action)) return 'create';
    if (['abrir', 'open'].includes(action)) return 'open';
    if (['fechar', 'close'].includes(action)) return 'close';
    if (['avaliar', 'avaliacao', 'avaliacao', 'review'].includes(action)) return 'review';
    if (['cancelar', 'cancel'].includes(action)) return 'cancel';
    if (['status', 'ver', 'info'].includes(action)) return 'status';
    if (['listar', 'lista', 'list'].includes(action)) return 'list';
    if (['entrar', 'participar', 'join'].includes(action)) return 'join';
    if (['sair', 'desistir', 'leave'].includes(action)) return 'leave';
    if (['add', 'adicionar', 'colocar'].includes(action)) return 'add';
    if (['remover', 'tirar', 'remove'].includes(action)) return 'remove';
    if (['marcar', 'presenca', 'presenca', 'mark'].includes(action)) return 'mark';
    if (['recompensa', 'recompensas', 'premio', 'premios', 'reward', 'rewards'].includes(action)) return 'rewards';
    if (['simular', 'sim', 'preview'].includes(action)) return 'simulate';
    if (['aplicar', 'confirmar', 'apply'].includes(action)) return 'apply';
    if (['script', 'clover', 'cloverscript'].includes(action)) return 'script';
    if (['modelo', 'modelos'].includes(action)) return 'model';
    if (['ajuda', 'help'].includes(action)) return 'help';
    return null;
}

function splitFirstLine(text) {
    const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
    const index = normalized.indexOf('\n');
    if (index === -1) return { line: normalized, rest: '' };
    return {
        line: normalized.slice(0, index).trim(),
        rest: normalized.slice(index + 1).trim(),
    };
}

function extractCodeAndRest(text) {
    const { line, rest } = splitFirstLine(text);
    const tokens = tokenize(line);
    const first = tokens.shift() || '';
    const kv = parseKv(line);
    const code = kv.codigo || kv.code || first;
    const remainingLine = tokens.join(' ').trim();
    return {
        code,
        rest: [remainingLine, rest].filter(Boolean).join('\n').trim(),
        kv,
    };
}

function targetTokensFrom(text, m) {
    const tokens = tokenize(text);
    if (tokens.length) return tokens;
    const quoted = getQuotedParticipant(m);
    if (quoted) return [`id="${normalizeJid(quoted)}"`];
    return [];
}

function activeParticipant(status) {
    return !['removido', 'ausente', 'desistiu'].includes(compact(status));
}

async function canManageOrReply({ sock, idChat, idJogador, m }) {
    if (await canManagePlayer(sock, idChat, idJogador)) return true;
    await sendReply({ sock, idChat, m, text: 'Apenas ADM do grupo ou Owner pode usar essa parte de raid.' });
    return false;
}

function renderHelp() {
    return [
        '*♧┃RAIDS 𖥔 CLOVER MULTICOLOR*',
        '     ── lobby de evento e recompensa em lote ──',
        '',
        '_`─( ✓ )───── Player`_',
        '',
        `*̣${COMMAND_PREFIX}raid listar*`,
        '> Ver raids abertas ou recentes.',
        `*̣${COMMAND_PREFIX}raid entrar codigo*`,
        '> Entrar numa raid aberta.',
        `*̣${COMMAND_PREFIX}raid status codigo*`,
        '> Ver participantes, status e recompensas registradas.',
        `*̣${COMMAND_PREFIX}raid sair codigo*`,
        '> Sair da raid antes da aplicação.',
        '',
        '_`─( ◆ )───── ADM`_',
        '',
        `*̣${COMMAND_PREFIX}raid criar codigo=capital-01 nome="Defesa da Capital" vagas=20 data=2026-06-24*`,
        '> Cria o lobby.',
        `*̣${COMMAND_PREFIX}raid abrir capital-01*`,
        '> Libera entrada de players.',
        `*̣${COMMAND_PREFIX}raid add capital-01 @player*`,
        '> Adiciona participante manualmente.',
        `*̣${COMMAND_PREFIX}raid marcar capital-01 todos presente*`,
        '> Marca todos os inscritos como presentes.',
        `*̣${COMMAND_PREFIX}raid recompensas capital-01*`,
        '> Salva os blocos de recompensa enviados na mesma mensagem.',
        `*̣${COMMAND_PREFIX}raid simular capital-01*`,
        '> Gera CloverScript e mostra o resumo antes de aplicar.',
        `*̣${COMMAND_PREFIX}raid aplicar capital-01*`,
        '> Aplica a simulação conferida.',
    ].join('\n');
}

function renderModel() {
    return [
        '*♧┃MODELO DE RAID 𖥔 CLOVER MULTICOLOR*',
        '     ── copie, ajuste e simule ──',
        '',
        '```txt',
        `${COMMAND_PREFIX}raid criar codigo=capital-01 nome="Defesa da Capital" vagas=20 data=2026-06-24`,
        'PARTICIPANTES',
        '@A',
        '@B',
        'FIM_PARTICIPANTES',
        '',
        'RECOMPENSA base',
        'PH +30 fonte=evento teto=fora motivo="Participação na raid"',
        'YULLS +300 motivo="Pagamento da raid"',
        'FIM_RECOMPENSA',
        '',
        'MVP @A',
        'PH +20 fonte=evento teto=fora motivo="MVP da raid"',
        'ITEM dar nome="Medalha da Raid" qtd=1 tipo=evento motivo="MVP"',
        'FIM_MVP',
        '```',
    ].join('\n');
}

function renderSimple(title, lines = []) {
    return [
        `*♧┃${title} 𖥔 CLOVER MULTICOLOR*`,
        '',
        ...lines.filter(Boolean),
    ].join('\n');
}

async function listRaids(db) {
    await ensureRaidSchema(db);
    return db.all(`
        SELECT r.*,
               COUNT(p.id) AS total_participantes,
               SUM(CASE WHEN p.status NOT IN ('removido', 'ausente', 'desistiu') THEN 1 ELSE 0 END) AS ativos
        FROM clover_raids r
        LEFT JOIN clover_raid_participants p ON p.raid_id = r.id
        WHERE r.status NOT IN ('aplicada', 'cancelada')
        GROUP BY r.id
        ORDER BY r.updated_at DESC, r.id DESC
        LIMIT 12
    `);
}

function renderRaidList(rows) {
    if (!rows.length) {
        return renderSimple('RAIDS', ['> Nenhuma raid aberta ou pendente agora.']);
    }
    return [
        '*♧┃RAIDS 𖥔 CLOVER MULTICOLOR*',
        '     ── abertas e pendentes ──',
        '',
        ...rows.flatMap((raid, index) => [
            `*${index + 1}. ${raid.name}*`,
            `> Código: ${raid.code} | Status: ${raid.status} | Ativos: ${raid.ativos || 0}/${raid.slots || '∞'}`,
        ]),
    ].join('\n');
}

async function handleCreate({ sock, m, idChat, idJogador, db, rest }) {
    const { line, rest: sections } = splitFirstLine(rest);
    const kv = parseKv(line);
    const firstToken = tokenize(line).find((token) => !token.includes('='));
    const result = await createRaid(db, {
        code: kv.codigo || kv.code || firstToken,
        name: kv.nome || kv.name,
        slots: kv.vagas || kv.slots || null,
        eventDate: kv.data || kv.date || null,
        createdBy: idJogador,
    });
    if (!result.ok) {
        await sendReply({ sock, idChat, m, text: renderSimple('RAID RECUSADA', [`> ${result.error}`]) });
        return;
    }

    if (sections) {
        const parsed = await parseRaidLongForm(db, sections, {
            mentions: getMentions(m),
            createdBy: idJogador,
        });
        if (parsed.participants.length) {
            await addParticipants(db, result.raid.code, parsed.participants, { status: 'inscrito' });
        }
        if (parsed.rewards.length) {
            await setRaidRewards(db, result.raid.code, parsed.rewards, idJogador);
        }
    }

    const view = await getRaidView(db, result.raid.code);
    await sendReply({
        sock,
        idChat,
        m,
        mentions: view.participants.map((item) => item.player_id),
        text: renderRaidCreated(result, view),
    });
}

async function handleJoin({ sock, m, idChat, idJogador, db, rest }) {
    const code = tokenize(rest)[0];
    if (!code) {
        await sendReply({ sock, idChat, m, text: renderHelp() });
        return;
    }

    const view = await getRaidView(db, code);
    if (!view) {
        await sendReply({ sock, idChat, m, text: renderSimple('RAID', ['> Raid não encontrada.']) });
        return;
    }
    if (view.raid.status !== 'aberta') {
        await sendReply({ sock, idChat, m, text: renderSimple('RAID FECHADA', ['> Essa raid não está aberta para entrada.']) });
        return;
    }

    const already = view.participants.find((item) => item.player_id === idJogador && activeParticipant(item.status));
    if (already) {
        await sendReply({ sock, idChat, m, text: renderSimple('RAID', ['> Você já está nessa raid.']) });
        return;
    }

    const activeCount = view.participants.filter((item) => activeParticipant(item.status)).length;
    if (view.raid.slots && activeCount >= Number(view.raid.slots)) {
        await sendReply({ sock, idChat, m, text: renderSimple('RAID LOTADA', ['> Não há vaga aberta nessa raid.']) });
        return;
    }

    await addParticipants(db, code, [`id="${idJogador}"`], { status: 'inscrito' });
    await sendReply({
        sock,
        idChat,
        m,
        mentions: [idJogador],
        text: renderSimple('RAID', [
            `*Raid:* ${view.raid.name}`,
            `*Player:* ${formatMention(idJogador)}`,
            '> Entrada registrada.',
        ]),
    });
}

async function handleLeave({ sock, m, idChat, idJogador, db, rest }) {
    const code = tokenize(rest)[0];
    if (!code) {
        await sendReply({ sock, idChat, m, text: renderHelp() });
        return;
    }
    const result = await markParticipants(db, code, [`id="${idJogador}"`], 'desistiu');
    if (!result.ok) {
        await sendReply({ sock, idChat, m, text: renderSimple('RAID', [`> ${result.error}`]) });
        return;
    }
    await sendReply({ sock, idChat, m, text: renderSimple('RAID', ['> Saída registrada.']) });
}

async function handleRewards({ sock, m, idChat, idJogador, db, rest }) {
    const { code, rest: rewardText } = extractCodeAndRest(rest);
    if (!code || !rewardText) {
        await sendReply({ sock, idChat, m, text: renderModel() });
        return;
    }
    const parsed = await parseRaidLongForm(db, rewardText, {
        mentions: getMentions(m),
        createdBy: idJogador,
    });
    if (!parsed.rewards.length) {
        await sendReply({ sock, idChat, m, text: renderSimple('RAID', ['> Nenhum bloco de recompensa encontrado.']) });
        return;
    }
    const result = await setRaidRewards(db, code, parsed.rewards, idJogador);
    if (!result.ok) {
        await sendReply({ sock, idChat, m, text: renderSimple('RAID', [`> ${result.error}`]) });
        return;
    }
    await sendReply({
        sock,
        idChat,
        m,
        text: renderSimple('RECOMPENSAS DE RAID', [
            `*Raid:* ${code}`,
            `*Blocos salvos:* ${result.count}`,
            '> Use simular antes de aplicar.',
        ]),
    });
}

function parseMark(rest) {
    const { code, rest: markText } = extractCodeAndRest(rest);
    const tokens = tokenize(markText);
    if (!tokens.length) return { code, targets: ['todos'], status: 'presente' };

    const first = compact(tokens[0]);
    const last = compact(tokens[tokens.length - 1]);
    if (PARTICIPANT_STATUSES.has(first)) {
        return { code, targets: tokens.slice(1), status: first };
    }
    if (PARTICIPANT_STATUSES.has(last)) {
        return { code, targets: tokens.slice(0, -1), status: last };
    }
    return { code, targets: tokens, status: 'presente' };
}

async function sendGeneratedScript({ sock, m, idChat, db, code }) {
    const generated = await generateRaidScript(db, code);
    if (!generated.ok) {
        await sendReply({ sock, idChat, m, text: renderSimple('RAID', [`> ${generated.error}`]) });
        return;
    }
    const script = generated.script || '';
    const safeScript = script.length > 3200 ? `${script.slice(0, 3200)}\n// ...cortado para caber na mensagem` : script;
    await sendReply({
        sock,
        idChat,
        m,
        text: [
            '*♧┃CLOVERSCRIPT DA RAID 𖥔 CLOVER MULTICOLOR*',
            '',
            '```txt',
            safeScript || '// Nenhuma ação gerada.',
            '```',
        ].join('\n'),
    });
}

module.exports = {
    nome: `${COMMAND_PREFIX}raid`,
    aliases: [
        `${COMMAND_PREFIX}raids`,
        `${COMMAND_PREFIX}evento`,
        `${COMMAND_PREFIX}eventos`,
    ],
    descricao: 'Cria lobbies de evento e aplica recompensas por CloverScript.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const { action: rawAction, rest } = splitAction(body);
        const action = normalizeAction(rawAction);

        try {
            if (!action || action === 'help') {
                await sendReply({ sock, idChat, m, text: renderHelp() });
                return;
            }

            if (action === 'model') {
                await sendReply({ sock, idChat, m, text: renderModel() });
                return;
            }

            if (action === 'list') {
                await sendReply({ sock, idChat, m, text: renderRaidList(await listRaids(db)) });
                return;
            }

            if (action === 'status') {
                const code = tokenize(rest)[0];
                if (!code) {
                    await sendReply({ sock, idChat, m, text: renderRaidList(await listRaids(db)) });
                    return;
                }
                const view = await getRaidView(db, code);
                await sendReply({
                    sock,
                    idChat,
                    m,
                    mentions: view?.participants?.map((item) => item.player_id) || [],
                    text: renderRaidView(view),
                });
                return;
            }

            if (action === 'join') {
                await handleJoin({ sock, m, idChat, idJogador, db, rest });
                return;
            }

            if (action === 'leave') {
                await handleLeave({ sock, m, idChat, idJogador, db, rest });
                return;
            }

            if (!await canManageOrReply({ sock, idChat, idJogador, m })) return;

            if (action === 'create') {
                await handleCreate({ sock, m, idChat, idJogador, db, rest });
                return;
            }

            if (action === 'open' || action === 'close' || action === 'review' || action === 'cancel') {
                const code = tokenize(rest)[0];
                const nextStatus = {
                    open: 'aberta',
                    close: 'fechada',
                    review: 'avaliacao',
                    cancel: 'cancelada',
                }[action];
                const result = await updateRaidStatus(db, code, nextStatus);
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: result.ok
                        ? renderSimple('RAID ATUALIZADA', [`*Raid:* ${result.raid.code}`, `*Status:* ${result.raid.status}`])
                        : renderSimple('RAID', [`> ${result.error}`]),
                });
                return;
            }

            if (action === 'add') {
                const { code, rest: targetText } = extractCodeAndRest(rest);
                const tokens = targetTokensFrom(targetText, m);
                if (!code || !tokens.length) {
                    await sendReply({ sock, idChat, m, text: `Use: *${COMMAND_PREFIX}raid add codigo @player*` });
                    return;
                }
                const result = await addParticipants(db, code, tokens, { mentions: getMentions(m), status: 'inscrito' });
                await sendReply({
                    sock,
                    idChat,
                    m,
                    mentions: result.added?.map((player) => player.id) || [],
                    text: result.ok
                        ? renderSimple('RAID', [`*Adicionados:* ${result.added.length}`])
                        : renderSimple('RAID', [`> ${result.error}`]),
                });
                return;
            }

            if (action === 'remove') {
                const { code, rest: targetText } = extractCodeAndRest(rest);
                const tokens = targetTokensFrom(targetText, m);
                if (!code || !tokens.length) {
                    await sendReply({ sock, idChat, m, text: `Use: *${COMMAND_PREFIX}raid remover codigo @player*` });
                    return;
                }
                const result = await removeParticipant(db, code, tokens[0], { mentions: getMentions(m) });
                await sendReply({
                    sock,
                    idChat,
                    m,
                    mentions: result.player?.id ? [result.player.id] : [],
                    text: result.ok
                        ? renderSimple('RAID', [`*Removido:* ${formatMention(result.player.id)}`])
                        : renderSimple('RAID', [`> ${result.error}`]),
                });
                return;
            }

            if (action === 'mark') {
                const parsed = parseMark(rest);
                const tokens = parsed.targets.length ? parsed.targets : ['todos'];
                const result = await markParticipants(db, parsed.code, tokens, parsed.status, { mentions: getMentions(m) });
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: result.ok
                        ? renderSimple('RAID', [`*Marcados:* ${result.count}`, `*Status:* ${result.status}`])
                        : renderSimple('RAID', [`> ${result.error}`]),
                });
                return;
            }

            if (action === 'rewards') {
                await handleRewards({ sock, m, idChat, idJogador, db, rest });
                return;
            }

            if (action === 'script') {
                await sendGeneratedScript({ sock, m, idChat, db, code: tokenize(rest)[0] });
                return;
            }

            if (action === 'simulate') {
                const result = await simulateRaidRewards(db, tokenize(rest)[0], {
                    actorId: idJogador,
                    chatId: idChat,
                });
                await sendReply({
                    sock,
                    idChat,
                    m,
                    mentions: result.plan?.blocks?.flatMap((block) => block.targets.map((target) => target.id)) || [],
                    text: result.ok ? result.text : renderSimple('RAID', [`> ${result.error}`]),
                });
                return;
            }

            if (action === 'apply') {
                const result = await applyRaidRewards(db, tokenize(rest)[0], {
                    actorId: idJogador,
                    chatId: idChat,
                    sock,
                });
                await sendReply({
                    sock,
                    idChat,
                    m,
                    text: result.text || renderSimple('RAID', [`> ${result.error || 'Não consegui aplicar.'}`]),
                });
            }
        } catch (error) {
            await sendReply({
                sock,
                idChat,
                m,
                text: renderSimple('RAID RECUSADA', [`> ${error?.message || String(error)}`]),
            });
        }
    },
};
