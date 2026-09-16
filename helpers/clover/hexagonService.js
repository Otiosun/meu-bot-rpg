const { ensureCloverManaHexagonSchema } = require('../../database');
const { ensurePhState, getPhSummary, spendPhInTransaction } = require('./phService');
const { normalizeText } = require('../textUtils');
const { getRetentionDuration } = require('./spellRuntimeRules');

const HEXAGON_SIDES = [
    { key: 'controle', label: 'Controle', aliases: ['controle', 'controlar'] },
    { key: 'precisao', label: 'Precisão', aliases: ['precisao', 'precisão', 'preciso'] },
    { key: 'estabilidade', label: 'Estabilidade', aliases: ['estabilidade', 'estavel', 'estável'] },
    { key: 'retencao', label: 'Retenção', aliases: ['retencao', 'retenção', 'reter', 'duracao', 'duração'] },
    { key: 'alcance', label: 'Alcance', aliases: ['alcance', 'distancia', 'distância'] },
    { key: 'escala', label: 'Escala', aliases: ['escala', 'area', 'área'] },
];

const SIDE_BY_KEY = Object.fromEntries(HEXAGON_SIDES.map((side) => [side.key, side]));

const ALCANCE_LABELS = [
    '3 m', '8 m', '15 m', '30 m', '60 m', '120 m', '250 m+ conforme técnica e contexto',
];
const CONTROLE_LABELS = [
    'simples e direto', 'pequeno ajuste', 'duas operações simples ou variação contínua',
    '3–4 operações ou divisão estável', 'várias funções já permitidas em combate complexo',
    'alto paralelismo e ajuste dinâmico', 'domínio extremo de coordenação',
];
const PRECISAO_LABELS = [
    'grosseira', 'zona clara', 'alvo pequeno ou contorno fino', 'execução fina sob movimento',
    'cirúrgica e seletiva', 'finesse extrema', 'microprecisão de mestre',
];
const ESTABILIDADE_LABELS = [
    'frágil a perturbação', 'suporta ambiente e movimento normal', 'interferência moderada',
    'combate intenso', 'alta resistência a ruído, choque e mana concorrente',
    'difícil de romper sem counter equivalente', 'integridade de mestre',
];
const ESCALA_LABELS = [
    'objeto ou alvo pequeno', 'pessoa, objeto grande ou área local pequena',
    'alguns alvos próximos ou sala pequena', 'sala grande ou zona pequena de batalha',
    'área local ampla ou muitos alvos', 'campo, estrutura ou grupo muito grande',
    'escala excepcional com validação ADM',
];
const HEXAGON_UPGRADE_COSTS = Object.freeze({ 2: 50, 3: 100, 4: 200, 5: 300, 6: 500, 7: 800 });
const HEXAGON_UPGRADE_PENDING_MINUTES = 15;

class HexagonServiceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'HexagonServiceError';
        this.code = code;
    }
}

async function ensureHexagonSchema(db) {
    await ensureCloverManaHexagonSchema(db);
}

function normalizeSide(side) {
    const normalized = normalizeText(side)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalized) return null;

    return HEXAGON_SIDES.find((item) => item.aliases
        .map((alias) => normalizeText(alias).replace(/[^a-z0-9]+/g, ' ').trim())
        .includes(normalized))?.key || null;
}

function assertPlayerId(playerId) {
    const normalized = String(playerId || '').trim();
    if (!normalized) {
        throw new HexagonServiceError('missing_player', 'Player inválido.');
    }
    return normalized;
}

function assertSide(side) {
    const normalized = normalizeSide(side);
    if (!normalized || !SIDE_BY_KEY[normalized]) {
        throw new HexagonServiceError('invalid_side', 'Lado do Hexágono inválido.');
    }
    return normalized;
}

function assertHexagonValue(value) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 7) {
        throw new HexagonServiceError('invalid_value', 'Valor do Hexágono precisa ser inteiro entre 1 e 7.');
    }
    return number;
}

function valueIndex(value) {
    return Math.max(0, Math.min(6, Number(value || 1) - 1));
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

function serializeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    return JSON.stringify(metadata);
}

function getSideLabel(side) {
    return SIDE_BY_KEY[side]?.label || side;
}

function getSideLimitLabel(side, value) {
    const index = valueIndex(value);
    if (side === 'alcance') return ALCANCE_LABELS[index];
    if (side === 'retencao') return getRetentionDuration(index + 1);
    if (side === 'controle') return CONTROLE_LABELS[index];
    if (side === 'precisao') return PRECISAO_LABELS[index];
    if (side === 'estabilidade') return ESTABILIDADE_LABELS[index];
    if (side === 'escala') return ESCALA_LABELS[index];
    return `${value}/7`;
}

function getUpgradeCost(nextValue) {
    return HEXAGON_UPGRADE_COSTS[Number(nextValue)] || null;
}

function requiresUpgradeApproval(nextValue) {
    return false;
}

function isPendingExpired(row) {
    return row?.expires_at && new Date(row.expires_at).getTime() <= Date.now();
}

function hydratePendingUpgrade(row) {
    if (!row) return null;
    return {
        ...row,
        oldValue: Number(row.old_value || 1),
        newValue: Number(row.new_value || 1),
        cost: Number(row.cost || 0),
        requiresApproval: Number(row.requires_approval || 0) === 1,
        sideLabel: getSideLabel(row.side),
        oldLimitLabel: getSideLimitLabel(row.side, row.old_value),
        newLimitLabel: getSideLimitLabel(row.side, row.new_value),
        metadata: safeJsonParse(row.metadata_json, {}),
    };
}

async function getOrCreateHexagon(db, playerId) {
    const normalizedPlayerId = assertPlayerId(playerId);
    await ensureHexagonSchema(db);

    await db.run(
        `INSERT OR IGNORE INTO clover_mana_hexagon
         (player_id, updated_at)
         VALUES (?, CURRENT_TIMESTAMP)`,
        [normalizedPlayerId]
    );

    return db.get('SELECT * FROM clover_mana_hexagon WHERE player_id = ?', [normalizedPlayerId]);
}

async function clearPendingHexagonUpgrade(db, playerId) {
    const normalizedPlayerId = assertPlayerId(playerId);
    await ensureHexagonSchema(db);
    await db.run('DELETE FROM clover_pending_hexagon_upgrades WHERE player_id = ?', [normalizedPlayerId]);
}

async function getPendingHexagonUpgrade(db, playerId) {
    const normalizedPlayerId = assertPlayerId(playerId);
    await ensureHexagonSchema(db);
    const row = await db.get(
        `SELECT *
         FROM clover_pending_hexagon_upgrades
         WHERE player_id = ?`,
        [normalizedPlayerId]
    );
    if (!row) return null;

    if (isPendingExpired(row)) {
        await clearPendingHexagonUpgrade(db, normalizedPlayerId);
        return null;
    }

    return hydratePendingUpgrade(row);
}

async function createPendingHexagonUpgrade(db, playerId, side, createdBy) {
    const normalizedPlayerId = assertPlayerId(playerId);
    const normalizedSide = assertSide(side);

    await ensureHexagonSchema(db);
    await ensurePhState(db, normalizedPlayerId);

    const hexagon = await getOrCreateHexagon(db, normalizedPlayerId);
    const ph = await getPhSummary(db, normalizedPlayerId);
    const oldValue = Number(hexagon?.[normalizedSide] || 1);

    if (oldValue >= 7) {
        return {
            ok: false,
            reason: 'max_level',
            side: normalizedSide,
            sideLabel: getSideLabel(normalizedSide),
            oldValue,
            ph,
        };
    }

    const newValue = oldValue + 1;
    const cost = getUpgradeCost(newValue);
    const requiresApproval = requiresUpgradeApproval(newValue);

    if (!cost) {
        throw new HexagonServiceError('invalid_cost', 'Custo de Hexágono não configurado.');
    }

    if (ph.phAvailable < cost) {
        return {
            ok: false,
            reason: 'insufficient_ph',
            side: normalizedSide,
            sideLabel: getSideLabel(normalizedSide),
            oldValue,
            newValue,
            oldLimitLabel: getSideLimitLabel(normalizedSide, oldValue),
            newLimitLabel: getSideLimitLabel(normalizedSide, newValue),
            cost,
            missingPh: cost - ph.phAvailable,
            requiresApproval,
            ph,
        };
    }

    const expiresAt = new Date(Date.now() + HEXAGON_UPGRADE_PENDING_MINUTES * 60 * 1000).toISOString();
    const metadata = {
        old_limit_label: getSideLimitLabel(normalizedSide, oldValue),
        new_limit_label: getSideLimitLabel(normalizedSide, newValue),
    };

    await db.run(
        `INSERT INTO clover_pending_hexagon_upgrades
         (player_id, side, old_value, new_value, cost, requires_approval, created_by, created_at, expires_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
             side = excluded.side,
             old_value = excluded.old_value,
             new_value = excluded.new_value,
             cost = excluded.cost,
             requires_approval = excluded.requires_approval,
             created_by = excluded.created_by,
             created_at = CURRENT_TIMESTAMP,
             expires_at = excluded.expires_at,
             metadata_json = excluded.metadata_json`,
        [
            normalizedPlayerId,
            normalizedSide,
            oldValue,
            newValue,
            cost,
            requiresApproval ? 1 : 0,
            String(createdBy || '').trim() || normalizedPlayerId,
            expiresAt,
            serializeMetadata(metadata),
        ]
    );

    const pending = await getPendingHexagonUpgrade(db, normalizedPlayerId);
    return {
        ok: true,
        pending,
        ph,
        expiresAt,
    };
}

async function setHexagonSide(db, playerId, side, value, adminId, reason) {
    const normalizedPlayerId = assertPlayerId(playerId);
    const normalizedSide = assertSide(side);
    const nextValue = assertHexagonValue(value);
    const normalizedAdminId = String(adminId || '').trim() || null;
    const normalizedReason = String(reason || '').trim() || null;

    await ensureHexagonSchema(db);
    await db.exec('BEGIN IMMEDIATE');

    try {
        await db.run(
            `INSERT OR IGNORE INTO clover_mana_hexagon
             (player_id, updated_at)
             VALUES (?, CURRENT_TIMESTAMP)`,
            [normalizedPlayerId]
        );

        const before = await db.get(
            'SELECT * FROM clover_mana_hexagon WHERE player_id = ?',
            [normalizedPlayerId]
        );
        const oldValue = Number(before?.[normalizedSide] || 1);

        await db.run(
            `UPDATE clover_mana_hexagon
             SET ${normalizedSide} = ?,
                 updated_at = CURRENT_TIMESTAMP,
                 updated_by = ?
             WHERE player_id = ?`,
            [nextValue, normalizedAdminId, normalizedPlayerId]
        );

        const ledger = await db.run(
            `INSERT INTO clover_mana_hexagon_ledger
             (player_id, side, old_value, new_value, reason, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
                normalizedPlayerId,
                normalizedSide,
                oldValue,
                nextValue,
                normalizedReason,
                normalizedAdminId,
            ]
        );

        const after = await db.get(
            'SELECT * FROM clover_mana_hexagon WHERE player_id = ?',
            [normalizedPlayerId]
        );

        await db.exec('COMMIT');

        return {
            ok: true,
            playerId: normalizedPlayerId,
            side: normalizedSide,
            sideLabel: SIDE_BY_KEY[normalizedSide].label,
            oldValue,
            newValue: nextValue,
            reason: normalizedReason,
            ledgerId: ledger.lastID,
            hexagon: after,
        };
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function applyPendingHexagonUpgrade(db, playerId, createdBy, options = {}) {
    const normalizedPlayerId = assertPlayerId(playerId);
    await ensureHexagonSchema(db);
    await ensurePhState(db, normalizedPlayerId);

    const row = await db.get(
        `SELECT *
         FROM clover_pending_hexagon_upgrades
         WHERE player_id = ?`,
        [normalizedPlayerId]
    );
    if (!row) return { ok: false, reason: 'missing_pending' };

    if (isPendingExpired(row)) {
        await clearPendingHexagonUpgrade(db, normalizedPlayerId);
        return { ok: false, reason: 'expired_pending', pending: hydratePendingUpgrade(row) };
    }

    const pending = hydratePendingUpgrade(row);
    if (pending.requiresApproval && !options.allowApproval) {
        return { ok: false, reason: 'approval_required', pending };
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const current = await db.get(
            'SELECT * FROM clover_mana_hexagon WHERE player_id = ?',
            [normalizedPlayerId]
        );
        const currentValue = Number(current?.[pending.side] || 1);

        if (currentValue !== pending.oldValue) {
            await db.run('DELETE FROM clover_pending_hexagon_upgrades WHERE player_id = ?', [normalizedPlayerId]);
            await db.exec('COMMIT');
            return {
                ok: false,
                reason: 'stale_pending',
                pending,
                currentValue,
            };
        }

        await db.run(
            `UPDATE clover_mana_hexagon
             SET ${pending.side} = ?,
                 updated_at = CURRENT_TIMESTAMP,
                 updated_by = ?
             WHERE player_id = ?`,
            [pending.newValue, String(createdBy || '').trim() || normalizedPlayerId, normalizedPlayerId]
        );

        const reason = options.reason
            || `Up de Hexágono: ${pending.sideLabel} ${pending.oldValue}/7 -> ${pending.newValue}/7`;

        const hexagonLedger = await db.run(
            `INSERT INTO clover_mana_hexagon_ledger
             (player_id, side, old_value, new_value, reason, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
                normalizedPlayerId,
                pending.side,
                pending.oldValue,
                pending.newValue,
                reason,
                String(createdBy || '').trim() || normalizedPlayerId,
            ]
        );

        const spend = await spendPhInTransaction(
            db,
            normalizedPlayerId,
            pending.cost,
            'hexagon_upgrade',
            reason,
            String(createdBy || '').trim() || normalizedPlayerId,
            {
                side: pending.side,
                side_label: pending.sideLabel,
                old_value: pending.oldValue,
                new_value: pending.newValue,
                requires_approval: pending.requiresApproval,
                hexagon_ledger_id: hexagonLedger.lastID,
            },
            `hexagon:${pending.side}:${pending.newValue}`
        );

        await db.run('DELETE FROM clover_pending_hexagon_upgrades WHERE player_id = ?', [normalizedPlayerId]);

        const after = await db.get(
            'SELECT * FROM clover_mana_hexagon WHERE player_id = ?',
            [normalizedPlayerId]
        );

        await db.exec('COMMIT');

        return {
            ok: true,
            pending,
            spend,
            hexagon: after,
            ledgerId: hexagonLedger.lastID,
        };
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }
}

async function confirmPendingHexagonUpgrade(db, playerId, createdBy = null) {
    return applyPendingHexagonUpgrade(db, playerId, createdBy || playerId, { allowApproval: false });
}

async function approvePendingHexagonUpgrade(db, playerId, adminId, reason = null) {
    return applyPendingHexagonUpgrade(db, playerId, adminId, {
        allowApproval: true,
        reason: String(reason || '').trim() || null,
    });
}

async function cancelPendingHexagonUpgrade(db, playerId) {
    const pending = await getPendingHexagonUpgrade(db, playerId);
    if (!pending) return { ok: false, reason: 'missing_pending' };
    await clearPendingHexagonUpgrade(db, playerId);
    return { ok: true, pending };
}

function formatHexagonShort(hexagon) {
    return HEXAGON_SIDES
        .map((side) => `*${side.label}:* ${Number(hexagon?.[side.key] || 1)}/7`)
        .join('\n');
}

function getHexagonDerivedLimits(hexagon) {
    return {
        alcanceLabel: ALCANCE_LABELS[valueIndex(hexagon?.alcance)],
        duracaoLabel: getRetentionDuration(valueIndex(hexagon?.retencao) + 1),
        controleLabel: CONTROLE_LABELS[valueIndex(hexagon?.controle)],
        precisaoLabel: PRECISAO_LABELS[valueIndex(hexagon?.precisao)],
        estabilidadeLabel: ESTABILIDADE_LABELS[valueIndex(hexagon?.estabilidade)],
        escalaLabel: ESCALA_LABELS[valueIndex(hexagon?.escala)],
    };
}

module.exports = {
    HEXAGON_SIDES,
    HEXAGON_UPGRADE_COSTS,
    HexagonServiceError,
    applyPendingHexagonUpgrade,
    assertHexagonValue,
    approvePendingHexagonUpgrade,
    cancelPendingHexagonUpgrade,
    clearPendingHexagonUpgrade,
    confirmPendingHexagonUpgrade,
    createPendingHexagonUpgrade,
    ensureHexagonSchema,
    formatHexagonShort,
    getHexagonDerivedLimits,
    getOrCreateHexagon,
    getPendingHexagonUpgrade,
    getSideLimitLabel,
    getUpgradeCost,
    normalizeSide,
    requiresUpgradeApproval,
    setHexagonSide,
};
