'use strict';

const { extractPhoneNumber, isOwner, normalizeJid } = require('../groupAccess');

const EDMUND_NUMBERS = new Set(['5591984726680', '9184726680']);

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

function isPerformanceTeamAdmin(actorId) {
    const phone = extractPhoneNumber(actorId);
    return isOwner(actorId) || EDMUND_NUMBERS.has(phone);
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

function eligibilityForPerformanceTeam(player) {
    if (!player) return { ok: false, code: 'player_not_found', message: 'Nao encontrei seu personagem.' };
    const gameStatus = normalizeAction(player.jogo_status);
    const sheetStatus = normalizeAction(player.ficha_status);
    const squad = clean(player.esquadrao);
    if (gameStatus !== 'liberado') {
        return { ok: false, code: 'game_not_released', message: 'Seu jogo precisa estar liberado para entrar nos Times.' };
    }
    if (!['aprovada', 'aprovado'].includes(sheetStatus)) {
        return { ok: false, code: 'sheet_not_approved', message: 'Sua ficha precisa estar aprovada para entrar nos Times.' };
    }
    if (squad) {
        return { ok: false, code: 'already_in_squad', message: 'Times de Performance sao apenas para quem ainda nao esta em esquadrao.' };
    }
    return { ok: true };
}

async function joinPerformanceTeams(db, playerId) {
    await ensurePerformanceTeamSchema(db);
    const player = await readPlayer(db, playerId);
    const eligibility = eligibilityForPerformanceTeam(player);
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

async function readPerformanceTeamStatus(db, playerId) {
    await ensurePerformanceTeamSchema(db);
    const player = await readPlayer(db, playerId);
    const id = normalizeJid(playerId) || String(playerId || '').trim();
    const application = id ? await db.get(
        `SELECT * FROM clover_performance_team_applications
         WHERE player_id = ? AND status IN ('pending', 'confirmed', 'placed')
         ORDER BY id DESC LIMIT 1`,
        [id]
    ) : null;
    return { player, application, eligibility: eligibilityForPerformanceTeam(player) };
}

function renderSystem(prefix) {
    return [
        '*Clover RPG | Times de Performance*',
        '',
        'Sistema para novatos ativos que ainda nao entraram em esquadrao.',
        '',
        '*Base*',
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
        `${prefix}times (ver o sistema)`,
        `${prefix}times comandos (ver esta lista)`,
        `${prefix}times participar (entrar na lista do proximo ciclo)`,
        `${prefix}time confirmar (confirmar vaga sorteada)`,
        `${prefix}meutime (ver seu time e progresso)`,
        `${prefix}time votar <numero> (votar na missao semanal)`,
        `${prefix}time ausencia <motivo> (pedir ausencia protegida)`,
        `${prefix}time historico (ver historico do ciclo)`,
    ];
    if (admin) {
        lines.push(
            '',
            '*Monitor/ADM*',
            `${prefix}times admin (ver comandos administrativos)`,
            `${prefix}times ciclo criar <nome> (criar ciclo)`,
            `${prefix}times elegiveis (listar elegiveis)`,
            `${prefix}times sortear (gerar times sugeridos)`,
            `${prefix}time transferir <player> <time> (mover player)`,
            `${prefix}time substituir <antigo> <novo> (trocar membro)`
        );
    }
    return lines.join('\n');
}

function renderAdminHelp(prefix) {
    return [
        '*Clover RPG | Times Admin*',
        '',
        'Acesso: owner ou Edmund.',
        '',
        `${prefix}times ciclo criar <nome>`,
        `${prefix}times elegiveis`,
        `${prefix}times sortear`,
        `${prefix}times publicar sorteio`,
        `${prefix}time criar <nome>`,
        `${prefix}time adicionar <player> <time>`,
        `${prefix}time remover <player> <motivo>`,
        `${prefix}time transferir <player> <time>`,
        `${prefix}time substituir <antigo> <novo>`,
        `${prefix}time representante <player>`,
        `${prefix}time monitor <player>`,
        `${prefix}time fechar semana <time>`,
        `${prefix}time fechar ciclo <time>`,
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
            : `${name}, sua inscricao entrou na lista do proximo ciclo.`,
        '',
        'Quando o sorteio sair, confirme em ate 48h com .#time confirmar.',
    ].join('\n');
}

function renderMyStatus(status) {
    const name = displayName(status.player);
    if (status.application) {
        return [
            '*Clover RPG | Meu Time*',
            '',
            `${name}`,
            `Status: ${status.application.status}`,
            status.application.cycle_key ? `Ciclo: ${status.application.cycle_key}` : 'Ciclo: aguardando sorteio',
        ].join('\n');
    }
    if (!status.eligibility.ok) {
        return `*Clover RPG | Meu Time*\n\n${status.eligibility.message}`;
    }
    return `*Clover RPG | Meu Time*\n\n${name}, voce ainda nao esta na lista. Use .#times participar.`;
}

module.exports = {
    ensurePerformanceTeamSchema,
    isPerformanceTeamAdmin,
    joinPerformanceTeams,
    normalizeAction,
    readPerformanceTeamStatus,
    renderAdminHelp,
    renderCommands,
    renderJoinResult,
    renderMyStatus,
    renderSystem,
};
