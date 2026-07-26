'use strict';

const crypto = require('node:crypto');

const {
    getYullsSummary,
    spendYullsInTransaction,
} = require('./yullsService');

const PUBLIC_WORLD_STATUSES = new Set([
    'announced',
    'available',
    'reserved',
    'forming_group',
    'running',
    'completed',
    'cancelled',
]);

const ACTIVE_REQUEST_STATUSES = new Set([
    'submitted',
    'under_review',
    'awaiting_confirmation',
    'approved',
]);

class DreamWorldsServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DreamWorldsServiceError';
        this.code = code;
        this.details = details;
    }
}

function normalizeOptional(value) {
    const text = String(value ?? '').trim();
    return text || null;
}

function normalizeRequired(value, field, label = field) {
    const text = normalizeOptional(value);
    if (!text) {
        throw new DreamWorldsServiceError(`missing_${field}`, `Informe ${label}.`);
    }
    return text;
}

function asInteger(value, options = {}) {
    const number = Number(value);
    const min = Number(options.min ?? 0);
    const max = Number(options.max ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isInteger(number) || number < min || number > max) {
        throw new DreamWorldsServiceError(
            options.code || 'invalid_number',
            options.message || 'Valor numérico inválido.',
            { value, min, max }
        );
    }
    return number;
}

function serializeJson(value) {
    if (value === null || value === undefined) return null;
    return JSON.stringify(value);
}

function parseJson(value, fallback) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch {
        return fallback;
    }
}

function slugify(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 90);
}

function operationKey(prefix) {
    const year = new Date().getFullYear();
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
    return `${prefix}-${year}-${suffix}`;
}

function worldStatus(value) {
    const status = String(value || 'draft').trim().toLowerCase();
    const allowed = new Set([
        'draft',
        'announced',
        'available',
        'reserved',
        'forming_group',
        'running',
        'completed',
        'cancelled',
    ]);
    if (!allowed.has(status)) {
        throw new DreamWorldsServiceError('invalid_world_status', 'Estado de Mundo dos Sonhos inválido.');
    }
    return status;
}

function dreamType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (!['self', 'assumed_identity', 'mixed'].includes(type)) {
        throw new DreamWorldsServiceError('invalid_dream_type', 'Tipo de Mundo dos Sonhos inválido.');
    }
    return type;
}

function paymentMethod(value) {
    const method = String(value || '').trim().toLowerCase();
    if (!['yulls', 'manual'].includes(method)) {
        throw new DreamWorldsServiceError('invalid_payment_method', 'Forma de aquisição inválida.');
    }
    return method;
}

function buyerType(value) {
    const type = String(value || 'player').trim().toLowerCase();
    if (!['player', 'squad'].includes(type)) {
        throw new DreamWorldsServiceError('invalid_buyer_type', 'Comprador inválido.');
    }
    return type;
}

function defaultSlotDistribution(maxPlayers) {
    const squad = Math.floor(maxPlayers * 0.4);
    const invited = Math.floor(maxPlayers * 0.3);
    return {
        squad,
        invited,
        public: maxPlayers - squad - invited,
    };
}

function normalizeSlotDistribution(maxPlayers, input = {}) {
    const defaults = defaultSlotDistribution(maxPlayers);
    const squad = asInteger(input.squad ?? input.squadSlots ?? defaults.squad, {
        min: 0,
        max: maxPlayers,
        code: 'invalid_squad_slots',
        message: 'Quantidade de vagas de esquadrão inválida.',
    });
    const invited = asInteger(input.invited ?? input.invitedSlots ?? defaults.invited, {
        min: 0,
        max: maxPlayers,
        code: 'invalid_invited_slots',
        message: 'Quantidade de vagas de indicação inválida.',
    });
    const publicSlots = asInteger(input.public ?? input.publicSlots ?? defaults.public, {
        min: 0,
        max: maxPlayers,
        code: 'invalid_public_slots',
        message: 'Quantidade de vagas públicas inválida.',
    });
    if (squad + invited + publicSlots !== maxPlayers) {
        throw new DreamWorldsServiceError(
            'invalid_slot_distribution',
            'A distribuição de vagas precisa somar o máximo de magos.',
            { squad, invited, public: publicSlots, maxPlayers }
        );
    }
    return { squad, invited, public: publicSlots };
}

async function ensureDreamWorldsSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_dream_worlds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            world_key TEXT NOT NULL UNIQUE,
            slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
            name TEXT NOT NULL,
            universe TEXT NOT NULL,
            arc TEXT DEFAULT NULL,
            synopsis TEXT NOT NULL,
            dream_type TEXT NOT NULL CHECK (dream_type IN ('self', 'assumed_identity', 'mixed')),
            rank TEXT NOT NULL DEFAULT 'B',
            status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                'draft', 'announced', 'available', 'reserved',
                'forming_group', 'running', 'completed', 'cancelled'
            )),
            risk_level TEXT DEFAULT 'alto',
            yulls_price INTEGER NOT NULL DEFAULT 0 CHECK (yulls_price >= 0),
            manual_payment_enabled INTEGER NOT NULL DEFAULT 0 CHECK (manual_payment_enabled IN (0, 1)),
            manual_price_label TEXT DEFAULT NULL,
            min_players INTEGER NOT NULL DEFAULT 2 CHECK (min_players BETWEEN 2 AND 50),
            max_players INTEGER NOT NULL DEFAULT 6 CHECK (max_players BETWEEN 2 AND 50),
            squad_slots INTEGER NOT NULL DEFAULT 2 CHECK (squad_slots >= 0),
            invited_slots INTEGER NOT NULL DEFAULT 1 CHECK (invited_slots >= 0),
            public_slots INTEGER NOT NULL DEFAULT 3 CHECK (public_slots >= 0),
            known_chapters INTEGER NOT NULL DEFAULT 1 CHECK (known_chapters > 0),
            cover_url TEXT DEFAULT NULL,
            public_risks_json TEXT DEFAULT NULL,
            rules_json TEXT DEFAULT NULL,
            fragment_categories_json TEXT DEFAULT NULL,
            announced_at TEXT DEFAULT NULL,
            purchase_opens_at TEXT DEFAULT NULL,
            purchase_closes_at TEXT DEFAULT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            CHECK (min_players <= max_players),
            CHECK (squad_slots + invited_slots + public_slots = max_players),
            CHECK (yulls_price > 0 OR manual_payment_enabled = 1)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_dream_worlds_status_dates
        ON clover_dream_worlds (status, purchase_opens_at, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_dream_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_key TEXT NOT NULL UNIQUE,
            world_id INTEGER NOT NULL,
            requester_player_id TEXT NOT NULL,
            buyer_type TEXT NOT NULL CHECK (buyer_type IN ('player', 'squad')),
            buyer_id TEXT NOT NULL,
            payment_method TEXT NOT NULL CHECK (payment_method IN ('yulls', 'manual')),
            status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN (
                'submitted', 'under_review', 'awaiting_confirmation',
                'approved', 'rejected', 'cancelled'
            )),
            player_note TEXT DEFAULT NULL,
            admin_note TEXT DEFAULT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            yulls_ledger_id INTEGER DEFAULT NULL,
            reviewed_by TEXT DEFAULT NULL,
            submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
            reviewed_at TEXT DEFAULT NULL,
            approved_at TEXT DEFAULT NULL,
            rejected_at TEXT DEFAULT NULL,
            cancelled_at TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT NULL,
            FOREIGN KEY (world_id) REFERENCES clover_dream_worlds(id)
        )
    `);

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_dream_requests_active_player_world
        ON clover_dream_requests (world_id, requester_player_id)
        WHERE status IN ('submitted', 'under_review', 'awaiting_confirmation', 'approved')
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_dream_requests_status
        ON clover_dream_requests (status, submitted_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_dream_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_key TEXT NOT NULL UNIQUE,
            world_id INTEGER NOT NULL,
            request_id INTEGER NOT NULL UNIQUE,
            buyer_type TEXT NOT NULL CHECK (buyer_type IN ('player', 'squad')),
            buyer_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'forming_group' CHECK (status IN (
                'forming_group', 'ready', 'running', 'paused',
                'completed', 'failed', 'cancelled'
            )),
            current_chapter INTEGER NOT NULL DEFAULT 0 CHECK (current_chapter >= 0),
            narrator_ids_json TEXT DEFAULT '[]',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            started_at TEXT DEFAULT NULL,
            completed_at TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            FOREIGN KEY (world_id) REFERENCES clover_dream_worlds(id),
            FOREIGN KEY (request_id) REFERENCES clover_dream_requests(id)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_dream_runs_status
        ON clover_dream_runs (status, updated_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_dream_slots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('squad', 'invited', 'public')),
            player_id TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
                'open', 'invited', 'confirmed', 'declined',
                'withdrawn', 'replaced'
            )),
            source TEXT NOT NULL DEFAULT 'system',
            invited_at TEXT DEFAULT NULL,
            confirmed_at TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            FOREIGN KEY (run_id) REFERENCES clover_dream_runs(id)
        )
    `);

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_dream_slots_active_player
        ON clover_dream_slots (run_id, player_id)
        WHERE player_id IS NOT NULL AND status IN ('invited', 'confirmed')
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_dream_slots_run
        ON clover_dream_slots (run_id, category, status, id)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_resonance_fragments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fragment_key TEXT NOT NULL UNIQUE,
            slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('ability', 'technique', 'style', 'trait', 'title')),
            origin_world_id INTEGER DEFAULT NULL,
            origin_run_id INTEGER DEFAULT NULL,
            owner_player_id TEXT DEFAULT NULL,
            rarity TEXT NOT NULL DEFAULT 'fragment',
            public_description TEXT NOT NULL,
            effect_text TEXT DEFAULT NULL,
            restrictions_text TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                'draft', 'review', 'active', 'sealed', 'changed', 'revoked'
            )),
            version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
            art_url TEXT DEFAULT NULL,
            public_visible INTEGER NOT NULL DEFAULT 1 CHECK (public_visible IN (0, 1)),
            created_by TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            FOREIGN KEY (origin_world_id) REFERENCES clover_dream_worlds(id),
            FOREIGN KEY (origin_run_id) REFERENCES clover_dream_runs(id)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_fragments_owner_status
        ON clover_resonance_fragments (owner_player_id, status, updated_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_dream_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_id TEXT NOT NULL,
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            before_json TEXT DEFAULT NULL,
            after_json TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_dream_audit_entity
        ON clover_dream_audit (entity_type, entity_id, created_at DESC, id DESC)
    `);
}

function serializeWorld(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        key: row.world_key,
        slug: row.slug,
        name: row.name,
        universe: row.universe,
        arc: row.arc,
        synopsis: row.synopsis,
        dreamType: row.dream_type,
        rank: row.rank,
        status: row.status,
        riskLevel: row.risk_level,
        price: {
            yulls: Number(row.yulls_price || 0),
            manualEnabled: Boolean(row.manual_payment_enabled),
            manualLabel: row.manual_price_label,
        },
        players: {
            min: Number(row.min_players),
            max: Number(row.max_players),
            distribution: {
                squad: Number(row.squad_slots),
                invited: Number(row.invited_slots),
                public: Number(row.public_slots),
            },
        },
        knownChapters: Number(row.known_chapters),
        coverUrl: row.cover_url,
        publicRisks: parseJson(row.public_risks_json, []),
        rules: parseJson(row.rules_json, []),
        fragmentCategories: parseJson(row.fragment_categories_json, []),
        announcedAt: row.announced_at,
        purchaseOpensAt: row.purchase_opens_at,
        purchaseClosesAt: row.purchase_closes_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function serializeRequest(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        key: row.request_key,
        worldId: Number(row.world_id),
        requesterPlayerId: row.requester_player_id,
        buyerType: row.buyer_type,
        buyerId: row.buyer_id,
        paymentMethod: row.payment_method,
        status: row.status,
        playerNote: row.player_note,
        adminNote: row.admin_note,
        yullsLedgerId: row.yulls_ledger_id ? Number(row.yulls_ledger_id) : null,
        submittedAt: row.submitted_at,
        reviewedAt: row.reviewed_at,
        approvedAt: row.approved_at,
        rejectedAt: row.rejected_at,
        cancelledAt: row.cancelled_at,
    };
}

async function writeAudit(db, actorId, action, entityType, entityId, payload = {}) {
    await db.run(
        `INSERT INTO clover_dream_audit (
            actor_id, action, entity_type, entity_id,
            before_json, after_json, reason, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            actorId,
            action,
            entityType,
            String(entityId),
            serializeJson(payload.before),
            serializeJson(payload.after),
            normalizeOptional(payload.reason),
            serializeJson(payload.metadata),
        ]
    );
}

async function createDreamWorld(db, input, actorId) {
    await ensureDreamWorldsSchema(db);
    const name = normalizeRequired(input.name, 'name', 'o nome da Fenda');
    const universe = normalizeRequired(input.universe, 'universe', 'o universo');
    const synopsis = normalizeRequired(input.synopsis, 'synopsis', 'a sinopse');
    const maxPlayers = asInteger(input.maxPlayers ?? 6, {
        min: 2,
        max: 50,
        code: 'invalid_max_players',
        message: 'O máximo de magos precisa ficar entre 2 e 50.',
    });
    const minPlayers = asInteger(input.minPlayers ?? 2, {
        min: 2,
        max: maxPlayers,
        code: 'invalid_min_players',
        message: 'O mínimo de magos é inválido.',
    });
    const slots = normalizeSlotDistribution(maxPlayers, input.slots || {});
    const yullsPrice = asInteger(input.yullsPrice ?? 0, {
        min: 0,
        code: 'invalid_yulls_price',
        message: 'Preço em Yuls inválido.',
    });
    const manualEnabled = Boolean(input.manualPaymentEnabled);
    if (yullsPrice < 1 && !manualEnabled) {
        throw new DreamWorldsServiceError(
            'missing_payment_option',
            'A Fenda precisa aceitar Yuls ou pagamento manual.'
        );
    }

    const slug = slugify(input.slug || name);
    if (!slug) {
        throw new DreamWorldsServiceError('invalid_slug', 'Não foi possível formar o endereço da Fenda.');
    }

    const result = await db.run(
        `INSERT INTO clover_dream_worlds (
            world_key, slug, name, universe, arc, synopsis, dream_type,
            rank, status, risk_level, yulls_price, manual_payment_enabled,
            manual_price_label, min_players, max_players, squad_slots,
            invited_slots, public_slots, known_chapters, cover_url,
            public_risks_json, rules_json, fragment_categories_json,
            announced_at, purchase_opens_at, purchase_closes_at,
            created_by, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
        [
            normalizeOptional(input.key) || operationKey('MSW'),
            slug,
            name,
            universe,
            normalizeOptional(input.arc),
            synopsis,
            dreamType(input.dreamType),
            normalizeOptional(input.rank) || 'B',
            worldStatus(input.status),
            normalizeOptional(input.riskLevel) || 'alto',
            yullsPrice,
            manualEnabled ? 1 : 0,
            normalizeOptional(input.manualPriceLabel),
            minPlayers,
            maxPlayers,
            slots.squad,
            slots.invited,
            slots.public,
            asInteger(input.knownChapters ?? 1, {
                min: 1,
                max: 1000,
                code: 'invalid_known_chapters',
                message: 'Quantidade de capítulos inválida.',
            }),
            normalizeOptional(input.coverUrl),
            serializeJson(input.publicRisks || []),
            serializeJson(input.rules || []),
            serializeJson(input.fragmentCategories || []),
            normalizeOptional(input.announcedAt),
            normalizeOptional(input.purchaseOpensAt),
            normalizeOptional(input.purchaseClosesAt),
            normalizeRequired(actorId, 'actor', 'o responsável'),
            serializeJson(input.metadata || {}),
        ]
    );

    const row = await db.get('SELECT * FROM clover_dream_worlds WHERE id = ?', [result.lastID]);
    await writeAudit(db, actorId, 'world_created', 'dream_world', row.id, { after: serializeWorld(row) });
    return serializeWorld(row);
}

async function listPublicDreamWorlds(db, options = {}) {
    await ensureDreamWorldsSchema(db);
    const requestedStatus = normalizeOptional(options.status)?.toLowerCase() || null;
    if (requestedStatus && !PUBLIC_WORLD_STATUSES.has(requestedStatus)) {
        throw new DreamWorldsServiceError('invalid_public_status', 'Filtro de Fendas inválido.');
    }
    const rows = requestedStatus
        ? await db.all(
            `SELECT * FROM clover_dream_worlds
             WHERE status = ?
             ORDER BY COALESCE(purchase_opens_at, announced_at, created_at) DESC, id DESC`,
            [requestedStatus]
        )
        : await db.all(
            `SELECT * FROM clover_dream_worlds
             WHERE status != 'draft'
             ORDER BY
                CASE status
                    WHEN 'available' THEN 1
                    WHEN 'announced' THEN 2
                    WHEN 'forming_group' THEN 3
                    WHEN 'running' THEN 4
                    WHEN 'reserved' THEN 5
                    WHEN 'completed' THEN 6
                    ELSE 7
                END,
                COALESCE(purchase_opens_at, announced_at, created_at) DESC,
                id DESC`
        );
    return rows.map(serializeWorld);
}

async function getPublicDreamWorldBySlug(db, slug) {
    await ensureDreamWorldsSchema(db);
    const row = await db.get(
        `SELECT * FROM clover_dream_worlds
         WHERE slug = ? COLLATE NOCASE AND status != 'draft'`,
        [normalizeRequired(slug, 'slug', 'a Fenda')]
    );
    if (!row) {
        throw new DreamWorldsServiceError('world_not_found', 'Mundo dos Sonhos não encontrado.');
    }
    const world = serializeWorld(row);
    const slots = await db.all(
        `SELECT category, status, COUNT(*) AS total
         FROM clover_dream_slots
         WHERE run_id IN (SELECT id FROM clover_dream_runs WHERE world_id = ?)
         GROUP BY category, status`,
        [row.id]
    );
    return { ...world, slotState: slots };
}

async function authorizeBuyer(db, playerId, type, buyerId) {
    if (type === 'player') return playerId;
    const squadKey = normalizeRequired(buyerId, 'buyer_id', 'o esquadrão comprador');
    const squad = await db.get(
        `SELECT squad_key, name, captain_player_id, vice_captain_player_id
         FROM clover_squads
         WHERE squad_key = ? COLLATE NOCASE OR name = ? COLLATE NOCASE`,
        [squadKey, squadKey]
    );
    if (!squad) {
        throw new DreamWorldsServiceError('squad_not_found', 'Esquadrão comprador não encontrado.');
    }
    const player = await db.get('SELECT esquadrao FROM jogadores WHERE id = ?', [playerId]);
    const memberLabel = String(player?.esquadrao || '').trim().toLowerCase();
    const authorized = [
        String(squad.squad_key || '').toLowerCase(),
        String(squad.name || '').toLowerCase(),
    ].includes(memberLabel)
        || squad.captain_player_id === playerId
        || squad.vice_captain_player_id === playerId;
    if (!authorized) {
        throw new DreamWorldsServiceError(
            'squad_buyer_forbidden',
            'Seu personagem não pode solicitar esta Fenda pelo esquadrão.'
        );
    }
    return squad.squad_key;
}

async function submitDreamRequest(db, playerId, worldInput, input = {}) {
    await ensureDreamWorldsSchema(db);
    const idempotencyKey = normalizeRequired(
        input.idempotencyKey,
        'idempotency_key',
        'a identificação da solicitação'
    );
    await db.exec('BEGIN IMMEDIATE');
    try {
        const duplicate = await db.get(
            'SELECT * FROM clover_dream_requests WHERE idempotency_key = ?',
            [idempotencyKey]
        );
        if (duplicate) {
            if (duplicate.requester_player_id !== playerId) {
                throw new DreamWorldsServiceError(
                    'idempotency_conflict',
                    'Essa identificação pertence a outra solicitação.'
                );
            }
            await db.exec('COMMIT');
            return { duplicate: true, request: serializeRequest(duplicate) };
        }

        const world = typeof worldInput === 'number'
            ? await db.get('SELECT * FROM clover_dream_worlds WHERE id = ?', [worldInput])
            : await db.get(
                `SELECT * FROM clover_dream_worlds
                 WHERE slug = ? COLLATE NOCASE OR world_key = ? COLLATE NOCASE`,
                [String(worldInput || ''), String(worldInput || '')]
            );
        if (!world) {
            throw new DreamWorldsServiceError('world_not_found', 'Mundo dos Sonhos não encontrado.');
        }
        if (world.status !== 'available') {
            throw new DreamWorldsServiceError(
                'world_not_available',
                'Esta Fenda não está recebendo solicitações.',
                { status: world.status }
            );
        }

        const method = paymentMethod(input.paymentMethod);
        if (method === 'yulls') {
            if (Number(world.yulls_price || 0) < 1) {
                throw new DreamWorldsServiceError('yulls_not_enabled', 'Esta Fenda não aceita aquisição por Yuls.');
            }
            const wallet = await getYullsSummary(db, playerId);
            if (wallet.available < Number(world.yulls_price)) {
                throw new DreamWorldsServiceError(
                    'insufficient_yulls',
                    'Saldo disponível de Yuls insuficiente para solicitar esta Fenda.',
                    { available: wallet.available, required: Number(world.yulls_price) }
                );
            }
        } else if (!world.manual_payment_enabled) {
            throw new DreamWorldsServiceError(
                'manual_payment_not_enabled',
                'Esta Fenda não aceita pagamento manual.'
            );
        }

        const type = buyerType(input.buyerType);
        const authorizedBuyerId = await authorizeBuyer(db, playerId, type, input.buyerId);
        const existing = await db.get(
            `SELECT * FROM clover_dream_requests
             WHERE world_id = ? AND requester_player_id = ?
               AND status IN ('submitted', 'under_review', 'awaiting_confirmation', 'approved')`,
            [world.id, playerId]
        );
        if (existing) {
            throw new DreamWorldsServiceError(
                'active_request_exists',
                'Seu personagem já possui uma solicitação ativa para esta Fenda.',
                { requestKey: existing.request_key, status: existing.status }
            );
        }

        const inserted = await db.run(
            `INSERT INTO clover_dream_requests (
                request_key, world_id, requester_player_id, buyer_type, buyer_id,
                payment_method, status, player_note, idempotency_key, metadata_json
             ) VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)`,
            [
                operationKey('MSR'),
                world.id,
                playerId,
                type,
                authorizedBuyerId,
                method,
                normalizeOptional(input.playerNote),
                idempotencyKey,
                serializeJson(input.metadata || {}),
            ]
        );
        const request = await db.get('SELECT * FROM clover_dream_requests WHERE id = ?', [inserted.lastID]);
        await writeAudit(db, playerId, 'request_submitted', 'dream_request', request.id, {
            after: serializeRequest(request),
            metadata: { worldId: world.id },
        });
        await db.exec('COMMIT');
        return { duplicate: false, request: serializeRequest(request) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function buildRunSlots(db, runId, world, requesterPlayerId, buyerKind) {
    const remaining = {
        squad: Number(world.squad_slots),
        invited: Number(world.invited_slots),
        public: Number(world.public_slots),
    };
    const preferred = buyerKind === 'squad'
        ? ['squad', 'invited', 'public']
        : ['invited', 'public', 'squad'];
    const buyerCategory = preferred.find((category) => remaining[category] > 0);
    if (!buyerCategory) {
        throw new DreamWorldsServiceError('invalid_slot_distribution', 'A Fenda não possui vaga para o comprador.');
    }
    await db.run(
        `INSERT INTO clover_dream_slots (
            run_id, category, player_id, status, source,
            invited_at, confirmed_at, updated_at, metadata_json
         ) VALUES (?, ?, ?, 'confirmed', 'buyer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
        [runId, buyerCategory, requesterPlayerId, serializeJson({ buyer: true })]
    );
    remaining[buyerCategory] -= 1;

    for (const category of ['squad', 'invited', 'public']) {
        for (let index = 0; index < remaining[category]; index += 1) {
            await db.run(
                `INSERT INTO clover_dream_slots (run_id, category, status, source, updated_at)
                 VALUES (?, ?, 'open', 'allocation', CURRENT_TIMESTAMP)`,
                [runId, category]
            );
        }
    }
}

async function approveDreamRequest(db, requestId, actorId, input = {}) {
    await ensureDreamWorldsSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const request = await db.get('SELECT * FROM clover_dream_requests WHERE id = ?', [requestId]);
        if (!request) {
            throw new DreamWorldsServiceError('request_not_found', 'Solicitação não encontrada.');
        }
        if (request.status === 'approved') {
            const existingRun = await db.get('SELECT * FROM clover_dream_runs WHERE request_id = ?', [request.id]);
            await db.exec('COMMIT');
            return {
                duplicate: true,
                request: serializeRequest(request),
                run: existingRun || null,
            };
        }
        if (!['submitted', 'under_review', 'awaiting_confirmation'].includes(request.status)) {
            throw new DreamWorldsServiceError(
                'request_not_approvable',
                'Esta solicitação não pode mais ser aprovada.',
                { status: request.status }
            );
        }

        const world = await db.get('SELECT * FROM clover_dream_worlds WHERE id = ?', [request.world_id]);
        if (!world) {
            throw new DreamWorldsServiceError('world_not_found', 'Mundo dos Sonhos não encontrado.');
        }
        if (world.status !== 'available') {
            throw new DreamWorldsServiceError(
                'world_not_available',
                'A Fenda já não está disponível para aprovação.',
                { status: world.status }
            );
        }

        let yullsResult = null;
        if (request.payment_method === 'yulls') {
            yullsResult = await spendYullsInTransaction(
                db,
                request.requester_player_id,
                Number(world.yulls_price),
                'mundo_dos_sonhos',
                `Aquisição de ${world.name}`,
                actorId,
                {
                    relatedId: request.request_key,
                    idempotencyKey: `dream-request:approve:${request.id}`,
                    metadata: { worldId: world.id, requestId: request.id },
                }
            );
        }

        const runInsert = await db.run(
            `INSERT INTO clover_dream_runs (
                run_key, world_id, request_id, buyer_type, buyer_id,
                status, current_chapter, narrator_ids_json, metadata_json
             ) VALUES (?, ?, ?, ?, ?, 'forming_group', 0, ?, ?)`,
            [
                operationKey('MS'),
                world.id,
                request.id,
                request.buyer_type,
                request.buyer_id,
                serializeJson(input.narratorIds || []),
                serializeJson(input.metadata || {}),
            ]
        );
        await buildRunSlots(db, runInsert.lastID, world, request.requester_player_id, request.buyer_type);

        await db.run(
            `UPDATE clover_dream_requests
             SET status = 'approved', admin_note = ?, reviewed_by = ?,
                 reviewed_at = CURRENT_TIMESTAMP, approved_at = CURRENT_TIMESTAMP,
                 yulls_ledger_id = ?
             WHERE id = ?`,
            [normalizeOptional(input.adminNote), actorId, yullsResult?.ledgerId || null, request.id]
        );
        await db.run(
            `UPDATE clover_dream_worlds
             SET status = 'reserved', updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'available'`,
            [world.id]
        );

        const approved = await db.get('SELECT * FROM clover_dream_requests WHERE id = ?', [request.id]);
        const run = await db.get('SELECT * FROM clover_dream_runs WHERE id = ?', [runInsert.lastID]);
        await writeAudit(db, actorId, 'request_approved', 'dream_request', request.id, {
            before: serializeRequest(request),
            after: serializeRequest(approved),
            metadata: { runId: run.id, yullsLedgerId: yullsResult?.ledgerId || null },
        });
        await db.exec('COMMIT');
        return {
            duplicate: false,
            request: serializeRequest(approved),
            run,
            yulls: yullsResult,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function rejectDreamRequest(db, requestId, actorId, input = {}) {
    await ensureDreamWorldsSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const request = await db.get('SELECT * FROM clover_dream_requests WHERE id = ?', [requestId]);
        if (!request) {
            throw new DreamWorldsServiceError('request_not_found', 'Solicitação não encontrada.');
        }
        if (!['submitted', 'under_review', 'awaiting_confirmation'].includes(request.status)) {
            throw new DreamWorldsServiceError(
                'request_not_rejectable',
                'Esta solicitação não pode ser recusada.',
                { status: request.status }
            );
        }
        await db.run(
            `UPDATE clover_dream_requests
             SET status = 'rejected', admin_note = ?, reviewed_by = ?,
                 reviewed_at = CURRENT_TIMESTAMP, rejected_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [normalizeOptional(input.adminNote), actorId, request.id]
        );
        const rejected = await db.get('SELECT * FROM clover_dream_requests WHERE id = ?', [request.id]);
        await writeAudit(db, actorId, 'request_rejected', 'dream_request', request.id, {
            before: serializeRequest(request),
            after: serializeRequest(rejected),
            reason: input.adminNote,
        });
        await db.exec('COMMIT');
        return serializeRequest(rejected);
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function getPlayerDreamDashboard(db, playerId) {
    await ensureDreamWorldsSchema(db);
    const [wallet, requests, runs, fragments] = await Promise.all([
        getYullsSummary(db, playerId),
        db.all(
            `SELECT r.*, w.name AS world_name, w.slug AS world_slug, w.status AS world_status
             FROM clover_dream_requests r
             JOIN clover_dream_worlds w ON w.id = r.world_id
             WHERE r.requester_player_id = ?
             ORDER BY r.id DESC`,
            [playerId]
        ),
        db.all(
            `SELECT DISTINCT run.*, w.name AS world_name, w.slug AS world_slug
             FROM clover_dream_runs run
             JOIN clover_dream_worlds w ON w.id = run.world_id
             LEFT JOIN clover_dream_slots slot ON slot.run_id = run.id
             WHERE (run.buyer_type = 'player' AND run.buyer_id = ?)
                OR slot.player_id = ?
             ORDER BY run.id DESC`,
            [playerId, playerId]
        ),
        db.all(
            `SELECT fragment.*, w.name AS origin_world_name, w.slug AS origin_world_slug
             FROM clover_resonance_fragments fragment
             LEFT JOIN clover_dream_worlds w ON w.id = fragment.origin_world_id
             WHERE fragment.owner_player_id = ?
             ORDER BY fragment.updated_at DESC, fragment.id DESC`,
            [playerId]
        ),
    ]);
    return {
        wallet,
        requests: requests.map((row) => ({
            ...serializeRequest(row),
            world: { name: row.world_name, slug: row.world_slug, status: row.world_status },
        })),
        runs,
        fragments,
    };
}

module.exports = {
    ACTIVE_REQUEST_STATUSES,
    DreamWorldsServiceError,
    approveDreamRequest,
    createDreamWorld,
    ensureDreamWorldsSchema,
    getPlayerDreamDashboard,
    getPublicDreamWorldBySlug,
    listPublicDreamWorlds,
    normalizeSlotDistribution,
    rejectDreamRequest,
    serializeRequest,
    serializeWorld,
    submitDreamRequest,
};
