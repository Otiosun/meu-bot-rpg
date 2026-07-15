'use strict';

const { COMMAND_PREFIX } = require('../config/bot');
const { sendReply } = require('../helpers/chatReply');
const { isOwner } = require('../helpers/groupAccess');
const {
    formatMention,
    playerDisplayName,
    resolveTargetAndRest,
    resolveTargetPlayer,
} = require('../helpers/clover/commandTargetUtils');
const {
    ROLE_DEFINITIONS,
    assignAccessRole,
    getRoleDefinition,
    getRoleLabel,
    listAccessRoleEvents,
    listActiveAccessRoles,
    resolveRoleKey,
    revokeAccessRole,
} = require('../helpers/clover/accessControlService');

const GIVE_ACTIONS = new Set(['dar', 'adicionar', 'atribuir', 'set', 'add']);
const REMOVE_ACTIONS = new Set(['remover', 'retirar', 'revogar', 'remove']);
const VIEW_ACTIONS = new Set(['ver', 'status', 'consultar']);
const LIST_ACTIONS = new Set(['listar', 'lista', 'ativos']);
const HISTORY_ACTIONS = new Set(['historico', 'histórico', 'log', 'eventos']);

function normalizeAction(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function splitAction(body) {
    const parts = String(body || '').trim().split(/\s+/).filter(Boolean);
    return {
        action: normalizeAction(parts.shift() || ''),
        rest: parts.join(' '),
    };
}

function section(symbol, title) {
    return `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;
}

function renderUsage() {
    return [
        '*♧┃𝐂𝐀𝐑𝐆𝐎𝐒 𝐄 𝐏𝐄𝐑𝐌𝐈𝐒𝐒𝐎̃𝐄𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  papéis sistêmicos do RPG  ──',
        '',
        section('✓', '𝗖𝗼𝗺𝗮𝗻𝗱𝗼𝘀'),
        '',
        `> ${COMMAND_PREFIX}cargo dar @player narrador`,
        `> ${COMMAND_PREFIX}cargo dar @player avaliador`,
        `> ${COMMAND_PREFIX}cargo dar @player capitao`,
        `> ${COMMAND_PREFIX}cargo dar @player vice`,
        `> ${COMMAND_PREFIX}cargo remover @player narrador`,
        `> ${COMMAND_PREFIX}cargo ver @player`,
        `> ${COMMAND_PREFIX}cargo listar`,
        `> ${COMMAND_PREFIX}cargo historico @player`,
        '',
        section('!', '𝗥𝗲𝗴𝗿𝗮'),
        '',
        '> Capitão e Vice usam o esquadrão atual do personagem.',
        '> Somente o Owner pode atribuir ou remover cargos nesta etapa.',
    ].join('\n');
}

async function resolveCargoTarget(db, text, m) {
    const parsed = resolveTargetAndRest(text, m);
    if (!parsed.targetId && !parsed.targetText) {
        return { ok: false, error: 'Marque o player, responda uma mensagem ou informe o número.' };
    }
    const resolved = await resolveTargetPlayer(db, parsed.targetId, parsed.targetText, { mechanical: true });
    if (!resolved.ok) return resolved;
    return { ok: true, player: resolved.player, rest: parsed.rest };
}

function parseRoleRequest(text, targetPlayer) {
    const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
    const rawRole = parts.shift() || '';
    const roleKey = resolveRoleKey(rawRole);
    if (!roleKey) return { ok: false, code: 'unknown_role', rawRole };

    const definition = getRoleDefinition(roleKey);
    const explicitScope = parts.join(' ').trim();
    const scopeLabel = definition.scopeType === 'squad'
        ? (explicitScope || String(targetPlayer?.esquadrao || '').trim())
        : null;
    if (definition.scopeType === 'squad' && (!scopeLabel || scopeLabel === '-')) {
        return { ok: false, code: 'squad_required', role: definition };
    }
    return { ok: true, roleKey, definition, scopeLabel };
}

function roleRequestError(parsed) {
    if (parsed?.code === 'squad_required') {
        return 'Capitão ou Vice precisa de um esquadrão. Registre o esquadrão no personagem ou informe o nome após o cargo.';
    }
    return 'Cargo inválido. Use: administrador, narrador, avaliador, capitão ou vice.';
}

function safeMetadata(value) {
    try {
        return JSON.parse(value || '{}');
    } catch {
        return {};
    }
}

function assignmentScopeLabel(assignment) {
    if (assignment.scope_type === 'global') return 'Global';
    const metadata = safeMetadata(assignment.metadata_json);
    return metadata.scope_label || assignment.scope_key;
}

function renderAssignmentResult(result, player) {
    if (!result.ok) {
        return [
            '*♧┃𝐂𝐀𝐑𝐆𝐎 𝐍𝐀̃𝐎 𝐀𝐋𝐓𝐄𝐑𝐀𝐃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '',
            `> ${roleRequestError(result)}`,
        ].join('\n');
    }

    const assignment = result.assignment;
    return [
        '*♧┃𝐂𝐀𝐑𝐆𝐎 𝐑𝐄𝐆𝐈𝐒𝐓𝐑𝐀𝐃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  permissão sistêmica atualizada  ──',
        '',
        `*𝐏𝐥𝐚𝐲𝐞𝐫:* ${playerDisplayName(player, player.id)} (${formatMention(player.id)})`,
        `*𝐂𝐚𝐫𝐠𝐨:* ${getRoleLabel(assignment.role_key)}`,
        `*𝐄𝐬𝐜𝐨𝐩𝐨:* ${assignmentScopeLabel(assignment)}`,
        `*𝐑𝐞𝐬𝐮𝐥𝐭𝐚𝐝𝐨:* ${result.code === 'already_active' ? 'já estava ativo' : 'atribuído'}`,
    ].join('\n');
}

function renderRevocationResult(result, player) {
    if (!result.ok) {
        return [
            '*♧┃𝐂𝐀𝐑𝐆𝐎 𝐍𝐀̃𝐎 𝐀𝐋𝐓𝐄𝐑𝐀𝐃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '',
            '> Esse cargo não está ativo nesse escopo.',
        ].join('\n');
    }

    return [
        '*♧┃𝐂𝐀𝐑𝐆𝐎 𝐑𝐄𝐌𝐎𝐕𝐈𝐃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*𝐏𝐥𝐚𝐲𝐞𝐫:* ${playerDisplayName(player, player.id)} (${formatMention(player.id)})`,
        `*𝐂𝐚𝐫𝐠𝐨:* ${getRoleLabel(result.role.key)}`,
        `*𝐑𝐞𝐠𝐢𝐬𝐭𝐫𝐨𝐬 𝐫𝐞𝐦𝐨𝐯𝐢𝐝𝐨𝐬:* ${result.revoked.length}`,
    ].join('\n');
}

function renderPlayerRoles(player, assignments) {
    const lines = [
        '*♧┃𝐂𝐀𝐑𝐆𝐎𝐒 𝐃𝐎 𝐏𝐋𝐀𝐘𝐄𝐑 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*𝐏𝐥𝐚𝐲𝐞𝐫:* ${playerDisplayName(player, player.id)} (${formatMention(player.id)})`,
        '',
    ];

    if (!assignments.length) {
        lines.push('> Nenhum cargo sistêmico ativo.');
        return lines.join('\n');
    }

    lines.push(section('✓', '𝗔𝘁𝗶𝘃𝗼𝘀'), '');
    assignments.forEach((assignment) => {
        lines.push(`*${getRoleLabel(assignment.role_key)}* · ${assignmentScopeLabel(assignment)}`);
    });
    return lines.join('\n');
}

function renderAllRoles(assignments) {
    const lines = [
        '*♧┃𝐂𝐀𝐑𝐆𝐎𝐒 𝐀𝐓𝐈𝐕𝐎𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
    ];
    if (!assignments.length) {
        lines.push('> Nenhum cargo sistêmico registrado.');
        return lines.join('\n');
    }

    for (const assignment of assignments.slice(0, 40)) {
        lines.push(
            `*${getRoleLabel(assignment.role_key)}* · ${formatMention(assignment.subject_id)}`,
            `> ${assignmentScopeLabel(assignment)}`
        );
    }
    if (assignments.length > 40) lines.push('', `> … e mais ${assignments.length - 40} cargo(s).`);
    return lines.join('\n');
}

function renderRoleHistory(player, events) {
    const lines = [
        '*♧┃𝐇𝐈𝐒𝐓𝐎́𝐑𝐈𝐂𝐎 𝐃𝐄 𝐂𝐀𝐑𝐆𝐎𝐒 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '',
        `*𝐏𝐥𝐚𝐲𝐞𝐫:* ${playerDisplayName(player, player.id)} (${formatMention(player.id)})`,
        '',
    ];
    if (!events.length) {
        lines.push('> Nenhum evento registrado.');
        return lines.join('\n');
    }

    events.slice(0, 20).forEach((event) => {
        const action = event.action === 'assigned' ? 'Atribuído' : 'Removido';
        lines.push(
            `*${action}:* ${getRoleLabel(event.role_key)}`,
            `> Escopo: ${event.scope_type === 'global' ? 'Global' : event.scope_key}`
        );
    });
    return lines.join('\n');
}

async function handleGive({ db, rest, m, actorId }) {
    const target = await resolveCargoTarget(db, rest, m);
    if (!target.ok) return { text: target.error, mentions: [] };
    const parsed = parseRoleRequest(target.rest, target.player);
    if (!parsed.ok) return { text: roleRequestError(parsed), mentions: [target.player.id] };

    const result = await assignAccessRole(db, {
        subjectId: target.player.id,
        role: parsed.roleKey,
        scopeKey: parsed.scopeLabel,
        assignedBy: actorId,
        reason: 'Cargo atribuído pelo comando do Owner',
        metadata: { scope_label: parsed.scopeLabel || 'Global' },
    });
    return { text: renderAssignmentResult(result, target.player), mentions: [target.player.id] };
}

async function handleRemove({ db, rest, m, actorId }) {
    const target = await resolveCargoTarget(db, rest, m);
    if (!target.ok) return { text: target.error, mentions: [] };
    const parsed = parseRoleRequest(target.rest, target.player);
    if (!parsed.ok) return { text: roleRequestError(parsed), mentions: [target.player.id] };

    const result = await revokeAccessRole(db, {
        subjectId: target.player.id,
        role: parsed.roleKey,
        scopeKey: parsed.scopeLabel,
        revokedBy: actorId,
        reason: 'Cargo removido pelo comando do Owner',
        metadata: { scope_label: parsed.scopeLabel || 'Global' },
    });
    return { text: renderRevocationResult(result, target.player), mentions: [target.player.id] };
}

async function handleView({ db, rest, m }) {
    const target = await resolveCargoTarget(db, rest, m);
    if (!target.ok) return { text: target.error, mentions: [] };
    const assignments = await listActiveAccessRoles(db, { subjectId: target.player.id });
    return { text: renderPlayerRoles(target.player, assignments), mentions: [target.player.id] };
}

async function handleHistory({ db, rest, m }) {
    const target = await resolveCargoTarget(db, rest, m);
    if (!target.ok) return { text: target.error, mentions: [] };
    const events = await listAccessRoleEvents(db, { subjectId: target.player.id, limit: 20 });
    return { text: renderRoleHistory(target.player, events), mentions: [target.player.id] };
}

module.exports = {
    nome: `${COMMAND_PREFIX}cargo`,
    aliases: [
        `${COMMAND_PREFIX}cargos`,
        `${COMMAND_PREFIX}permissao`,
        `${COMMAND_PREFIX}permissão`,
        `${COMMAND_PREFIX}permissoes`,
        `${COMMAND_PREFIX}permissões`,
    ],
    descricao: 'Gerencia cargos sistêmicos e seus escopos.',
    groupBypass: true,
    executar: async ({ sock, m, idChat, idJogador, db, body }) => {
        if (!isOwner(idJogador)) {
            await sendReply({
                sock,
                idChat,
                m,
                text: 'Apenas o Owner pode gerenciar cargos sistêmicos.',
            });
            return;
        }

        const { action, rest } = splitAction(body);
        let response = null;
        if (!action || ['ajuda', 'help'].includes(action)) {
            response = { text: renderUsage(), mentions: [] };
        } else if (GIVE_ACTIONS.has(action)) {
            response = await handleGive({ db, rest, m, actorId: idJogador });
        } else if (REMOVE_ACTIONS.has(action)) {
            response = await handleRemove({ db, rest, m, actorId: idJogador });
        } else if (VIEW_ACTIONS.has(action)) {
            response = await handleView({ db, rest, m });
        } else if (LIST_ACTIONS.has(action)) {
            const assignments = await listActiveAccessRoles(db);
            response = {
                text: renderAllRoles(assignments),
                mentions: [...new Set(assignments.map((assignment) => assignment.subject_id))],
            };
        } else if (HISTORY_ACTIONS.has(action)) {
            response = await handleHistory({ db, rest, m });
        } else {
            response = { text: renderUsage(), mentions: [] };
        }

        await sendReply({
            sock,
            idChat,
            m,
            text: response.text,
            mentions: response.mentions,
        });
    },
    parseRoleRequest,
    renderAllRoles,
    renderAssignmentResult,
    renderPlayerRoles,
    renderRevocationResult,
    renderRoleHistory,
    renderUsage,
    splitAction,
};