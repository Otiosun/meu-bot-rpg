'use strict';

const { normalizeJid } = require('../groupAccess');
const { getAccessContext } = require('./accessControlService');
const {
    ACCESS_PERMISSIONS,
    roleGrantsIntegratedPermission,
} = require('./accessIntegrationService');
const { resolvePlayerSquadMembership } = require('./squadMembershipReadService');

const PERFORMANCE_TEAM_MANAGE_PERMISSION = ACCESS_PERMISSIONS.PERFORMANCE_TEAM_MANAGE;

function clean(value) {
    const text = String(value || '').trim();
    return text && text !== '-' ? text : null;
}

function displayName(player = {}) {
    return clean(player.personagem_nome) || clean(player.display_name) || clean(player.nome) || 'Personagem';
}

function normalizeAction(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function isPerformanceTeamAdmin(db, actorId) {
    const context = await getAccessContext(db, actorId);
    if (context.owner) return true;
    return context.assignments.some((assignment) => (
        assignment.status === 'active'
        && roleGrantsIntegratedPermission(assignment.role_key, PERFORMANCE_TEAM_MANAGE_PERMISSION)
    ));
}

async function ensurePerformanceTeamSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_performance_team_applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'confirmed', 'cancelled', 'placed')),
            cycle_key TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_performance_team_applications_open
        ON clover_performance_team_applications (player_id)
        WHERE status IN ('pending', 'confirmed', 'placed')
    `);
}

async function readPlayer(db, playerId) {
    const id = normalizeJid(playerId) || String(playerId || '').trim();
    if (!id) return null;
    return db.get('SELECT * FROM jogadores WHERE id = ?', [id]);
}

async function eligibilityForPerformanceTeam(db, player) {
    if (!player) return { ok: false, code: 'player_not_found', message: 'Nao encontrei seu personagem.' };
    const gameStatus = normalizeAction(player.jogo_status);
    const sheetStatus = normalizeAction(player.ficha_status);
    if (gameStatus !== 'liberado') {
        return { ok: false, code: 'game_not_released', message: 'Seu jogo precisa estar liberado para entrar nos Times.' };
    }
    if (!['aprovada', 'aprovado'].includes(sheetStatus)) {
        return { ok: false, code: 'sheet_not_approved', message: 'Sua ficha precisa estar aprovada para entrar nos Times.' };
    }
    const membership = await resolvePlayerSquadMembership(db, player.id);
    if (membership.ok) {
        return { ok: false, code: 'already_in_squad', message: 'Times de Performance sao apenas para quem ainda nao esta em esquadrao.' };
    }
    return { ok: true };
}

async function joinPerformanceTeams(db, playerId) {
    await ensurePerformanceTeamSchema(db);
    const player = await readPlayer(db, playerId);
    const eligibility = await eligibilityForPerformanceTeam(db, player);
    if (!eligibility.ok) return { ok: false, ...eligibility };

    const id = normalizeJid(playerId) || String(playerId || '').trim();
    const existing = await db.get(
        `SELECT * FROM clover_performance_team_applications
         WHERE player_id = ? AND status IN ('pending', 'confirmed', 'placed')
         ORDER BY id DESC LIMIT 1`,
        [id]
    );
    if (existing) {
        return {
            ok: true,
            duplicate: true,
            application: { id: String(existing.id), status: existing.status, playerId: id },
            player,
        };
    }
    const inserted = await db.run(
        `INSERT INTO clover_performance_team_applications
         (player_id, status, metadata_json)
         VALUES (?, 'pending', ?)`,
        [id, JSON.stringify({ source: 'bot_command' })]
    );
    return {
        ok: true,
        duplicate: false,
        application: { id: String(inserted.lastID), status: 'pending', playerId: id },
        player,
    };
}

async function getOpenApplication(db, playerId) {
    const id = normalizeJid(playerId) || String(playerId || '').trim();
    if (!id) return null;
    return db.get(
        `SELECT * FROM clover_performance_team_applications
         WHERE player_id = ? AND status IN ('pending', 'confirmed', 'placed')
         ORDER BY id DESC LIMIT 1`,
        [id]
    );
}

async function confirmPerformanceTeamApplication(db, playerId, options = {}) {
    await ensurePerformanceTeamSchema(db);
    const player = await readPlayer(db, playerId);
    const eligibility = await eligibilityForPerformanceTeam(db, player);
    if (!eligibility.ok) return { ok: false, ...eligibility };

    const id = normalizeJid(playerId) || String(playerId || '').trim();
    const application = await getOpenApplication(db, id);
    if (!application) {
        return {
            ok: false,
            code: 'application_not_found',
            message: 'Voce ainda nao esta na lista. Use .#times participar primeiro.',
            player,
        };
    }
    if (application.status === 'confirmed') {
        return { ok: true, duplicate: true, application, player };
    }
    if (application.status === 'placed') {
        return {
            ok: true,
            duplicate: true,
            application,
            player,
            message: 'Essa inscricao ja foi colocada em um ciclo.',
        };
    }

    const metadata = {
        confirmedBy: normalizeJid(options.actorId) || null,
        confirmedSource: options.source || 'bot_command',
    };
    await db.run(
        `UPDATE clover_performance_team_applications
         SET status = 'confirmed',
             updated_at = CURRENT_TIMESTAMP,
             metadata_json = json_patch(COALESCE(metadata_json, '{}'), ?)
         WHERE id = ? AND status = 'pending'`,
        [JSON.stringify(metadata), application.id]
    );
    const updated = await db.get('SELECT * FROM clover_performance_team_applications WHERE id = ?', [application.id]);
    return { ok: true, duplicate: false, application: updated, player };
}

async function cancelPerformanceTeamApplication(db, playerId, options = {}) {
    await ensurePerformanceTeamSchema(db);
    const player = await readPlayer(db, playerId);
    const id = normalizeJid(playerId) || String(playerId || '').trim();
    const application = await getOpenApplication(db, id);
    if (!application) {
        return {
            ok: false,
            code: 'application_not_found',
            message: player
                ? `${displayName(player)} nao possui inscricao aberta nos Times.`
                : 'Nao encontrei inscricao aberta para esse player.',
            player,
        };
    }
    if (application.status === 'placed') {
        return {
            ok: false,
            code: 'application_already_placed',
            message: 'Essa inscricao ja foi colocada em um ciclo. Use transferencia/substituicao quando a fase 2 estiver ativa.',
            player,
            application,
        };
    }

    const metadata = {
        cancelledBy: normalizeJid(options.actorId) || null,
        cancelReason: clean(options.reason) || null,
        cancelSource: options.source || 'bot_command',
    };
    await db.run(
        `UPDATE clover_performance_team_applications
         SET status = 'cancelled',
             updated_at = CURRENT_TIMESTAMP,
             metadata_json = json_patch(COALESCE(metadata_json, '{}'), ?)
         WHERE id = ? AND status IN ('pending', 'confirmed')`,
        [JSON.stringify(metadata), application.id]
    );
    return { ok: true, application: { ...application, status: 'cancelled' }, player };
}

async function listPerformanceTeamApplications(db, options = {}) {
    await ensurePerformanceTeamSchema(db);
    const limit = Math.max(1, Math.min(50, Number(options.limit) || 25));
    const statuses = Array.isArray(options.statuses) && options.statuses.length
        ? options.statuses
        : ['pending', 'confirmed'];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT a.*, j.nome, j.display_name, j.personagem_nome, j.jogo_status, j.ficha_status, j.esquadrao
         FROM clover_performance_team_applications a
         LEFT JOIN jogadores j ON j.id = a.player_id
         WHERE a.status IN (${placeholders})
         ORDER BY
            CASE a.status WHEN 'pending' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
            a.created_at ASC,
            a.id ASC
         LIMIT ?`,
        [...statuses, limit]
    );
    return { rows, limit, statuses };
}

async function readPerformanceTeamStatus(db, playerId) {
    await ensurePerformanceTeamSchema(db);
    const player = await readPlayer(db, playerId);
    const id = normalizeJid(playerId) || String(playerId || '').trim();
    const application = id ? await getOpenApplication(db, id) : null;
    return { player, application, eligibility: await eligibilityForPerformanceTeam(db, player) };
}

function renderSystem(prefix) {
    return [
        '*Clover RPG | Times de Performance*',
        '',
        'Sistema preparatorio para novatos ativos que ainda nao entraram em esquadrao.',
        '',
        '*Agora*',
        `- ${prefix}times participar entra na fila do proximo ciclo;`,
        `- ${prefix}time confirmar confirma sua inscricao;`,
        `- ${prefix}meutime mostra seu estado atual.`,
        '',
        '*Quando o ciclo abrir*',
        '- ciclo de 4 semanas;',
        '- times de 4 players;',
        '- 1 representante e 1 monitor fora das vagas;',
        '- entrada por inscricao, sorteio assistido e confirmacao.',
        '',
        '*Metas*',
        '- bater teto semanal de PH;',
        '- missao semanal de recrutamento;',
        '- concluir arco pessoal mensal.',
        '',
        `Use ${prefix}times comandos para ver a lista de comandos.`,
    ].join('\n');
}

function renderCommands(prefix, admin = false) {
    const lines = [
        '*Clover RPG | Comandos dos Times*',
        '',
        '*Ativos agora*',
        `${prefix}times (ver o sistema)`,
        `${prefix}times comandos (ver esta lista)`,
        `${prefix}times participar (entrar na fila)`,
        `${prefix}time confirmar (confirmar inscricao)`,
        `${prefix}time sair (cancelar inscricao)`,
        `${prefix}meutime (ver seu estado)`,
        '',
        '*Fase 2*',
        `${prefix}time votar <numero>`,
        `${prefix}time ausencia <motivo>`,
        `${prefix}time historico`,
    ];
    if (admin) {
        lines.push(
            '',
            '*Administracao ativa*',
            `${prefix}times admin (ver painel administrativo)`,
            `${prefix}times lista (listar inscricoes abertas)`,
            `${prefix}time confirmar @player (confirmar player)`,
            `${prefix}time cancelar @player <motivo> (cancelar player)`
        );
    }
    return lines.join('\n');
}

function renderAdminHelp(prefix) {
    return [
        '*Clover RPG | Times Admin*',
        '',
        'Acesso: Owner ou Administrador.',
        '',
        '*Ativos agora*',
        `${prefix}times lista`,
        `${prefix}time confirmar @player`,
        `${prefix}time cancelar @player <motivo>`,
        '',
        '*Fase 2 ainda nao ativa*',
        `${prefix}times ciclo criar <nome>`,
        `${prefix}times sortear`,
        `${prefix}times publicar sorteio`,
        `${prefix}time transferir <player> <time>`,
        `${prefix}time substituir <antigo> <novo>`,
        `${prefix}time fechar semana <time>`,
        '',
        'Esses comandos de fase 2 ainda nao executam operacao real no bot vivo.',
    ].join('\n');
}

function renderJoinResult(result) {
    if (!result.ok) {
        return `*Clover RPG | Times de Performance*\n\n${result.message}`;
    }
    const name = displayName(result.player);
    return [
        '*Clover RPG | Times de Performance*',
        '',
        result.duplicate
            ? `${name}, voce ja esta na lista do proximo ciclo.`
            : `${name}, sua inscricao entrou na fila do proximo ciclo.`,
        '',
        'Confirme com .#time confirmar para mostrar que ainda tem interesse.',
    ].join('\n');
}

function renderConfirmResult(result) {
    if (!result.ok) return `*Clover RPG | Times de Performance*\n\n${result.message}`;
    const name = displayName(result.player);
    return [
        '*Clover RPG | Times de Performance*',
        '',
        result.duplicate
            ? `${name}, sua inscricao ja estava confirmada.`
            : `${name}, inscricao confirmada.`,
        '',
        'Agora e so aguardar a organizacao do ciclo.',
    ].join('\n');
}

function renderCancelResult(result) {
    if (!result.ok) return `*Clover RPG | Times de Performance*\n\n${result.message}`;
    return [
        '*Clover RPG | Times de Performance*',
        '',
        `${displayName(result.player)}, inscricao cancelada.`,
        '',
        'Se mudar de ideia, use .#times participar de novo.',
    ].join('\n');
}

function renderApplicationList(list) {
    const lines = [
        '*Clover RPG | Fila dos Times*',
        '',
    ];
    if (!list.rows.length) {
        lines.push('Nenhuma inscricao aberta no momento.');
        return lines.join('\n');
    }
    list.rows.forEach((row, index) => {
        const status = row.status === 'confirmed' ? 'confirmado' : 'pendente';
        lines.push(`${index + 1}. ${displayName(row)} - ${status}`);
    });
    if (list.rows.length >= list.limit) {
        lines.push('', `Mostrando os primeiros ${list.limit} registros.`);
    }
    return lines.join('\n');
}

function renderPhaseTwo(prefix, commandLabel = null) {
    return [
        '*Clover RPG | Times de Performance*',
        '',
        commandLabel ? `Comando: ${commandLabel}` : 'Essa parte ainda nao esta ativa.',
        '',
        'A fase atual cobre fila, confirmacao e cancelamento de inscricoes.',
        'Sorteio, ciclos, votacao, ausencia, historico, transferencia e fechamento entram na fase 2.',
        '',
        `Use ${prefix}times comandos para ver o que ja funciona agora.`,
    ].join('\n');
}

function renderUnknownCommand(prefix) {
    return [
        '*Clover RPG | Times de Performance*',
        '',
        'Nao entendi esse comando dos Times.',
        '',
        `Use ${prefix}times comandos para ver a lista atual.`,
    ].join('\n');
}

function renderMyStatus(status) {
    const name = displayName(status.player);
    if (status.application) {
        const statusLabel = {
            pending: 'inscricao pendente',
            confirmed: 'inscricao confirmada',
            placed: 'em ciclo',
        }[status.application.status] || status.application.status;
        return [
            '*Clover RPG | Meu Time*',
            '',
            `${name}`,
            `Status: ${statusLabel}`,
            status.application.cycle_key ? `Ciclo: ${status.application.cycle_key}` : 'Ciclo: aguardando sorteio',
        ].join('\n');
    }
    if (!status.eligibility.ok) {
        return `*Clover RPG | Meu Time*\n\n${status.eligibility.message}`;
    }
    return `*Clover RPG | Meu Time*\n\n${name}, voce ainda nao esta na lista. Use .#times participar.`;
}

module.exports = {
    cancelPerformanceTeamApplication,
    confirmPerformanceTeamApplication,
    ensurePerformanceTeamSchema,
    isPerformanceTeamAdmin,
    joinPerformanceTeams,
    listPerformanceTeamApplications,
    normalizeAction,
    readPerformanceTeamStatus,
    renderAdminHelp,
    renderApplicationList,
    renderCancelResult,
    renderCommands,
    renderConfirmResult,
    renderJoinResult,
    renderMyStatus,
    renderPhaseTwo,
    renderSystem,
    renderUnknownCommand,
};
