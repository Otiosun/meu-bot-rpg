const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const {
    formatMention,
    getMentions,
    getQuotedParticipant,
    jidFromToken,
    stripMentionTokens,
} = require('../helpers/clover/commandTargetUtils');
const { getCanonicalPlayer } = require('../helpers/clover/targetResolver');
const {
    SERVICE_WEIGHTS,
    WEEKLY_COMMON_PH_LIMIT,
    addManualServicePoints,
    getCommonPhUsedThisWeek,
    getEvaluatorPendingWeeks,
    getEvaluatorsWithPending,
    getServiceSummary,
    getWeeklyServiceRanking,
    listServiceWeeks,
    listRecentServiceEntries,
    normalizeWeekInput,
    payService,
    resolveServiceEvaluatorId,
    syncExistingEvaluations,
} = require('../helpers/clover/adminService');

function normalizeToken(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function parseKeyValues(text) {
    const kv = {};
    const regex = /([A-Za-z0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    while ((match = regex.exec(String(text || '')))) {
        const key = normalizeToken(match[1]);
        const value = String(match[2] || '').trim().replace(/^["']|["']$/g, '');
        if (key) kv[key] = value;
    }
    return kv;
}

function splitAction(body) {
    const text = String(body || '').trim();
    if (!text) return { action: 'status', rest: '' };
    const [first, ...rest] = text.split(/\s+/);
    const action = normalizeToken(first);
    const known = {
        status: 'status',
        saldo: 'status',
        meu: 'status',
        meus: 'status',
        historico: 'history',
        hist: 'history',
        semanas: 'weeks',
        semanaadm: 'weeks',
        extrato: 'weeks',
        semana: 'week',
        ranking: 'week',
        config: 'config',
        pesos: 'config',
        pagar: 'pay',
        pagamento: 'pay',
        resgatar: 'redeem',
        usar: 'redeem',
        sacar: 'redeem',
        receber: 'redeem',
        bonus: 'bonus',
        bônus: 'bonus',
        ajustar: 'adjust',
        ajuste: 'adjust',
        sincronizar: 'sync',
        sync: 'sync',
        importar: 'sync',
        ajuda: 'help',
    };
    if (!known[action]) return { action: 'status', rest: text };
    return { action: known[action], rest: rest.join(' ').trim() };
}

function firstInteger(text) {
    const match = String(text || '').match(/(?:^|\s)([+-]?\d+)(?=\s|$)/);
    return match ? Number(match[1]) : null;
}

function removeFirstInteger(text) {
    return String(text || '').replace(/(?:^|\s)[+-]?\d+(?=\s|$)/, ' ').replace(/\s+/g, ' ').trim();
}

function cleanReason(text) {
    return String(text || '')
        .replace(/([A-Za-z0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseRequestedPoints(rest, kv = {}) {
    const raw = kv.pa || kv.ph || kv.qtd || kv.quantia || kv.valor || kv.pontos || null;
    const fromKv = raw !== null ? Number(raw) : null;
    if (Number.isInteger(fromKv) && fromKv > 0) return fromKv;

    const number = firstInteger(rest);
    if (Number.isInteger(number) && number > 0) return number;

    return null;
}

function renderTitle(subtitle = 'controle de avaliacao') {
    return [
        '*♧┃SERVIÇO ADM 𖥔 CLOVER MULTICOLOR*',
        `     ── ${subtitle} ──`,
    ];
}

function formatShortDate(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!match) return text || '-';
    return `${match[3]}/${match[2]} ${match[4]}:${match[5]}`;
}

function formatEvaluatorName(player, evaluatorId) {
    return player?.personagem_nome
        || player?.display_name
        || player?.nome
        || formatMention(evaluatorId);
}

async function getEvaluatorLabel(db, evaluatorId) {
    const player = await getCanonicalPlayer(db, evaluatorId).catch(() => null);
    return {
        player,
        label: formatEvaluatorName(player, evaluatorId),
    };
}

function isTodos(rest) {
    return ['todos', 'todas', 'all'].includes(normalizeToken(String(rest || '').split(/\s+/)[0]));
}

async function resolveServiceTarget(db, rest, m, fallbackId, { allowTextTarget = true } = {}) {
    const mentions = getMentions(m);
    if (mentions.length) {
        return {
            targetId: await resolveServiceEvaluatorId(db, mentions[0]),
            rest: stripMentionTokens(rest),
            source: 'mention',
        };
    }

    const quoted = getQuotedParticipant(m);
    if (quoted && !String(rest || '').trim()) {
        return {
            targetId: await resolveServiceEvaluatorId(db, quoted),
            rest: '',
            source: 'quote',
        };
    }

    const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
    if (allowTextTarget && parts.length) {
        const rawTarget = parts[0];
        const targetId = jidFromToken(rawTarget);
        if (targetId) {
            return {
                targetId: await resolveServiceEvaluatorId(db, targetId),
                rest: parts.slice(1).join(' ').trim(),
                source: 'body',
            };
        }
    }

    return {
        targetId: await resolveServiceEvaluatorId(db, fallbackId),
        rest: String(rest || '').trim(),
        source: 'self',
    };
}

function renderUsage(owner = false) {
    const lines = [
        ...renderTitle('comandos curtos'),
        '',
        '_`─( ✓ )───── ADM`_',
        '',
        `*${COMMAND_PREFIX}servico*`,
        '> Ver seus PA pendentes e pagos.',
        `*${COMMAND_PREFIX}servico semanas*`,
        '> Ver PA separado por semana e teto disponível.',
        `*${COMMAND_PREFIX}servico resgatar*`,
        '> Usa seus PA até completar o teto semanal atual.',
        `*${COMMAND_PREFIX}servico resgatar 10*`,
        '> Usa uma quantia específica de PA.',
        `*${COMMAND_PREFIX}servico resgatar semana=2026-06-22*`,
        '> Usa PA atrasado naquela semana, respeitando o teto dela.',
        `*${COMMAND_PREFIX}servico historico*`,
        '> Ver seus registros recentes.',
    ];

    if (owner) {
        lines.push(
            '',
            '_`─( ◆ )───── Dono`_',
            '',
            `*${COMMAND_PREFIX}servico status @adm*`,
            '> Ver saldo de um avaliador.',
            `*${COMMAND_PREFIX}servico semana*`,
            '> Ver ranking da semana atual.',
            `*${COMMAND_PREFIX}servico pagar @adm*`,
            '> Paga PA como PH dentro do teto semanal.',
            `*${COMMAND_PREFIX}servico pagar @adm semana=2026-06-22*`,
            '> Paga PA atrasado usando o teto da semana escolhida.',
            `*${COMMAND_PREFIX}servico pagar todos*`,
            '> Paga todos os avaliadores por semanas pendentes.',
            `*${COMMAND_PREFIX}servico bonus @adm 5 motivo*`,
            '> Adiciona PA manual.',
            `*${COMMAND_PREFIX}servico ajustar @adm -3 motivo*`,
            '> Remove PA pendente manualmente.',
            `*${COMMAND_PREFIX}servico sincronizar semana=2026-06-22*`,
            '> Importa avaliações antigas sem duplicar.'
        );
    }

    return lines.join('\n');
}

async function renderStatus(db, evaluatorId, { includeHistory = false } = {}) {
    const summary = await getServiceSummary(db, evaluatorId);
    const { label, player } = await getEvaluatorLabel(db, evaluatorId);
    const lines = [
        ...renderTitle('saldo de servico'),
        '',
        '_`─( ✓ )───── Avaliador`_',
        '',
        `*Nome:* ${label}`,
        `*Alvo:* ${formatMention(evaluatorId)}`,
        player && player.id !== evaluatorId ? `*Personagem:* ${formatEvaluatorName(player, evaluatorId)}` : null,
        '',
        '_`─( ✦ )───── Pontos`_',
        '',
        `*PA pendente:* ${summary.pendingPoints}`,
        `*PA total registrado:* ${summary.earnedPoints}`,
        `*PH pago por serviço:* ${summary.phPaid}`,
        `*Avaliações contadas:* ${summary.evaluations}`,
        '',
        '_`─( ! )───── Regra`_',
        '',
        `> 1 PA vira 1 PH, mas só até o teto semanal de ${WEEKLY_COMMON_PH_LIMIT} PH comuns.`,
        '> Se não houver personagem vinculado, o PA fica guardado.',
    ].filter(Boolean);

    if (includeHistory) {
        const entries = await listRecentServiceEntries(db, evaluatorId, 8);
        lines.push('', '_`─( ◆ )───── Histórico`_', '');
        if (!entries.length) {
            lines.push('> Nenhum registro ainda.');
        } else {
            for (const entry of entries) {
                const open = Math.max(0, Number(entry.points || 0) - Number(entry.paid_points || 0));
                lines.push(
                    `*#${entry.id} · ${entry.modality_label}:* ${entry.points} PA`,
                    `> Aberto: ${open} · ${formatShortDate(entry.created_at)}`
                );
            }
        }
    }

    return lines.join('\n');
}

async function renderWeeks(db, evaluatorId) {
    const weeks = await listServiceWeeks(db, evaluatorId, { limit: 10 });
    const { label, player } = await getEvaluatorLabel(db, evaluatorId);
    const lines = [
        ...renderTitle('semanas de PA'),
        '',
        '_`─( ✓ )───── Avaliador`_',
        '',
        `*Nome:* ${label}`,
        `*Alvo:* ${formatMention(evaluatorId)}`,
        '',
        '_`─( ◆ )───── Semanas`_',
        '',
    ];

    if (!weeks.length) {
        lines.push('> Nenhum PA registrado ainda.');
        return lines.join('\n');
    }

    for (const week of weeks) {
        let capLine = 'teto indisponível';
        if (player?.id) {
            const used = await getCommonPhUsedThisWeek(db, player.id, week.weekKey);
            const remaining = Math.max(0, WEEKLY_COMMON_PH_LIMIT - used);
            capLine = `${used}/${WEEKLY_COMMON_PH_LIMIT} PH usados · cabe ${remaining}`;
        }
        lines.push(`*Semana ${week.weekKey}:* ${week.pendingPoints} PA pendente`);
        lines.push(`> Ganho: ${week.earnedPoints} · Pago: ${week.pointsPaid} · Avaliações: ${week.evaluations}`);
        lines.push(`> Teto da semana: ${capLine}`);
    }

    lines.push(
        '',
        '_`─( ✦ )───── Uso`_',
        '',
        `> ${COMMAND_PREFIX}servico resgatar semana=AAAA-MM-DD`,
        '> Sem semana, o resgate usa a semana atual.'
    );

    return lines.join('\n');
}

function renderConfig() {
    const groups = [
        ['Peso 1', ['treino_solo', 'cena_vinculo', 'missao_auto_narrada', 'diario']],
        ['Peso 2', ['cena_interativa', 'treino_duo', 'cena_consequencia']],
        ['Peso 3', ['spin_off']],
        ['Peso 4', ['missao_desenvolvimento']],
    ];
    const labels = {
        treino_solo: 'Treino Solo',
        cena_vinculo: 'Cena de Vínculo',
        missao_auto_narrada: 'Missão Auto-Narrada',
        diario: 'Diário',
        cena_interativa: 'Cena Interativa',
        treino_duo: 'Treino Duo',
        cena_consequencia: 'Cena de Consequência',
        spin_off: 'Spin-Off',
        missao_desenvolvimento: 'Missão de Desenvolvimento',
    };

    const lines = [
        ...renderTitle('pesos atuais'),
        '',
    ];
    for (const [title, keys] of groups) {
        const first = SERVICE_WEIGHTS[keys[0]];
        lines.push(`*${title}:* ${first.points} PA`);
        lines.push(`> ${keys.map((key) => labels[key] || key).join(', ')}`);
    }
    lines.push('', '*Outro:* não gera PA automático.');
    return lines.join('\n');
}

async function renderWeek(db, weekKey) {
    const rows = await getWeeklyServiceRanking(db, weekKey);
    const lines = [
        ...renderTitle('semana de servico'),
        '',
        `*Semana:* ${weekKey}`,
        '',
        '_`─( ★ )───── Ranking`_',
        '',
    ];
    if (!rows.length) {
        lines.push('> Nenhum serviço registrado nessa semana.');
        return lines.join('\n');
    }
    let index = 1;
    for (const row of rows.slice(0, 15)) {
        const { label } = await getEvaluatorLabel(db, row.evaluator_id);
        lines.push(`*${index}. ${label}:* ${row.points} PA`);
        lines.push(`> Avaliações: ${row.evaluations}`);
        index += 1;
    }
    return lines.join('\n');
}

function renderPayResult(result) {
    if (result.ok) {
        return [
            ...renderTitle('pagamento aplicado'),
            '',
            `*Avaliador:* ${formatMention(result.evaluatorId)}`,
            `*Personagem:* ${formatEvaluatorName(result.player, result.player.id)}`,
            `*PA pago:* ${result.pointsPaid}`,
            `*PH entregue:* ${result.phPaid}`,
            `*Semana do teto:* ${result.weekKey}`,
            '',
            `> Antes do pagamento, já havia ${result.usedThisWeek}/${WEEKLY_COMMON_PH_LIMIT} PH comuns na semana.`,
        ].join('\n');
    }

    const reason = {
        no_pending: 'Não há PA pendente para pagar.',
        no_player: 'Esse avaliador ainda não tem cadastro encontrado. O PA continua guardado.',
        no_character: 'Esse avaliador ainda não tem personagem vinculado. O PA continua guardado.',
        weekly_cap: 'O teto semanal já foi atingido. O PA continua guardado.',
    }[result.code] || 'Pagamento não aplicado.';

    return [
        ...renderTitle('pagamento pendente'),
        '',
        `*Motivo:* ${reason}`,
        result.weekKey ? `*Semana:* ${result.weekKey}` : null,
        result.usedThisWeek !== undefined ? `*PH comum usado:* ${result.usedThisWeek}/${WEEKLY_COMMON_PH_LIMIT}` : null,
    ].filter(Boolean).join('\n');
}

function renderBulkPay(results) {
    const paid = results.filter((item) => item.ok);
    const held = results.filter((item) => !item.ok);
    const totalPh = paid.reduce((sum, item) => sum + Number(item.phPaid || 0), 0);
    const totalPoints = paid.reduce((sum, item) => sum + Number(item.pointsPaid || 0), 0);
    const lines = [
        ...renderTitle('pagamento em lote'),
        '',
        `*Pagos:* ${paid.length}`,
        `*Pendentes:* ${held.length}`,
        `*PA pago:* ${totalPoints}`,
        `*PH entregue:* ${totalPh}`,
    ];
    if (paid.length) {
        lines.push('', '_`─( ✓ )───── Aplicados`_', '');
        for (const item of paid.slice(0, 8)) {
            lines.push(`> ${formatMention(item.evaluatorId)} · ${item.phPaid} PH`);
        }
    }
    if (held.length) {
        lines.push('', '_`─( ! )───── Guardados`_', '');
        for (const item of held.slice(0, 8)) {
            lines.push(`> ${formatMention(item.evaluatorId)} · ${item.code}`);
        }
    }
    return lines.join('\n');
}

module.exports = {
    nome: `${COMMAND_PREFIX}servico`,
    aliases: [
        `${COMMAND_PREFIX}serviço`,
        `${COMMAND_PREFIX}pa`,
        `${COMMAND_PREFIX}salarioadm`,
        `${COMMAND_PREFIX}salárioadm`,
        `${COMMAND_PREFIX}servicoadm`,
        `${COMMAND_PREFIX}serviçoadm`,
    ],
    descricao: 'Mostra e gerencia PA de servico dos avaliadores.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        const owner = isOwner(idJogador);
        const { action, rest } = splitAction(body);

        if (action === 'help') {
            await sendReply({ sock, idChat, m, text: renderUsage(owner) });
            return;
        }

        if (action === 'config') {
            await sendReply({ sock, idChat, m, text: renderConfig() });
            return;
        }

        if (action === 'weeks') {
            const target = owner
                ? await resolveServiceTarget(db, rest, m, idJogador)
                : { targetId: await resolveServiceEvaluatorId(db, idJogador), rest: '', source: 'self' };
            await sendReply({ sock, idChat, m, text: await renderWeeks(db, target.targetId) });
            return;
        }

        if (action === 'week') {
            if (!owner) {
                await sendReply({ sock, idChat, m, text: 'Apenas o dono pode ver o resumo geral de serviço ADM.' });
                return;
            }
            const kv = parseKeyValues(rest);
            const weekKey = normalizeWeekInput(kv.semana || kv.week || rest);
            await sendReply({ sock, idChat, m, text: await renderWeek(db, weekKey) });
            return;
        }

        if (action === 'sync') {
            if (!owner) {
                await sendReply({ sock, idChat, m, text: 'Apenas o dono pode sincronizar serviço ADM antigo.' });
                return;
            }
            const kv = parseKeyValues(rest);
            const weekKey = kv.semana || kv.week ? normalizeWeekInput(kv.semana || kv.week) : null;
            const result = await syncExistingEvaluations(db, { weekKey });
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    ...renderTitle('sincronizacao concluida'),
                    '',
                    `*Avaliações lidas:* ${result.checked}`,
                    `*Registros criados:* ${result.inserted}`,
                    `*Ignorados:* ${result.skipped}`,
                    weekKey ? `*Semana:* ${weekKey}` : '*Semana:* todas',
                ].join('\n'),
            });
            return;
        }

        if (action === 'redeem') {
            const kv = parseKeyValues(rest);
            const weekKey = kv.semana || kv.week ? normalizeWeekInput(kv.semana || kv.week) : null;
            const points = parseRequestedPoints(rest, kv);
            const evaluatorId = await resolveServiceEvaluatorId(db, idJogador);
            const result = await payService(db, evaluatorId, {
                createdBy: idJogador,
                reason: cleanReason(rest) || 'Resgate de PA de avaliador',
                weekKey,
                points,
            });
            await sendReply({ sock, idChat, m, text: renderPayResult({ ...result, evaluatorId }) });
            return;
        }

        if (action === 'pay') {
            if (!owner) {
                await sendReply({ sock, idChat, m, text: 'Apenas o dono pode pagar serviço ADM.' });
                return;
            }
            const payKv = parseKeyValues(rest);
            const forcedWeek = payKv.semana || payKv.week ? normalizeWeekInput(payKv.semana || payKv.week) : null;
            const forcedPoints = parseRequestedPoints(rest, payKv);
            if (isTodos(rest)) {
                const rows = await getEvaluatorsWithPending(db);
                const results = [];
                for (const row of rows) {
                    if (forcedWeek) {
                        results.push(await payService(db, row.evaluator_id, {
                            createdBy: idJogador,
                            reason: 'Pagamento de servico ADM',
                            weekKey: forcedWeek,
                            points: forcedPoints,
                        }));
                        continue;
                    }

                    const weeks = await getEvaluatorPendingWeeks(db, row.evaluator_id);
                    if (!weeks.length) {
                        results.push(await payService(db, row.evaluator_id, {
                            createdBy: idJogador,
                            reason: 'Pagamento de servico ADM',
                            points: forcedPoints,
                        }));
                        continue;
                    }

                    for (const week of weeks) {
                        results.push(await payService(db, row.evaluator_id, {
                            createdBy: idJogador,
                            reason: 'Pagamento de servico ADM',
                            weekKey: week.week_key,
                            points: forcedPoints,
                        }));
                    }
                }
                await sendReply({ sock, idChat, m, text: renderBulkPay(results) });
                return;
            }
            const target = await resolveServiceTarget(db, rest, m, idJogador);
            const targetKv = parseKeyValues(target.rest);
            const weekKey = targetKv.semana || targetKv.week ? normalizeWeekInput(targetKv.semana || targetKv.week) : null;
            const points = parseRequestedPoints(target.rest, targetKv);
            const result = await payService(db, target.targetId, {
                createdBy: idJogador,
                reason: cleanReason(target.rest) || 'Pagamento de servico ADM',
                weekKey,
                points,
            });
            await sendReply({ sock, idChat, m, text: renderPayResult({ ...result, evaluatorId: target.targetId }) });
            return;
        }

        if (action === 'bonus' || action === 'adjust') {
            if (!owner) {
                await sendReply({ sock, idChat, m, text: 'Apenas o dono pode ajustar PA de serviço ADM.' });
                return;
            }
            const target = await resolveServiceTarget(db, rest, m, idJogador);
            const amount = firstInteger(target.rest);
            if (!Number.isInteger(amount) || amount === 0) {
                await sendReply({ sock, idChat, m, text: renderUsage(owner) });
                return;
            }
            const reason = cleanReason(removeFirstInteger(target.rest));
            if (!reason || reason.length < 3) {
                await sendReply({ sock, idChat, m, text: 'Informe um motivo curto para o ajuste de PA.' });
                return;
            }
            const result = await addManualServicePoints(db, target.targetId, {
                points: amount,
                createdBy: idJogador,
                reason,
                source: action === 'bonus' ? 'manual_bonus' : 'manual_adjustment',
            });
            await sendReply({
                sock,
                idChat,
                m,
                text: [
                    ...renderTitle('ajuste registrado'),
                    '',
                    `*Avaliador:* ${formatMention(target.targetId)}`,
                    `*Resultado:* ${result.code}`,
                    `*PA:* ${result.points || amount}`,
                    `*Motivo:* ${reason}`,
                ].join('\n'),
            });
            return;
        }

        const target = owner
            ? await resolveServiceTarget(db, rest, m, idJogador)
            : { targetId: await resolveServiceEvaluatorId(db, idJogador), rest: '', source: 'self' };
        const includeHistory = action === 'history';
        await sendReply({
            sock,
            idChat,
            m,
            text: await renderStatus(db, target.targetId, { includeHistory }),
        });
    },
};
