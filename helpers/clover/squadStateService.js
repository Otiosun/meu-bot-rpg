'use strict';

const { ensureCloverSquadSchema } = require('../../database');
const { normalizeSquadKey } = require('./cavalierService');

const RENOWN_GRADES = Object.freeze([
    Object.freeze({ grade: 6, name: 'Lenda Viva', min: 200, max: null, description: 'O nome do esquadrão entra para a história.' }),
    Object.freeze({ grade: 5, name: 'Pilar do Reino', min: 130, max: 199, description: 'Parte da segurança e do orgulho de Clover.' }),
    Object.freeze({ grade: 4, name: 'Prestigiado', min: 85, max: 129, description: 'Influencia decisões e recebe missões críticas.' }),
    Object.freeze({ grade: 3, name: 'Respeitado', min: 50, max: 84, description: 'O nome do esquadrão já pesa em Clover.' }),
    Object.freeze({ grade: 2, name: 'Confiável', min: 25, max: 49, description: 'Pode receber missões mais sérias.' }),
    Object.freeze({ grade: 1, name: 'Reconhecido', min: 10, max: 24, description: 'O Reino já reconhece que o esquadrão é útil.' }),
    Object.freeze({ grade: 0, name: 'Recém-Registrado', min: 0, max: 9, description: 'Ainda está provando seu valor.' }),
]);

const RESOURCE_BANDS = Object.freeze([
    Object.freeze({ min: 6, max: null, key: 'exceptional', label: 'Excepcional', description: 'Há margem para requisição excepcional, investimento grande ou apoio institucional.' }),
    Object.freeze({ min: 4, max: 5, key: 'relevant', label: 'Relevante', description: 'Há margem para equipe de apoio, transporte especial ou preparo de alto risco.' }),
    Object.freeze({ min: 3, max: 3, key: 'prepared', label: 'Preparado', description: 'Há margem para reforço relevante, especialista ou acesso restrito.' }),
    Object.freeze({ min: 2, max: 2, key: 'useful', label: 'Útil', description: 'Há margem para materiais melhores, mapas, poções ou investigação formal.' }),
    Object.freeze({ min: 1, max: 1, key: 'basic', label: 'Básico', description: 'Há margem para informação simples, pequeno reparo ou suprimento comum.' }),
    Object.freeze({ min: 0, max: 0, key: 'empty', label: 'Sem margem', description: 'O esquadrão não possui Estrelas Atuais para requisições.' }),
]);

function asNonNegativeInteger(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.trunc(number));
}

function isFilled(value) {
    const text = String(value || '').trim();
    return Boolean(text) && text !== '-';
}

function displayName(player = {}) {
    return [player.personagem_nome, player.display_name, player.nome]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-')
        || 'Membro';
}

function getRenownGrade(historicalStars) {
    const stars = asNonNegativeInteger(historicalStars);
    return RENOWN_GRADES.find((grade) => stars >= grade.min && (grade.max === null || stars <= grade.max))
        || RENOWN_GRADES[RENOWN_GRADES.length - 1];
}

function getResourceBand(currentStars) {
    const stars = asNonNegativeInteger(currentStars);
    return RESOURCE_BANDS.find((band) => stars >= band.min && (band.max === null || stars <= band.max))
        || RESOURCE_BANDS[RESOURCE_BANDS.length - 1];
}

function getReputationState(blackStars) {
    const stars = asNonNegativeInteger(blackStars);
    if (stars === 0) {
        return {
            key: 'clean',
            label: 'Íntegra',
            description: 'Não há Estrelas Negras registradas contra a fama do esquadrão.',
        };
    }
    if (stars === 1) {
        return {
            key: 'watched',
            label: 'Sob observação',
            description: 'Uma mancha pública exige cuidado com conduta e próximos resultados.',
        };
    }
    if (stars <= 3) {
        return {
            key: 'shaken',
            label: 'Abalada',
            description: 'As Estrelas Negras já pressionam a confiança pública no esquadrão.',
        };
    }
    return {
        key: 'compromised',
        label: 'Comprometida',
        description: 'A quantidade de Estrelas Negras compromete seriamente a imagem pública.',
    };
}

function getCommandState(squad = {}) {
    const hasCaptain = isFilled(squad.captain_player_id) || isFilled(squad.captain_name);
    const hasVice = isFilled(squad.vice_captain_player_id);
    if (hasCaptain && hasVice) {
        return { key: 'complete', label: 'Completo', description: 'Capitão e Vice estão registrados.' };
    }
    if (hasCaptain) {
        return { key: 'captain_only', label: 'Parcial', description: 'Há Capitão registrado, mas o posto de Vice está vazio.' };
    }
    if (hasVice) {
        return { key: 'vice_only', label: 'Irregular', description: 'Há Vice registrado, mas não existe Capitão definido.' };
    }
    return { key: 'missing', label: 'Sem comando', description: 'Capitão e Vice ainda não foram registrados.' };
}

function getActivityState({
    recentEntries,
    recentMemberEntries,
    recentAdministrativeEntries,
    recentContributors,
    memberCount,
    recentStars,
    recentAdministrativeStars,
}) {
    const entries = asNonNegativeInteger(recentEntries);
    const memberEntries = recentMemberEntries === undefined
        ? entries
        : asNonNegativeInteger(recentMemberEntries);
    const administrativeEntries = asNonNegativeInteger(recentAdministrativeEntries);
    const contributors = asNonNegativeInteger(recentContributors);
    const members = asNonNegativeInteger(memberCount);
    const stars = Number(recentStars || 0);
    const administrativeStars = Number(recentAdministrativeStars || 0);

    if (!entries) {
        return {
            key: 'quiet',
            label: 'Sem movimento recente',
            description: 'Nenhum registro de Estrela apareceu nos últimos 30 dias.',
        };
    }

    if (!memberEntries) {
        return {
            key: 'administrative',
            label: 'Movimento administrativo',
            description: `${administrativeEntries || entries} registro(s) contábil(eis) do esquadrão tiveram saldo de ${administrativeStars >= 0 ? '+' : ''}${administrativeStars} Estrela(s), sem contribuição individual de membro.`,
        };
    }

    const administrativeSuffix = administrativeEntries
        ? ` Além disso, houve ${administrativeEntries} movimentação(ões) administrativa(s), separada(s) da atividade dos membros.`
        : '';
    const participationBase = Math.max(1, members);
    const participation = contributors / participationBase;
    if (members > 1 && participation >= 0.5) {
        return {
            key: 'distributed',
            label: 'Atividade distribuída',
            description: `${contributors} de ${members} membros contribuíram em ${memberEntries} registro(s), com saldo recente de ${stars >= 0 ? '+' : ''}${stars} Estrela(s).${administrativeSuffix}`,
        };
    }

    return {
        key: 'concentrated',
        label: 'Atividade concentrada',
        description: `${memberEntries} registro(s) recentes dependem de ${contributors} membro(s), com saldo de ${stars >= 0 ? '+' : ''}${stars} Estrela(s).${administrativeSuffix}`,
    };
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
        [tableName]
    );
    return Boolean(row?.name);
}

async function readStructureState(db, squadKey) {
    const exists = await tableExists(db, 'clover_squad_upgrades');
    if (!exists) {
        return {
            registered: false,
            count: 0,
            label: 'Não registrada',
            description: 'Benfeitorias e setores do QG ainda não possuem registro operacional no bot.',
        };
    }

    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_squad_upgrades
         WHERE squad_key = ?
           AND COALESCE(status, 'active') = 'active'`,
        [squadKey]
    ).catch(() => null);
    const count = asNonNegativeInteger(row?.total);
    return {
        registered: true,
        count,
        label: count ? 'Em desenvolvimento' : 'Sem benfeitorias',
        description: count
            ? `${count} benfeitoria(s) ativa(s) registrada(s) no QG.`
            : 'O QG está registrado, mas ainda não possui benfeitorias ativas.',
    };
}

async function listSquadMembers(db, squadKey) {
    const rows = await db.all(
        `SELECT id, nome, display_name, personagem_nome, esquadrao, estrelas,
                patente, jogo_status, ficha_status
         FROM jogadores
         WHERE esquadrao IS NOT NULL
           AND TRIM(esquadrao) <> ''
           AND TRIM(esquadrao) <> '-'`
    );
    return rows
        .filter((player) => normalizeSquadKey(player.esquadrao) === squadKey)
        .map((player) => ({
            ...player,
            displayName: displayName(player),
            stars: asNonNegativeInteger(player.estrelas),
        }))
        .sort((left, right) => right.stars - left.stars || left.displayName.localeCompare(right.displayName, 'pt-BR'));
}

async function readRecentSquadActivity(db, squadKey) {
    const row = await db.get(
        `SELECT COUNT(*) AS entries,
                COALESCE(SUM(CASE WHEN player_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS member_entries,
                COALESCE(SUM(CASE WHEN player_id IS NULL THEN 1 ELSE 0 END), 0) AS administrative_entries,
                COUNT(DISTINCT CASE WHEN player_id IS NOT NULL THEN player_id END) AS contributors,
                COALESCE(SUM(amount), 0) AS net_stars,
                COALESCE(SUM(CASE WHEN player_id IS NOT NULL THEN amount ELSE 0 END), 0) AS member_net_stars,
                COALESCE(SUM(CASE WHEN player_id IS NULL THEN amount ELSE 0 END), 0) AS administrative_net_stars,
                MAX(created_at) AS last_entry_at
         FROM clover_squad_star_ledger
         WHERE squad_key = ?
           AND datetime(created_at) >= datetime('now', '-30 days')`,
        [squadKey]
    );
    return {
        entries: asNonNegativeInteger(row?.entries),
        memberEntries: asNonNegativeInteger(row?.member_entries),
        administrativeEntries: asNonNegativeInteger(row?.administrative_entries),
        contributors: asNonNegativeInteger(row?.contributors),
        netStars: Number(row?.net_stars || 0),
        memberNetStars: Number(row?.member_net_stars || 0),
        administrativeNetStars: Number(row?.administrative_net_stars || 0),
        lastEntryAt: row?.last_entry_at || null,
    };
}

async function getSquadByKey(db, squadKey) {
    await ensureCloverSquadSchema(db);
    const normalized = normalizeSquadKey(squadKey);
    if (!normalized) return null;
    return db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [normalized]);
}

async function resolveSquad(db, {
    squadName = null,
    groupId = null,
    playerId = null,
} = {}) {
    await ensureCloverSquadSchema(db);

    if (squadName) {
        const key = normalizeSquadKey(squadName);
        if (key) {
            const direct = await db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [key]);
            if (direct) return direct;
        }
    }

    if (groupId) {
        const byGroup = await db.get('SELECT * FROM clover_squads WHERE group_id = ?', [groupId]);
        if (byGroup) return byGroup;
    }

    if (playerId) {
        const player = await db.get('SELECT esquadrao FROM jogadores WHERE id = ?', [playerId]);
        const key = normalizeSquadKey(player?.esquadrao);
        if (key) return db.get('SELECT * FROM clover_squads WHERE squad_key = ?', [key]);
    }

    return null;
}

function buildOverallReading(state) {
    const parts = [
        `${state.renown.name}, Grau ${state.renown.grade}, com ${state.historicalStars} Estrelas no histórico.`,
        `${state.currentStars} Estrelas Atuais deixam o nível de recursos como ${state.resources.label.toLowerCase()}.`,
        `O comando está ${state.command.label.toLowerCase()}.`,
    ];

    if (state.blackStars > 0) {
        parts.push(`${state.blackStars} Estrela(s) Negra(s) deixam a reputação ${state.reputation.label.toLowerCase()}.`);
    } else {
        parts.push('A reputação pública está íntegra.');
    }

    if (!state.structure.registered) {
        parts.push('A estrutura do QG ainda não pode ser medida porque as benfeitorias não estão registradas no bot.');
    } else {
        parts.push(state.structure.description);
    }

    return parts.join(' ');
}

async function getSquadState(db, squadInput) {
    const squad = typeof squadInput === 'string'
        ? await getSquadByKey(db, squadInput)
        : squadInput;
    if (!squad) return { ok: false, code: 'squad_not_found' };

    const squadKey = squad.squad_key || normalizeSquadKey(squad.name);
    const [members, recent, structure] = await Promise.all([
        listSquadMembers(db, squadKey),
        readRecentSquadActivity(db, squadKey),
        readStructureState(db, squadKey),
    ]);

    const historicalStars = asNonNegativeInteger(squad.historical_stars);
    const currentStars = asNonNegativeInteger(squad.current_stars);
    const blackStars = asNonNegativeInteger(squad.black_stars);
    const renown = getRenownGrade(historicalStars);
    const resources = getResourceBand(currentStars);
    const reputation = getReputationState(blackStars);
    const command = getCommandState(squad);
    const activity = getActivityState({
        recentEntries: recent.entries,
        recentMemberEntries: recent.memberEntries,
        recentAdministrativeEntries: recent.administrativeEntries,
        recentContributors: recent.contributors,
        recentStars: recent.memberNetStars,
        recentAdministrativeStars: recent.administrativeNetStars,
        memberCount: members.length,
    });

    const state = {
        ok: true,
        squadKey,
        squad,
        name: squad.name || squadKey,
        phrase: squad.phrase || null,
        historicalStars,
        currentStars,
        blackStars,
        renown,
        resources,
        reputation,
        command,
        activity,
        structure,
        members,
        memberCount: members.length,
        recent,
        topContributors: members.slice(0, 5),
    };
    state.overallReading = buildOverallReading(state);
    return state;
}

function section(symbol, title) {
    return `_` + '`' + `─( ${symbol} )───── ${title}` + '`' + `_`;
}

function renderSquadState(state, { prefix = '.#' } = {}) {
    if (!state?.ok) {
        return [
            '*♧┃𝐄𝐒𝐓𝐀𝐃𝐎 𝐃𝐎 𝐄𝐒𝐐𝐔𝐀𝐃𝐑𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
            '',
            '> Não encontrei esse esquadrão no banco.',
        ].join('\n');
    }

    const lines = [
        '*♧┃𝐄𝐒𝐓𝐀𝐃𝐎 𝐃𝐎 𝐄𝐒𝐐𝐔𝐀𝐃𝐑𝐀̃𝐎 𖥔 𝐂𝐥𝐨𝐯𝐞𝐫 𝐌𝐮𝐥𝐭𝐢𝐜𝐨𝐥𝐨𝐫*',
        '     ──  leitura atual de mérito, recursos e organização  ──',
        '',
        `*𝐄𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨:* ${state.name}`,
        state.phrase ? `*𝐅𝐫𝐚𝐬𝐞:* _${state.phrase}_` : null,
        `*𝐌𝐞𝐦𝐛𝐫𝐨𝐬:* ${state.memberCount}`,
        '',
        section('★', '𝗥𝗲𝗻𝗼𝗺𝗲'),
        '',
        `*𝐆𝐫𝐚𝐮 ${state.renown.grade} · ${state.renown.name}*`,
        `> ${state.historicalStars} Estrelas no Histórico. ${state.renown.description}`,
        '',
        section('✦', '𝗥𝗲𝗰𝘂𝗿𝘀𝗼𝘀'),
        '',
        `*${state.currentStars} Estrelas Atuais · ${state.resources.label}*`,
        `> ${state.resources.description}`,
        '',
        section('!', '𝗥𝗲𝗽𝘂𝘁𝗮𝗰̧𝗮̃𝗼'),
        '',
        `*${state.blackStars} Estrela(s) Negra(s) · ${state.reputation.label}*`,
        `> ${state.reputation.description}`,
        '',
        section('♜', '𝗢𝗿𝗴𝗮𝗻𝗶𝘇𝗮𝗰̧𝗮̃𝗼'),
        '',
        `*𝐂𝐨𝐦𝐚𝐧𝐝𝐨:* ${state.command.label}`,
        `> ${state.command.description}`,
        `*𝐀𝐭𝐢𝐯𝐢𝐝𝐚𝐝𝐞:* ${state.activity.label}`,
        `> ${state.activity.description}`,
        '',
        section('⌂', '𝗘𝘀𝘁𝗿𝘂𝘁𝘂𝗿𝗮'),
        '',
        `*𝐐𝐆:* ${state.structure.label}`,
        `> ${state.structure.description}`,
        '',
        section('◆', '𝗟𝗲𝗶𝘁𝘂𝗿𝗮 𝗚𝗲𝗿𝗮𝗹'),
        '',
        `> ${state.overallReading}`,
    ].filter(Boolean);

    if (state.topContributors.length) {
        lines.push('', section('◇', '𝗖𝗼𝗻𝘁𝗿𝗶𝗯𝘂𝗶𝗱𝗼𝗿𝗲𝘀'), '');
        state.topContributors.forEach((member, index) => {
            lines.push(`*${index + 1}. ${member.displayName}* · ${member.stars} Estrela(s)`);
        });
    }

    lines.push('', `> Visão básica: ${prefix}esquadrao`);
    return lines.join('\n');
}

module.exports = {
    RENOWN_GRADES,
    RESOURCE_BANDS,
    buildOverallReading,
    getActivityState,
    getCommandState,
    getRenownGrade,
    getReputationState,
    getResourceBand,
    getSquadState,
    listSquadMembers,
    readRecentSquadActivity,
    renderSquadState,
    resolveSquad,
};