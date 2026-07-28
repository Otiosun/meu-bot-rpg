'use strict';

const crypto = require('node:crypto');
const {
    getYullsSummary,
    spendYullsInTransaction,
} = require('./yullsService');
const {
    validateDreamWorldDualAcquisition,
} = require('./dreamWorldsAcquisitionPolicy');

class DreamWorldsServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DreamWorldsServiceError';
        this.code = code;
        this.details = details;
    }
}

const PUBLIC_STATUSES = new Set([
    'announced', 'available', 'reserved', 'forming_group',
    'running', 'completed', 'cancelled',
]);
const ADMIN_WORLD_TRANSITIONS = new Map([
    ['draft', new Set(['announced', 'cancelled'])],
    ['announced', new Set(['draft', 'available', 'cancelled'])],
    ['available', new Set(['announced', 'cancelled'])],
]);
const ACTIVE_REQUEST_STATUSES = new Set([
    'submitted', 'under_review', 'awaiting_confirmation', 'approved',
]);
const ACTIVE_RUN_STATUSES = new Set([
    'forming_group', 'ready', 'running', 'paused',
]);

function text(value) {
    const normalized = String(value ?? '').trim();
    return normalized || null;
}

function required(value, code, message) {
    const normalized = text(value);
    if (!normalized) throw new DreamWorldsServiceError(code, message);
    return normalized;
}

function integer(value, min, max, code, message) {
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
        throw new DreamWorldsServiceError(code, message, { value, min, max });
    }
    return normalized;
}

function toJson(value) {
    return value === undefined || value === null ? null : JSON.stringify(value);
}

function fromJson(value, fallback) {
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

function generateKey(prefix) {
    const year = new Date().getFullYear();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
    return `${prefix}-${year}-${suffix}`;
}

function normalizeWorldStatus(value = 'draft') {
    const status = String(value).trim().toLowerCase();
    const allowed = new Set([
        'draft', 'announced', 'available', 'reserved', 'forming_group',
        'running', 'completed', 'cancelled',
    ]);
    if (!allowed.has(status)) {
        throw new DreamWorldsServiceError('invalid_world_status', 'Estado de Fenda inválido.');
    }
    return status;
}

function normalizeDreamType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (!['self', 'assumed_identity', 'mixed'].includes(type)) {
        throw new DreamWorldsServiceError('invalid_dream_type', 'Tipo de Mundo dos Sonhos inválido.');
    }
    return type;
}

function normalizePaymentMethod(value) {
    const method = String(value || '').trim().toLowerCase();
    if (!['yulls', 'manual'].includes(method)) {
        throw new DreamWorldsServiceError('invalid_payment_method', 'Forma de aquisição inválida.');
    }
    return method;
}

function normalizeBuyerType(value = 'player') {
    const type = String(value).trim().toLowerCase();
    if (!['player', 'squad'].includes(type)) {
        throw new DreamWorldsServiceError('invalid_buyer_type', 'Tipo de comprador inválido.');
    }
    return type;
}

function defaultSlotDistribution(maxPlayers) {
    const squad = Math.floor(maxPlayers * 0.4);
    const invited = Math.floor(maxPlayers * 0.3);
    return { squad, invited, public: maxPlayers - squad - invited };
}

function normalizeSlotDistribution(maxPlayers, source = {}) {
    const defaults = defaultSlotDistribution(maxPlayers);
    const result = {
        squad: integer(source.squad ?? source.squadSlots ?? defaults.squad, 0, maxPlayers, 'invalid_squad_slots', 'Vagas de esquadrão inválidas.'),
        invited: integer(source.invited ?? source.invitedSlots ?? defaults.invited, 0, maxPlayers, 'invalid_invited_slots', 'Vagas de indicação inválidas.'),
        public: integer(source.public ?? source.publicSlots ?? defaults.public, 0, maxPlayers, 'invalid_public_slots', 'Vagas públicas inválidas.'),
    };
    if (result.squad + result.invited + result.public !== maxPlayers) {
        throw new DreamWorldsServiceError(
            'invalid_slot_distribution',
            'A distribuição de vagas precisa somar o máximo de magos.',
            { ...result, maxPlayers }
        );
    }
    return result;
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
                'draft', 'announced', 'available', 'reserved', 'forming_group',
                'running', 'completed', 'cancelled'
            )),
            risk_level TEXT NOT NULL DEFAULT 'alto',
            yulls_price INTEGER NOT NULL CHECK (yulls_price > 0),
            manual_payment_enabled INTEGER NOT NULL DEFAULT 1 CHECK (manual_payment_enabled = 1),
            manual_price_label TEXT NOT NULL CHECK (trim(manual_price_label) != ''),
            min_players INTEGER NOT NULL DEFAULT 2 CHECK (min_players BETWEEN 2 AND 50),
            max_players INTEGER NOT NULL DEFAULT 6 CHECK (max_players BETWEEN 2 AND 50),
            squad_slots INTEGER NOT NULL DEFAULT 2 CHECK (squad_slots >= 0),
            invited_slots INTEGER NOT NULL DEFAULT 1 CHECK (invited_slots >= 0),
            public_slots INTEGER NOT NULL DEFAULT 3 CHECK (public_slots >= 0),
            known_chapters INTEGER NOT NULL DEFAULT 1 CHECK (known_chapters > 0),
            cover_url TEXT DEFAULT NULL,
            public_risks_json TEXT DEFAULT '[]',
            rules_json TEXT DEFAULT '[]',
            fragment_categories_json TEXT DEFAULT '[]',
            announced_at TEXT DEFAULT NULL,
            purchase_opens_at TEXT DEFAULT NULL,
            purchase_closes_at TEXT DEFAULT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT '{}',
            CHECK (min_players <= max_players),
            CHECK (squad_slots + invited_slots + public_slots = max_players)
        );

        CREATE TRIGGER IF NOT EXISTS trg_clover_dream_worlds_dual_acquisition_insert
        BEFORE INSERT ON clover_dream_worlds
        WHEN NEW.yulls_price <= 0
          OR NEW.manual_payment_enabled != 1
          OR NEW.manual_price_label IS NULL
          OR trim(NEW.manual_price_label) = ''
        BEGIN
            SELECT RAISE(ABORT, 'clover_dream_worlds requires positive Yuls and enabled manual real-money label');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_clover_dream_worlds_dual_acquisition_update
        BEFORE UPDATE OF yulls_price, manual_payment_enabled, manual_price_label ON clover_dream_worlds
        WHEN NEW.yulls_price <= 0
          OR NEW.manual_payment_enabled != 1
          OR NEW.manual_price_label IS NULL
          OR trim(NEW.manual_price_label) = ''
        BEGIN
            SELECT RAISE(ABORT, 'clover_dream_worlds requires positive Yuls and enabled manual real-money label');
        END;

        CREATE INDEX IF NOT EXISTS idx_clover_dream_worlds_status
        ON clover_dream_worlds (status, purchase_opens_at, created_at DESC, id DESC);

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
            metadata_json TEXT DEFAULT '{}'
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_dream_requests_active
        ON clover_dream_requests (world_id, requester_player_id)
        WHERE status IN ('submitted', 'under_review', 'awaiting_confirmation', 'approved');

        CREATE INDEX IF NOT EXISTS idx_clover_dream_requests_status
        ON clover_dream_requests (status, submitted_at DESC, id DESC);

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
            metadata_json TEXT DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS clover_dream_slots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('squad', 'invited', 'public')),
            player_id TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
                'open', 'invited', 'confirmed', 'declined', 'withdrawn', 'replaced'
            )),
            source TEXT NOT NULL DEFAULT 'system',
            invited_at TEXT DEFAULT NULL,
            confirmed_at TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT '{}'
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_dream_slots_active_player
        ON clover_dream_slots (run_id, player_id)
        WHERE player_id IS NOT NULL AND status IN ('invited', 'confirmed');

        CREATE INDEX IF NOT EXISTS idx_clover_dream_slots_run
        ON clover_dream_slots (run_id, category, status, id);

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
            metadata_json TEXT DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_clover_fragments_owner
        ON clover_resonance_fragments (owner_player_id, status, updated_at DESC, id DESC);

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
            metadata_json TEXT DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_clover_dream_audit_entity
        ON clover_dream_audit (entity_type, entity_id, created_at DESC, id DESC);
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
        publicRisks: fromJson(row.public_risks_json, []),
        rules: fromJson(row.rules_json, []),
        fragmentCategories: fromJson(row.fragment_categories_json, []),
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

async function audit(db, actorId, action, entityType, entityId, payload = {}) {
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
            toJson(payload.before),
            toJson(payload.after),
            text(payload.reason),
            toJson(payload.metadata || {}),
        ]
    );
}

async function createDreamWorld(db, input, actorId) {
    await ensureDreamWorldsSchema(db);
    const name = required(input.name, 'missing_name', 'Informe o nome da Fenda.');
    const universe = required(input.universe, 'missing_universe', 'Informe o universo.');
    const synopsis = required(input.synopsis, 'missing_synopsis', 'Informe a sinopse.');
    const maxPlayers = integer(input.maxPlayers ?? 6, 2, 50, 'invalid_max_players', 'Máximo de magos inválido.');
    const minPlayers = integer(input.minPlayers ?? 2, 2, maxPlayers, 'invalid_min_players', 'Mínimo de magos inválido.');
    const slots = normalizeSlotDistribution(maxPlayers, input.slots || {});
    let acquisition;
    try {
        acquisition = validateDreamWorldDualAcquisition(input);
    } catch (error) {
        throw new DreamWorldsServiceError(
            error?.code || 'invalid_acquisition_policy',
            error?.message || 'Politica de aquisicao invalida.',
            error?.details || {}
        );
    }
    const slug = slugify(input.slug || name);
    if (!slug) throw new DreamWorldsServiceError('invalid_slug', 'Endereço da Fenda inválido.');

    const insert = await db.run(
        `INSERT INTO clover_dream_worlds (
            world_key, slug, name, universe, arc, synopsis, dream_type, rank,
            status, risk_level, yulls_price, manual_payment_enabled, manual_price_label,
            min_players, max_players, squad_slots, invited_slots, public_slots,
            known_chapters, cover_url, public_risks_json, rules_json,
            fragment_categories_json, announced_at, purchase_opens_at,
            purchase_closes_at, created_by, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            text(input.key) || generateKey('MSW'),
            slug,
            name,
            universe,
            text(input.arc),
            synopsis,
            normalizeDreamType(input.dreamType),
            text(input.rank) || 'B',
            normalizeWorldStatus(input.status),
            text(input.riskLevel) || 'alto',
            acquisition.yullsPrice,
            acquisition.manualPaymentEnabled ? 1 : 0,
            acquisition.manualPriceLabel,
            minPlayers,
            maxPlayers,
            slots.squad,
            slots.invited,
            slots.public,
            integer(input.knownChapters ?? 1, 1, 1000, 'invalid_known_chapters', 'Quantidade de capítulos inválida.'),
            text(input.coverUrl),
            toJson(input.publicRisks || []),
            toJson(input.rules || []),
            toJson(input.fragmentCategories || []),
            text(input.announcedAt),
            text(input.purchaseOpensAt),
            text(input.purchaseClosesAt),
            required(actorId, 'missing_actor', 'Responsável inválido.'),
            toJson(input.metadata || {}),
        ]
    );
    const row = await db.get('SELECT * FROM clover_dream_worlds WHERE id = ?', [insert.lastID]);
    await audit(db, actorId, 'world_created', 'dream_world', row.id, { after: serializeWorld(row) });
    return serializeWorld(row);
}

async function listPublicDreamWorlds(db, options = {}) {
    await ensureDreamWorldsSchema(db);
    const status = text(options.status)?.toLowerCase() || null;
    if (status && !PUBLIC_STATUSES.has(status)) {
        throw new DreamWorldsServiceError('invalid_public_status', 'Filtro de Fendas inválido.');
    }
    const rows = status
        ? await db.all('SELECT * FROM clover_dream_worlds WHERE status = ? ORDER BY id DESC', [status])
        : await db.all(`
            SELECT * FROM clover_dream_worlds
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
                id DESC
        `);
    return rows.map(serializeWorld);
}

async function getPublicDreamWorldBySlug(db, slug) {
    await ensureDreamWorldsSchema(db);
    const row = await db.get(
        `SELECT * FROM clover_dream_worlds
         WHERE slug = ? COLLATE NOCASE AND status != 'draft'`,
        [required(slug, 'missing_slug', 'Informe a Fenda.')]
    );
    if (!row) throw new DreamWorldsServiceError('world_not_found', 'Mundo dos Sonhos não encontrado.');
    return serializeWorld(row);
}

async function resolveBuyerId(db, playerId, type, candidate) {
    if (type === 'player') return playerId;
    const squadInput = required(candidate, 'missing_squad', 'Informe o esquadrão comprador.');
    const squad = await db.get(
        `SELECT squad_key, name, captain_player_id, vice_captain_player_id
         FROM clover_squads
         WHERE squad_key = ? COLLATE NOCASE OR name = ? COLLATE NOCASE`,
        [squadInput, squadInput]
    );
    if (!squad) throw new DreamWorldsServiceError('squad_not_found', 'Esquadrão comprador não encontrado.');
    const player = await db.get('SELECT esquadrao FROM jogadores WHERE id = ?', [playerId]);
    const membership = String(player?.esquadrao || '').trim().toLowerCase();
    const allowed = membership === String(squad.squad_key).toLowerCase()
        || membership === String(squad.name).toLowerCase()
        || squad.captain_player_id === playerId
        || squad.vice_captain_player_id === playerId;
    if (!allowed) {
        throw new DreamWorldsServiceError('squad_buyer_forbidden', 'Seu personagem não pertence ao esquadrão comprador.');
    }
    return squad.squad_key;
}

async function findWorld(db, input) {
    if (Number.isInteger(Number(input)) && String(input).trim() !== '') {
        return db.get('SELECT * FROM clover_dream_worlds WHERE id = ?', [Number(input)]);
    }
    return db.get(
        `SELECT * FROM clover_dream_worlds
         WHERE slug = ? COLLATE NOCASE OR world_key = ? COLLATE NOCASE`,
        [String(input || ''), String(input || '')]
    );
}

async function countActiveDreamRequests(db, worldId) {
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_dream_requests
         WHERE world_id = ?
           AND status IN (${Array.from(ACTIVE_REQUEST_STATUSES).map(() => '?').join(', ')})`,
        [worldId, ...ACTIVE_REQUEST_STATUSES]
    );
    return Number(row?.total || 0);
}

async function countLinkedDreamRuns(db, worldId) {
    const row = await db.get(
        'SELECT COUNT(*) AS total FROM clover_dream_runs WHERE world_id = ?',
        [worldId]
    );
    return Number(row?.total || 0);
}

async function countActiveDreamRuns(db, worldId) {
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_dream_runs
         WHERE world_id = ?
           AND status IN (${Array.from(ACTIVE_RUN_STATUSES).map(() => '?').join(', ')})`,
        [worldId, ...ACTIVE_RUN_STATUSES]
    );
    return Number(row?.total || 0);
}

function assertAdminWorldTransition(currentStatus, targetStatus) {
    const allowed = ADMIN_WORLD_TRANSITIONS.get(currentStatus);
    if (!allowed?.has(targetStatus)) {
        throw new DreamWorldsServiceError(
            'invalid_world_status_transition',
            'TransiÃ§Ã£o de estado da Fenda invÃ¡lida.',
            { from: currentStatus, to: targetStatus }
        );
    }
}

async function transitionDreamWorldStatus(db, worldInput, actorId, input = {}) {
    await ensureDreamWorldsSchema(db);
    const targetStatus = normalizeWorldStatus(input.status);
    const normalizedActorId = required(actorId, 'missing_actor', 'ResponsÃ¡vel invÃ¡lido.');
    const reason = text(input.reason);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const current = await findWorld(db, worldInput);
        if (!current) throw new DreamWorldsServiceError('world_not_found', 'Mundo dos Sonhos nÃ£o encontrado.');
        assertAdminWorldTransition(current.status, targetStatus);

        if (targetStatus === 'draft') {
            const activeRequests = await countActiveDreamRequests(db, current.id);
            if (activeRequests > 0) {
                throw new DreamWorldsServiceError(
                    'active_requests_block_draft',
                    'SolicitaÃ§Ãµes ativas impedem retorno para rascunho.',
                    { activeRequests }
                );
            }
            const linkedRuns = await countLinkedDreamRuns(db, current.id);
            if (linkedRuns > 0) {
                throw new DreamWorldsServiceError(
                    'active_run_blocks_transition',
                    'IncursÃ£o vinculada impede esta transiÃ§Ã£o.',
                    { linkedRuns }
                );
            }
        }

        if (targetStatus === 'cancelled') {
            if (!reason) {
                throw new DreamWorldsServiceError(
                    'missing_transition_reason',
                    'Informe o motivo do cancelamento da Fenda.'
                );
            }
            const activeRuns = await countActiveDreamRuns(db, current.id);
            if (activeRuns > 0) {
                throw new DreamWorldsServiceError(
                    'active_run_blocks_transition',
                    'IncursÃ£o ativa impede esta transiÃ§Ã£o.',
                    { activeRuns }
                );
            }
        }

        const updates = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
        const params = [targetStatus];
        if (current.status === 'draft' && targetStatus === 'announced') {
            updates.push(
                'announced_at = COALESCE(announced_at, CURRENT_TIMESTAMP)',
                'purchase_opens_at = NULL'
            );
        }
        if (current.status === 'announced' && targetStatus === 'available') {
            updates.push('purchase_opens_at = COALESCE(purchase_opens_at, CURRENT_TIMESTAMP)');
        }
        if (current.status === 'announced' && targetStatus === 'draft') {
            updates.push('announced_at = NULL', 'purchase_opens_at = NULL');
        }
        if (targetStatus === 'cancelled') {
            updates.push('purchase_closes_at = COALESCE(purchase_closes_at, CURRENT_TIMESTAMP)');
        }

        params.push(current.id);
        await db.run(
            `UPDATE clover_dream_worlds
             SET ${updates.join(', ')}
             WHERE id = ?`,
            params
        );
        const updated = await db.get('SELECT * FROM clover_dream_worlds WHERE id = ?', [current.id]);
        await audit(db, normalizedActorId, 'world_status_transition', 'dream_world', current.id, {
            before: serializeWorld(current),
            after: serializeWorld(updated),
            reason,
            metadata: {
                from: current.status,
                to: targetStatus,
                ...(input.metadata || {}),
            },
        });
        await db.exec('COMMIT');
        return serializeWorld(updated);
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function submitDreamRequest(db, playerId, worldInput, input = {}) {
    await ensureDreamWorldsSchema(db);
    const idempotencyKey = required(input.idempotencyKey, 'missing_idempotency_key', 'Informe a identificação da solicitação.');
    const method = normalizePaymentMethod(input.paymentMethod);
    const type = normalizeBuyerType(input.buyerType);
    const preliminaryWorld = await findWorld(db, worldInput);
    if (!preliminaryWorld) throw new DreamWorldsServiceError('world_not_found', 'Mundo dos Sonhos não encontrado.');
    if (preliminaryWorld.status !== 'available') {
        throw new DreamWorldsServiceError('world_not_available', 'Esta Fenda não está recebendo solicitações.', { status: preliminaryWorld.status });
    }
    if (method === 'yulls') {
        if (Number(preliminaryWorld.yulls_price) < 1) {
            throw new DreamWorldsServiceError('yulls_not_enabled', 'Esta Fenda não aceita aquisição por Yuls.');
        }
        const wallet = await getYullsSummary(db, playerId);
        if (wallet.available < Number(preliminaryWorld.yulls_price)) {
            throw new DreamWorldsServiceError('insufficient_yulls', 'Saldo disponível de Yuls insuficiente.', {
                available: wallet.available,
                required: Number(preliminaryWorld.yulls_price),
            });
        }
    } else if (!preliminaryWorld.manual_payment_enabled) {
        throw new DreamWorldsServiceError('manual_payment_not_enabled', 'Esta Fenda não aceita pagamento manual.');
    }
    const resolvedBuyerId = await resolveBuyerId(db, playerId, type, input.buyerId);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const duplicate = await db.get('SELECT * FROM clover_dream_requests WHERE idempotency_key = ?', [idempotencyKey]);
        if (duplicate) {
            if (duplicate.requester_player_id !== playerId) {
                throw new DreamWorldsServiceError('idempotency_conflict', 'Identificação usada por outra solicitação.');
            }
            await db.exec('COMMIT');
            return { duplicate: true, request: serializeRequest(duplicate) };
        }
        const world = await findWorld(db, worldInput);
        if (!world || world.status !== 'available') {
            throw new DreamWorldsServiceError('world_not_available', 'A Fenda deixou de aceitar solicitações.');
        }
        const active = await db.get(
            `SELECT * FROM clover_dream_requests
             WHERE world_id = ? AND requester_player_id = ?
               AND status IN ('submitted', 'under_review', 'awaiting_confirmation', 'approved')`,
            [world.id, playerId]
        );
        if (active) {
            throw new DreamWorldsServiceError('active_request_exists', 'Já existe uma solicitação ativa para esta Fenda.', {
                requestKey: active.request_key,
                status: active.status,
            });
        }
        const insert = await db.run(
            `INSERT INTO clover_dream_requests (
                request_key, world_id, requester_player_id, buyer_type, buyer_id,
                payment_method, player_note, idempotency_key, metadata_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                generateKey('MSR'),
                world.id,
                playerId,
                type,
                resolvedBuyerId,
                method,
                text(input.playerNote),
                idempotencyKey,
                toJson(input.metadata || {}),
            ]
        );
        const request = await db.get('SELECT * FROM clover_dream_requests WHERE id = ?', [insert.lastID]);
        await audit(db, playerId, 'request_submitted', 'dream_request', request.id, {
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

async function createRunSlots(db, runId, world, requesterPlayerId, buyerKind) {
    const remaining = {
        squad: Number(world.squad_slots),
        invited: Number(world.invited_slots),
        public: Number(world.public_slots),
    };
    const priority = buyerKind === 'squad'
        ? ['squad', 'invited', 'public']
        : ['invited', 'public', 'squad'];
    const buyerCategory = priority.find((category) => remaining[category] > 0);
    if (!buyerCategory) throw new DreamWorldsServiceError('invalid_slot_distribution', 'Não há vaga para o comprador.');
    await db.run(
        `INSERT INTO clover_dream_slots (
            run_id, category, player_id, status, source,
            invited_at, confirmed_at, metadata_json
         ) VALUES (?, ?, ?, 'confirmed', 'buyer', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
        [runId, buyerCategory, requesterPlayerId, toJson({ buyer: true })]
    );
    remaining[buyerCategory] -= 1;
    for (const category of ['squad', 'invited', 'public']) {
        for (let index = 0; index < remaining[category]; index += 1) {
            await db.run(
                `INSERT INTO clover_dream_slots (run_id, category, status, source)
                 VALUES (?, ?, 'open', 'allocation')`,
                [runId, category]
            );
        }
    }
}

async function approveDreamRequest(db, requestId, actorId, input = {}) {
    await ensureDreamWorldsSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const request = await db.get('SELECT * FROM clover_dream_requests WHERE id = ?', [Number(requestId)]);
        if (!request) throw new DreamWorldsServiceError('request_not_found', 'Solicitação não encontrada.');
        if (request.status === 'approved') {
            const run = await db.get('SELECT * FROM clover_dream_runs WHERE request_id = ?', [request.id]);
            await db.exec('COMMIT');
            return { duplicate: true, request: serializeRequest(request), run };
        }
        if (!['submitted', 'under_review', 'awaiting_confirmation'].includes(request.status)) {
            throw new DreamWorldsServiceError('request_not_approvable', 'Esta solicitação não pode ser aprovada.', { status: request.status });
        }
        const world = await db.get('SELECT * FROM clover_dream_worlds WHERE id = ?', [request.world_id]);
        if (!world || world.status !== 'available') {
            throw new DreamWorldsServiceError('world_not_available', 'A Fenda já não está disponível.');
        }

        let yulls = null;
        if (request.payment_method === 'yulls') {
            yulls = await spendYullsInTransaction(
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
                narrator_ids_json, metadata_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                generateKey('MS'),
                world.id,
                request.id,
                request.buyer_type,
                request.buyer_id,
                toJson(input.narratorIds || []),
                toJson(input.metadata || {}),
            ]
        );
        await createRunSlots(db, runInsert.lastID, world, request.requester_player_id, request.buyer_type);
        await db.run(
            `UPDATE clover_dream_requests
             SET status = 'approved', admin_note = ?, reviewed_by = ?,
                 reviewed_at = CURRENT_TIMESTAMP, approved_at = CURRENT_TIMESTAMP,
                 yulls_ledger_id = ?
             WHERE id = ?`,
            [text(input.adminNote), actorId, yulls?.ledgerId || null, request.id]
        );
        await db.run(
            `UPDATE clover_dream_worlds
             SET status = 'reserved', updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'available'`,
            [world.id]
        );
        const approved = await db.get('SELECT * FROM clover_dream_requests WHERE id = ?', [request.id]);
        const run = await db.get('SELECT * FROM clover_dream_runs WHERE id = ?', [runInsert.lastID]);
        await audit(db, actorId, 'request_approved', 'dream_request', request.id, {
            before: serializeRequest(request),
            after: serializeRequest(approved),
            metadata: { runId: run.id, yullsLedgerId: yulls?.ledgerId || null },
        });
        await db.exec('COMMIT');
        return { duplicate: false, request: serializeRequest(approved), run, yulls };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function rejectDreamRequest(db, requestId, actorId, input = {}) {
    await ensureDreamWorldsSchema(db);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const request = await db.get('SELECT * FROM clover_dream_requests WHERE id = ?', [Number(requestId)]);
        if (!request) throw new DreamWorldsServiceError('request_not_found', 'Solicitação não encontrada.');
        if (!['submitted', 'under_review', 'awaiting_confirmation'].includes(request.status)) {
            throw new DreamWorldsServiceError('request_not_rejectable', 'Esta solicitação não pode ser recusada.', { status: request.status });
        }
        await db.run(
            `UPDATE clover_dream_requests
             SET status = 'rejected', admin_note = ?, reviewed_by = ?,
                 reviewed_at = CURRENT_TIMESTAMP, rejected_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [text(input.adminNote), actorId, request.id]
        );
        const rejected = await db.get('SELECT * FROM clover_dream_requests WHERE id = ?', [request.id]);
        await audit(db, actorId, 'request_rejected', 'dream_request', request.id, {
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
    const wallet = await getYullsSummary(db, playerId);
    const [requests, runs, fragments] = await Promise.all([
        db.all(
            `SELECT request.*, world.name AS world_name, world.slug AS world_slug, world.status AS world_status
             FROM clover_dream_requests request
             JOIN clover_dream_worlds world ON world.id = request.world_id
             WHERE request.requester_player_id = ?
             ORDER BY request.id DESC`,
            [playerId]
        ),
        db.all(
            `SELECT DISTINCT run.*, world.name AS world_name, world.slug AS world_slug
             FROM clover_dream_runs run
             JOIN clover_dream_worlds world ON world.id = run.world_id
             LEFT JOIN clover_dream_slots slot ON slot.run_id = run.id
             WHERE (run.buyer_type = 'player' AND run.buyer_id = ?) OR slot.player_id = ?
             ORDER BY run.id DESC`,
            [playerId, playerId]
        ),
        db.all(
            `SELECT fragment.*, world.name AS origin_world_name, world.slug AS origin_world_slug
             FROM clover_resonance_fragments fragment
             LEFT JOIN clover_dream_worlds world ON world.id = fragment.origin_world_id
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
    transitionDreamWorldStatus,
};
