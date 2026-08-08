'use strict';

const crypto = require('crypto');
const {
    BOX_CATALOGS,
    getAnyTemplate,
} = require('./seasonalEventCatalog');
const { getBoxPityPolicy } = require('./boxPityPolicy');

const CATALOG_STATUSES = Object.freeze(['draft', 'active', 'archived']);
const REWARD_TYPES = Object.freeze(new Set([
    'yulls',
    'ph',
    'item',
    'item_pool',
    'title',
    'unique_relic_pool',
]));

class BoxCatalogVersionError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'BoxCatalogVersionError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function fingerprint(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function parseJson(value, fallback = null) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
}

function cleanText(value, maximum = 200) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maximum) : '';
}

function validatePositiveInteger(value, label, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new BoxCatalogVersionError('invalid_catalog_number', `${label} inválido.`, 400, { label, value });
    }
    return parsed;
}

function validateRangeReward(reward, index) {
    const min = Number(reward.min);
    const max = Number(reward.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
        throw new BoxCatalogVersionError(
            'invalid_box_reward_range',
            `A recompensa ${index + 1} possui intervalo inválido.`,
            400,
            { rewardKey: reward.key, min: reward.min, max: reward.max }
        );
    }
    if (reward.type === 'yulls') {
        const step = Number(reward.step || 1);
        if (!Number.isSafeInteger(step) || step < 1) {
            throw new BoxCatalogVersionError('invalid_box_reward_step', `A recompensa ${reward.key} possui step inválido.`, 400);
        }
    }
}

function assertTemplateExists(templateKey, context) {
    const key = cleanText(templateKey, 160);
    if (!key || !getAnyTemplate(key)) {
        throw new BoxCatalogVersionError(
            'box_reward_template_not_found',
            `Referência de item/título inexistente em ${context}.`,
            400,
            { templateKey: key || null, context }
        );
    }
    return key;
}

function normalizeReward(raw, index) {
    const reward = raw && typeof raw === 'object' && !Array.isArray(raw) ? clone(raw) : {};
    const key = cleanText(reward.key, 160);
    const label = cleanText(reward.label, 240);
    const type = cleanText(reward.type, 80).toLowerCase();
    const chance = Number(reward.chance);
    if (!key || !label) {
        throw new BoxCatalogVersionError('invalid_box_reward_identity', `A recompensa ${index + 1} precisa de key e label.`, 400);
    }
    if (!REWARD_TYPES.has(type)) {
        throw new BoxCatalogVersionError('unsupported_box_reward_type', `Tipo de recompensa não suportado: ${type || '(vazio)'}.`, 400, { key, type });
    }
    if (!Number.isFinite(chance) || chance <= 0 || chance > 100) {
        throw new BoxCatalogVersionError('invalid_box_reward_chance', `Chance inválida em ${key}.`, 400, { chance });
    }

    reward.key = key;
    reward.label = label;
    reward.type = type;
    reward.chance = chance;

    if (type === 'yulls' || type === 'ph') validateRangeReward(reward, index);
    if (type === 'item' || type === 'title') {
        reward.templateKey = assertTemplateExists(reward.templateKey, key);
    }
    if (type === 'item_pool' || type === 'unique_relic_pool') {
        if (!Array.isArray(reward.pool) || !reward.pool.length || reward.pool.length > 100) {
            throw new BoxCatalogVersionError('invalid_box_reward_pool', `Pool inválido em ${key}.`, 400);
        }
        reward.pool = [...new Set(reward.pool.map((entry) => assertTemplateExists(entry, key)))];
        if (!reward.pool.length) throw new BoxCatalogVersionError('empty_box_reward_pool', `Pool vazio em ${key}.`, 400);
    }
    if (reward.expiresInDays !== undefined && reward.expiresInDays !== null) {
        reward.expiresInDays = validatePositiveInteger(reward.expiresInDays, `expiresInDays de ${key}`, 1, 3650);
    }
    reward.pityTier = cleanText(reward.pityTier, 80) || null;
    reward.qualitySuccess = Boolean(reward.qualitySuccess);
    return reward;
}

function validateBoxCatalogDefinition(rawCatalog, options = {}) {
    const raw = rawCatalog && typeof rawCatalog === 'object' && !Array.isArray(rawCatalog) ? clone(rawCatalog) : {};
    const key = cleanText(raw.key || options.boxKey, 80).toLowerCase();
    if (!key || !BOX_CATALOGS[key]) {
        throw new BoxCatalogVersionError('unknown_box_catalog_key', 'Tipo de Caixa desconhecido.', 400, { key });
    }
    const name = cleanText(raw.name, 160);
    const templateKey = assertTemplateExists(raw.templateKey, `Caixa ${key}`);
    const version = validatePositiveInteger(raw.version, 'Versão do catálogo', 1, 1000000);
    if (!name) throw new BoxCatalogVersionError('box_catalog_name_required', 'O catálogo precisa de nome.', 400);
    if (!Array.isArray(raw.rewards) || !raw.rewards.length || raw.rewards.length > 60) {
        throw new BoxCatalogVersionError('invalid_box_reward_count', 'O catálogo precisa ter entre 1 e 60 recompensas.', 400);
    }
    const rewards = raw.rewards.map(normalizeReward);
    const keys = new Set();
    for (const reward of rewards) {
        if (keys.has(reward.key)) {
            throw new BoxCatalogVersionError('duplicate_box_reward_key', `Recompensa duplicada: ${reward.key}.`, 400);
        }
        keys.add(reward.key);
    }
    const totalUnits = rewards.reduce((sum, reward) => sum + Math.round(reward.chance * 100), 0);
    if (totalUnits !== 10000) {
        throw new BoxCatalogVersionError(
            'box_catalog_chance_total_invalid',
            `As probabilidades precisam fechar exatamente em 100%; o catálogo soma ${(totalUnits / 100).toFixed(2)}%.`,
            400,
            { totalUnits, totalChance: totalUnits / 100 }
        );
    }
    const ultraRelics = rewards.filter((reward) => reward.pityTier === 'ultra_relic');
    if (ultraRelics.length !== 1 || ultraRelics[0].type !== 'unique_relic_pool') {
        throw new BoxCatalogVersionError(
            'box_catalog_relic_tier_invalid',
            'Cada Caixa precisa de exatamente uma recompensa ultra_relic ligada ao pool de relíquias.',
            400
        );
    }
    if (!rewards.some((reward) => reward.pityTier === 'high_non_relic')) {
        throw new BoxCatalogVersionError('box_catalog_quality_tier_missing', 'A Caixa precisa de ao menos uma recompensa high_non_relic para o pity de qualidade.', 400);
    }
    return { key, templateKey, name, version, rewards };
}

function validateBoxPityPolicy(rawPolicy, boxKey) {
    const policy = rawPolicy && typeof rawPolicy === 'object' && !Array.isArray(rawPolicy) ? clone(rawPolicy) : {};
    const quality = policy.quality && typeof policy.quality === 'object' ? policy.quality : {};
    const relic = policy.relic && typeof policy.relic === 'object' ? policy.relic : {};
    const softAfterMisses = validatePositiveInteger(quality.softAfterMisses, 'softAfterMisses', 1, 100000);
    const hardAtOpening = validatePositiveInteger(quality.hardAtOpening, 'hardAtOpening', 2, 100000);
    const softBonusPercentagePoints = Number(quality.softBonusPercentagePoints);
    if (hardAtOpening <= softAfterMisses) {
        throw new BoxCatalogVersionError('invalid_quality_pity_order', 'O hard pity precisa acontecer depois do início do soft pity.', 400);
    }
    if (!Number.isFinite(softBonusPercentagePoints) || softBonusPercentagePoints < 0 || softBonusPercentagePoints > 100) {
        throw new BoxCatalogVersionError('invalid_quality_pity_bonus', 'Bônus do soft pity inválido.', 400);
    }
    const boostAfterMisses = validatePositiveInteger(relic.boostAfterMisses, 'boostAfterMisses', 1, 100000);
    const stepBaseMultiplier = Number(relic.stepBaseMultiplier);
    const maxMultiplier = Number(relic.maxMultiplier);
    const maxAbsoluteBonusPercentagePoints = Number(relic.maxAbsoluteBonusPercentagePoints);
    if (!Number.isFinite(stepBaseMultiplier) || stepBaseMultiplier < 0 || stepBaseMultiplier > 10) {
        throw new BoxCatalogVersionError('invalid_relic_pity_step', 'Passo do pity de relíquia inválido.', 400);
    }
    if (!Number.isFinite(maxMultiplier) || maxMultiplier < 1 || maxMultiplier > 100) {
        throw new BoxCatalogVersionError('invalid_relic_pity_multiplier', 'Multiplicador máximo do pity de relíquia inválido.', 400);
    }
    if (!Number.isFinite(maxAbsoluteBonusPercentagePoints) || maxAbsoluteBonusPercentagePoints < 0 || maxAbsoluteBonusPercentagePoints > 100) {
        throw new BoxCatalogVersionError('invalid_relic_pity_absolute_cap', 'Bônus absoluto máximo do pity de relíquia inválido.', 400);
    }
    return {
        quality: { softAfterMisses, hardAtOpening, softBonusPercentagePoints },
        relic: { boostAfterMisses, stepBaseMultiplier, maxMultiplier, maxAbsoluteBonusPercentagePoints },
        boxKey,
    };
}

async function ensureBoxCatalogVersionSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_box_catalog_versions (
            box_key TEXT NOT NULL,
            version INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            catalog_json TEXT NOT NULL,
            pity_policy_json TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'admin',
            reason TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            activated_by TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            activated_at TEXT DEFAULT NULL,
            archived_at TEXT DEFAULT NULL,
            PRIMARY KEY (box_key, version),
            CHECK (status IN ('draft', 'active', 'archived'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_box_catalog_one_active
            ON clover_box_catalog_versions(box_key)
            WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_clover_box_catalog_versions_status
            ON clover_box_catalog_versions(status, box_key, version DESC);
    `);
}

function sourceSnapshot(boxKey) {
    const source = BOX_CATALOGS[boxKey];
    if (!source) throw new BoxCatalogVersionError('box_catalog_not_found', 'Catálogo fonte não encontrado.', 404, { boxKey });
    const catalog = validateBoxCatalogDefinition(clone(source), { boxKey });
    const policy = validateBoxPityPolicy(getBoxPityPolicy(boxKey), boxKey);
    return { catalog, policy };
}

async function seedSourceBoxCatalogVersions(db) {
    await ensureBoxCatalogVersionSchema(db);
    for (const boxKey of Object.keys(BOX_CATALOGS)) {
        const count = await db.get('SELECT COUNT(*) AS total FROM clover_box_catalog_versions WHERE box_key = ?', [boxKey]);
        if (Number(count?.total || 0) > 0) continue;
        const { catalog, policy } = sourceSnapshot(boxKey);
        const hash = fingerprint({ catalog, policy });
        await db.run(
            `INSERT INTO clover_box_catalog_versions (
                box_key, version, status, catalog_json, pity_policy_json,
                fingerprint, source, reason, created_by, activated_by,
                created_at, activated_at
             ) VALUES (?, ?, 'active', ?, ?, ?, 'source-bootstrap', ?, 'system', 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
                boxKey,
                catalog.version,
                JSON.stringify(catalog),
                JSON.stringify(policy),
                hash,
                'Versão canônica importada do catálogo fonte atual.',
            ]
        );
    }
}

function mapVersion(row) {
    if (!row) return null;
    return {
        boxKey: row.box_key,
        version: Number(row.version),
        status: row.status,
        catalog: parseJson(row.catalog_json, null),
        pityPolicy: parseJson(row.pity_policy_json, null),
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

async function listBoxCatalogVersions(db, boxKey = null) {
    await seedSourceBoxCatalogVersions(db);
    const key = cleanText(boxKey, 80).toLowerCase();
    const rows = key
        ? await db.all('SELECT * FROM clover_box_catalog_versions WHERE box_key = ? ORDER BY version DESC', [key])
        : await db.all('SELECT * FROM clover_box_catalog_versions ORDER BY box_key, version DESC');
    return rows.map(mapVersion);
}

async function getActiveBoxCatalogVersion(db, boxKey) {
    await seedSourceBoxCatalogVersions(db);
    const key = cleanText(boxKey, 80).toLowerCase();
    const row = await db.get(
        `SELECT * FROM clover_box_catalog_versions
         WHERE box_key = ? AND status = 'active'
         ORDER BY version DESC LIMIT 1`,
        [key]
    );
    return mapVersion(row);
}

async function createDraftBoxCatalogVersion(db, input = {}, actorId = null, reason = null) {
    await seedSourceBoxCatalogVersions(db);
    const boxKey = cleanText(input.boxKey || input.catalog?.key, 80).toLowerCase();
    const current = await db.get(
        'SELECT MAX(version) AS max_version FROM clover_box_catalog_versions WHERE box_key = ?',
        [boxKey]
    );
    const nextVersion = Number(current?.max_version || 0) + 1;
    const catalog = validateBoxCatalogDefinition({ ...(input.catalog || {}), key: boxKey, version: nextVersion }, { boxKey });
    const policy = validateBoxPityPolicy(input.pityPolicy || input.policy, boxKey);
    const hash = fingerprint({ catalog, policy });
    await db.run(
        `INSERT INTO clover_box_catalog_versions (
            box_key, version, status, catalog_json, pity_policy_json,
            fingerprint, source, reason, created_by, created_at
         ) VALUES (?, ?, 'draft', ?, ?, ?, 'admin', ?, ?, CURRENT_TIMESTAMP)`,
        [boxKey, nextVersion, JSON.stringify(catalog), JSON.stringify(policy), hash, cleanText(reason, 2000) || null, actorId || null]
    );
    return mapVersion(await db.get(
        'SELECT * FROM clover_box_catalog_versions WHERE box_key = ? AND version = ?',
        [boxKey, nextVersion]
    ));
}

async function deleteUnusedDraftBoxCatalogVersion(db, boxKey, version) {
    await ensureBoxCatalogVersionSchema(db);
    const key = cleanText(boxKey, 80).toLowerCase();
    const numericVersion = validatePositiveInteger(version, 'Versão do catálogo', 1, 1000000);
    const row = await db.get(
        'SELECT * FROM clover_box_catalog_versions WHERE box_key = ? AND version = ?',
        [key, numericVersion]
    );
    if (!row) return { ok: true, deleted: false };
    if (row.status !== 'draft') {
        throw new BoxCatalogVersionError('box_catalog_version_not_draft', 'Somente uma versão ainda não ativada pode ser removida automaticamente.', 409);
    }
    const used = await db.get(
        'SELECT COUNT(*) AS total FROM clover_box_openings WHERE box_key = ? AND catalog_version = ?',
        [key, numericVersion]
    ).catch(() => ({ total: 0 }));
    if (Number(used?.total || 0) > 0) {
        throw new BoxCatalogVersionError('box_catalog_version_already_used', 'A versão já aparece em aberturas e não pode ser apagada.', 409);
    }
    await db.run(
        "DELETE FROM clover_box_catalog_versions WHERE box_key = ? AND version = ? AND status = 'draft'",
        [key, numericVersion]
    );
    return { ok: true, deleted: true };
}

module.exports = {
    BoxCatalogVersionError,
    CATALOG_STATUSES,
    REWARD_TYPES,
    createDraftBoxCatalogVersion,
    deleteUnusedDraftBoxCatalogVersion,
    ensureBoxCatalogVersionSchema,
    fingerprint,
    getActiveBoxCatalogVersion,
    listBoxCatalogVersions,
    mapVersion,
    seedSourceBoxCatalogVersions,
    sourceSnapshot,
    validateBoxCatalogDefinition,
    validateBoxPityPolicy,
};
