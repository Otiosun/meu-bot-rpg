'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const {
    canManagePlayer,
    getMentions,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const { ensureRecruitmentCode } = require('../helpers/clover/recruitmentService');
const {
    PerformanceTeamServiceError,
    addMemberToTeam,
    approveProtectedAbsence,
    closePerformanceCycle,
    closeWeekPreview,
    confirmMembership,
    createCycle,
    createManualTeam,
    displayName,
    generateTeamsFromSignups,
    getCycleSummary,
    getMyTeam,
    getTeamByNameOrId,
    getTeamHistory,
    isPerformanceMonitor,
    joinCycle,
    listEligiblePlayers,
    publishDraw,
    recordRecruitAction,
    removeMember,
    requestProtectedAbsence,
    setRepresentative,
    setTeamMonitor,
} = require('../helpers/clover/performanceTeamService');
const { normalizeText } = require('../helpers/textUtils');

const TITLE = '*♧┃𝐓𝐈𝐌𝐄𝐒 𝐃𝐄 𝐏𝐄𝐑𝐅𝐎𝐑𝐌𝐀𝐍𝐂𝐄 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*';
const ADMIN_ACTIONS = new Set([
    'ciclo',
    'elegiveis',
    'elegíveis',
    'sortear',
    'publicar',
    'criar',
    'adicionar',
    'remover',
    'transferir',
    'substituir',
    'representante',
    'monitor',
    'validar',
    'invalidar',
    'fechar',
    'ausencia',
]);

function cleanAction(value) {
    return normalizeText(value || '').replace(/[^a-z0-9]+/g, '');
}

function splitBody(body) {
    return String(body || '').trim().split(/\s+/).filter(Boolean);
}

function renderCommands() {
    return [
        TITLE,
        '',
        '*Player*',
        `> ${COMMAND_PREFIX}times (ver sistema e times ativos)`,
        `> ${COMMAND_PREFIX}times comandos (ver esta lista)`,
        `> ${COMMAND_PREFIX}times participar (entrar na lista do próximo ciclo)`,
        `> ${COMMAND_PREFIX}time confirmar (confirmar vaga sorteada)`,
        `> ${COMMAND_PREFIX}meutime (ver seu time e progresso)`,
        `> ${COMMAND_PREFIX}time convite (ver seu código de convite)`,
        `> ${COMMAND_PREFIX}time recrutas (ver progresso de recrutamento do time)`,
        `> ${COMMAND_PREFIX}time acolhi <player> (registrar acolhimento de recruta)`,
        `> ${COMMAND_PREFIX}time ausencia <motivo> (pedir ausência protegida)`,
        `> ${COMMAND_PREFIX}time historico (ver histórico do ciclo)`,
        '',
        '*Representante*',
        `> ${COMMAND_PREFIX}time painel (painel do representante)`,
        `> ${COMMAND_PREFIX}time lembrar (lembrete neutro do time)`,
        `> ${COMMAND_PREFIX}time avisar monitor <texto> (avisar monitor)`,
        '',
        '*Monitor/ADM*',
        `> ${COMMAND_PREFIX}times ciclo criar <nome> (criar ciclo)`,
        `> ${COMMAND_PREFIX}times ciclo fechar (encerrar ciclo aberto)`,
        `> ${COMMAND_PREFIX}times elegiveis (listar novatos elegíveis)`,
        `> ${COMMAND_PREFIX}times sortear (gerar times sugeridos)`,
        `> ${COMMAND_PREFIX}times publicar sorteio (abrir confirmação)`,
        `> ${COMMAND_PREFIX}time criar <nome> (criar time manual)`,
        `> ${COMMAND_PREFIX}time adicionar <player> <time> (adicionar membro)`,
        `> ${COMMAND_PREFIX}time remover <player> <motivo> (remover membro)`,
        `> ${COMMAND_PREFIX}time transferir <player> <time> (mover player)`,
        `> ${COMMAND_PREFIX}time substituir <antigo> <novo> (trocar membro)`,
        `> ${COMMAND_PREFIX}time representante <player> (definir representante)`,
        `> ${COMMAND_PREFIX}time monitor <player> (definir monitor)`,
        `> ${COMMAND_PREFIX}time ausencia aprovar <player> (aprovar ausência protegida)`,
        `> ${COMMAND_PREFIX}time validar recruta <player> (validar acolhimento)`,
        `> ${COMMAND_PREFIX}time invalidar recruta <player> (invalidar acolhimento)`,
        `> ${COMMAND_PREFIX}time fechar semana <time> (prévia de recompensas)`,
        `> ${COMMAND_PREFIX}time fechar ciclo (encerrar ciclo aberto)`,
        '',
        '_Obs.: participação e vagas são exclusivas para novatos com jogo liberado e sem esquadrão._',
    ].join('\n');
}

function renderSystem(summary) {
    const cycle = summary.cycle;
    const lines = [
        TITLE,
        '',
        '*Essência:* times temporários para novatos sem esquadrão.',
        '*Ciclo:* 4 semanas · 4 players · 1 monitor fora das vagas.',
        '*Missão semanal:* recrutar/acolher 2 players ativos via código.',
        '*Meta fixa:* bater o teto semanal de PH.',
        '*Meta mensal:* concluir Arco Pessoal.',
        '',
        cycle
            ? `*Ciclo atual:* ${cycle.name} · ${cycle.status}`
            : '*Ciclo atual:* nenhum ciclo aberto.',
    ];
    if (summary.teams.length) {
        lines.push('', '*Times ativos:*');
        for (const team of summary.teams) {
            const members = team.members
                .filter((member) => ['pending', 'confirmed', 'active', 'absence_requested', 'protected_absence'].includes(member.status))
                .map((member) => displayName(member))
                .join(', ') || '-';
            lines.push(`> #${team.id} ${team.name} · ${team.status} · ${members}`);
            lines.push(`> Recrutas semanais: ${team.progress.validatedRecruits}/${team.progress.target}`);
        }
    }
    lines.push('', `Use *${COMMAND_PREFIX}times comandos* para ver a lista completa.`);
    return lines.join('\n');
}

function formatMemberStatus(status) {
    if (status === 'protected_absence') return 'ausência protegida';
    if (status === 'absence_requested') return 'ausência solicitada';
    if (status === 'pending') return 'pendente';
    if (status === 'confirmed') return 'confirmado';
    if (status === 'active') return 'ativo';
    if (status === 'removed') return 'removido';
    if (status === 'transferred') return 'transferido';
    return status || '-';
}

function renderMyTeam(result) {
    if (!result.membership) {
        return [
            TITLE,
            '',
            'Você ainda não está em um Time de Performance ativo.',
            `Use *${COMMAND_PREFIX}times participar* quando houver ciclo aberto.`,
        ].join('\n');
    }
    const team = result.team;
    const progress = result.progress;
    const lines = [
        TITLE,
        '',
        `*Seu time:* #${team.id} ${team.name}`,
        `*Status:* ${team.status}`,
        `*Sua vaga:* ${formatMemberStatus(result.membership.status)}`,
        `*Prestígio:* ${team.prestige}`,
        `*Recrutas da semana:* ${progress.validatedRecruits}/${progress.target}`,
        `*Validados por código:* ${progress.systemValidatedRecruits}`,
        `*Validados pela monitoria:* ${progress.manualValidatedRecruits}`,
        `*Acolhimentos registrados:* ${progress.welcomed}`,
        '',
        '*Membros:*',
    ];
    for (const member of result.members) {
        const role = member.role === 'representative' ? 'Representante' : 'Membro';
        lines.push(`> ${displayName(member)} · ${role} · ${formatMemberStatus(member.status)}`);
    }
    return lines.join('\n');
}

function renderTeamHistory(result, history) {
    if (!result.membership) return renderMyTeam(result);
    const lines = [
        TITLE,
        '',
        `*Histórico:* #${result.team.id} ${result.team.name}`,
    ];
    if (!history.length) {
        lines.push('> Nenhum fechamento semanal registrado ainda.');
    } else {
        for (const row of history) {
            lines.push(`> ${row.week_key} · ${row.status} · ${row.validated_recruits}/2 recrutas · ${row.eligible_members} elegíveis`);
        }
    }
    return lines.join('\n');
}

function renderEligible(players) {
    const lines = [TITLE, '', `*Novatos elegíveis:* ${players.length}`];
    for (const player of players.slice(0, 40)) {
        lines.push(`> ${displayName(player)} · ${player.id}`);
    }
    if (players.length > 40) lines.push(`> ... +${players.length - 40}`);
    return lines.join('\n');
}

function renderDraw(result) {
    const lines = [TITLE, '', `*Ciclo:* ${result.cycle.name}`, `*Times criados:* ${result.teams.length}`];
    if (result.reserves?.length) {
        lines.push(`*Reservas:* ${result.reserves.length}`);
    }
    if (result.skipped.length) {
        lines.push(`*Ignorados por elegibilidade:* ${result.skipped.length}`);
    }
    lines.push('', `Use *${COMMAND_PREFIX}times publicar sorteio* para abrir as confirmações.`);
    return lines.join('\n');
}

function renderCycleSummary(summary) {
    const lines = [TITLE, '', `*Ciclo:* ${summary.cycle?.name || '-'}`, '*Sorteio publicado.*'];
    for (const team of summary.teams) {
        lines.push('', `*#${team.id} ${team.name}*`);
        for (const member of team.members) {
            lines.push(`> ${displayName(member)} · ${member.role} · ${member.status}`);
        }
    }
    return lines.join('\n');
}

function renderRecruitCode(code) {
    return [
        TITLE,
        '',
        '*Convite de recrutamento:*',
        `> ${code}`,
        '',
        'Quando o player novo informar esse código e tiver o primeiro UP validado, ele passa a contar para a missão de recrutamento.',
    ].join('\n');
}

function renderCloseWeek(result) {
    return [
        TITLE,
        '',
        `*Semana:* ${result.weekKey}`,
        `*Elegíveis:* ${result.eligibleMembers}`,
        `*Recrutas validados:* ${result.progress.validatedRecruits}/${result.progress.target}`,
        '',
        '*Resultado:* prévia registrada.',
        'As recompensas econômicas ficam pendentes para aplicação administrativa segura.',
    ].join('\n');
}

async function assertAdmin({ db, sock, idChat, idJogador }) {
    if (!await canManagePlayer(sock, idChat, idJogador) && !await isPerformanceMonitor(db, idJogador)) {
        throw new PerformanceTeamServiceError('forbidden', 'Apenas monitor/ADM pode usar esse comando.');
    }
}

async function resolveTarget(db, body, m) {
    const parsed = resolveTargetAndRest(body, m);
    const resolved = await resolveTargetPlayer(db, parsed.targetId, parsed.targetText, {
        rejectEmptyCharacter: false,
    });
    if (!resolved.ok) {
        throw new PerformanceTeamServiceError('target_not_found', resolved.error || 'Não encontrei esse player.');
    }
    return { player: resolved.player, rest: parsed.rest };
}

async function resolveMentionAt(db, m, index) {
    const mentions = getMentions(m);
    const targetId = mentions[index] || null;
    if (!targetId) return null;
    const resolved = await resolveTargetPlayer(db, targetId, '', {
        rejectEmptyCharacter: false,
    });
    if (!resolved.ok) {
        throw new PerformanceTeamServiceError('target_not_found', resolved.error || 'Não encontrei esse player.');
    }
    return resolved.player;
}

async function resolveTeamFromRest(db, rest) {
    const team = await getTeamByNameOrId(db, rest);
    if (!team) throw new PerformanceTeamServiceError('team_not_found', 'Time não encontrado.');
    return team;
}

async function handleTimes({ sock, m, idChat, idJogador, db, body }) {
    const tokens = splitBody(body);
    const action = cleanAction(tokens[0]);
    if (!action) {
        await sendReply({ sock, idChat, m, text: renderSystem(await getCycleSummary(db)) });
        return;
    }
    if (['comandos', 'ajuda', 'help'].includes(action)) {
        await sendReply({ sock, idChat, m, text: renderCommands() });
        return;
    }
    if (action === 'participar') {
        const result = await joinCycle(db, idJogador, tokens.slice(1).join(' '));
        await sendReply({
            sock,
            idChat,
            m,
            text: [
                TITLE,
                '',
                `Inscrição registrada em *${result.cycle.name}* para *${displayName(result.player)}*.`,
                'Se for sorteado, confirme em até 48h com o comando de confirmação.',
            ].join('\n'),
        });
        return;
    }
    if (action === 'ciclo' && cleanAction(tokens[1]) === 'criar') {
        await assertAdmin({ db, sock, idChat, idJogador });
        const cycle = await createCycle(db, { name: tokens.slice(2).join(' '), actorId: idJogador });
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\nCiclo criado: *${cycle.name}* · draft.` });
        return;
    }
    if (action === 'ciclo' && cleanAction(tokens[1]) === 'fechar') {
        await assertAdmin({ db, sock, idChat, idJogador });
        const summary = await closePerformanceCycle(db, { actorId: idJogador });
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\nCiclo encerrado: *${summary.cycle?.name || '-'}*.` });
        return;
    }
    if (action === 'elegiveis') {
        await assertAdmin({ db, sock, idChat, idJogador });
        await sendReply({ sock, idChat, m, text: renderEligible(await listEligiblePlayers(db)) });
        return;
    }
    if (action === 'sortear') {
        await assertAdmin({ db, sock, idChat, idJogador });
        await sendReply({ sock, idChat, m, text: renderDraw(await generateTeamsFromSignups(db, { actorId: idJogador })) });
        return;
    }
    if (action === 'publicar' && cleanAction(tokens[1]) === 'sorteio') {
        await assertAdmin({ db, sock, idChat, idJogador });
        await sendReply({ sock, idChat, m, text: renderCycleSummary(await publishDraw(db, { actorId: idJogador })) });
        return;
    }
    await sendReply({ sock, idChat, m, text: renderCommands() });
}

async function handleTime({ sock, m, idChat, idJogador, db, body }) {
    const tokens = splitBody(body);
    const action = cleanAction(tokens[0]);
    if (action === 'historico') {
        const result = await getMyTeam(db, idJogador);
        const history = result.team ? await getTeamHistory(db, result.team.id) : [];
        await sendReply({ sock, idChat, m, text: renderTeamHistory(result, history) });
        return;
    }
    if (!action || ['painel', 'recrutas'].includes(action)) {
        await sendReply({ sock, idChat, m, text: renderMyTeam(await getMyTeam(db, idJogador)) });
        return;
    }
    if (['comandos', 'ajuda', 'help'].includes(action)) {
        await sendReply({ sock, idChat, m, text: renderCommands() });
        return;
    }
    if (action === 'confirmar') {
        await sendReply({ sock, idChat, m, text: renderMyTeam(await confirmMembership(db, idJogador)) });
        return;
    }
    if (action === 'convite') {
        const team = await getMyTeam(db, idJogador);
        if (!team.membership) {
            throw new PerformanceTeamServiceError(
                'membership_not_found',
                'Esse convite é exclusivo para membros de Times de Performance.'
            );
        }
        const code = await ensureRecruitmentCode(db, idJogador);
        await sendReply({ sock, idChat, m, text: renderRecruitCode(code) });
        return;
    }
    if (action === 'acolhi') {
        const target = await resolveTarget(db, tokens.slice(1).join(' '), m);
        const progress = await recordRecruitAction(db, {
            actorId: idJogador,
            recruitPlayerId: target.player.id,
            actionType: 'welcomed',
        });
        await sendReply({
            sock,
            idChat,
            m,
            text: `${TITLE}\n\nAcolhimento registrado. Recrutas da semana: *${progress.validatedRecruits}/${progress.target}*.`,
        });
        return;
    }
    if (action === 'ausencia' && cleanAction(tokens[1]) === 'aprovar') {
        await assertAdmin({ db, sock, idChat, idJogador });
        const target = await resolveTarget(db, tokens.slice(2).join(' '), m);
        await sendReply({
            sock,
            idChat,
            m,
            text: renderMyTeam(await approveProtectedAbsence(db, {
                playerId: target.player.id,
                actorId: idJogador,
            })),
        });
        return;
    }
    if (action === 'ausencia') {
        await sendReply({
            sock,
            idChat,
            m,
            text: renderMyTeam(await requestProtectedAbsence(db, {
                playerId: idJogador,
                reason: tokens.slice(1).join(' '),
            })),
        });
        return;
    }
    if (action === 'lembrar') {
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\nLembrete: confiram a meta semanal e acolham os novatos com calma.` });
        return;
    }
    if (action === 'avisar' && cleanAction(tokens[1]) === 'monitor') {
        const text = tokens.slice(2).join(' ').trim();
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\nAviso registrado para monitoria:\n> ${text || 'sem texto'}` });
        return;
    }
    if (ADMIN_ACTIONS.has(action)) {
        await assertAdmin({ db, sock, idChat, idJogador });
        await handleAdminTime({ sock, m, idChat, idJogador, db, body, tokens, action });
        return;
    }
    await sendReply({ sock, idChat, m, text: renderCommands() });
}

async function handleAdminTime({ sock, m, idChat, idJogador, db, body, tokens, action }) {
    if (action === 'criar') {
        const team = await createManualTeam(db, { name: tokens.slice(1).join(' '), actorId: idJogador });
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\nTime criado: *#${team.id} ${team.name}*.` });
        return;
    }
    if (action === 'adicionar') {
        const target = await resolveTarget(db, tokens.slice(1).join(' '), m);
        const team = await resolveTeamFromRest(db, target.rest);
        await addMemberToTeam(db, { teamId: team.id, playerId: target.player.id, actorId: idJogador });
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\n${playerDisplayName(target.player)} adicionado ao *${team.name}*.` });
        return;
    }
    if (action === 'remover') {
        const target = await resolveTarget(db, tokens.slice(1).join(' '), m);
        await removeMember(db, { playerId: target.player.id, reason: target.rest || 'Remoção administrativa.' });
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\n${playerDisplayName(target.player)} removido do time.` });
        return;
    }
    if (action === 'transferir') {
        const target = await resolveTarget(db, tokens.slice(1).join(' '), m);
        const team = await resolveTeamFromRest(db, target.rest);
        await removeMember(db, { playerId: target.player.id, reason: 'Transferência administrativa.', status: 'transferred' });
        await addMemberToTeam(db, { teamId: team.id, playerId: target.player.id, actorId: idJogador });
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\n${playerDisplayName(target.player)} transferido para *${team.name}*.` });
        return;
    }
    if (action === 'substituir') {
        const firstMention = await resolveMentionAt(db, m, 0);
        const secondMention = await resolveMentionAt(db, m, 1);
        const first = firstMention
            ? { player: firstMention, rest: tokens.slice(1).filter((token) => !token.startsWith('@')).join(' ') }
            : await resolveTarget(db, tokens.slice(1).join(' '), m);
        const second = secondMention
            ? { player: secondMention, rest: '' }
            : await resolveTarget(db, first.rest, m);
        const oldMembership = await removeMember(db, {
            playerId: first.player.id,
            reason: 'Substituição administrativa.',
            status: 'removed',
        });
        await addMemberToTeam(db, { teamId: oldMembership.team_id, playerId: second.player.id, actorId: idJogador });
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\nSubstituição registrada.` });
        return;
    }
    if (action === 'representante') {
        const target = await resolveTarget(db, tokens.slice(1).join(' '), m);
        const current = await getMyTeam(db, target.player.id);
        if (!current.team) throw new PerformanceTeamServiceError('membership_not_found', 'Esse player não está em time ativo.');
        await setRepresentative(db, { teamId: current.team.id, playerId: target.player.id });
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\n${playerDisplayName(target.player)} agora é representante.` });
        return;
    }
    if (action === 'monitor') {
        const target = await resolveTarget(db, tokens.slice(1).join(' '), m);
        const team = await resolveTeamFromRest(db, target.rest);
        await setTeamMonitor(db, { teamId: team.id, monitorPlayerId: target.player.id });
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\nMonitor definido para *${team.name}*.` });
        return;
    }
    if (action === 'validar' && cleanAction(tokens[1]) === 'recruta') {
        const target = await resolveTarget(db, tokens.slice(2).join(' '), m);
        const team = target.rest ? await resolveTeamFromRest(db, target.rest) : null;
        const progress = await recordRecruitAction(db, {
            actorId: idJogador,
            recruitPlayerId: target.player.id,
            actionType: 'validated',
            teamId: team?.id || null,
        });
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\nRecruta validado no painel do time. Semana: *${progress.validatedRecruits}/${progress.target}*.` });
        return;
    }
    if (action === 'invalidar' && cleanAction(tokens[1]) === 'recruta') {
        const target = await resolveTarget(db, tokens.slice(2).join(' '), m);
        const team = target.rest ? await resolveTeamFromRest(db, target.rest) : null;
        const progress = await recordRecruitAction(db, {
            actorId: idJogador,
            recruitPlayerId: target.player.id,
            actionType: 'invalidated',
            teamId: team?.id || null,
        });
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\nRegistro de recruta invalidado para auditoria. Semana: *${progress.validatedRecruits}/${progress.target}*.` });
        return;
    }
    if (action === 'fechar' && cleanAction(tokens[1]) === 'semana') {
        const team = await resolveTeamFromRest(db, tokens.slice(2).join(' '));
        await sendReply({ sock, idChat, m, text: renderCloseWeek(await closeWeekPreview(db, { teamId: team.id, actorId: idJogador })) });
        return;
    }
    if (action === 'fechar' && cleanAction(tokens[1]) === 'ciclo') {
        const summary = await closePerformanceCycle(db, { actorId: idJogador });
        await sendReply({ sock, idChat, m, text: `${TITLE}\n\nCiclo encerrado: *${summary.cycle?.name || '-'}*.` });
        return;
    }
    await sendReply({ sock, idChat, m, text: renderCommands() });
}

module.exports = {
    nome: `${COMMAND_PREFIX}times`,
    aliases: [
        `${COMMAND_PREFIX}time`,
        `${COMMAND_PREFIX}meutime`,
        `${COMMAND_PREFIX}timesperformance`,
        `${COMMAND_PREFIX}times performance`,
    ],
    descricao: 'Gerencia Times de Performance para novatos sem esquadrão.',
    gameCommand: true,
    groupBypass: true,
    executar: async (context) => {
        try {
            const command = String(context.matchedCommand || context.command || '').toLowerCase();
            if (command.includes('meutime')) {
                await sendReply({
                    sock: context.sock,
                    idChat: context.idChat,
                    m: context.m,
                    text: renderMyTeam(await getMyTeam(context.db, context.idJogador)),
                });
                return;
            }
            if (command.includes('time') && !command.includes('times')) {
                await handleTime(context);
                return;
            }
            await handleTimes(context);
        } catch (error) {
            const text = error instanceof PerformanceTeamServiceError
                ? error.message
                : 'Não consegui processar os Times de Performance agora.';
            await sendReply({ sock: context.sock, idChat: context.idChat, m: context.m, text });
            if (!(error instanceof PerformanceTeamServiceError)) throw error;
        }
    },
    renderCommands,
    renderMyTeam,
    renderSystem,
};
