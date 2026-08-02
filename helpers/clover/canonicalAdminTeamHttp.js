'use strict';

const {
    applyCanonicalAdminRoleChange,
    cancelCanonicalAdminRoleChange,
    createCanonicalAdminRoleChange,
    getCanonicalAdminRoleChange,
    listCanonicalAdminTeam,
    undoCanonicalAdminRoleChange,
} = require('./canonicalAdminTeamService');

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

function methodNotAllowed() {
    const error = new Error('Método não permitido para esta rota administrativa.');
    error.code = 'method_not_allowed';
    error.status = 405;
    return error;
}

function ownerRequired() {
    const error = new Error('Apenas o Owner pode alterar permissões administrativas.');
    error.code = 'owner_required';
    error.status = 403;
    return error;
}

function parseCanonicalAdminTeamPath(pathname) {
    const path = String(pathname || '');
    if (path === '/admin/team') return { kind: 'team' };
    if (path === '/admin/team/changes') return { kind: 'changes' };
    const match = path.match(
        /^\/admin\/team\/changes\/(AC-[A-F0-9]{8,10})(?:\/(apply|cancel|undo))?$/i
    );
    if (!match) return null;
    return {
        kind: 'change',
        code: match[1].toUpperCase(),
        command: match[2]?.toLowerCase() || 'read',
    };
}

function errorPayload(error) {
    return {
        ok: false,
        error: error?.code || 'canonical_admin_team_request_failed',
        message: error?.message || 'Não foi possível processar a Equipe ADM.',
        details: error?.details || null,
    };
}

async function handleCanonicalAdminTeamHttp(req, res, options = {}) {
    const url = new URL(req.url || '/', 'http://localhost');
    const route = parseCanonicalAdminTeamPath(url.pathname);
    if (!route) return false;

    const method = String(req.method || 'GET').toUpperCase();
    setCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const resolveContext = options.resolveAdminContext;
    if (typeof resolveContext !== 'function') {
        sendJson(res, 500, {
            ok: false,
            error: 'admin_context_resolver_missing',
            message: 'O resolvedor administrativo não foi configurado.',
            details: null,
        });
        return true;
    }

    const context = await resolveContext(req, res, options);
    if (!context) return true;
    const { db, access } = context;
    const actorId = access?.actor?.id;
    const readBody = options.readJsonBody;

    try {
        if (access?.actor?.role !== 'owner') throw ownerRequired();

        if (route.kind === 'team') {
            if (method !== 'GET') throw methodNotAllowed();
            const list = options.listTeam
                || options.teamList
                || listCanonicalAdminTeam;
            sendJson(res, 200, await list(db, {
                actorId,
                ownerActor: {
                    id: actorId,
                    displayName: context.session?.player?.personagem_nome
                        || context.session?.player?.nome
                        || access?.actor?.displayName
                        || 'Proprietário',
                },
                ownerCheck: options.ownerCheck,
                referenceDate: options.referenceDate,
                includeRevoked: url.searchParams.get('revoked') === 'true',
                changeLimit: url.searchParams.get('changes') || 30,
            }));
            return true;
        }

        if (route.kind === 'changes') {
            if (method !== 'POST') throw methodNotAllowed();
            if (typeof readBody !== 'function') {
                throw Object.assign(new Error('Leitor JSON indisponível.'), {
                    code: 'json_body_reader_missing',
                    status: 500,
                });
            }
            const body = await readBody(req);
            const create = options.createChange
                || options.teamChangeCreate
                || createCanonicalAdminRoleChange;
            sendJson(res, 201, await create(db, {
                actorId,
                targetId: body.targetId || body.playerId,
                action: body.action,
                role: body.role,
                reason: body.reason,
            }, {
                ownerCheck: options.ownerCheck,
                referenceDate: options.referenceDate,
            }));
            return true;
        }

        if (route.command === 'read') {
            if (method !== 'GET') throw methodNotAllowed();
            const getChange = options.getChange
                || options.teamChangeGet
                || getCanonicalAdminRoleChange;
            sendJson(res, 200, {
                ok: true,
                change: await getChange(db, route.code),
            });
            return true;
        }

        if (method !== 'POST') throw methodNotAllowed();
        if (route.command === 'apply') {
            const apply = options.applyChange
                || options.teamChangeApply
                || applyCanonicalAdminRoleChange;
            sendJson(res, 200, await apply(db, route.code, actorId, {
                ownerCheck: options.ownerCheck,
                referenceDate: options.referenceDate,
            }));
            return true;
        }
        if (route.command === 'cancel') {
            const cancel = options.cancelChange
                || options.teamChangeCancel
                || cancelCanonicalAdminRoleChange;
            sendJson(res, 200, await cancel(db, route.code, actorId, {
                ownerCheck: options.ownerCheck,
                referenceDate: options.referenceDate,
            }));
            return true;
        }

        if (typeof readBody !== 'function') {
            throw Object.assign(new Error('Leitor JSON indisponível.'), {
                code: 'json_body_reader_missing',
                status: 500,
            });
        }
        const body = await readBody(req);
        const undo = options.undoChange
            || options.teamChangeUndo
            || undoCanonicalAdminRoleChange;
        sendJson(res, 200, await undo(
            db,
            route.code,
            actorId,
            body.reason,
            {
                ownerCheck: options.ownerCheck,
                referenceDate: options.referenceDate,
            }
        ));
        return true;
    } catch (error) {
        sendJson(res, Number(error?.status || 400), errorPayload(error));
        return true;
    }
}

module.exports = {
    handleCanonicalAdminTeamHttp,
    parseCanonicalAdminTeamPath,
    setCors,
};
