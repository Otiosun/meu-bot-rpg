'use strict';

const { isSameUser, normalizeJid } = require('../groupAccess');
const { hasAccessPermission } = require('./accessControlService');
const { authenticateSiteSession } = require('./siteAuthService');

const ALLOWED_STATUSES = new Set(['pending', 'returned', 'approved', 'rejected', 'delivered']);

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function bearerToken(req) {
    const match = String(req.headers?.authorization || '').trim().match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function filled(value) {
    const text = String(value || '').trim();
    return text && text !== '-' ? text : null;
}

function normalizeStatus(value) {
    const status = String(value || 'pending').trim().toLowerCase();
    return ALLOWED_STATUSES.has(status) ? status : 'pending';
}

function playerDisplayName(row, fallback = 'Personagem') {
    return filled(row?.personagem_nome)
        || filled(row?.display_name)
        || filled(row?.nome)
        || fallback;
}

function squadDisplayName(row, fallback) {
    return filled(row?.name)
        || filled(row?.display_name)
        || filled(row?.nome)
        || fallback;
}

async function readPlayerNames(db, ids) {
    const unique = [...new Set((ids || []).map((id) => normalizeJid(id)).filter(Boolean))];
    if (!unique.length) return new Map();
    const placeholders = unique.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT *
         FROM jogadores
         WHERE id IN (${placeholders})`,
        unique
    ).catch(() => []);
    return new Map((rows || []).map((row) => [normalizeJid(row.id), playerDisplayName(row)]));
}

async function readSquadNames(db, keys) {
    const unique = [...new Set((keys || []).map((key) => String(key || '').trim()).filter(Boolean))];
    if (!unique.length) return new Map();
    const placeholders = unique.map(() => '?').join(', ');
    const rows = await db.all(
        `SELECT *
         FROM clover_squads
         WHERE squad_key IN (${placeholders})`,
        unique
    ).catch(() => []);
    return new Map((rows || []).map((row) => {
        const key = String(row.squad_key);
        return [key, squadDisplayName(row, key)];
    }));
}

function rewardTargetLabel(reward, playerNames) {
    const playerId = normalizeJid(reward?.targetPlayerId);
    if (playerId) return playerNames.get(playerId) || 'Personagem não identificado';
    const type = String(reward?.targetType || '').trim().toLowerCase();
    if (type === 'participants' || type === 'raid_participants') return 'Participantes elegíveis';
    if (type === 'squad') return 'Esquadrão da Raid';
    if (type === 'all') return 'Todos os elegíveis';
    return null;
}

async function serializeProposalForReview(db, row, actorId) {
    const snapshot = safeJsonParse(row.snapshot_json, {});
    const rewards = Array.isArray(snapshot.rewards) ? snapshot.rewards : [];
    const participants = Array.isArray(snapshot.participants) ? snapshot.participants : [];

    const playerIds = [
        row.proposed_by,
        ...rewards.map((reward) => reward?.targetPlayerId),
        ...participants.map((participant) => participant?.playerId),
    ];
    const playerNames = await readPlayerNames(db, playerIds);
    const squadKeys = [
        row.scope_squad_key,
        ...participants.map((participant) => participant?.starBeneficiarySquadKey),
    ];
    const squadNames = await readSquadNames(db, squadKeys);
    const actor = normalizeJid(actorId);
    const selfReviewBlocked = Boolean(actor && isSameUser(actor, row.proposed_by));
    const status = normalizeStatus(row.status);

    return {
        id: String(row.id),
        raidId: String(row.raid_id),
        raidKey: row.raid_key,
        raidName: row.raid_name,
        squad: row.scope_squad_key
            ? {
                key: row.scope_squad_key,
                name: squadNames.get(String(row.scope_squad_key)) || row.scope_squad_key,
            }
            : null,
        proposer: {
            displayName: playerNames.get(normalizeJid(row.proposed_by)) || 'Proponente',
        },
        status,
        proposedAt: row.proposed_at,
        reviewedAt: row.reviewed_at || null,
        reviewNote: filled(row.review_note),
        canReview: Boolean(status === 'pending' && !selfReviewBlocked),
        selfReviewBlocked,
        snapshot: {
            version: Number(row.snapshot_version || snapshot.version || 1),
            fingerprint: String(row.snapshot_hash || '').slice(0, 12) || null,
            rewards: rewards.map((reward) => ({
                id: Number(reward?.id) || null,
                targetType: filled(reward?.targetType),
                targetDisplayName: rewardTargetLabel(reward, playerNames),
                rewardType: filled(reward?.rewardType),
                amount: Number(reward?.amount || 0),
                templateKey: filled(reward?.templateKey),
                resourceKey: filled(reward?.resourceKey),
                label: filled(reward?.label) || filled(reward?.rewardType) || 'Recompensa',
                reason: filled(reward?.reason),
                status: filled(reward?.status),
            })),
            participants: participants.map((participant) => {
                const playerId = normalizeJid(participant?.playerId);
                const beneficiaryKey = filled(participant?.starBeneficiarySquadKey);
                return {
                    displayName: playerNames.get(playerId) || 'Personagem não identificado',
                    status: filled(participant?.status),
                    finalizationStatus: filled(participant?.finalizationStatus) || 'pending',
                    starBeneficiarySquad: beneficiaryKey
                        ? {
                            key: beneficiaryKey,
                            name: squadNames.get(beneficiaryKey) || beneficiaryKey,
                        }
                        : null,
                };
            }),
        },
    };
}

async function listReviewProposals(db, actorId, status) {
    const rows = await db.all(
        `SELECT p.*, r.raid_key, r.name AS raid_name, r.scope_squad_key
         FROM clover_raid_reward_proposals p
         JOIN clover_raids r ON r.id = p.raid_id
         WHERE p.status = ?
         ORDER BY p.proposed_at ASC, p.id ASC`,
        [normalizeStatus(status)]
    );
    return Promise.all((rows || []).map((row) => serializeProposalForReview(db, row, actorId)));
}

function isAdminRaidRewardReviewReadPath(pathname) {
    return String(pathname || '') === '/admin/raid-reward-proposals';
}

async function handleAdminRaidRewardReviewReadHttp(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (!isAdminRaidRewardReviewReadPath(url.pathname)) return false;

    setCors(req, res);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }
    if (method !== 'GET') {
        sendJson(res, 405, {
            ok: false,
            error: 'method_not_allowed',
            message: 'Método não permitido para a fila administrativa de recompensas.',
        });
        return true;
    }

    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, {
            ok: false,
            error: 'database_unavailable',
            message: 'Banco ainda não está pronto.',
        });
        return true;
    }

    try {
        const authenticate = options.authenticateSession || authenticateSiteSession;
        const auth = await authenticate(db, bearerToken(req));
        if (!auth?.ok || !auth.player?.id) {
            sendJson(res, 401, {
                ok: false,
                error: auth?.reason || 'invalid_session',
                message: 'Sessão inválida ou expirada.',
            });
            return true;
        }

        const permissionCheck = options.permissionCheck || hasAccessPermission;
        if (!await permissionCheck(db, auth.player.id, 'raid.reward.review')) {
            sendJson(res, 403, {
                ok: false,
                error: 'forbidden',
                message: 'Seu perfil não pode revisar recompensas de Raid.',
            });
            return true;
        }

        const status = normalizeStatus(url.searchParams.get('status'));
        const list = options.listProposals || listReviewProposals;
        const proposals = await list(db, auth.player.id, status);
        sendJson(res, 200, {
            ok: true,
            status,
            proposals,
        });
        return true;
    } catch (error) {
        sendJson(res, Number(error?.status || 500), {
            ok: false,
            error: error?.code || 'raid_reward_review_read_failed',
            message: error?.message || 'Não foi possível carregar a fila de revisão.',
        });
        return true;
    }
}

module.exports = {
    ALLOWED_STATUSES,
    handleAdminRaidRewardReviewReadHttp,
    isAdminRaidRewardReviewReadPath,
    listReviewProposals,
    serializeProposalForReview,
};
