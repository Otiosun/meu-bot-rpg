'use strict';

const crypto = require('crypto');
const { getTemplate } = require('./economyItemCatalog');

const AVAILABILITY = new Set(['comum', 'regional', 'exclusivo', 'restrito']);

class ShopCatalogVersionError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'ShopCatalogVersionError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function fingerprint(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function cleanText(value, maximum = 240) {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, maximum) : '';
}

function nullableText(value, maximum = 4000) {
    const text = cleanText(value, maximum);
    return text || null;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, nullable = false } = {}) {
    if (nullable && (value === null || value === undefined || value === '')) return null;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
        throw new ShopCatalogVersionError('invalid_shop_catalog_number', `${label} inválido.`, 400, { label, value });
    }
    return number;
}

function normalizeMetadata(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : {};
}

function parseJson(value, fallback = {}) {
    if (!value) return clone(fallback);
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : clone(fallback);
    } catch {
        return clone(fallback);
    }
}

function normalizeShop(raw, index) {
    const shopKey = cleanText(raw?.shopKey ?? raw?.key, 120).toLowerCase();
    const name = cleanText(raw?.name, 180);
    if (!shopKey || !name) {
        throw new ShopCatalogVersionError('invalid_shop_identity', `Loja ${index + 1} precisa de código e nome.`, 400);
    }
    return {
        shopKey,
        name,
        description: nullableText(raw?.description, 4000),
        active: raw?.active !== false,
        displayOrder: integer(raw?.displayOrder ?? raw?.order ?? index, 'Ordem da loja', { min: 0, max: 100000 }),
        metadata: normalizeMetadata(raw?.metadata),
    };
}

function normalizeListing(raw, index, shopKeys) {
    const listingKey = cleanText(raw?.listingKey ?? raw?.key, 160).toLowerCase();
    const shopKey = cleanText(raw?.shopKey, 120).toLowerCase();
    const templateKey = cleanText(raw?.templateKey, 160).toLowerCase();
    if (!listingKey || !shopKey || !templateKey) {
        throw new ShopCatalogVersionError('invalid_shop_listing_identity', `Oferta ${index + 1} precisa de listingKey, shopKey e templateKey.`, 400);
    }
    if (!shopKeys.has(shopKey)) {
        throw new ShopCatalogVersionError('shop_listing_unknown_shop', `A oferta ${listingKey} referencia uma loja inexistente.`, 400, { shopKey });
    }
    if (!getTemplate(templateKey)) {
        throw new ShopCatalogVersionError('shop_listing_unknown_template', `Item inexistente no catálogo: ${templateKey}.`, 400, { templateKey });
    }
    const availability = cleanText(raw?.availability || 'comum', 40).toLowerCase();
    if (!AVAILABILITY.has(availability)) {
        throw new ShopCatalogVersionError('invalid_shop_listing_availability', `Disponibilidade inválida em ${listingKey}.`, 400, { availability });
    }
    const startsAt = nullableText(raw?.startsAt, 80);
    const endsAt = nullableText(raw?.endsAt, 80);
    if (startsAt && Number.isNaN(new Date(startsAt).getTime())) {
        throw new ShopCatalogVersionError('invalid_shop_listing_start', `Início inválido em ${listingKey}.`, 400);
    }
    if (endsAt && Number.isNaN(new Date(endsAt).getTime())) {
        throw new ShopCatalogVersionError('invalid_shop_listing_end', `Fim inválido em ${listingKey}.`, 400);
    }
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
        throw new ShopCatalogVersionError('invalid_shop_listing_window', `Janela temporal inválida em ${listingKey}.`, 400);
    }

    return {
        listingKey,
        shopKey,
        templateKey,
        quality: cleanText(raw?.quality || 'comum', 80) || 'comum',
        availability,
        unitPrice: integer(raw?.unitPrice, 'Preço', { min: 0, max: 1000000000 }),
        deliveryMinutes: integer(raw?.deliveryMinutes ?? 0, 'Prazo de entrega', { min: 0, max: 525600 }),
        regionalFeePercent: integer(raw?.regionalFeePercent ?? 0, 'Taxa regional', { min: 0, max: 1000 }),
        personalWeeklyLimit: integer(raw?.personalWeeklyLimit, 'Limite semanal', { min: 1, max: 1000000, nullable: true }),
        globalStock: integer(raw?.globalStock, 'Estoque global', { min: 0, max: 1000000000, nullable: true }),
        active: raw?.active !== false,
        displayOrder: integer(raw?.displayOrder ?? index, 'Ordem da oferta', { min: 0, max: 100000 }),
        startsAt,
        endsAt,
        metadata: normalizeMetadata(raw?.metadata),
    };
}

function validateShopCatalogDefinition(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? clone(raw) : {};
    if (!Array.isArray(source.shops) || !source.shops.length) {
        throw new ShopCatalogVersionError('shop_catalog_empty', 'O catálogo precisa de ao menos uma loja.', 400);
    }
    if (!Array.isArray(source.listings)) {
        throw new ShopCatalogVersionError('shop_catalog_listings_invalid', 'A lista de ofertas é inválida.', 400);
    }

    const shops = source.shops.map(normalizeShop);
    const shopKeys = new Set();
    for (const shop of shops) {
        if (shopKeys.has(shop.shopKey)) {
            throw new ShopCatalogVersionError('duplicate_shop_key', `Loja duplicada: ${shop.shopKey}.`, 400);
        }
        shopKeys.add(shop.shopKey);
    }

    const listings = source.listings.map((entry, index) => normalizeListing(entry, index, shopKeys));
    const listingKeys = new Set();
    for (const listing of listings) {
        if (listingKeys.has(listing.listingKey)) {
            throw new ShopCatalogVersionError('duplicate_shop_listing_key', `Oferta duplicada: ${listing.listingKey}.`, 400);
        }
        listingKeys.add(listing.listingKey);
    }

    return {
        shops,
        listings,
    };
}

async function ensureShopCatalogVersionSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_shop_catalog_versions (
            version INTEGER PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'active', 'archived')),
            catalog_json TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'admin',
            reason TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            activated_by TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            activated_at TEXT DEFAULT NULL,
            archived_at TEXT DEFAULT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_shop_catalog_one_active
            ON clover_shop_catalog_versions(status)
            WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_clover_shop_catalog_versions_status
            ON clover_shop_catalog_versions(status, version DESC);
    `);
}

async function snapshotCurrentShopCatalog(db) {
    const shops = await db.all(
        'SELECT * FROM clover_economy_shops ORDER BY display_order ASC, shop_key ASC'
    );
    const listings = await db.all(
        'SELECT * FROM clover_economy_listings ORDER BY display_order ASC, listing_key ASC'
    );
    return validateShopCatalogDefinition({
        shops: shops.map((row) => ({
            shopKey: row.shop_key,
            name: row.name,
            description: row.description,
            active: Boolean(row.active),
            displayOrder: Number(row.display_order || 0),
            metadata: parseJson(row.metadata_json, {}),
        })),
        listings: listings.map((row) => ({
            listingKey: row.listing_key,
            shopKey: row.shop_key,
            templateKey: row.template_key,
            quality: row.quality,
            availability: row.availability,
            unitPrice: Number(row.unit_price || 0),
            deliveryMinutes: Number(row.delivery_minutes || 0),
            regionalFeePercent: Number(row.regional_fee_percent || 0),
            personalWeeklyLimit: row.personal_weekly_limit === null ? null : Number(row.personal_weekly_limit),
            globalStock: row.global_stock === null ? null : Number(row.global_stock),
            active: Boolean(row.active),
            displayOrder: Number(row.display_order || 0),
            startsAt: row.starts_at || null,
            endsAt: row.ends_at || null,
            metadata: parseJson(row.metadata_json, {}),
        })),
    });
}

function mapVersion(row) {
    if (!row) return null;
    return {
        version: Number(row.version),
        status: row.status,
        catalog: parseJson(row.catalog_json, null),
        fingerprint: row.fingerprint,
        source: row.source,
        reason: row.reason || null,
        createdBy: row.created_by || null,
        activatedBy: row.activated_by || null,
        createdAt: row.created_at || null,
        activatedAt: row.activated_at || null,
        archivedAt: row.archived_at || null,
    };
}

async function seedCurrentShopCatalogVersion(db) {
    await ensureShopCatalogVersionSchema(db);
    const count = await db.get('SELECT COUNT(*) AS total FROM clover_shop_catalog_versions');
    if (Number(count?.total || 0) > 0) return;
    const catalog = await snapshotCurrentShopCatalog(db);
    await db.run(
        `INSERT INTO clover_shop_catalog_versions
         (version, status, catalog_json, fingerprint, source, reason, created_by, activated_by, created_at, activated_at)
         VALUES (1, 'active', ?, ?, 'source-bootstrap', ?, 'system', 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
            JSON.stringify(catalog),
            fingerprint(catalog),
            'Versão canônica importada do catálogo de Economia V1.',
        ]
    );
}

async function listShopCatalogVersions(db) {
    await ensureShopCatalogVersionSchema(db);
    const rows = await db.all('SELECT * FROM clover_shop_catalog_versions ORDER BY version DESC');
    return rows.map(mapVersion);
}

async function getActiveShopCatalogVersion(db) {
    await ensureShopCatalogVersionSchema(db);
    return mapVersion(await db.get(
        `SELECT * FROM clover_shop_catalog_versions
         WHERE status = 'active'
         ORDER BY version DESC LIMIT 1`
    ));
}

async function getShopCatalogVersion(db, version) {
    await ensureShopCatalogVersionSchema(db);
    const numericVersion = integer(version, 'Versão do catálogo', { min: 1, max: 1000000 });
    return mapVersion(await db.get(
        'SELECT * FROM clover_shop_catalog_versions WHERE version = ?',
        [numericVersion]
    ));
}

async function deleteUnusedDraftShopCatalogVersion(db, version) {
    await ensureShopCatalogVersionSchema(db);
    const candidate = await getShopCatalogVersion(db, version);
    if (!candidate) return { ok: true, deleted: false };
    if (candidate.status !== 'draft') {
        throw new ShopCatalogVersionError(
            'shop_catalog_version_not_draft',
            'Somente uma versão draft pode ser removida automaticamente.',
            409
        );
    }
    const result = await db.run(
        `DELETE FROM clover_shop_catalog_versions
         WHERE version = ? AND status = 'draft'`,
        [candidate.version]
    );
    return { ok: true, deleted: Number(result?.changes || 0) === 1 };
}

async function createDraftShopCatalogVersion(db, input = {}, options = {}) {
    await ensureShopCatalogVersionSchema(db);
    const catalog = validateShopCatalogDefinition(input.catalog);
    const current = await db.get('SELECT COALESCE(MAX(version), 0) AS version FROM clover_shop_catalog_versions');
    const version = Number(current?.version || 0) + 1;
    const hash = fingerprint(catalog);
    await db.run(
        `INSERT INTO clover_shop_catalog_versions
         (version, status, catalog_json, fingerprint, source, reason, created_by, created_at)
         VALUES (?, 'draft', ?, ?, 'admin', ?, ?, CURRENT_TIMESTAMP)`,
        [
            version,
            JSON.stringify(catalog),
            hash,
            nullableText(input.reason, 2000),
            options.actorId || input.actorId || null,
        ]
    );
    return mapVersion(await db.get('SELECT * FROM clover_shop_catalog_versions WHERE version = ?', [version]));
}

async function materializeShopCatalog(db, rawCatalog) {
    const catalog = validateShopCatalogDefinition(rawCatalog);
    const shopKeys = catalog.shops.map((shop) => shop.shopKey);
    const listingKeys = catalog.listings.map((listing) => listing.listingKey);

    await db.run('UPDATE clover_economy_listings SET active = 0, updated_at = CURRENT_TIMESTAMP');
    await db.run('UPDATE clover_economy_shops SET active = 0, updated_at = CURRENT_TIMESTAMP');

    for (const shop of catalog.shops) {
        await db.run(
            `INSERT INTO clover_economy_shops
             (shop_key, name, description, active, display_order, created_at, updated_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
             ON CONFLICT(shop_key) DO UPDATE SET
                 name = excluded.name,
                 description = excluded.description,
                 active = excluded.active,
                 display_order = excluded.display_order,
                 updated_at = CURRENT_TIMESTAMP,
                 metadata_json = excluded.metadata_json`,
            [
                shop.shopKey,
                shop.name,
                shop.description,
                shop.active ? 1 : 0,
                shop.displayOrder,
                JSON.stringify(shop.metadata || {}),
            ]
        );
    }

    for (const listing of catalog.listings) {
        await db.run(
            `INSERT INTO clover_economy_listings
             (listing_key, shop_key, template_key, quality, availability, unit_price,
              delivery_minutes, regional_fee_percent, personal_weekly_limit, global_stock,
              sold_quantity, active, display_order, starts_at, ends_at, created_at, updated_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
             ON CONFLICT(listing_key) DO UPDATE SET
                 shop_key = excluded.shop_key,
                 template_key = excluded.template_key,
                 quality = excluded.quality,
                 availability = excluded.availability,
                 unit_price = excluded.unit_price,
                 delivery_minutes = excluded.delivery_minutes,
                 regional_fee_percent = excluded.regional_fee_percent,
                 personal_weekly_limit = excluded.personal_weekly_limit,
                 global_stock = excluded.global_stock,
                 active = excluded.active,
                 display_order = excluded.display_order,
                 starts_at = excluded.starts_at,
                 ends_at = excluded.ends_at,
                 updated_at = CURRENT_TIMESTAMP,
                 metadata_json = excluded.metadata_json`,
            [
                listing.listingKey,
                listing.shopKey,
                listing.templateKey,
                listing.quality,
                listing.availability,
                listing.unitPrice,
                listing.deliveryMinutes,
                listing.regionalFeePercent,
                listing.personalWeeklyLimit,
                listing.globalStock,
                listing.active ? 1 : 0,
                listing.displayOrder,
                listing.startsAt,
                listing.endsAt,
                JSON.stringify(listing.metadata || {}),
            ]
        );
    }

    return { catalog, shopKeys, listingKeys };
}

async function pendingPurchaseCount(db) {
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_economy_purchase_intents
         WHERE status = 'pending'`
    );
    return Number(row?.total || 0);
}

async function previewShopCatalogActivation(db, version) {
    await ensureShopCatalogVersionSchema(db);
    const candidate = await getShopCatalogVersion(db, version);
    if (!candidate) throw new ShopCatalogVersionError('shop_catalog_version_not_found', 'Versão de lojas não encontrada.', 404);
    if (candidate.status !== 'draft') {
        throw new ShopCatalogVersionError('shop_catalog_candidate_not_draft', 'Somente uma versão draft pode ser ativada.', 409);
    }
    const active = await getActiveShopCatalogVersion(db);
    const pending = await pendingPurchaseCount(db);
    return {
        active,
        candidate,
        pendingPurchaseCount: pending,
        changed: active?.fingerprint !== candidate.fingerprint,
    };
}

async function activateShopCatalogVersion(db, input = {}, options = {}) {
    const execute = async () => {
        const preview = await previewShopCatalogActivation(db, input.version);
        if (preview.pendingPurchaseCount > 0) {
            throw new ShopCatalogVersionError(
                'shop_catalog_pending_purchases',
                'Existem compras de loja aguardando confirmação. Resolva-as antes de ativar outro catálogo.',
                409,
                { pendingPurchaseCount: preview.pendingPurchaseCount }
            );
        }
        const actorId = options.actorId || input.actorId || null;
        if (preview.active) {
            await db.run(
                `UPDATE clover_shop_catalog_versions
                 SET status = 'archived', archived_at = CURRENT_TIMESTAMP
                 WHERE version = ? AND status = 'active'`,
                [preview.active.version]
            );
        }
        await materializeShopCatalog(db, preview.candidate.catalog);
        await db.run(
            `UPDATE clover_shop_catalog_versions
             SET status = 'active', activated_by = ?, activated_at = CURRENT_TIMESTAMP
             WHERE version = ? AND status = 'draft'`,
            [actorId, preview.candidate.version]
        );
        return {
            previous: preview.active,
            activated: await getActiveShopCatalogVersion(db),
        };
    };

    if (options.transactionManaged) return execute();
    await db.exec('BEGIN IMMEDIATE');
    try {
        const result = await execute();
        await db.exec('COMMIT');
        return result;
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function ensureRuntimeShopCatalogVersion(db) {
    await seedCurrentShopCatalogVersion(db);
    const active = await getActiveShopCatalogVersion(db);
    if (active?.catalog) await materializeShopCatalog(db, active.catalog);
    return active;
}

module.exports = {
    ShopCatalogVersionError,
    activateShopCatalogVersion,
    createDraftShopCatalogVersion,
    deleteUnusedDraftShopCatalogVersion,
    ensureRuntimeShopCatalogVersion,
    ensureShopCatalogVersionSchema,
    fingerprint,
    getActiveShopCatalogVersion,
    getShopCatalogVersion,
    listShopCatalogVersions,
    materializeShopCatalog,
    pendingPurchaseCount,
    previewShopCatalogActivation,
    seedCurrentShopCatalogVersion,
    snapshotCurrentShopCatalog,
    validateShopCatalogDefinition,
};
