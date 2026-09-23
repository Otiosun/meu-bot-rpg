'use strict';

const { ensureCloverTraitAttemptsSchema } = require('../../database');
const { getSlotConfigOption, loadCloverConfigs } = require('./configLoader');
const {
    listReturnShopEntitlements,
    assertReturnShopRollMutable,
    getRollByNumber,
    safeJson,
} = require('./preresetReturnShopAssignmentService');

const MAGIC_SCOPE_BY_KINGDOM = Object.freeze({
    clover: 'Misto',
    spade: 'Misto',
    diamond: 'Misto',
    heart: 'Elemental',
});

const RETURN_SHOP_TO_CONFIG_KEY = Object.freeze({
    clover: { listName: 'kingdoms', field: 'kingdom', key: 'clover' },
    heart: { listName: 'kingdoms', field: 'kingdom', key: 'heart' },
    spade: { listName: 'kingdoms', field: 'kingdom', key: 'spade' },
    diamond: { listName: 'kingdoms', field: 'kingdom', key: 'diamond' },

    miserable: { listName: 'socialClasses', field: 'social_class', key: 'miseravel_marginal' },
    artisans: { listName: 'socialClasses', field: 'social_class', key: 'artesao_comerciante' },
    burguesia: { listName: 'socialClasses', field: 'social_class', key: 'burguesia' },
    nobreza: { listName: 'socialClasses', field: 'social_class', key: 'nobreza' },
    realeza: { listName: 'socialClasses', field: 'social_class', key: 'realeza' },

    human: { listName: 'races', field: 'race', key: 'humano' },
    witch: { listName: 'races', field: 'race', key: 'bruxa' },
    dwarf: { listName: 'races', field: 'race', key: 'anao' },
    elf: { listName: 'races', field: 'race', key: 'elfo' },

    threeLeaves: { listName: 'grimoires', field: 'grimoire', key: 'clover_3f' },
    fourLeaves: { listName: 'grimoires', field: 'grimoire', key: 'clover_4f' },
    heartGrimoire: { listName: 'grimoires', field: 'grimoire', key: 'heart_3f' },
    doubleHeart: { listName: 'grimoires', field: 'grimoire', key: 'heart_4f' },
    diamondGrimoire: { listName: 'grimoires', field: 'grimoire', key: 'diamond_3f' },
    polishedDiamond: { listName: 'grimoires', field: 'grimoire', key: 'diamond_4f' },
    oneSword: { listName: 'grimoires', field: 'grimoire', key: 'spade_3f' },
    twoSwords: { listName: 'grimoires', field: 'grimoire', key: 'spade_4f' },
});

const TRAIT_ATTEMPT_BY_SHOP_KEY = Object.freeze({
    rareTrait: 'rare_aptitude',
    rareMark: 'rare_mark',
    anomaly: 'anomaly',
});

// Return Shop eligibility is independent from random-roll probability weights.
const SHOP_RACE_KINGDOMS = Object.freeze({
    humano: ['clover', 'spade', 'diamond', 'heart'],
    bruxa: ['clover'],
    anao: ['clover', 'spade'],
    elfo: ['clover', 'heart'],
});

function isReturnShopRaceCompatible(raceKey, kingdomKey) {
    return Boolean(SHOP_RACE_KINGDOMS[raceKey]?.includes(kingdomKey));
}

class PreresetReturnShopFulfillmentError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreresetReturnShopFulfillmentError';
        this.code = code;
        this.details = details;
    }
}

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [tableName]
    ).catch(() => null);
    return Boolean(row?.ok);
}

async function tableColumns(db, tableName) {
    if (!await tableExists(db, tableName)) return new Set();
    const rows = await db.all(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
    return new Set(rows.map((row) => row.name));
}

function getItems(metadata) {
    return Array.isArray(metadata?.items) ? metadata.items : [];
}

function isRollFulfillmentItem(item) {
    const key = String(item?.key || '');
    return Boolean(RETURN_SHOP_TO_CONFIG_KEY[key] || TRAIT_ATTEMPT_BY_SHOP_KEY[key]);
}

function getCarryoverItems(metadata) {
    return getItems(metadata).filter((item) => !isRollFulfillmentItem(item));
}

function formatCarryoverItem(item) {
    const quantity = Number(item?.quantity || 1);
    const label = String(item?.label || item?.key || '').trim() || 'Item';
    return quantity > 1 ? `${quantity}x ${label}` : label;
}

function carryoverRequestLabel(items) {
    return items.map(formatCarryoverItem).filter(Boolean).join(' + ') || 'Proximo personagem';
}

function getOption(config, listName, optionKey) {
    const option = config.maps?.[listName]?.get(optionKey);
    if (!option) {
        throw new PreresetReturnShopFulfillmentError(
            'config_option_not_found',
            `Opcao da loja nao existe na config: ${listName}/${optionKey}.`,
            { listName, optionKey }
        );
    }
    return option;
}

function applyOptionToPatch(patch, field, option) {
    if (field === 'kingdom') {
        patch.kingdom = option.name;
        patch.kingdom_key = option.key;
        patch.magic_scope = MAGIC_SCOPE_BY_KINGDOM[option.key] || patch.magic_scope;
    } else if (field === 'social_class') {
        patch.social_class = option.name;
        patch.social_class_key = option.key;
    } else if (field === 'race') {
        patch.race = option.name;
        patch.race_key = option.key;
    } else if (field === 'grimoire') {
        patch.grimoire = option.name;
        patch.grimoire_key = option.key;
        patch.grimoire_rank = option.rank || '-';
        patch.grimoire_symbol = option.symbol || '-';
    }
}

function buildRollSummary(roll) {
    return [
        roll.kingdom,
        roll.social_class,
        roll.race,
        roll.grimoire,
        roll.magic_rarity,
    ].join(' | ');
}

function buildFulfilledRoll(entry, roll, options = {}) {
    const config = loadCloverConfigs();
    const next = { ...roll };
    const appliedItems = [];
    const traitAttempts = [];
    let explicitKingdom = null;
    let grimoireKingdom = null;
    let selectedRace = null;
    let selectedSocialClass = null;

    for (const item of getItems(entry.metadata)) {
        const mapping = RETURN_SHOP_TO_CONFIG_KEY[item.key];
        const traitCategory = TRAIT_ATTEMPT_BY_SHOP_KEY[item.key];

        if (mapping) {
            const option = getOption(config, mapping.listName, mapping.key);
            if (mapping.field === 'kingdom') explicitKingdom = option;
            if (mapping.field === 'race') selectedRace = option;
            if (mapping.field === 'social_class') selectedSocialClass = option;
            if (mapping.field === 'grimoire' && option.kingdomKey) {
                grimoireKingdom = getOption(config, 'kingdoms', option.kingdomKey);
            }
            applyOptionToPatch(next, mapping.field, option);
            appliedItems.push({
                item_key: item.key,
                label: item.label || option.name,
                field: mapping.field,
                option_key: option.key,
            });
        } else if (traitCategory) {
            traitAttempts.push({
                item_key: item.key,
                label: item.label || item.key,
                category: traitCategory,
            });
            appliedItems.push({
                item_key: item.key,
                label: item.label || item.key,
                field: 'trait_attempt',
                option_key: traitCategory,
            });
        }
    }

    if (explicitKingdom && grimoireKingdom && explicitKingdom.key !== grimoireKingdom.key) {
        throw new PreresetReturnShopFulfillmentError(
            'kingdom_grimoire_conflict',
            'A compra tem reino e grimorio de reinos diferentes.',
            {
                entitlementId: entry.entitlementId,
                kingdom: explicitKingdom.key,
                grimoireKingdom: grimoireKingdom.key,
            }
        );
    }

    if (grimoireKingdom && !roll.campaign_key) {
        applyOptionToPatch(next, 'kingdom', grimoireKingdom);
    }

    if (explicitKingdom && roll.campaign_key) {
        const purchased = new Set(options.purchasedFields || []);
        for (const record of safeJson(roll.roll_payload, {}).return_shop_fulfillments || []) {
            for (const item of record.applied_items || []) if (!item.automatic) purchased.add(item.field);
        }
        for (const item of appliedItems) purchased.add(item.field);
        const defaults = [];
        if (!purchased.has('grimoire') && getOption(config,'grimoires',next.grimoire_key).kingdomKey!==explicitKingdom.key) {
            defaults.push(['grimoire',getOption(config,'grimoires',`${explicitKingdom.key}_3f`)]);
        }
        if (!purchased.has('race') && !isReturnShopRaceCompatible(next.race_key,explicitKingdom.key)) {
            defaults.push(['race',getOption(config,'races','humano')]);
        }
        for (const [field,option] of defaults) {
            applyOptionToPatch(next,field,option);
            appliedItems.push({field,option_key:option.key,label:option.name,automatic:true,reason:'kingdom_purchase_compatibility'});
        }
        if (next.race_key==='humano' && next.social_class_key==='nao_se_aplica' && !purchased.has('social_class')) {
            const option=getOption(config,'socialClasses','miseravel_marginal');
            applyOptionToPatch(next,'social_class',option);
            appliedItems.push({field:'social_class',option_key:option.key,label:option.name,automatic:true,reason:'human_default'});
        }
    }

    if (selectedRace && selectedRace.key !== 'humano' && selectedSocialClass) {
        throw new PreresetReturnShopFulfillmentError(
            'non_human_social_class_conflict',
            'Raca nao humana nao deve receber classe social da loja no mesmo roll.',
            { entitlementId: entry.entitlementId, race: selectedRace.key, socialClass: selectedSocialClass.key }
        );
    }

    if (selectedRace && selectedRace.key !== 'humano' && !selectedSocialClass) {
        next.social_class = 'N/A';
        next.social_class_key = 'nao_se_aplica';
    }

    next.summary = buildRollSummary(next);
    const now = options.now || new Date().toISOString();
    const payload = safeJson(roll.roll_payload, {});
    const history = Array.isArray(payload.return_shop_fulfillments)
        ? payload.return_shop_fulfillments.slice(-20)
        : [];
    const fulfillmentRecord = {
        entitlement_id: entry.entitlementId,
        purchase_id: entry.purchaseId,
        label: entry.label,
        target_roll_number: Number(entry.targetRollNumber),
        fulfilled_at: now,
        fulfilled_by: options.actorId || null,
        applied_items: appliedItems,
    };
    history.push(fulfillmentRecord);

    next.roll_payload = JSON.stringify({
        ...payload,
        kingdomKey: next.kingdom_key || payload.kingdomKey || null,
        socialClassKey: next.social_class_key || payload.socialClassKey || null,
        raceKey: next.race_key || payload.raceKey || null,
        grimoireKey: next.grimoire_key || payload.grimoireKey || null,
        magicRarityKey: next.magic_rarity_key || payload.magicRarityKey || null,
        magicScope: next.magic_scope || payload.magicScope || null,
        return_shop_fulfillments: history,
    });

    return {
        roll: next,
        appliedItems,
        traitAttempts,
        fulfilledAt: now,
        fulfilledBy: options.actorId || null,
    };
}

async function getRoll(db, entry) {
    const roll = await getRollByNumber(db, entry.playerId, entry.targetRollNumber, {
        campaignKey: entry.metadata.target_campaign_key || entry.metadata.reset_cycle_key,
    });
    if (roll && entry.metadata.target_player_id && roll.player_id !== entry.metadata.target_player_id) {
        throw new PreresetReturnShopFulfillmentError('roll_owner_changed', 'O cadastro do roll mudou desde a escolha. A equipe precisa revisar.');
    }
    return roll;
}

async function updateRoll(db, roll) {
    const table = roll.campaign_key ? 'clover_prereset_future_rolls' : 'player_rolls';
    const columns = await tableColumns(db, table);
    const desired = {
        kingdom: roll.kingdom,
        kingdom_key: roll.kingdom_key,
        social_class: roll.social_class,
        social_class_key: roll.social_class_key,
        race: roll.race,
        race_key: roll.race_key,
        grimoire: roll.grimoire,
        grimoire_key: roll.grimoire_key,
        grimoire_rank: roll.grimoire_rank,
        grimoire_symbol: roll.grimoire_symbol,
        magic_scope: roll.magic_scope,
        summary: roll.summary,
        roll_payload: roll.roll_payload,
    };
    const entries = Object.entries(desired).filter(([column]) => columns.has(column));
    await db.run(
        `UPDATE ${table}
            SET ${entries.map(([column]) => `${quoteIdentifier(column)} = ?`).join(', ')}
          WHERE player_id = ?
            AND roll_number = ?${roll.campaign_key ? ' AND campaign_key = ?' : ''}`,
        [...entries.map(([, value]) => value), roll.player_id, roll.roll_number, ...(roll.campaign_key ? [roll.campaign_key] : [])]
    );
}

function limitedSlotFor(category, optionKey) {
    if (!optionKey) return null;
    try {
        const option = getSlotConfigOption(category, optionKey);
        if (!option || option.capacity === null || option.capacity === undefined) return null;
        return { category, optionKey: option.key };
    } catch {
        return null;
    }
}

async function refreshFutureReservations(db, before, after, entitlementId) {
    for (const category of ['race', 'grimoire']) {
        const field = `${category}_key`;
        if (before[field] === after[field]) continue;
        if (!await tableExists(db, 'clover_prereset_future_slot_reservations')) {
            throw new PreresetReturnShopFulfillmentError('future_slot_schema_missing', 'Reservas futuras indisponiveis; nenhuma compra foi aplicada.');
        }
        const { releaseFutureSlotCategory, holdFutureSlot } = require('./preResetFutureSlotService');
        await releaseFutureSlotCategory(db, before.player_id, before.roll_number, category, before.campaign_key);
        const result = await holdFutureSlot(db, {
            playerId: before.player_id, rollNumber: before.roll_number, category,
            optionKey: after[field], campaignKey: before.campaign_key, source: 'return_shop_roll',
            excludeEntitlementId: entitlementId,
        });
        if (!result.ok) {
            throw new PreresetReturnShopFulfillmentError('future_slot_capacity_full', 'Nao ha vaga disponivel para cumprir essa compra. Nada foi consumido.', result);
        }
    }
}

async function refreshRollSlotReservation(db, playerId, rollNumber, category, optionKey) {
    if (!await tableExists(db, 'slot_reservations')) return null;
    const slot = limitedSlotFor(category, optionKey);
    if (!slot) return null;

    await db.run(
        `UPDATE slot_reservations
            SET status = 'released',
                expires_at = NULL
          WHERE player_id = ?
            AND category = ?
            AND roll_number = ?
            AND status = 'pending'
            AND source IN ('roll_race', 'roll_grimoire', 'return_shop_roll')`,
        [playerId, category, rollNumber]
    );

    const existing = await db.get(
        `SELECT *
           FROM slot_reservations
          WHERE player_id = ?
            AND category = ?
            AND option_key = ?
            AND roll_number = ?
            AND status IN ('pending', 'confirmed')
          ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, id DESC
          LIMIT 1`,
        [playerId, category, slot.optionKey, rollNumber]
    );
    if (existing) return existing;

    const inserted = await db.run(
        `INSERT INTO slot_reservations
         (player_id, category, option_key, status, source, roll_number, expires_at, created_at)
         VALUES (?, ?, ?, 'pending', 'return_shop_roll', ?, NULL, CURRENT_TIMESTAMP)`,
        [playerId, category, slot.optionKey, rollNumber]
    );
    return db.get('SELECT * FROM slot_reservations WHERE id = ?', [inserted.lastID]);
}

async function nextTraitAttemptNumber(db, playerId, category) {
    const existingSuccess = await db.get(
        `SELECT *
           FROM clover_trait_attempts
          WHERE player_id = ?
            AND category = ?
            AND result = 'success'
          ORDER BY attempt_number ASC
          LIMIT 1`,
        [playerId, category]
    );
    if (existingSuccess) return { existing: existingSuccess, number: Number(existingSuccess.attempt_number) };

    const rows = await db.all(
        `SELECT attempt_number
           FROM clover_trait_attempts
          WHERE player_id = ?
          ORDER BY attempt_number ASC`,
        [playerId]
    );
    const used = new Set(rows.map((row) => Number(row.attempt_number)));
    const number = [1, 2].find((candidate) => !used.has(candidate));
    if (!number) {
        throw new PreresetReturnShopFulfillmentError(
            'trait_attempt_slots_full',
            'Nao ha tentativa especial livre para cumprir essa compra.',
            { playerId, category }
        );
    }
    return { existing: null, number };
}

async function grantTraitAttempts(db, playerId, attempts) {
    if (!attempts.length) return [];
    await ensureCloverTraitAttemptsSchema(db);

    const granted = [];
    for (const attempt of attempts) {
        const resolved = await nextTraitAttemptNumber(db, playerId, attempt.category);
        if (!resolved.existing) {
            await db.run(
                `INSERT INTO clover_trait_attempts
                 (player_id, attempt_number, category, status, result, chosen_key, created_at)
                 VALUES (?, ?, ?, 'completed', 'success', NULL, CURRENT_TIMESTAMP)`,
                [playerId, resolved.number, attempt.category]
            );
        }
        const row = await db.get(
            `SELECT *
               FROM clover_trait_attempts
              WHERE player_id = ?
                AND attempt_number = ?`,
            [playerId, resolved.number]
        );
        granted.push({
            ...attempt,
            attempt_number: resolved.number,
            existing: Boolean(resolved.existing),
            row,
        });
    }
    return granted;
}

async function updatePurchaseMetadata(db, purchaseId, patch) {
    const row = await db.get(
        'SELECT metadata_json FROM clover_prereset_purchases WHERE id = ?',
        [purchaseId]
    );
    const metadata = {
        ...safeJson(row?.metadata_json, {}),
        ...patch,
    };
    await db.run(
        'UPDATE clover_prereset_purchases SET metadata_json = ? WHERE id = ?',
        [JSON.stringify(metadata), purchaseId]
    );
}

function buildFulfilledMetadata(entry, result) {
    const previousHistory = Array.isArray(entry.metadata.fulfillment_history)
        ? entry.metadata.fulfillment_history.slice(-20)
        : [];
    const event = {
        at: result.fulfilledAt,
        by: result.fulfilledBy,
        target_roll_number: Number(entry.targetRollNumber),
        applied_items: result.appliedItems,
        trait_attempts: result.traitAttempts.map((attempt) => ({
            item_key: attempt.item_key,
            category: attempt.category,
        })),
    };
    previousHistory.push(event);
    return {
        ...entry.metadata,
        fulfillment_status: 'fulfilled',
        fulfilled_at: result.fulfilledAt,
        fulfilled_by: result.fulfilledBy,
        fulfilled_roll_number: Number(entry.targetRollNumber),
        fulfillment_result: event,
        fulfillment_history: previousHistory,
    };
}

function buildCarryoverMetadata(entry, fulfilledMetadata, carryoverItems) {
    const request = carryoverRequestLabel(carryoverItems);
    return {
        ...entry.metadata,
        items: carryoverItems,
        attempt: {
            ...(entry.metadata.attempt || {}),
            request,
        },
        requires_roll_assignment: false,
        exclusive_categories: [],
        target_roll_number: null,
        fulfillment_status: 'pending_character_fulfillment',
        roll_fulfillment_status: 'fulfilled',
        roll_fulfilled_at: fulfilledMetadata.fulfilled_at,
        roll_fulfilled_by: fulfilledMetadata.fulfilled_by,
        roll_fulfilled_roll_number: fulfilledMetadata.fulfilled_roll_number,
        roll_fulfillment_result: fulfilledMetadata.fulfillment_result,
        roll_fulfillment_history: fulfilledMetadata.fulfillment_history,
    };
}

async function previewReturnShopRollFulfillment(db, options = {}) {
    const playerId = String(options.playerId || '').trim();
    if (!playerId) {
        throw new PreresetReturnShopFulfillmentError(
            'missing_player',
            'Informe o player para revisar o cumprimento da loja.'
        );
    }

    const entries = await listReturnShopEntitlements(db, playerId);
    const ready = [];
    const pendingAssignment = [];
    const pendingCharacter = [];
    const blocked = [];

    for (const entry of entries) {
        if (!entry.requiresRollAssignment) {
            pendingCharacter.push(entry);
            continue;
        }
        if (entry.fulfillmentStatus === 'roll_assigned_pending_fulfillment' && entry.targetRollNumber) {
            const roll = await getRoll(db, entry);
            if (roll) ready.push({ ...entry, roll });
            else blocked.push({ ...entry, reason: 'roll_not_found' });
        } else {
            pendingAssignment.push(entry);
        }
    }

    return {
        ok: true,
        playerId,
        ready,
        pendingAssignment,
        pendingCharacter,
        blocked,
    };
}

async function applyReturnShopRollFulfillment(db, options = {}) {
    const actorId = String(options.actorId || '').trim() || null;
    const preview = await previewReturnShopRollFulfillment(db, options);
    const fulfilled = [];
    const requireAllAssigned = options.requireAllAssigned === true;
    if (requireAllAssigned && (preview.pendingAssignment.length || preview.blocked.length)) {
        return {
            ...preview,
            fulfilled,
            applied: false,
            incomplete: true,
            complete: false,
        };
    }
    if (!preview.ready.length) {
        return {
            ...preview,
            fulfilled,
            applied: false,
            incomplete: false,
            complete: !preview.pendingAssignment.length && !preview.blocked.length,
        };
    }

    await db.exec('BEGIN IMMEDIATE');
    try {
        const lockedPreview = await previewReturnShopRollFulfillment(db, options);
        if (requireAllAssigned && (lockedPreview.pendingAssignment.length || lockedPreview.blocked.length)) {
            await db.exec('ROLLBACK');
            return {
                ...lockedPreview,
                fulfilled,
                applied: false,
                incomplete: true,
                complete: false,
            };
        }

        const futureEntries = lockedPreview.ready.filter(e => e.roll.campaign_key);
        if (futureEntries.length) {
            if (lockedPreview.pendingAssignment.length || lockedPreview.blocked.length) {
                throw new PreresetReturnShopFulfillmentError('return_shop_build_pending', 'Escolha o destino de todas as compras antes de finalizar.');
            }
            if (new Set(futureEntries.map(e => `${e.roll.campaign_key}:${e.roll.player_id}:${e.targetRollNumber}`)).size !== 1) {
                throw new PreresetReturnShopFulfillmentError('return_shop_multiple_rolls', 'As compras de personagem devem ser aplicadas no mesmo roll escolhido para a ficha.');
            }
            const guard = require('./returnShopBuildGuard');
            await guard.assertReturnShopCharacterReady(db, futureEntries[0].roll.player_id, futureEntries[0].targetRollNumber);
            const categories = new Set();
            const previous = safeJson(futureEntries[0].roll.roll_payload).return_shop_fulfillments || [];
            for (const record of previous) {
                for (const item of record.applied_items || []) {
                    if (item.field !== 'trait_attempt' && !item.automatic) categories.add(item.field);
                }
            }
            let combined = futureEntries[0].roll;
            for (const entry of futureEntries) {
                for (const item of getItems(entry.metadata)) {
                    const field = RETURN_SHOP_TO_CONFIG_KEY[item.key]?.field;
                    if (!field) continue;
                    if (categories.has(field)) throw new PreresetReturnShopFulfillmentError('exclusive_category_conflict', 'Ha mais de uma compra da mesma categoria para o personagem.');
                    categories.add(field);
                }
            }
            for (const entry of futureEntries) combined=buildFulfilledRoll(entry,combined,{actorId,purchasedFields:categories}).roll;
            const config = loadCloverConfigs();
            const race = getOption(config, 'races', combined.race_key);
            const grimoire = getOption(config, 'grimoires', combined.grimoire_key);
            if (grimoire.kingdomKey !== combined.kingdom_key) {
                throw new PreresetReturnShopFulfillmentError('kingdom_grimoire_conflict', 'O grimorio e o reino nao combinam. Escolha um roll compativel com suas compras.');
            }
            if (!isReturnShopRaceCompatible(race.key, combined.kingdom_key)) {
                throw new PreresetReturnShopFulfillmentError('kingdom_race_conflict', 'A raca e o reino nao combinam. Escolha um roll compativel com suas compras.');
            }
            if (combined.race_key !== 'humano' && (categories.has('social_class') || combined.social_class_key !== 'nao_se_aplica')) {
                throw new PreresetReturnShopFulfillmentError('non_human_social_class_conflict', 'Raca nao humana nao pode receber classe social humana.');
            }
        }

        for (const entry of lockedPreview.ready) {
            const freshEntitlement = await db.get(
                `SELECT *
                   FROM clover_prereset_entitlements
                  WHERE id = ?
                    AND status = 'active'`,
                [entry.entitlementId]
            );
            if (!freshEntitlement) continue;

            const roll = await getRoll(db, entry);
            if (!roll) {
                throw new PreresetReturnShopFulfillmentError(
                    'roll_not_found',
                    `Nao encontrei o roll #${entry.targetRollNumber} para cumprir a compra.`,
                    { entitlementId: entry.entitlementId, playerId: entry.playerId }
                );
            }
            await assertReturnShopRollMutable(db, roll);

            const result = buildFulfilledRoll(entry, roll, {
                actorId,
                purchasedFields: lockedPreview.ready.flatMap(e=>getItems(e.metadata).map(item=>RETURN_SHOP_TO_CONFIG_KEY[item.key]?.field).filter(Boolean)),
                now: options.now || new Date().toISOString(),
            });
            await updateRoll(db, result.roll);
            if (roll.campaign_key) {
                await refreshFutureReservations(db, roll, result.roll, entry.entitlementId);
            } else {
                await refreshRollSlotReservation(db, entry.playerId, entry.targetRollNumber, 'race', result.roll.race_key);
                await refreshRollSlotReservation(db, entry.playerId, entry.targetRollNumber, 'grimoire', result.roll.grimoire_key);
            }
            const traitAttempts = roll.campaign_key
                ? result.traitAttempts
                : await grantTraitAttempts(db, entry.playerId, result.traitAttempts);
            const metadata = buildFulfilledMetadata(entry, {
                ...result,
                traitAttempts,
            });
            const carryoverItems = getCarryoverItems(entry.metadata);
            if (carryoverItems.length) {
                const carryoverMetadata = buildCarryoverMetadata(entry, metadata, carryoverItems);
                await db.run(
                    `UPDATE clover_prereset_entitlements
                        SET status = 'active',
                            consumed_at = NULL,
                            metadata_json = ?
                      WHERE id = ?
                        AND status = 'active'`,
                    [JSON.stringify(carryoverMetadata), entry.entitlementId]
                );
                await updatePurchaseMetadata(db, entry.purchaseId, {
                    fulfillment_status: 'partial_roll_fulfilled',
                    roll_fulfilled_at: metadata.fulfilled_at,
                    roll_fulfilled_by: metadata.fulfilled_by,
                    roll_fulfilled_roll_number: metadata.fulfilled_roll_number,
                    roll_fulfillment_result: metadata.fulfillment_result,
                    pending_character_items: carryoverItems,
                });
            } else {
                await db.run(
                    `UPDATE clover_prereset_entitlements
                        SET status = 'consumed',
                            consumed_at = CURRENT_TIMESTAMP,
                            metadata_json = ?
                      WHERE id = ?
                        AND status = 'active'`,
                    [JSON.stringify(metadata), entry.entitlementId]
                );
                await updatePurchaseMetadata(db, entry.purchaseId, {
                    fulfillment_status: 'fulfilled',
                    fulfilled_at: metadata.fulfilled_at,
                    fulfilled_by: metadata.fulfilled_by,
                    fulfilled_roll_number: metadata.fulfilled_roll_number,
                    fulfillment_result: metadata.fulfillment_result,
                });
            }
            fulfilled.push({
                entitlementId: entry.entitlementId,
                purchaseId: entry.purchaseId,
                playerId: entry.playerId,
                label: entry.label,
                targetRollNumber: Number(entry.targetRollNumber),
                appliedItems: result.appliedItems,
                traitAttempts,
            });
        }
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }

    const after = await previewReturnShopRollFulfillment(db, options);
    return {
        ...after,
        fulfilled,
        applied: fulfilled.length > 0,
        incomplete: false,
        complete: !after.ready.length && !after.pendingAssignment.length && !after.blocked.length,
    };
}

module.exports = {
    isReturnShopRaceCompatible,
    PreresetReturnShopFulfillmentError,
    applyReturnShopRollFulfillment,
    buildFulfilledRoll,
    previewReturnShopRollFulfillment,
};
