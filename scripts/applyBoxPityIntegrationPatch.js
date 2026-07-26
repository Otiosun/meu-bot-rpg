'use strict';

const fs = require('node:fs');
const path = require('node:path');

function replaceOnce(source, before, after, label) {
    const first = source.indexOf(before);
    if (first < 0) throw new Error(`Trecho não encontrado: ${label}`);
    if (source.indexOf(before, first + before.length) >= 0) {
        throw new Error(`Trecho duplicado: ${label}`);
    }
    return source.slice(0, first) + after + source.slice(first + before.length);
}

function patchFile(filePath, patches) {
    const absolute = path.resolve(filePath);
    let source = fs.readFileSync(absolute, 'utf8');
    for (const patch of patches) {
        source = replaceOnce(source, patch.before, patch.after, patch.label);
    }
    fs.writeFileSync(absolute, source, 'utf8');
    console.log(`[box-pity-patch] ${path.relative(process.cwd(), absolute)} atualizado.`);
}

function patchBoxService() {
    patchFile('helpers/clover/boxService.js', [
        {
            label: 'imports pity',
            before: `const { serializeBoxOpeningReceipt } = require('./boxReceiptService');
const { addYullsInTransaction, ensureYullsState } = require('./yullsService');

const BOX_ROLL_SCALE = 10000;`,
            after: `const { serializeBoxOpeningReceipt } = require('./boxReceiptService');
const { addYullsInTransaction, ensureYullsState } = require('./yullsService');
const {
    buildEffectiveRewardWeights,
    filterRepeatWeights,
    getBoxPityPolicy,
    selectRewardFromWeights,
    selectWeightedWithScale,
} = require('./boxPityPolicy');
const {
    ensureBoxPitySchema,
    getOrCreatePityStateInTransaction,
    previewPlayerPityState,
    publicPityState,
    updatePityStateInTransaction,
} = require('./boxPityStateService');

const BOX_ROLL_SCALE = 10000;`,
        },
        {
            label: 'public catalog pity',
            before: `function publicCatalog(box) {
    return {
        key: box.key,
        templateKey: box.templateKey,
        name: box.name,
        version: box.version,
        totalChance: Math.round(
            box.rewards.reduce((sum, reward) => sum + reward.chance, 0) * 10
        ) / 10,
        pity: false,
        transferable: false,
        rewards: box.rewards.map((reward) => ({
            key: reward.key,
            label: reward.label,
            chance: reward.chance,
            type: reward.type,
        })),
    };
}`,
            after: `function publicCatalog(box) {
    return {
        key: box.key,
        templateKey: box.templateKey,
        name: box.name,
        version: box.version,
        totalChance: Math.round(
            box.rewards.reduce((sum, reward) => sum + reward.chance, 0) * 10
        ) / 10,
        pity: true,
        pityPolicy: getBoxPityPolicy(box.key),
        antiRepeat: true,
        transferable: false,
        rewards: box.rewards.map((reward) => ({
            key: reward.key,
            label: reward.label,
            chance: reward.chance,
            type: reward.type,
            pityTier: reward.pityTier,
            qualitySuccess: Boolean(reward.qualitySuccess),
        })),
    };
}`,
        },
        {
            label: 'relic resolution',
            before: `async function resolveRewardInTransaction(db, box, selectedReward, randomInt) {
    if (selectedReward.type !== 'unique_relic_pool') {
        return { reward: selectedReward, relicKey: null, rerolledFrom: null };
    }

    const available = await availableRelicKeysInTransaction(
        db,
        selectedReward.pool
    );
    if (available.length) {
        return {
            reward: selectedReward,
            relicKey: available[randomInt(0, available.length)],
            rerolledFrom: null,
        };
    }

    const fallback = selectWeightedReward(
        box.rewards.filter((reward) => reward.type !== 'unique_relic_pool'),
        randomInt
    );
    return {
        reward: fallback,
        relicKey: null,
        rerolledFrom: selectedReward.key,
    };
}`,
            after: `async function resolveRewardInTransaction(db, box, selectedReward, randomInt, options = {}) {
    const available = Array.isArray(options.availableRelicKeys)
        ? options.availableRelicKeys
        : await availableRelicKeysInTransaction(db, selectedReward.pool || RELIC_POOL);
    const poolEmpty = available.length === 0;

    if (selectedReward.type !== 'unique_relic_pool') {
        return {
            reward: selectedReward,
            relicKey: null,
            rerolledFrom: null,
            relicPoolEmpty: poolEmpty,
        };
    }

    if (available.length) {
        return {
            reward: selectedReward,
            relicKey: available[randomInt(0, available.length)],
            rerolledFrom: null,
            relicPoolEmpty: false,
        };
    }

    const fallbackWeights = Array.isArray(options.relicFallbackWeights)
        ? options.relicFallbackWeights.filter((entry) => entry.reward.pityTier === 'high_non_relic' && entry.units > 0)
        : [];
    const fallback = selectWeightedWithScale(fallbackWeights, randomInt)
        || selectWeightedReward(
            box.rewards.filter((reward) => reward.pityTier === 'high_non_relic'),
            randomInt
        );
    return {
        reward: fallback,
        relicKey: null,
        rerolledFrom: selectedReward.key,
        relicPoolEmpty: true,
    };
}`,
        },
        {
            label: 'ensure pity schema',
            before: `    await seedSeasonalEventTemplates(db);
    await ensureSeasonalRelicSchema(db);
    await ensurePhState(db, playerId);`,
            after: `    await seedSeasonalEventTemplates(db);
    await ensureSeasonalRelicSchema(db);
    await ensureBoxPitySchema(db);
    await ensurePhState(db, playerId);`,
        },
        {
            label: 'pity-aware selection',
            before: `        const rollBasisPoints = fixedRoll
            ? (fixedRoll <= 100 ? fixedRoll * 100 : fixedRoll)
            : randomInclusive(randomInt, 1, BOX_ROLL_SCALE);
        const roll = Math.max(
            1,
            Math.min(100, Math.ceil(rollBasisPoints / 100))
        );
        const originallySelected = selectReward(box, rollBasisPoints);
        const resolved = await resolveRewardInTransaction(
            db,
            box,
            originallySelected,
            randomInt
        );
        const reward = resolved.reward;`,
            after: `        const pityBefore = await getOrCreatePityStateInTransaction(db, playerId, box);
        const availableRelicKeys = await availableRelicKeysInTransaction(db, RELIC_POOL);
        const distribution = buildEffectiveRewardWeights(box, pityBefore);
        const rollBasisPoints = fixedRoll
            ? (fixedRoll <= 100 ? fixedRoll * 100 : fixedRoll)
            : randomInclusive(randomInt, 1, BOX_ROLL_SCALE);
        const roll = Math.max(
            1,
            Math.min(100, Math.ceil(rollBasisPoints / 100))
        );
        const initiallySelected = selectRewardFromWeights(
            distribution.weights,
            rollBasisPoints
        );
        let originallySelected = initiallySelected;
        let antiRepeatApplied = false;
        if (
            initiallySelected?.key === pityBefore.lastRewardKey
            && initiallySelected?.pityTier !== 'ultra_relic'
        ) {
            const filtered = filterRepeatWeights(
                distribution.weights,
                pityBefore.lastRewardKey
            );
            const rerolled = selectWeightedWithScale(filtered, randomInt);
            if (rerolled && rerolled.key !== initiallySelected.key) {
                originallySelected = rerolled;
                antiRepeatApplied = true;
            }
        }
        const resolved = await resolveRewardInTransaction(
            db,
            box,
            originallySelected,
            randomInt,
            {
                availableRelicKeys,
                relicFallbackWeights: distribution.weights,
            }
        );
        const reward = resolved.reward;
        const pityBeforePublic = publicPityState(pityBefore);
        const openingMetadata = {
            source: options.source || 'bot',
            roll_basis_points: rollBasisPoints,
            initial_reward_key: initiallySelected.key,
            original_reward_key: originallySelected.key,
            rerolled_from: resolved.rerolledFrom,
            relic_key: resolved.relicKey,
            pity: {
                before: pityBeforePublic,
                effectiveRelicChance: distribution.relicChance,
                effectiveHighChance: distribution.highChance,
                softActive: distribution.quality.softActive,
                hardActive: distribution.quality.hardActive,
                antiRepeat: {
                    applied: antiRepeatApplied,
                    from: antiRepeatApplied ? initiallySelected.key : null,
                    to: antiRepeatApplied ? originallySelected.key : null,
                },
                relicPool: {
                    availableBefore: availableRelicKeys.length,
                    frozen: availableRelicKeys.length === 0,
                },
            },
        };`,
        },
        {
            label: 'opening metadata',
            before: `                JSON.stringify({
                    source: options.source || 'bot',
                    roll_basis_points: rollBasisPoints,
                    original_reward_key: originallySelected.key,
                    rerolled_from: resolved.rerolledFrom,
                    relic_key: resolved.relicKey,
                }),`,
            after: `                JSON.stringify(openingMetadata),`,
        },
        {
            label: 'consumption metadata',
            before: `                reward_key: reward.key,
                original_reward_key: originallySelected.key,
                rerolled_from: resolved.rerolledFrom,`,
            after: `                reward_key: reward.key,
                initial_reward_key: initiallySelected.key,
                original_reward_key: originallySelected.key,
                rerolled_from: resolved.rerolledFrom,
                anti_repeat_applied: antiRepeatApplied,
                pity_before: pityBeforePublic,`,
        },
        {
            label: 'completion pity state',
            before: `        await db.run(
            \`UPDATE clover_box_openings
             SET result_json = ?,
                 status = 'completed',
                 completed_at = CURRENT_TIMESTAMP
             WHERE id = ?\`,
            [JSON.stringify(result), openingId]
        );`,
            after: `        const pityAfter = await updatePityStateInTransaction(
            db,
            pityBefore,
            box,
            reward,
            openingId,
            {
                deliveredRelic: result.type === 'relic',
                relicCounterFrozen: availableRelicKeys.length === 0,
            }
        );
        const pityReceipt = {
            before: pityBeforePublic,
            after: publicPityState(pityAfter),
            effectiveRelicChance: distribution.relicChance,
            effectiveHighChance: distribution.highChance,
            softActive: distribution.quality.softActive,
            hardActive: distribution.quality.hardActive,
            antiRepeat: openingMetadata.pity.antiRepeat,
            relicPool: openingMetadata.pity.relicPool,
        };
        const completedResult = { ...result, pity: pityReceipt };
        openingMetadata.pity.after = pityReceipt.after;

        await db.run(
            \`UPDATE clover_box_openings
             SET result_json = ?,
                 metadata_json = ?,
                 status = 'completed',
                 completed_at = CURRENT_TIMESTAMP
             WHERE id = ?\`,
            [JSON.stringify(completedResult), JSON.stringify(openingMetadata), openingId]
        );`,
        },
        {
            label: 'dashboard pity',
            before: `async function getBoxDashboard(db, playerId) {
    await ensureInventoryV1(db);
    await seedSeasonalEventTemplates(db);
    const boxes = [];
    for (const key of ['simples', 'rara']) {
        const box = getBoxCatalog(key);
        const row = await db.get(
            \`SELECT COALESCE(SUM(quantity), 0) AS total
             FROM clover_inventory_items
             WHERE player_id = ?
               AND template_key = ?
               AND status = 'disponivel'\`,
            [playerId, box.templateKey]
        );
        boxes.push({
            ...publicCatalog(box),
            owned: Number(row?.total || 0),
        });
    }
    const relics = await getRelicState(db);
    return {
        pity: false,
        independentRolls: true,
        relicEmptyPolicy: 'reroll_non_relic',
        boxes,
        relics,
    };
}`,
            after: `async function getBoxDashboard(db, playerId) {
    await ensureInventoryV1(db);
    await seedSeasonalEventTemplates(db);
    await ensureSeasonalRelicSchema(db);
    await ensureBoxPitySchema(db);
    const boxes = [];
    for (const key of ['simples', 'rara']) {
        const box = getBoxCatalog(key);
        const row = await db.get(
            \`SELECT COALESCE(SUM(quantity), 0) AS total
             FROM clover_inventory_items
             WHERE player_id = ?
               AND template_key = ?
               AND status = 'disponivel'\`,
            [playerId, box.templateKey]
        );
        const pityState = await previewPlayerPityState(db, playerId, key);
        boxes.push({
            ...publicCatalog(box),
            owned: Number(row?.total || 0),
            pityState: publicPityState(pityState),
        });
    }
    const relics = await getRelicState(db);
    return {
        pity: true,
        independentRolls: false,
        antiRepeat: true,
        relicEmptyPolicy: 'fallback_high_non_relic_freeze_relic_pity',
        boxes,
        relics,
    };
}`,
        },
    ]);
}

function patchReceiptService() {
    patchFile('helpers/clover/boxReceiptService.js', [
        {
            label: 'receipt metadata parse',
            before: `    const reward = safeJson(row.result_json, null);
    const presentedReward = rewardPresentation(reward || {});
    const completed = row.status === 'completed';`,
            after: `    const reward = safeJson(row.result_json, null);
    const metadata = safeJson(row.metadata_json, {});
    const pity = reward?.pity || metadata?.pity || null;
    const presentedReward = rewardPresentation(reward || {});
    const completed = row.status === 'completed';`,
        },
        {
            label: 'receipt pity fields',
            before: `        rewardKey: row.reward_key,
        reward: reward || null,
        presentation: {
            headline: completed
                ? (presentedReward.newlyUnlocked === false ? 'Prêmio convertido' : 'Você ganhou')
                : 'Abertura ainda não concluída',
            reward: presentedReward,
            stored: completed,
            recoverable: true,
        },`,
            after: `        rewardKey: row.reward_key,
        reward: reward || null,
        pity,
        presentation: {
            headline: completed
                ? (presentedReward.newlyUnlocked === false ? 'Prêmio convertido' : 'Você ganhou')
                : 'Abertura ainda não concluída',
            reward: presentedReward,
            pity,
            stored: completed,
            recoverable: true,
        },`,
        },
    ]);
}

function patchStateService() {
    patchFile('helpers/clover/boxPityStateService.js', [
        {
            label: 'stored preview normalization',
            before: `    const stored = await readStoredPityState(db, playerId, box);
    const state = stored || await reconstructPityStateFromHistory(db, playerId, box);
    return normalizeStateRow({
        player_id: state.playerId || playerId,
        quality_miss_streak: state.qualityMissStreak,
        relic_miss_streak: state.relicMissStreak,
        last_reward_key: state.lastRewardKey,
        last_opening_id: state.lastOpeningId,
        initialized_from: state.initializedFrom,
        migration_json: state.migration ? JSON.stringify(state.migration) : null,
    }, box);`,
            after: `    const stored = await readStoredPityState(db, playerId, box);
    if (stored) return normalizeStateRow(stored, box);
    const state = await reconstructPityStateFromHistory(db, playerId, box);
    return normalizeStateRow({
        player_id: state.playerId || playerId,
        quality_miss_streak: state.qualityMissStreak,
        relic_miss_streak: state.relicMissStreak,
        last_reward_key: state.lastRewardKey,
        last_opening_id: state.lastOpeningId,
        initialized_from: state.initializedFrom,
        migration_json: state.migration ? JSON.stringify(state.migration) : null,
    }, box);`,
        },
        {
            label: 'public state privacy',
            before: `        relic: state.relic,
        initializedFrom: state.initializedFrom,
        migration: state.migration,`,
            after: `        relic: state.relic,
        initializedFrom: state.initializedFrom,`,
        },
    ]);
}

function run() {
    patchBoxService();
    patchReceiptService();
    patchStateService();
    console.log('[box-pity-patch] Integração aplicada. Revise o diff e execute os testes antes de commit.');
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error(`[box-pity-patch] ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { patchFile, replaceOnce, run };
