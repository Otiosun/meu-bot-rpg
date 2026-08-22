'use strict';

const crypto = require('crypto');
const { createItemExecutors } = require('./itemAdminService');
const { addPhInTransaction, appendPhLedgerEntryInTransaction, getPhSummary, recalculatePh } = require('./phService');
const { addYullsInTransaction, mutateYullsInTransaction } = require('./yullsService');

const REWARD_PACKAGE_STATUSES = Object.freeze(['active', 'archived']);
const REWARD_ENTRY_TYPES = Object.freeze(['yulls', 'ph', 'item']);

class AdminRewardServiceError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminRewardServiceError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function valuesMatch(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function requireText(value, field, maximum = 4000) {
    const text = String(value || '').trim();
    if (!text) {
        throw new AdminRewardServiceError('missing_reward_field', `${field} é obrigatório.`, 400, { field });
    }
    return text.slice(0, maximum);
}

function optionalText(value, maximum = 4000) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maximum) : null;
}

function normalizeKey(value, fallback = 'recompensa') {
    return String(value || fallback)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || fallback;
}

function asInteger(value, field, options = {}) {
    const number = Number(value);
    const minimum = options.minimum ?? 1;
    const maximum = options.maximum ?? 1000000000;
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new AdminRewardServiceError('invalid_reward_field', `${field} inválido.`, 400, {
            field,
            minimum,
            maximum,
        });
    }
    return number;
}

function nowIso() {
    return new Date().toISOString();
}

function generateRewardId(randomBytes = crypto.randomBytes) {
    return `RW-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function normalizeEntryType(value) {
    const raw = String(value || '').trim().toLowerCase();
    const aliases = {
        yull: 'yulls',
        dinheiro: 'yulls',
        money: 'yulls',
        ponto_habilidade: 'ph',
        pontos_habilidade: 'ph',
        item_template: 'item',
        box: 'item',
        caixa: 'item',
    };
    const type = aliases[raw] || raw;
    if (!REWARD_ENTRY_TYPES.includes(type)) {
        throw new AdminRewardServiceError(
            'unsupported_reward_entry',
            `Tipo de recompensa não suportado: ${raw || '(vazio)'}.`,
            400,
            { type: raw, supported: REWARD_ENTRY_TYPES }
        );
    }
    return type;
}

function normalizeRewardEntries(value) {
    const source = Array.isArray(value) ? value : [];
    if (!source.length) {
        throw new AdminRewardServiceError('empty_reward_package', 'O pacote precisa de pelo menos uma recompensa.');
    }
    if (source.length > 20) {
        throw new AdminRewardServiceError('reward_package_too_large', 'O pacote aceita no máximo 20 recompensas.');
    }

    const seenResourceTypes = new Set();
    const seenTemplates = new Set();
    return source.map((entryValue, index) => {
        const entry = entryValue && typeof entryValue === 'object' && !Array.isArray(entryValue)
            ? entryValue
            : {};
        const type = normalizeEntryType(entry.type || entry.kind || entry.tipo);
        const label = optionalText(entry.label || entry.name || entry.nome, 160);
        if (type === 'yulls') {
            if (seenResourceTypes.has(type)) {
                throw new AdminRewardServiceError('duplicate_reward_resource', 'Use apenas uma entrada de Yulls por pacote.', 400);
            }
            seenResourceTypes.add(type);
            return {
                type,
                amount: asInteger(entry.amount ?? entry.quantidade ?? entry.value, `Yulls da entrada ${index + 1}`),
                label: label || 'Yulls',
            };
        }
        if (type === 'ph') {
            if (seenResourceTypes.has(type)) {
                throw new AdminRewardServiceError('duplicate_reward_resource', 'Use apenas uma entrada de PH por pacote.', 400);
            }
            seenResourceTypes.add(type);
            return {
                type,
                amount: asInteger(entry.amount ?? entry.quantidade ?? entry.value, `PH da entrada ${index + 1}`, {
                    maximum: 100000,
                }),
                label: label || 'PH fora do teto',
            };
        }

        const templateKey = requireText(
            entry.templateKey || entry.template_key || entry.key,
            `Modelo do item da entrada ${index + 1}`,
            120
        );
        const normalizedTemplate = templateKey.toLowerCase();
        if (seenTemplates.has(normalizedTemplate)) {
            throw new AdminRewardServiceError(
                'duplicate_reward_item',
                `O modelo ${templateKey} aparece mais de uma vez no pacote.`,
                400
            );
        }
        seenTemplates.add(normalizedTemplate);
        return {
            type: 'item',
            templateKey,
            quantity: asInteger(entry.quantity ?? entry.quantidade ?? entry.amount ?? 1, `Quantidade do item da entrada ${index + 1}`, {
                maximum: 100,
            }),
            label,
        };
    });
}

async function ensureAdminRewardSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_reward_packages (
            id TEXT PRIMARY KEY,
            canonical_key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            description TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            version INTEGER NOT NULL DEFAULT 1,
            entries_json TEXT NOT NULL DEFAULT '[]',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            operation_code TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            updated_by TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_reward_packages_status_name
        ON clover_reward_packages (status, name, id)
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_reward_grants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            grant_key TEXT NOT NULL UNIQUE,
            package_id TEXT NOT NULL,
            package_version INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            operation_code TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'applied',
            effects_json TEXT NOT NULL DEFAULT '[]',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            granted_by TEXT DEFAULT NULL,
            granted_at TEXT NOT NULL,
            undone_by TEXT DEFAULT NULL,
            undone_at TEXT DEFAULT NULL,
            FOREIGN KEY (package_id) REFERENCES clover_reward_packages(id)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_reward_grants_player_status
        ON clover_reward_grants (player_id, status, granted_at DESC, id DESC)
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_reward_grants_package_status
        ON clover_reward_grants (package_id, status, granted_at DESC, id DESC)
    `);
}

function mapRewardPackage(row) {
    if (!row) return null;
    return {
        id: row.id,
        canonicalKey: row.canonical_key,
        name: row.name,
        description: row.description || null,
        status: row.status,
        version: Number(row.version || 1),
        entries: parseJson(row.entries_json, []),
        metadata: parseJson(row.metadata_json, {}),
        operationCode: row.operation_code || null,
        createdBy: row.created_by || null,
        updatedBy: row.updated_by || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
    };
}

function mapRewardGrant(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        grantKey: row.grant_key,
        packageId: row.package_id,
        packageVersion: Number(row.package_version || 1),
        playerId: row.player_id,
        characterName: row.personagem_nome || row.player_id,
        packageName: row.package_name || row.package_id,
        operationCode: row.operation_code,
        status: row.status,
        effects: parseJson(row.effects_json, []),
        metadata: parseJson(row.metadata_json, {}),
        grantedBy: row.granted_by || null,
        grantedAt: row.granted_at || null,
        undoneBy: row.undone_by || null,
        undoneAt: row.undone_at || null,
    };
}

function grantSelectSql() {
    return `SELECT grant.*, j.personagem_nome, package.name AS package_name
            FROM clover_reward_grants grant
            LEFT JOIN jogadores j ON j.id = grant.player_id
            LEFT JOIN clover_reward_packages package ON package.id = grant.package_id`;
}

async function getRewardPackage(db, packageId, options = {}) {
    await ensureAdminRewardSchema(db);
    const id = String(packageId || '').trim().toUpperCase();
    const row = await db.get('SELECT * FROM clover_reward_packages WHERE id = ?', [id]);
    if (!row) {
        if (options.nullIfMissing) return null;
        throw new AdminRewardServiceError('reward_package_not_found', 'Pacote de recompensa não encontrado.', 404, {
            packageId: id,
        });
    }
    return mapRewardPackage(row);
}

async function listRewardPackages(db, options = {}) {
    await ensureAdminRewardSchema(db);
    const conditions = [];
    const params = [];
    if (!options.includeArchived) conditions.push("status = 'active'");
    if (options.query) {
        const pattern = `%${String(options.query).trim()}%`;
        conditions.push(`(LOWER(name) LIKE LOWER(?)
            OR LOWER(COALESCE(description, '')) LIKE LOWER(?)
            OR LOWER(canonical_key) LIKE LOWER(?))`);
        params.push(pattern, pattern, pattern);
    }
    params.push(Math.max(1, Math.min(300, Number(options.limit) || 100)));
    const rows = await db.all(
        `SELECT * FROM clover_reward_packages
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY status ASC, updated_at DESC, name ASC, id ASC
         LIMIT ?`,
        params
    );
    return {
        ok: true,
        packages: rows.map(mapRewardPackage),
        statuses: [...REWARD_PACKAGE_STATUSES],
        supportedEntryTypes: [...REWARD_ENTRY_TYPES],
    };
}

async function listRewardGrants(db, options = {}) {
    await ensureAdminRewardSchema(db);
    const conditions = [];
    const params = [];
    if (options.playerId) {
        conditions.push('grant.player_id = ?');
        params.push(String(options.playerId).trim());
    }
    if (options.packageId) {
        conditions.push('grant.package_id = ?');
        params.push(String(options.packageId).trim().toUpperCase());
    }
    if (options.status) {
        conditions.push('grant.status = ?');
        params.push(String(options.status).trim().toLowerCase());
    }
    params.push(Math.max(1, Math.min(300, Number(options.limit) || 100)));
    const rows = await db.all(
        `${grantSelectSql()}
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY grant.id DESC
         LIMIT ?`,
        params
    );
    return { ok: true, grants: rows.map(mapRewardGrant) };
}

function normalizePackagePayload(payload = {}, options = {}) {
    const partial = options.partial === true;
    const has = (...keys) => keys.some((key) => Object.prototype.hasOwnProperty.call(payload, key));
    const result = {};
    if (!partial || has('name', 'nome')) result.name = requireText(payload.name || payload.nome, 'Nome', 160);
    if (!partial || has('description', 'descricao')) result.description = optionalText(payload.description || payload.descricao, 4000);
    if (!partial || has('canonicalKey', 'canonical_key', 'key')) {
        result.canonicalKey = normalizeKey(payload.canonicalKey || payload.canonical_key || payload.key || result.name || payload.name);
    }
    if (!partial || has('entries', 'rewards', 'recompensas')) {
        result.entries = normalizeRewardEntries(payload.entries || payload.rewards || payload.recompensas);
    }
    if (!partial || has('metadata')) {
        result.metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
            ? stableValue(payload.metadata)
            : {};
    }
    if (partial && !Object.keys(result).length) {
        throw new AdminRewardServiceError('empty_reward_package_update', 'Nenhuma alteração foi informada.');
    }
    return result;
}

async function createRewardPackage(db, payload, context = {}) {
    await ensureAdminRewardSchema(db);
    const data = normalizePackagePayload(payload);
    const timestamp = context.timestamp || nowIso();
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const id = String(payload.id || generateRewardId(context.randomBytes)).trim().toUpperCase();
        try {
            await db.run(
                `INSERT INTO clover_reward_packages
                 (id, canonical_key, name, description, status, version, entries_json, metadata_json,
                  operation_code, created_by, updated_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id, data.canonicalKey, data.name, data.description,
                    JSON.stringify(data.entries), JSON.stringify(data.metadata),
                    context.operationCode || null, context.actorId || null, context.actorId || null,
                    timestamp, timestamp,
                ]
            );
            return getRewardPackage(db, id);
        } catch (error) {
            const message = String(error?.message || error);
            if (/clover_reward_packages\.id/i.test(message) && !payload.id) continue;
            if (/canonical_key/i.test(message)) {
                throw new AdminRewardServiceError('reward_package_duplicate', 'Já existe um pacote com esse código canônico.', 409, {
                    canonicalKey: data.canonicalKey,
                });
            }
            throw error;
        }
    }
    throw new AdminRewardServiceError('reward_package_id_collision', 'Não foi possível gerar o identificador do pacote.', 503);
}

function comparablePackage(value) {
    if (!value) return value;
    const { operationCode, updatedBy, updatedAt, ...stable } = value;
    return stable;
}

async function assertPackageUnchanged(db, expected) {
    const current = await getRewardPackage(db, expected?.id, { nullIfMissing: true });
    if (!current || !expected || !valuesMatch(comparablePackage(current), comparablePackage(expected))) {
        throw new AdminRewardServiceError(
            'reward_package_changed_since_apply',
            'O pacote foi alterado depois da aplicação e não pode ser desfeito automaticamente.',
            409,
            { packageId: expected?.id || null }
        );
    }
}

async function restorePackageSnapshot(db, snapshot, context = {}) {
    await db.run(
        `UPDATE clover_reward_packages
         SET canonical_key = ?, name = ?, description = ?, status = ?, version = ?,
             entries_json = ?, metadata_json = ?, operation_code = ?, updated_by = ?, updated_at = ?
         WHERE id = ?`,
        [
            snapshot.canonicalKey, snapshot.name, snapshot.description, snapshot.status,
            snapshot.version, JSON.stringify(snapshot.entries || []), JSON.stringify(snapshot.metadata || {}),
            snapshot.operationCode || null, context.actorId || null, context.timestamp || nowIso(), snapshot.id,
        ]
    );
}

async function previewPackageEntries(db, operation, action, target, packageSnapshot, unitId = 'preview') {
    const player = await db.get(
        `SELECT id, personagem_nome, COALESCE(dinheiro, 0) AS dinheiro
         FROM jogadores WHERE id = ?`,
        [target.playerId]
    );
    if (!player) throw new AdminRewardServiceError('player_not_found', 'Jogador não encontrado.', 404, { playerId: target.playerId });

    const itemExecutor = createItemExecutors()['player.item.grant'];
    const effects = [];
    let yullsBalance = Number(player.dinheiro || 0);
    let phSummary = null;
    for (let index = 0; index < packageSnapshot.entries.length; index += 1) {
        const entry = packageSnapshot.entries[index];
        if (entry.type === 'yulls') {
            effects.push({ type: 'yulls', amount: entry.amount, label: entry.label, before: yullsBalance, after: yullsBalance + entry.amount });
            yullsBalance += entry.amount;
            continue;
        }
        if (entry.type === 'ph') {
            phSummary ||= await getPhSummary(db, target.playerId);
            effects.push({
                type: 'ph',
                amount: entry.amount,
                label: entry.label,
                before: phSummary,
                after: {
                    ...phSummary,
                    phAccumulated: phSummary.phAccumulated + entry.amount,
                    phAvailable: phSummary.phAvailable + entry.amount,
                },
            });
            continue;
        }
        const preview = await itemExecutor.preview({
            db,
            operation,
            action: { type: 'player.item.grant', payload: { templateKey: entry.templateKey, quantity: entry.quantity } },
            target,
            unit: { id: `${unitId}-${index}` },
        });
        effects.push({ type: 'item', entryIndex: index, label: entry.label || preview.after.itemName, preview: preview.after });
    }
    return effects;
}

async function applyRewardEntries(db, operation, action, target, unit, packageSnapshot) {
    const effects = [];
    const itemExecutor = createItemExecutors()['player.item.grant'];
    for (let index = 0; index < packageSnapshot.entries.length; index += 1) {
        const entry = packageSnapshot.entries[index];
        const effectKey = `${operation.code}:unit:${unit.id}:reward:${index}`;
        if (entry.type === 'yulls') {
            const result = await addYullsInTransaction(
                db,
                target.playerId,
                entry.amount,
                'admin_reward_package',
                `Pacote ${packageSnapshot.name}`,
                operation.actor.id,
                {
                    relatedId: operation.code,
                    idempotencyKey: effectKey,
                    metadata: { packageId: packageSnapshot.id, packageVersion: packageSnapshot.version, entryIndex: index },
                }
            );
            effects.push({ type: 'yulls', entryIndex: index, amount: entry.amount, label: entry.label, ...result });
            continue;
        }
        if (entry.type === 'ph') {
            const result = await addPhInTransaction(
                db,
                target.playerId,
                entry.amount,
                'admin_reward_package',
                `Pacote ${packageSnapshot.name}`,
                operation.actor.id,
                { packageId: packageSnapshot.id, packageVersion: packageSnapshot.version, entryIndex: index, operationCode: operation.code },
                effectKey
            );
            effects.push({ type: 'ph', entryIndex: index, amount: entry.amount, label: entry.label, ...result });
            continue;
        }
        const syntheticAction = {
            type: 'player.item.grant',
            payload: { templateKey: entry.templateKey, quantity: entry.quantity },
        };
        const applied = await itemExecutor.apply({
            db,
            operation,
            action: syntheticAction,
            target,
            unit: { ...unit, id: `${unit.id}-${index}` },
            after: {
                playerId: target.playerId,
                templateKey: entry.templateKey,
                itemName: entry.label || entry.templateKey,
                quantity: entry.quantity,
            },
        });
        effects.push({
            type: 'item',
            entryIndex: index,
            label: entry.label || applied.after?.itemName || entry.templateKey,
            snapshot: applied.after,
        });
    }
    return effects;
}

async function assertLatestLedger(db, table, playerId, expectedId, code, message) {
    const row = await db.get(`SELECT id FROM ${table} WHERE player_id = ? ORDER BY id DESC LIMIT 1`, [playerId]);
    if (Number(row?.id || 0) !== Number(expectedId || 0)) {
        throw new AdminRewardServiceError(code, message, 409, {
            expectedLedgerId: Number(expectedId || 0),
            latestLedgerId: Number(row?.id || 0),
        });
    }
}

async function undoPhEffect(db, operation, playerId, effect) {
    await assertLatestLedger(
        db,
        'clover_ph_ledger',
        playerId,
        effect.ledgerId,
        'reward_ph_changed_since_apply',
        'O PH recebeu outro lançamento depois deste pacote e não pode ser desfeito automaticamente.'
    );
    const current = await getPhSummary(db, playerId);
    if (!valuesMatch(current, effect.after)) {
        throw new AdminRewardServiceError('reward_ph_state_changed', 'O estado de PH mudou depois do pacote.', 409);
    }
    await appendPhLedgerEntryInTransaction(db, playerId, {
        amount: -Math.abs(effect.amount),
        kind: 'estorno',
        source: 'admin_reward_undo',
        reason: `Desfazer pacote ${effect.label || ''}`.trim(),
        relatedId: operation.code,
        createdBy: operation.actor.id,
        metadata: {
            accumulated_delta: -Math.abs(effect.amount),
            available_delta: -Math.abs(effect.amount),
            original_ledger_id: effect.ledgerId,
        },
    });
    await recalculatePh(db, playerId);
}

async function undoYullsEffect(db, operation, playerId, effect) {
    await assertLatestLedger(
        db,
        'clover_yulls_ledger',
        playerId,
        effect.ledgerId,
        'reward_yulls_changed_since_apply',
        'Os Yulls receberam outro lançamento depois deste pacote e não podem ser desfeitos automaticamente.'
    );
    const player = await db.get('SELECT COALESCE(dinheiro, 0) AS dinheiro FROM jogadores WHERE id = ?', [playerId]);
    if (Number(player?.dinheiro || 0) !== Number(effect.balanceAfter || 0)) {
        throw new AdminRewardServiceError('reward_yulls_state_changed', 'O saldo de Yulls mudou depois do pacote.', 409);
    }
    await mutateYullsInTransaction(db, playerId, {
        amount: -Math.abs(effect.amount),
        kind: 'ajuste_admin',
        source: 'admin_reward_undo',
        reason: `Desfazer pacote ${effect.label || ''}`.trim(),
        createdBy: operation.actor.id,
        relatedId: operation.code,
        idempotencyKey: `${operation.code}:reward-undo:yulls:${effect.entryIndex}`,
        metadata: { affects_accumulated: false, original_ledger_id: effect.ledgerId },
    });
}

async function undoRewardEffects(db, operation, playerId, effects) {
    const itemExecutor = createItemExecutors()['player.item.grant'];
    for (const effect of [...(effects || [])].reverse()) {
        if (effect.type === 'item') {
            await itemExecutor.undo({ db, operation, after: effect.snapshot });
        } else if (effect.type === 'ph') {
            await undoPhEffect(db, operation, playerId, effect);
        } else if (effect.type === 'yulls') {
            await undoYullsEffect(db, operation, playerId, effect);
        }
    }
}

function createRewardExecutors() {
    return {
        'catalog.reward.create': {
            async preview({ action }) {
                const data = normalizePackagePayload(action.payload || {});
                return {
                    summary: `Criar pacote: ${data.name}`,
                    before: null,
                    after: { ...data, status: 'active', version: 1 },
                };
            },
            async apply({ db, operation, action }) {
                const packageSnapshot = await createRewardPackage(db, action.payload || {}, {
                    operationCode: operation.code,
                    actorId: operation.actor.id,
                });
                return { before: null, after: packageSnapshot, summary: `Pacote ${packageSnapshot.name} criado.` };
            },
            async undo({ db, after }) {
                await assertPackageUnchanged(db, after);
                const grants = await db.get('SELECT COUNT(*) AS total FROM clover_reward_grants WHERE package_id = ?', [after.id]);
                if (Number(grants?.total || 0) > 0) {
                    throw new AdminRewardServiceError('reward_package_in_use', 'O pacote já possui concessões e não pode ser removido pelo desfazer.', 409);
                }
                await db.run('DELETE FROM clover_reward_packages WHERE id = ?', [after.id]);
            },
        },
        'catalog.reward.update': {
            async preview({ db, action }) {
                const packageId = requireText(action.payload?.packageId || action.payload?.id, 'packageId', 40).toUpperCase();
                const before = await getRewardPackage(db, packageId);
                const changes = normalizePackagePayload(action.payload || {}, { partial: true });
                return {
                    summary: `Editar pacote: ${before.name}`,
                    before,
                    after: { ...before, ...changes, version: before.version + 1 },
                };
            },
            async apply({ db, operation, after }) {
                await db.run(
                    `UPDATE clover_reward_packages
                     SET canonical_key = ?, name = ?, description = ?, version = ?, entries_json = ?,
                         metadata_json = ?, operation_code = ?, updated_by = ?, updated_at = ?
                     WHERE id = ?`,
                    [
                        after.canonicalKey, after.name, after.description, after.version,
                        JSON.stringify(after.entries), JSON.stringify(after.metadata || {}),
                        operation.code, operation.actor.id, nowIso(), after.id,
                    ]
                );
                const current = await getRewardPackage(db, after.id);
                return { after: current, summary: `Pacote ${current.name} atualizado.` };
            },
            async undo({ db, operation, before, after }) {
                await assertPackageUnchanged(db, after);
                await restorePackageSnapshot(db, before, { actorId: operation.actor.id });
            },
        },
        'catalog.reward.archive': {
            async preview({ db, action }) {
                const before = await getRewardPackage(db, action.payload?.packageId || action.payload?.id);
                return {
                    summary: `Arquivar pacote: ${before.name}`,
                    before,
                    after: { ...before, status: 'archived', version: before.version + 1 },
                };
            },
            async apply({ db, operation, after }) {
                await db.run(
                    `UPDATE clover_reward_packages
                     SET status = 'archived', version = ?, operation_code = ?, updated_by = ?, updated_at = ?
                     WHERE id = ?`,
                    [after.version, operation.code, operation.actor.id, nowIso(), after.id]
                );
                const current = await getRewardPackage(db, after.id);
                return { after: current, summary: `Pacote ${current.name} arquivado.` };
            },
            async undo({ db, operation, before, after }) {
                await assertPackageUnchanged(db, after);
                await restorePackageSnapshot(db, before, { actorId: operation.actor.id });
            },
        },
        'catalog.reward.restore': {
            async preview({ db, action }) {
                const before = await getRewardPackage(db, action.payload?.packageId || action.payload?.id);
                return {
                    summary: `Restaurar pacote: ${before.name}`,
                    before,
                    after: { ...before, status: 'active', version: before.version + 1 },
                };
            },
            async apply({ db, operation, after }) {
                await db.run(
                    `UPDATE clover_reward_packages
                     SET status = 'active', version = ?, operation_code = ?, updated_by = ?, updated_at = ?
                     WHERE id = ?`,
                    [after.version, operation.code, operation.actor.id, nowIso(), after.id]
                );
                const current = await getRewardPackage(db, after.id);
                return { after: current, summary: `Pacote ${current.name} restaurado.` };
            },
            async undo({ db, operation, before, after }) {
                await assertPackageUnchanged(db, after);
                await restorePackageSnapshot(db, before, { actorId: operation.actor.id });
            },
        },
        'reward.grant': {
            async preview({ db, operation, action, target }) {
                const packageSnapshot = await getRewardPackage(db, action.payload?.packageId || action.payload?.id);
                if (packageSnapshot.status !== 'active') {
                    throw new AdminRewardServiceError('reward_package_archived', 'O pacote está arquivado.', 409);
                }
                const effects = await previewPackageEntries(db, operation, action, target, packageSnapshot);
                return {
                    summary: `${target.characterName || target.playerId}: conceder ${packageSnapshot.name}`,
                    before: { playerId: target.playerId, effects: effects.map((effect) => ({ type: effect.type, before: effect.before || null })) },
                    after: {
                        playerId: target.playerId,
                        characterName: target.characterName || target.playerId,
                        package: packageSnapshot,
                        effects,
                    },
                };
            },
            async apply({ db, operation, action, target, unit, after }) {
                const currentPackage = await getRewardPackage(db, after.package?.id || action.payload?.packageId || action.payload?.id);
                if (currentPackage.status !== 'active') {
                    throw new AdminRewardServiceError('reward_package_archived', 'O pacote foi arquivado depois da simulação.', 409);
                }
                if (!valuesMatch(comparablePackage(currentPackage), comparablePackage(after.package))) {
                    throw new AdminRewardServiceError('reward_package_changed_after_preview', 'O pacote mudou depois da simulação. Gere uma nova prévia.', 409);
                }
                const grantKey = `${operation.code}:unit:${unit.id}:reward-grant`;
                const existing = await db.get(`${grantSelectSql()} WHERE grant.grant_key = ?`, [grantKey]);
                if (existing) {
                    const grant = mapRewardGrant(existing);
                    return {
                        after: { ...after, grant, effects: grant.effects, duplicate: true },
                        summary: `${target.characterName || target.playerId}: pacote ${currentPackage.name} já concedido.`,
                    };
                }
                const effects = await applyRewardEntries(db, operation, action, target, unit, currentPackage);
                const inserted = await db.run(
                    `INSERT INTO clover_reward_grants
                     (grant_key, package_id, package_version, player_id, operation_code, status,
                      effects_json, metadata_json, granted_by, granted_at)
                     VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?)`,
                    [
                        grantKey, currentPackage.id, currentPackage.version, target.playerId,
                        operation.code, JSON.stringify(effects),
                        JSON.stringify({ actionPayload: action.payload || {} }), operation.actor.id, nowIso(),
                    ]
                );
                const grant = mapRewardGrant(await db.get(`${grantSelectSql()} WHERE grant.id = ?`, [inserted.lastID]));
                return {
                    after: { ...after, package: currentPackage, grant, effects, duplicate: false },
                    summary: `${target.characterName || target.playerId}: pacote ${currentPackage.name} concedido.`,
                };
            },
            async undo({ db, operation, after }) {
                const grantId = Number(after?.grant?.id || 0);
                const grant = grantId > 0
                    ? mapRewardGrant(await db.get(`${grantSelectSql()} WHERE grant.id = ?`, [grantId]))
                    : null;
                if (!grant || grant.status !== 'applied') {
                    throw new AdminRewardServiceError('reward_grant_not_applied', 'A concessão não está disponível para desfazimento.', 409);
                }
                await undoRewardEffects(db, operation, grant.playerId, grant.effects);
                await db.run(
                    `UPDATE clover_reward_grants
                     SET status = 'undone', undone_by = ?, undone_at = ?
                     WHERE id = ? AND status = 'applied'`,
                    [operation.actor.id, nowIso(), grant.id]
                );
            },
        },
    };
}

module.exports = {
    AdminRewardServiceError,
    REWARD_ENTRY_TYPES,
    REWARD_PACKAGE_STATUSES,
    createRewardExecutors,
    createRewardPackage,
    ensureAdminRewardSchema,
    getRewardPackage,
    listRewardGrants,
    listRewardPackages,
    mapRewardGrant,
    mapRewardPackage,
    normalizePackagePayload,
    normalizeRewardEntries,
    undoRewardEffects,
};
