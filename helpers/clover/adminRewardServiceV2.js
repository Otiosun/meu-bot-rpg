'use strict';

const crypto = require('crypto');
const base = require('./adminRewardService');
const { createItemExecutors } = require('./itemAdminService');
const {
    addPhInTransaction,
    getPhSummary,
    recalculatePh,
} = require('./phService');
const {
    addYullsInTransaction,
    mutateYullsInTransaction,
} = require('./yullsService');
const {
    addPaInTransaction,
    mutatePaInTransaction,
} = require('./paService');
const {
    adjustPoderMagicoInTransaction,
} = require('./characterStatAdjustmentService');
const {
    ensureWeeklyPhCapSchema,
    getWeeklyPhCapSummary,
    planWeeklyGrant,
    recordWeeklyPhUsageInTransaction,
    voidWeeklyPhUsageInTransaction,
} = require('./weeklyPhCapService');

const REWARD_ENTRY_TYPES_V2 = Object.freeze([
    'yulls',
    'ph',
    'pa',
    'pm',
    'item',
    'box',
]);
const PH_CAP_POLICIES = Object.freeze([
    'outside_weekly',
    'weekly',
    'adjustment',
]);

class AdminRewardV2Error extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminRewardV2Error';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function optionalText(value, maximum = 4000) {
    const text = String(value || '').trim();
    return text ? text.slice(0, maximum) : null;
}

function requireText(value, field, maximum = 4000) {
    const text = optionalText(value, maximum);
    if (!text) throw new AdminRewardV2Error('missing_reward_field', `${field} é obrigatório.`, 400, { field });
    return text;
}

function asInteger(value, field, maximum = 1_000_000_000) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
        throw new AdminRewardV2Error('invalid_reward_field', `${field} inválido.`, 400, { field, maximum });
    }
    return number;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function valuesMatch(left, right) {
    return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
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
        poder_magico: 'pm',
        'poder mágico': 'pm',
        item_template: 'item',
        caixa: 'box',
    };
    const type = aliases[raw] || raw;
    if (!REWARD_ENTRY_TYPES_V2.includes(type)) {
        throw new AdminRewardV2Error(
            'unsupported_reward_entry',
            `Tipo de recompensa ainda não suportado nesta etapa: ${raw || '(vazio)'}.`,
            400,
            { type: raw, supported: REWARD_ENTRY_TYPES_V2 }
        );
    }
    return type;
}

function normalizePhPolicy(value) {
    const raw = String(value || 'outside_weekly').trim().toLowerCase();
    const aliases = {
        fora: 'outside_weekly',
        fora_do_teto: 'outside_weekly',
        outside: 'outside_weekly',
        semanal: 'weekly',
        teto_semanal: 'weekly',
        conta_no_teto: 'weekly',
        ajuste: 'adjustment',
    };
    const policy = aliases[raw] || raw;
    if (!PH_CAP_POLICIES.includes(policy)) {
        throw new AdminRewardV2Error(
            'invalid_ph_cap_policy',
            'A política de PH precisa ser semanal, fora do teto ou ajuste.',
            400,
            { policy: raw, allowed: PH_CAP_POLICIES }
        );
    }
    return policy;
}

function normalizeRewardEntriesV2(value) {
    const source = Array.isArray(value) ? value : [];
    if (!source.length) throw new AdminRewardV2Error('empty_reward_package', 'O pacote precisa de pelo menos uma recompensa.');
    if (source.length > 30) throw new AdminRewardV2Error('reward_package_too_large', 'O pacote aceita no máximo 30 entradas.');

    const singleton = new Set();
    const seenItems = new Set();
    return source.map((entryValue, index) => {
        const entry = entryValue && typeof entryValue === 'object' && !Array.isArray(entryValue)
            ? entryValue
            : {};
        const type = normalizeEntryType(entry.type || entry.kind || entry.tipo);
        const label = optionalText(entry.label || entry.name || entry.nome, 160);

        if (['yulls', 'pa', 'pm'].includes(type)) {
            if (singleton.has(type)) {
                throw new AdminRewardV2Error('duplicate_reward_resource', `Use apenas uma entrada de ${type.toUpperCase()} por pacote.`);
            }
            singleton.add(type);
            return {
                type,
                amount: asInteger(entry.amount ?? entry.quantidade ?? entry.value, `${type.toUpperCase()} da entrada ${index + 1}`),
                label: label || type.toUpperCase(),
            };
        }

        if (type === 'ph') {
            if (singleton.has(type)) {
                throw new AdminRewardV2Error('duplicate_reward_resource', 'Use apenas uma entrada de PH por pacote.');
            }
            singleton.add(type);
            const capPolicy = normalizePhPolicy(entry.capPolicy || entry.cap_policy || entry.teto);
            const effectiveDate = optionalText(entry.effectiveDate || entry.effective_date || entry.sceneDate || entry.scene_date, 40);
            return {
                type,
                amount: asInteger(entry.amount ?? entry.quantidade ?? entry.value, `PH da entrada ${index + 1}`, 100_000),
                capPolicy,
                effectiveDate,
                label: label || (
                    capPolicy === 'weekly'
                        ? 'PH dentro do teto semanal'
                        : capPolicy === 'adjustment'
                            ? 'Ajuste de PH'
                            : 'PH fora do teto semanal'
                ),
            };
        }

        const templateKey = requireText(
            entry.templateKey || entry.template_key || entry.key,
            `Modelo do ${type === 'box' ? 'caixa' : 'item'} da entrada ${index + 1}`,
            120
        );
        const uniqueKey = `${type}:${templateKey.toLowerCase()}`;
        if (seenItems.has(uniqueKey)) {
            throw new AdminRewardV2Error('duplicate_reward_item', `O modelo ${templateKey} aparece mais de uma vez no pacote.`);
        }
        seenItems.add(uniqueKey);
        return {
            type,
            templateKey,
            quantity: asInteger(entry.quantity ?? entry.quantidade ?? entry.amount ?? 1, `Quantidade da entrada ${index + 1}`, 100),
            label,
        };
    });
}

function normalizePackagePayloadV2(payload = {}, options = {}) {
    const partial = options.partial === true;
    const has = (...keys) => keys.some((key) => Object.prototype.hasOwnProperty.call(payload, key));
    const result = {};
    if (!partial || has('name', 'nome')) result.name = requireText(payload.name || payload.nome, 'Nome', 160);
    if (!partial || has('description', 'descricao')) result.description = optionalText(payload.description || payload.descricao, 4000);
    if (!partial || has('canonicalKey', 'canonical_key', 'key')) {
        result.canonicalKey = normalizeKey(payload.canonicalKey || payload.canonical_key || payload.key || result.name || payload.name);
    }
    if (!partial || has('entries', 'rewards', 'recompensas')) {
        result.entries = normalizeRewardEntriesV2(payload.entries || payload.rewards || payload.recompensas);
    }
    if (!partial || has('metadata')) {
        result.metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
            ? stableValue(payload.metadata)
            : {};
    }
    if (partial && !Object.keys(result).length) {
        throw new AdminRewardV2Error('empty_reward_package_update', 'Nenhuma alteração foi informada.');
    }
    return result;
}

async function ensureAdminRewardV2Schema(db) {
    await base.ensureAdminRewardSchema(db);
    await ensureWeeklyPhCapSchema(db);
}

async function createRewardPackageV2(db, payload, context = {}) {
    await ensureAdminRewardV2Schema(db);
    const data = normalizePackagePayloadV2(payload);
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
                    id,
                    data.canonicalKey,
                    data.name,
                    data.description,
                    JSON.stringify(data.entries),
                    JSON.stringify({ ...(data.metadata || {}), rewardEngineVersion: 2 }),
                    context.operationCode || null,
                    context.actorId || null,
                    context.actorId || null,
                    timestamp,
                    timestamp,
                ]
            );
            return base.getRewardPackage(db, id);
        } catch (error) {
            const message = String(error?.message || error);
            if (/clover_reward_packages\.id/i.test(message) && !payload.id) continue;
            if (/canonical_key/i.test(message)) {
                throw new AdminRewardV2Error('reward_package_duplicate', 'Já existe um pacote com esse código canônico.', 409, { canonicalKey: data.canonicalKey });
            }
            throw error;
        }
    }
    throw new AdminRewardV2Error('reward_package_id_collision', 'Não foi possível gerar o identificador do pacote.', 503);
}

async function updateRewardPackageV2(db, packageId, changes, context = {}) {
    const before = await base.getRewardPackage(db, packageId);
    const normalized = normalizePackagePayloadV2(changes, { partial: true });
    const after = {
        ...before,
        ...normalized,
        version: before.version + 1,
        metadata: {
            ...(before.metadata || {}),
            ...(normalized.metadata || {}),
            rewardEngineVersion: 2,
        },
    };
    await db.run(
        `UPDATE clover_reward_packages
         SET canonical_key = ?, name = ?, description = ?, version = ?, entries_json = ?,
             metadata_json = ?, operation_code = ?, updated_by = ?, updated_at = ?
         WHERE id = ?`,
        [
            after.canonicalKey,
            after.name,
            after.description,
            after.version,
            JSON.stringify(after.entries),
            JSON.stringify(after.metadata),
            context.operationCode || null,
            context.actorId || null,
            context.timestamp || nowIso(),
            before.id,
        ]
    );
    return { before, after: await base.getRewardPackage(db, before.id) };
}

async function getPoderMagicoSummary(db, playerId) {
    const row = await db.get(
        `SELECT COALESCE(poder_magico, 0) AS value
         FROM clover_character_stats WHERE player_id = ?`,
        [playerId]
    );
    return Number(row?.value || 0);
}

async function previewEntriesV2(db, operation, target, packageSnapshot, unitId = 'preview') {
    const player = await db.get(
        `SELECT id, personagem_nome, COALESCE(dinheiro, 0) AS dinheiro
         FROM jogadores WHERE id = ?`,
        [target.playerId]
    );
    if (!player) throw new AdminRewardV2Error('player_not_found', 'Jogador não encontrado.', 404);

    const itemExecutor = createItemExecutors()['player.item.grant'];
    const effects = [];
    let yulls = Number(player.dinheiro || 0);
    let ph = null;

    for (let index = 0; index < packageSnapshot.entries.length; index += 1) {
        const entry = packageSnapshot.entries[index];
        if (entry.type === 'yulls') {
            effects.push({ type: 'yulls', entryIndex: index, amount: entry.amount, label: entry.label, before: yulls, after: yulls + entry.amount });
            yulls += entry.amount;
            continue;
        }
        if (entry.type === 'ph') {
            ph ||= await getPhSummary(db, target.playerId);
            if (entry.capPolicy === 'weekly') {
                const cap = await getWeeklyPhCapSummary(db, target.playerId, entry.effectiveDate || new Date());
                const plan = planWeeklyGrant(cap, entry.amount);
                if (plan.applied <= 0) {
                    throw new AdminRewardV2Error(
                        'weekly_ph_cap_exhausted',
                        `${target.characterName || target.playerId} já atingiu o teto semanal de PH.`,
                        409,
                        { cap, requested: entry.amount }
                    );
                }
                effects.push({
                    type: 'ph',
                    entryIndex: index,
                    amount: plan.applied,
                    requestedAmount: entry.amount,
                    capPolicy: 'weekly',
                    weeklyPlan: plan,
                    label: entry.label,
                    before: ph,
                    after: {
                        ...ph,
                        phAccumulated: ph.phAccumulated + plan.applied,
                        phAvailable: ph.phAvailable + plan.applied,
                    },
                });
                ph = effects[effects.length - 1].after;
                continue;
            }
            effects.push({
                type: 'ph',
                entryIndex: index,
                amount: entry.amount,
                requestedAmount: entry.amount,
                capPolicy: entry.capPolicy || 'outside_weekly',
                label: entry.label,
                before: ph,
                after: {
                    ...ph,
                    phAccumulated: ph.phAccumulated + entry.amount,
                    phAvailable: ph.phAvailable + entry.amount,
                },
            });
            ph = effects[effects.length - 1].after;
            continue;
        }
        if (entry.type === 'pa') {
            const row = await db.get(
                'SELECT COALESCE(SUM(amount), 0) AS balance FROM clover_pa_ledger WHERE player_id = ?',
                [target.playerId]
            ).catch(() => ({ balance: 0 }));
            const before = Number(row?.balance || 0);
            effects.push({ type: 'pa', entryIndex: index, amount: entry.amount, label: entry.label, before, after: before + entry.amount });
            continue;
        }
        if (entry.type === 'pm') {
            const before = await getPoderMagicoSummary(db, target.playerId);
            effects.push({ type: 'pm', entryIndex: index, amount: entry.amount, label: entry.label, before, after: before + entry.amount });
            continue;
        }

        const preview = await itemExecutor.preview({
            db,
            operation,
            action: { type: 'player.item.grant', payload: { templateKey: entry.templateKey, quantity: entry.quantity } },
            target,
            unit: { id: `${unitId}-${index}` },
        });
        effects.push({
            type: entry.type,
            entryIndex: index,
            templateKey: entry.templateKey,
            quantity: entry.quantity,
            label: entry.label || preview.after.itemName,
            preview: preview.after,
        });
    }
    return effects;
}

async function assertWeeklyPlanFresh(db, playerId, effect) {
    const current = await getWeeklyPhCapSummary(db, playerId, effect.weeklyPlan.effectiveDate);
    if (
        current.weekKey !== effect.weeklyPlan.weekKey
        || Number(current.used) !== Number(effect.weeklyPlan.before)
    ) {
        throw new AdminRewardV2Error(
            'reward_weekly_ph_changed_after_preview',
            'O consumo semanal de PH mudou depois da prévia. Gere uma nova prévia.',
            409,
            { preview: effect.weeklyPlan, current }
        );
    }
}

async function applyEntriesV2(db, operation, target, unit, packageSnapshot, previewEffects) {
    const effects = [];
    const itemExecutor = createItemExecutors()['player.item.grant'];

    for (let index = 0; index < packageSnapshot.entries.length; index += 1) {
        const entry = packageSnapshot.entries[index];
        const preview = previewEffects[index];
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
            let amount = entry.amount;
            let weeklyUsage = null;
            if (entry.capPolicy === 'weekly') {
                await assertWeeklyPlanFresh(db, target.playerId, preview);
                amount = Number(preview.weeklyPlan.applied);
            }
            const result = await addPhInTransaction(
                db,
                target.playerId,
                amount,
                'admin_reward_package',
                `${packageSnapshot.name} — ${entry.capPolicy === 'weekly' ? 'dentro do teto semanal' : entry.capPolicy === 'adjustment' ? 'ajuste administrativo' : 'fora do teto semanal'}`,
                operation.actor.id,
                {
                    packageId: packageSnapshot.id,
                    packageVersion: packageSnapshot.version,
                    entryIndex: index,
                    operationCode: operation.code,
                    cap_policy: entry.capPolicy,
                    outside_weekly_cap: entry.capPolicy !== 'weekly',
                    effective_date: preview?.weeklyPlan?.effectiveDate || entry.effectiveDate || null,
                },
                effectKey
            );
            if (entry.capPolicy === 'weekly') {
                weeklyUsage = await recordWeeklyPhUsageInTransaction(db, {
                    usageKey: effectKey,
                    playerId: target.playerId,
                    weekKey: preview.weeklyPlan.weekKey,
                    effectiveDate: preview.weeklyPlan.effectiveDate,
                    requestedAmount: entry.amount,
                    appliedAmount: amount,
                    operationCode: operation.code,
                    source: 'admin_reward_package',
                    reason: `Pacote ${packageSnapshot.name}`,
                    createdBy: operation.actor.id,
                    metadata: { packageId: packageSnapshot.id, packageVersion: packageSnapshot.version, entryIndex: index },
                });
            }
            effects.push({
                type: 'ph',
                entryIndex: index,
                amount,
                requestedAmount: entry.amount,
                capPolicy: entry.capPolicy,
                weeklyUsage,
                weeklyPlan: preview?.weeklyPlan || null,
                label: entry.label,
                ...result,
            });
            continue;
        }

        if (entry.type === 'pa') {
            const result = await addPaInTransaction(
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
            effects.push({ type: 'pa', entryIndex: index, amount: entry.amount, label: entry.label, ...result });
            continue;
        }

        if (entry.type === 'pm') {
            const result = await adjustPoderMagicoInTransaction(db, target.playerId, entry.amount, {
                kind: 'ganho',
                source: 'admin_reward_package',
                reason: `Pacote ${packageSnapshot.name}`,
                relatedId: operation.code,
                idempotencyKey: effectKey,
                createdBy: operation.actor.id,
                metadata: { packageId: packageSnapshot.id, packageVersion: packageSnapshot.version, entryIndex: index },
            });
            effects.push({ type: 'pm', entryIndex: index, amount: entry.amount, label: entry.label, ...result });
            continue;
        }

        const applied = await itemExecutor.apply({
            db,
            operation,
            action: { type: 'player.item.grant', payload: { templateKey: entry.templateKey, quantity: entry.quantity } },
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
            type: entry.type,
            entryIndex: index,
            templateKey: entry.templateKey,
            quantity: entry.quantity,
            label: entry.label || applied.after?.itemName || entry.templateKey,
            snapshot: applied.after,
        });
    }
    return effects;
}

async function assertLatestLedger(db, table, whereSql, params, expectedId, code, message) {
    const row = await db.get(
        `SELECT id FROM ${table} WHERE ${whereSql} ORDER BY id DESC LIMIT 1`,
        params
    );
    if (Number(row?.id || 0) !== Number(expectedId || 0)) {
        throw new AdminRewardV2Error(code, message, 409, {
            expectedLedgerId: Number(expectedId || 0),
            latestLedgerId: Number(row?.id || 0),
        });
    }
}

async function undoExtendedEffects(db, operation, playerId, effects) {
    const baseEffects = (effects || []).filter((effect) => ['item', 'box', 'ph', 'yulls'].includes(effect.type));
    const translated = baseEffects.map((effect) => effect.type === 'box' ? { ...effect, type: 'item' } : effect);
    await base.undoRewardEffects(db, operation, playerId, translated);

    for (const effect of [...(effects || [])].reverse()) {
        if (effect.type === 'ph' && effect.capPolicy === 'weekly' && effect.weeklyUsage?.usageKey) {
            await voidWeeklyPhUsageInTransaction(
                db,
                effect.weeklyUsage.usageKey,
                operation.actor.id,
                `Desfazer ${operation.code}`
            );
            continue;
        }
        if (effect.type === 'pa') {
            await assertLatestLedger(
                db,
                'clover_pa_ledger',
                'player_id = ?',
                [playerId],
                effect.ledgerId,
                'reward_pa_changed_since_apply',
                'O PA recebeu outro lançamento depois deste pacote e não pode ser desfeito automaticamente.'
            );
            await mutatePaInTransaction(db, playerId, {
                amount: -Math.abs(effect.amount),
                kind: 'estorno',
                source: 'admin_reward_undo',
                reason: `Desfazer ${operation.code}`,
                relatedId: operation.code,
                idempotencyKey: `${operation.code}:reward-undo:pa:${effect.entryIndex}`,
                createdBy: operation.actor.id,
                metadata: { original_ledger_id: effect.ledgerId },
            });
            continue;
        }
        if (effect.type === 'pm') {
            await assertLatestLedger(
                db,
                'clover_character_stat_ledger',
                "player_id = ? AND stat_key = 'poder_magico'",
                [playerId],
                effect.ledgerId,
                'reward_pm_changed_since_apply',
                'O Poder Mágico recebeu outro lançamento depois deste pacote e não pode ser desfeito automaticamente.'
            );
            await adjustPoderMagicoInTransaction(db, playerId, -Math.abs(effect.amount), {
                kind: 'estorno',
                source: 'admin_reward_undo',
                reason: `Desfazer ${operation.code}`,
                relatedId: operation.code,
                idempotencyKey: `${operation.code}:reward-undo:pm:${effect.entryIndex}`,
                createdBy: operation.actor.id,
                metadata: { original_ledger_id: effect.ledgerId },
            });
        }
    }
}

function comparablePackage(value) {
    if (!value) return value;
    const { operationCode, updatedBy, updatedAt, ...stable } = value;
    return stable;
}

function createRewardExecutorsV2() {
    const v1 = base.createRewardExecutors();
    return {
        ...v1,
        'catalog.reward.create': {
            async preview({ action }) {
                const data = normalizePackagePayloadV2(action.payload || {});
                return {
                    summary: `Criar pacote V2: ${data.name}`,
                    before: null,
                    after: { ...data, status: 'active', version: 1 },
                };
            },
            async apply({ db, operation, action }) {
                const packageSnapshot = await createRewardPackageV2(db, action.payload || {}, {
                    operationCode: operation.code,
                    actorId: operation.actor.id,
                });
                return { before: null, after: packageSnapshot, summary: `Pacote ${packageSnapshot.name} criado.` };
            },
            undo: v1['catalog.reward.create'].undo,
        },
        'catalog.reward.update': {
            async preview({ db, action }) {
                const packageId = requireText(action.payload?.packageId || action.payload?.id, 'packageId', 40).toUpperCase();
                const before = await base.getRewardPackage(db, packageId);
                const changes = normalizePackagePayloadV2(action.payload || {}, { partial: true });
                return {
                    summary: `Editar pacote V2: ${before.name}`,
                    before,
                    after: { ...before, ...changes, version: before.version + 1 },
                };
            },
            async apply({ db, operation, action, before }) {
                const result = await updateRewardPackageV2(
                    db,
                    before?.id || action.payload?.packageId || action.payload?.id,
                    action.payload || {},
                    { operationCode: operation.code, actorId: operation.actor.id }
                );
                return { before: result.before, after: result.after, summary: `Pacote ${result.after.name} atualizado.` };
            },
            async undo(context) {
                return v1['catalog.reward.update'].undo(context);
            },
        },
        'reward.grant': {
            async preview({ db, operation, action, target, unit }) {
                const packageSnapshot = await base.getRewardPackage(db, action.payload?.packageId || action.payload?.id);
                if (packageSnapshot.status !== 'active') {
                    throw new AdminRewardV2Error('reward_package_archived', 'O pacote está arquivado.', 409);
                }
                const effects = await previewEntriesV2(db, operation, target, packageSnapshot, unit?.id || 'preview');
                return {
                    summary: `${target.characterName || target.playerId}: conceder ${packageSnapshot.name}`,
                    before: {
                        playerId: target.playerId,
                        effects: effects.map((effect) => ({
                            type: effect.type,
                            before: effect.before ?? null,
                            weeklyPlan: effect.weeklyPlan || null,
                        })),
                    },
                    after: {
                        playerId: target.playerId,
                        characterName: target.characterName || target.playerId,
                        package: packageSnapshot,
                        effects,
                    },
                };
            },
            async apply({ db, operation, action, target, unit, after }) {
                const currentPackage = await base.getRewardPackage(db, after.package?.id || action.payload?.packageId || action.payload?.id);
                if (currentPackage.status !== 'active') {
                    throw new AdminRewardV2Error('reward_package_archived', 'O pacote foi arquivado depois da simulação.', 409);
                }
                if (!valuesMatch(comparablePackage(currentPackage), comparablePackage(after.package))) {
                    throw new AdminRewardV2Error('reward_package_changed_after_preview', 'O pacote mudou depois da simulação. Gere uma nova prévia.', 409);
                }

                const grantKey = `${operation.code}:unit:${unit.id}:reward-grant`;
                const existing = await db.get(
                    `SELECT * FROM clover_reward_grants WHERE grant_key = ?`,
                    [grantKey]
                );
                if (existing) {
                    const grant = base.mapRewardGrant(existing);
                    return {
                        after: { ...after, grant, effects: grant.effects, duplicate: true },
                        summary: `${target.characterName || target.playerId}: pacote ${currentPackage.name} já concedido.`,
                    };
                }

                const effects = await applyEntriesV2(
                    db,
                    operation,
                    target,
                    unit,
                    currentPackage,
                    after.effects || []
                );
                const inserted = await db.run(
                    `INSERT INTO clover_reward_grants
                     (grant_key, package_id, package_version, player_id, operation_code, status,
                      effects_json, metadata_json, granted_by, granted_at)
                     VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?)`,
                    [
                        grantKey,
                        currentPackage.id,
                        currentPackage.version,
                        target.playerId,
                        operation.code,
                        JSON.stringify(effects),
                        JSON.stringify({ actionPayload: action.payload || {}, rewardEngineVersion: 2 }),
                        operation.actor.id,
                        nowIso(),
                    ]
                );
                const row = await db.get('SELECT * FROM clover_reward_grants WHERE id = ?', [inserted.lastID]);
                const grant = base.mapRewardGrant(row);
                return {
                    after: { ...after, package: currentPackage, grant, effects, duplicate: false },
                    summary: `${target.characterName || target.playerId}: pacote ${currentPackage.name} concedido.`,
                };
            },
            async undo({ db, operation, after }) {
                const grantId = Number(after?.grant?.id || 0);
                const row = grantId > 0
                    ? await db.get('SELECT * FROM clover_reward_grants WHERE id = ?', [grantId])
                    : null;
                const grant = row ? base.mapRewardGrant(row) : null;
                if (!grant || grant.status !== 'applied') {
                    throw new AdminRewardV2Error('reward_grant_not_applied', 'A concessão não está disponível para desfazimento.', 409);
                }
                await undoExtendedEffects(db, operation, grant.playerId, grant.effects);
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
    AdminRewardV2Error,
    PH_CAP_POLICIES,
    REWARD_ENTRY_TYPES_V2,
    createRewardExecutorsV2,
    createRewardPackageV2,
    ensureAdminRewardV2Schema,
    normalizePackagePayloadV2,
    normalizeRewardEntriesV2,
    previewEntriesV2,
    updateRewardPackageV2,
};
