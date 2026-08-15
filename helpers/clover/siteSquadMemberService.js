'use strict';

const { isSameUser } = require('../groupAccess');
const { normalizeSquadKey } = require('./cavalierService');
const { listEffectiveSquadMembers } = require('./squadMembershipReadService');
const {
    ACCESS_PERMISSIONS,
    authorizeSquadAccess,
} = require('./accessIntegrationService');
const { resolveSquad } = require('./squadStateService');

function filled(value) {
    const text = String(value || '').trim();
    return text && text !== '-' ? text : null;
}

function displayName(player = {}) {
    return filled(player.personagem_nome)
        || filled(player.display_name)
        || filled(player.nome)
        || 'Membro sem nome';
}

function normalizeStatus(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function availabilityLabel(player = {}) {
    const game = normalizeStatus(player.jogo_status);
    const profile = normalizeStatus(player.ficha_status);
    if (game === 'liberado') return 'Liberado';
    if (['aprovada', 'aprovado', 'confirmada', 'confirmado'].includes(profile)) {
        return 'Cadastro aprovado';
    }
    return 'Em preparação';
}

function leadershipLabel(playerId, squad = {}) {
    if (isSameUser(playerId, squad.captain_player_id)) return 'Capitão';
    if (isSameUser(playerId, squad.vice_captain_player_id)) return 'Vice-Capitão';
    return null;
}

function safeStars(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.trunc(number));
}

function serializeMember(player, squad) {
    return {
        name: displayName(player),
        leadership: leadershipLabel(player.id, squad),
        rank: filled(player.patente),
        magic: filled(player.magia),
        grimoire: filled(player.grimorio),
        race: filled(player.raca),
        className: filled(player.classe),
        stars: safeStars(player.estrelas),
        availability: availabilityLabel(player),
        image: filled(player.site_profile_image_data),
    };
}

function leadershipPriority(member) {
    if (member.leadership === 'Capitão') return 0;
    if (member.leadership === 'Vice-Capitão') return 1;
    return 2;
}

async function listSquadRows(db, squadKey) {
    const result = await listEffectiveSquadMembers(db, squadKey);
    return result.members;
}

async function getSquadMemberDirectory(db, {
    actorId,
    squadInput,
}) {
    const squad = typeof squadInput === 'object' && squadInput?.squad_key
        ? squadInput
        : await resolveSquad(db, { squadName: squadInput });
    if (!squad) return { ok: false, code: 'squad_not_found' };

    const access = await authorizeSquadAccess(db, {
        actorId,
        squad,
        permission: ACCESS_PERMISSIONS.SQUAD_MEMBERS_READ,
        allowMemberRead: true,
    });
    if (!access.ok) {
        return {
            ok: false,
            code: 'forbidden',
            squadKey: squad.squad_key,
        };
    }

    const members = (await listSquadRows(db, squad.squad_key))
        .map((player) => serializeMember(player, squad))
        .sort((left, right) => (
            leadershipPriority(left) - leadershipPriority(right)
            || right.stars - left.stars
            || left.name.localeCompare(right.name, 'pt-BR')
        ));

    return {
        ok: true,
        access: access.code,
        squad: {
            key: squad.squad_key,
            name: filled(squad.name) || squad.squad_key,
        },
        memberCount: members.length,
        members,
    };
}

module.exports = {
    availabilityLabel,
    displayName,
    getSquadMemberDirectory,
    leadershipLabel,
    leadershipPriority,
    listSquadRows,
    serializeMember,
};
