'use strict';

const { authenticateSiteSession } = require('./siteAuthService');
const {
    CONTRACT_VERSION,
    requiredCapabilitiesForActions,
} = require('./adminOperationContract');
const { getAdminActorAccess } = require('./adminAccessService');
const { searchAdminPlayers } = require('./adminPlayerSearchService');
const { getAdminPlayerDetail } = require('./adminPlayerDetailService');
const {
    applyAdminOperation,
    approveAdminOperation,
    createAdminOperation,
    getOperationByCode,
    listAdminOperations,
    simulateAdminOperation,
    undoAdminOperation,
} = require('./adminOperationService');
const { getAdminOperationExecutors } = require('./adminOperationRegistry');
const { getTraitTemplate, listTraitTemplates } = require('./adminTraitService');
const {
    applyAdminAccessChange,
    cancelAdminAccessChange,
    createAdminAccessChange,
    getAdminAccessChange,
    listAdminTeam,
    undoAdminAccessChange,
} = require('./adminTeamService');
const { diagnoseDatabaseIntegrity } = require('./databaseIntegrityService');
const { routeDescriptor } = require('./httpRouteDescriptor');

const ADMIN_BASE_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'admin.bootstrap', methods: ['GET'], template: '/admin/bootstrap', samplePath: '/admin/bootstrap', match: (path) => path === '/admin/bootstrap', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-bootstrap-v1' }),
    routeDescriptor({ id: 'admin.players.search', methods: ['GET'], template: '/admin/players/search', samplePath: '/admin/players/search', match: (path) => path === '/admin/players/search', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-player-search-v1', contractShapeId: 'admin-player-search-shape-v1' }),
    routeDescriptor({ id: 'admin.integrity.summary', methods: ['GET'], template: '/admin/integrity/summary', samplePath: '/admin/integrity/summary', match: (path) => path === '/admin/integrity/summary', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-integrity-summary-v1', contractShapeId: 'admin-integrity-summary-shape-v1' }),
]);

const ADMIN_SECTIONS = Object.freeze([
    {
        key: 'operations',
        label: 'Operações',
        description: 'Criar, simular, aplicar e acompanhar alterações administrativas.',
        capability: 'operation.view',
    },
    {
        key: 'team',
        label: 'Equipe ADM',
        description: 'Conceder, trocar e revogar cargos administrativos com revisão protegida.',
        ownerOnly: true,
    },
    {
        key: 'players',
        label: 'Jogadores',
        description: 'Consultar fichas, vínculos, traços, itens e histórico.',
        capability: 'player.view',
    },
    {
        key: 'traits',
        label: 'Traços',
        description: 'Organizar o catálogo e atribuir traços do sistema.',
        capability: 'catalog.view',
    },
    {
        key: 'skill-approvals',
        label: 'Aprovações de Árvore',
        description: 'Revisar nós especiais antes da compra e do gasto de PH.',
        capability: 'catalog.view',
    },
    {
        key: 'trees',
        label: 'Árvores',
        description: 'Versionar o catálogo de Árvores, revisar nós e ativar mudanças com prévia protegida.',
        capability: 'catalog.view',
    },
    {
        key: 'shops',
        label: 'Lojas NPC',
        description: 'Versionar preços, disponibilidade, limites e janelas das lojas sem editar runtime diretamente.',
        capability: 'catalog.view',
    },
    {
        key: 'items',
        label: 'Itens',
        description: 'Criar modelos, versões, propriedades e cópias de itens.',
        capability: 'catalog.view',
    },
    {
        key: 'hooks',
        label: 'Ganchos',
        description: 'Criar e acompanhar ganchos narrativos dos personagens.',
        capability: 'catalog.view',
    },
    {
        key: 'rewards',
        label: 'Recompensas',
        description: 'Preparar pacotes, recursos, caixas e entregas em lote.',
        capability: 'catalog.view',
    },
    {
        key: 'boxes',
        label: 'Caixas',
        description: 'Versionar catálogos, revisar pity, relíquias e recibos de abertura.',
        capability: 'catalog.view',
    },
    {
        key: 'raids',
        label: 'Raids e Missões',
        description: 'Revisar participantes, condições e premiações pendentes.',
        capability: 'raid.view',
    },
    {
        key: 'market',
        label: 'Mercado',
        description: 'Moderar anúncios, reservas e estados econômicos sem burlar o motor do Mercado.',
        capability: 'market.view',
    },
    {
        key: 'dream-worlds',
        label: 'Mundos dos Sonhos',
        description: 'Aquisições, candidaturas, incursões, fendas e Fragmentos de Ressonância.',
        capability: 'raid.view',
    },
    {
        key: 'integrity',
        label: 'Integridade',
        description: 'Visualizar conflitos de identidade e referências quebradas.',
        capability: 'integrity.view',
    },
    {
        key: 'history',
        label: 'Histórico',
        description: 'Consultar operações, responsáveis, falhas e desfazimentos.',
        capability: 'operation.view',
    },
]);

function setAdminCors(req, res) {
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

function bearerToken(req) {
    const value = String(req.headers?.authorization || '').trim();
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function defaultAuthenticate(db, req) {
    return authenticateSiteSession(db, bearerToken(req));
}

function hasCapability(access, capability) {
    return Boolean(access?.actor?.capabilities?.includes(capability));
}

function requireCapability(access, capability) {
    if (hasCapability(access, capability)) return;
    const error = new Error('Seu perfil não possui a permissão necessária.');
    error.code = 'missing_capability';
    error.status = 403;
    error.details = { capability };
    throw error;
}

function requireOwnerRole(access) {
    if (access?.actor?.role === 'owner') return;
    const error = new Error('Apenas o Proprietário pode administrar a Equipe ADM.');
    error.code = 'owner_required';
    error.status = 403;
    throw error;
}

function requireActionCapabilities(access, actions) {
    const required = requiredCapabilitiesForActions(Array.isArray(actions) ? actions : []);
    const missing = required.filter((capability) => !hasCapability(access, capability));
    if (!missing.length) return;
    const error = new Error('Seu perfil não pode executar todas as ações desta operação.');
    error.code = 'forbidden_actions';
    error.status = 403;
    error.details = { missing };
    throw error;
}

async function readJsonBody(req, maximumBytes = 256 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > maximumBytes) {
            const error = new Error('Corpo da requisição grande demais.');
            error.code = 'payload_too_large';
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        const error = new Error('JSON inválido.');
        error.code = 'invalid_json';
        error.status = 400;
        throw error;
    }
}

async function resolveAdminContext(req, res, options) {
    const db = options.getDb?.();
    if (!db) {
        sendJson(res, 503, {
            ok: false,
            error: 'database_unavailable',
            message: 'O banco ainda não está pronto.',
        });
        return null;
    }

    const authenticate = options.authenticateSession || defaultAuthenticate;
    const auth = await authenticate(db, req);
    if (!auth?.ok || !auth.player?.id) {
        sendJson(res, 401, {
            ok: false,
            error: auth?.reason || 'invalid_session',
            message: 'Sessão inválida ou expirada.',
        });
        return null;
    }

    const accessResolver = options.accessResolver || getAdminActorAccess;
    const access = await accessResolver(db, auth.player.id, options.accessOptions || {});
    if (!access?.ok) {
        sendJson(res, 403, {
            ok: false,
            error: access?.code || 'admin_access_denied',
            message: 'Sua conta não possui acesso à Central ADM.',
        });
        return null;
    }

    return { db, auth, access };
}

function parsePlayerDetailPath(pathname) {
    const match = String(pathname || '').match(/^\/admin\/players\/([^/]+)$/);
    if (!match || match[1] === 'search') return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

function parseOperationPath(pathname) {
    const match = String(pathname || '').match(/^\/admin\/operations\/(OP-[A-F0-9]{6})(?:\/(simulate|approve|apply|undo))?$/i);
    if (!match) return null;
    return { code: match[1].toUpperCase(), command: match[2] || null };
}

function parseTraitDetailPath(pathname) {
    const match = String(pathname || '').match(/^\/admin\/traits\/(TR-[A-F0-9]{8})$/i);
    return match ? match[1].toUpperCase() : null;
}

function parseTeamChangePath(pathname) {
    const match = String(pathname || '').match(/^\/admin\/team\/changes\/(AC-[A-F0-9]{8})(?:\/(apply|undo|cancel))?$/i);
    if (!match) return null;
    return { code: match[1].toUpperCase(), command: match[2] || null };
}

const ADMIN_DYNAMIC_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id: 'admin.team.read', methods: ['GET'], template: '/admin/team', samplePath: '/admin/team', match: (p) => p === '/admin/team', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-team-v1' }),
    routeDescriptor({ id: 'admin.team.change.create', methods: ['POST'], template: '/admin/team/changes', samplePath: '/admin/team/changes', match: (p) => p === '/admin/team/changes', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-team-change-v1' }),
    routeDescriptor({ id: 'admin.team.change.detail', methods: ['GET'], template: '/admin/team/changes/:changeId', samplePath: '/admin/team/changes/AC-A1B2C3D4', match: (p) => parseTeamChangePath(p)?.command === null, handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-team-change-v1' }),
    routeDescriptor({ id: 'admin.team.change.apply', methods: ['POST'], template: '/admin/team/changes/:changeId/apply', samplePath: '/admin/team/changes/AC-A1B2C3D4/apply', match: (p) => parseTeamChangePath(p)?.command === 'apply', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-team-change-v1' }),
    routeDescriptor({ id: 'admin.team.change.undo', methods: ['POST'], template: '/admin/team/changes/:changeId/undo', samplePath: '/admin/team/changes/AC-A1B2C3D4/undo', match: (p) => parseTeamChangePath(p)?.command === 'undo', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-team-change-v1' }),
    routeDescriptor({ id: 'admin.team.change.cancel', methods: ['POST'], template: '/admin/team/changes/:changeId/cancel', samplePath: '/admin/team/changes/AC-A1B2C3D4/cancel', match: (p) => parseTeamChangePath(p)?.command === 'cancel', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-team-change-v1' }),
    routeDescriptor({ id: 'admin.player.detail', methods: ['GET'], template: '/admin/players/:playerId', samplePath: '/admin/players/PL-TEST', match: (p) => Boolean(parsePlayerDetailPath(p)), handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-player-detail-v1', contractShapeId: 'admin-player-detail-shape-v1' }),
    routeDescriptor({ id: 'admin.operations.collection', methods: ['GET', 'POST'], template: '/admin/operations', samplePath: '/admin/operations', match: (p) => p === '/admin/operations', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-operations-v1', contractShapeId: 'admin-operations-collection-shape-v1' }),
    routeDescriptor({ id: 'admin.operation.detail', methods: ['GET'], template: '/admin/operations/:operationId', samplePath: '/admin/operations/OP-A1B2C3', match: (p) => parseOperationPath(p)?.command === null, handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-operation-v1', contractShapeId: 'admin-operation-detail-shape-v1' }),
    routeDescriptor({ id: 'admin.operation.simulate', methods: ['POST'], template: '/admin/operations/:operationId/simulate', samplePath: '/admin/operations/OP-A1B2C3/simulate', match: (p) => parseOperationPath(p)?.command === 'simulate', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-operation-v1', contractShapeId: 'admin-operation-simulate-shape-v1' }),
    routeDescriptor({ id: 'admin.operation.approve', methods: ['POST'], template: '/admin/operations/:operationId/approve', samplePath: '/admin/operations/OP-A1B2C3/approve', match: (p) => parseOperationPath(p)?.command === 'approve', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-operation-v1', contractShapeId: 'admin-operation-approve-shape-v1' }),
    routeDescriptor({ id: 'admin.operation.apply', methods: ['POST'], template: '/admin/operations/:operationId/apply', samplePath: '/admin/operations/OP-A1B2C3/apply', match: (p) => parseOperationPath(p)?.command === 'apply', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-operation-v1', contractShapeId: 'admin-operation-apply-shape-v1' }),
    routeDescriptor({ id: 'admin.operation.undo', methods: ['POST'], template: '/admin/operations/:operationId/undo', samplePath: '/admin/operations/OP-A1B2C3/undo', match: (p) => parseOperationPath(p)?.command === 'undo', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-operation-v1', contractShapeId: 'admin-operation-undo-shape-v1' }),
    routeDescriptor({ id: 'admin.traits.collection', methods: ['GET'], template: '/admin/traits', samplePath: '/admin/traits', match: (p) => p === '/admin/traits', handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-traits-v1', contractShapeId: 'admin-traits-list-shape-v1' }),
    routeDescriptor({ id: 'admin.trait.detail', methods: ['GET'], template: '/admin/traits/:traitId', samplePath: '/admin/traits/TR-A1B2C3D4', match: (p) => Boolean(parseTraitDetailPath(p)), handlerOwner: 'handleAdminApiSupport', sourceFile: 'helpers/clover/adminApiSupportBase.js', authClass: 'ADMIN_CAPABILITY', contractId: 'admin-trait-v1', contractShapeId: 'admin-trait-detail-shape-v1' }),
]);
const ADMIN_ROUTE_DESCRIPTORS = Object.freeze([...ADMIN_BASE_ROUTE_DESCRIPTORS, ...ADMIN_DYNAMIC_ROUTE_DESCRIPTORS]);

function isRecognizedAdminPath(url) {
    return ADMIN_ROUTE_DESCRIPTORS.some((route) => route.match(url.pathname));
}

async function handleAdminApiSupport(req, res, options = {}) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    if (!isRecognizedAdminPath(url)) return false;

    setAdminCors(req, res);
    if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return true;
    }

    const context = await resolveAdminContext(req, res, options);
    if (!context) return true;
    const { db, auth, access } = context;
    const actor = { id: access.actor.id, role: access.actor.role };
    const executors = options.executors || getAdminOperationExecutors();

    try {
        if (url.pathname === '/admin/bootstrap') {
            if (method !== 'GET') throw methodNotAllowed();
            const capabilitySet = new Set(access.actor.capabilities || []);
            const sections = ADMIN_SECTIONS.filter((section) => (
                section.ownerOnly
                    ? access.actor.role === 'owner'
                    : capabilitySet.has(section.capability)
            ));
            sendJson(res, 200, {
                ok: true,
                actor: {
                    id: access.actor.id,
                    displayName: auth.player.personagem_nome || auth.player.nome || null,
                    role: access.actor.role,
                    capabilities: [...capabilitySet],
                },
                contractVersion: CONTRACT_VERSION,
                sections,
            });
            return true;
        }

        const teamChangePath = parseTeamChangePath(url.pathname);
        if (url.pathname === '/admin/team' || url.pathname === '/admin/team/changes' || teamChangePath) {
            requireOwnerRole(access);

            if (url.pathname === '/admin/team') {
                if (method !== 'GET') throw methodNotAllowed();
                const teamList = options.teamList || listAdminTeam;
                sendJson(res, 200, await teamList(db, {
                    ownerActor: {
                        id: access.actor.id,
                        displayName: auth.player.personagem_nome || auth.player.nome || null,
                    },
                    includeRevoked: ['1', 'true', 'yes'].includes(
                        String(url.searchParams.get('revoked') || '').toLowerCase()
                    ),
                    changeLimit: url.searchParams.get('changes') || undefined,
                }));
                return true;
            }

            if (url.pathname === '/admin/team/changes') {
                if (method !== 'POST') throw methodNotAllowed();
                const body = await readJsonBody(req);
                const createChange = options.teamChangeCreate || createAdminAccessChange;
                sendJson(res, 201, await createChange(db, {
                    actorId: actor.id,
                    targetId: body.targetId,
                    action: body.action,
                    role: body.role,
                    reason: body.reason,
                }, options.accessOptions || {}));
                return true;
            }

            if (teamChangePath) {
                if (!teamChangePath.command) {
                    if (method !== 'GET') throw methodNotAllowed();
                    const getChange = options.teamChangeGet || getAdminAccessChange;
                    sendJson(res, 200, {
                        ok: true,
                        change: await getChange(db, teamChangePath.code),
                    });
                    return true;
                }

                if (method !== 'POST') throw methodNotAllowed();
                const body = await readJsonBody(req);

                if (teamChangePath.command === 'apply') {
                    const applyChange = options.teamChangeApply || applyAdminAccessChange;
                    sendJson(res, 200, await applyChange(
                        db,
                        teamChangePath.code,
                        actor.id,
                        options.accessOptions || {}
                    ));
                    return true;
                }

                if (teamChangePath.command === 'undo') {
                    const undoChange = options.teamChangeUndo || undoAdminAccessChange;
                    sendJson(res, 200, await undoChange(
                        db,
                        teamChangePath.code,
                        actor.id,
                        body.reason,
                        options.accessOptions || {}
                    ));
                    return true;
                }

                if (teamChangePath.command === 'cancel') {
                    const cancelChange = options.teamChangeCancel || cancelAdminAccessChange;
                    sendJson(res, 200, await cancelChange(
                        db,
                        teamChangePath.code,
                        actor.id,
                        options.accessOptions || {}
                    ));
                    return true;
                }
            }
        }

        const playerDetailId = parsePlayerDetailPath(url.pathname);
        if (url.pathname === '/admin/players/search' || playerDetailId) {
            if (method !== 'GET') throw methodNotAllowed();
            requireCapability(access, 'player.view');
            if (playerDetailId) {
                const detailResolver = options.playerDetail || getAdminPlayerDetail;
                sendJson(res, 200, await detailResolver(db, playerDetailId));
                return true;
            }
            const search = options.playerSearch || searchAdminPlayers;
            sendJson(res, 200, await search(db, url.searchParams.get('q') || '', {
                limit: url.searchParams.get('limit') || undefined,
            }));
            return true;
        }

        if (url.pathname === '/admin/traits' || parseTraitDetailPath(url.pathname)) {
            if (method !== 'GET') throw methodNotAllowed();
            requireCapability(access, 'catalog.view');
            const traitId = parseTraitDetailPath(url.pathname);
            if (traitId) {
                const traitGet = options.traitGet || getTraitTemplate;
                sendJson(res, 200, { ok: true, trait: await traitGet(db, traitId) });
                return true;
            }
            const traitList = options.traitList || listTraitTemplates;
            sendJson(res, 200, await traitList(db, {
                query: url.searchParams.get('q') || '',
                slotKey: url.searchParams.get('slot') || '',
                includeArchived: ['1', 'true', 'yes'].includes(String(url.searchParams.get('archived') || '').toLowerCase()),
                limit: url.searchParams.get('limit') || undefined,
            }));
            return true;
        }

        if (url.pathname === '/admin/integrity/summary') {
            if (method !== 'GET') throw methodNotAllowed();
            requireCapability(access, 'integrity.view');
            const integritySummary = options.integritySummary || diagnoseDatabaseIntegrity;
            sendJson(res, 200, await integritySummary(db, {
                sampleLimit: url.searchParams.get('sampleLimit') || undefined,
            }));
            return true;
        }

        if (url.pathname === '/admin/operations') {
            if (method === 'GET') {
                requireCapability(access, 'operation.view');
                const listOperations = options.operationList || listAdminOperations;
                sendJson(res, 200, await listOperations(db, {
                    status: url.searchParams.get('status') || '',
                    query: url.searchParams.get('q') || '',
                    actorId: url.searchParams.get('mine') === 'true' ? actor.id : '',
                    limit: url.searchParams.get('limit') || undefined,
                }));
                return true;
            }
            if (method === 'POST') {
                requireCapability(access, 'operation.draft');
                const body = await readJsonBody(req);
                requireActionCapabilities(access, body.actions);
                const createOperation = options.operationCreate || createAdminOperation;
                const idempotencyKey = String(req.headers?.['idempotency-key'] || body.idempotencyKey || '').trim();
                const result = await createOperation(db, {
                    ...body,
                    ...(idempotencyKey ? { idempotencyKey } : {}),
                    metadata: { ...(body.metadata || {}), source: body.metadata?.source || 'admin_site' },
                }, actor);
                sendJson(res, result.duplicate ? 200 : 201, result);
                return true;
            }
            throw methodNotAllowed();
        }

        const operationPath = parseOperationPath(url.pathname);
        if (operationPath) {
            if (!operationPath.command) {
                if (method !== 'GET') throw methodNotAllowed();
                requireCapability(access, 'operation.view');
                const getOperation = options.operationGet || getOperationByCode;
                sendJson(res, 200, {
                    ok: true,
                    operation: await getOperation(db, operationPath.code, { includeEvents: true, includeUnits: true }),
                });
                return true;
            }
            if (method !== 'POST') throw methodNotAllowed();
            const body = await readJsonBody(req);
            const getOperation = options.operationGet || getOperationByCode;
            const operation = await getOperation(db, operationPath.code, { includeEvents: true, includeUnits: true });
            requireActionCapabilities(access, operation.actions);

            if (operationPath.command === 'simulate') {
                requireCapability(access, 'operation.simulate');
                const simulate = options.operationSimulate || simulateAdminOperation;
                sendJson(res, 200, await simulate(db, operationPath.code, actor, { executors }));
                return true;
            }
            if (operationPath.command === 'approve') {
                requireCapability(access, 'operation.apply');
                const approve = options.operationApprove || approveAdminOperation;
                sendJson(res, 200, await approve(db, operationPath.code, actor));
                return true;
            }
            if (operationPath.command === 'apply') {
                requireCapability(access, 'operation.apply');
                const apply = options.operationApply || applyAdminOperation;
                const result = await apply(db, operationPath.code, actor, { executors });
                sendJson(res, result.ok ? 200 : 409, result);
                return true;
            }
            if (operationPath.command === 'undo') {
                requireCapability(access, 'operation.undo');
                if (!String(body.reason || '').trim()) {
                    const error = new Error('Informe o motivo para desfazer a operação.');
                    error.code = 'missing_undo_reason';
                    error.status = 400;
                    throw error;
                }
                const undo = options.operationUndo || undoAdminOperation;
                sendJson(res, 200, await undo(db, operationPath.code, actor, {
                    executors,
                    reason: String(body.reason).trim(),
                }));
                return true;
            }
        }

        return false;
    } catch (error) {
        sendJson(res, Number(error?.status || 400), {
            ok: false,
            error: error?.code || 'admin_request_failed',
            message: error?.message || 'Não foi possível concluir a solicitação administrativa.',
            details: error?.details || null,
        });
        return true;
    }
}

function methodNotAllowed() {
    const error = new Error('Método não permitido para esta rota administrativa.');
    error.code = 'method_not_allowed';
    error.status = 405;
    return error;
}

module.exports = {
    ADMIN_SECTIONS,
    ADMIN_BASE_ROUTE_DESCRIPTORS,
    ADMIN_DYNAMIC_ROUTE_DESCRIPTORS,
    ADMIN_ROUTE_DESCRIPTORS,
    handleAdminApiSupport,
    isRecognizedAdminPath,
    parseOperationPath,
    parsePlayerDetailPath,
    parseTeamChangePath,
    parseTraitDetailPath,
    readJsonBody,
    resolveAdminContext,
};
