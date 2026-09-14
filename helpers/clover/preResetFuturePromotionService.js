'use strict';

const { getSlotConfigOption } = require('./configLoader');
const { getFutureCharacter } = require('./preResetCharacterService');
const { DEFAULT_PRE_RESET_CAMPAIGN_KEY } = require('./preResetCampaignStateService');
const { fulfillReturnPointShopEconomicEntitlements } = require('./returnPointShopFulfillmentService');
const { normalizeAppearanceValue } = require('../profileForms');
const { getAllMagics } = require('../magicManager');

class PreResetFuturePromotionError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreResetFuturePromotionError';
        this.code = code;
        this.details = details;
    }
}

function optionLabel(category, key) {
    if (!key || key === 'sem_linhagem') return category === 'family' ? '-' : null;
    const configured = getSlotConfigOption(category, key);
    if (configured?.name) return configured.name;
    if (category === 'magic') {
        const magic = getAllMagics().find((item) => String(item.key) === String(key));
        if (magic?.label) return magic.label;
    }
    return null;
}

function limitedSlot(category, key) {
    if (!key || key === 'sem_linhagem') return null;
    const option = getSlotConfigOption(category, key);
    if (!option || option.capacity === null || option.capacity === undefined) return null;
    return { category, optionKey:String(option.key), capacity:Number(option.capacity) };
}

async function futureRollCount(db, playerId, campaignKey) {
    const row = await db.get(
        `SELECT COUNT(*) AS total FROM clover_prereset_future_rolls
         WHERE campaign_key=? AND player_id=?`,
        [campaignKey,String(playerId)]
    );
    return Number(row?.total || 0);
}

async function isFutureAlreadyMaterialized(db, playerId, character, selectedRoll, expectedRollCount) {
    const draft = character?.draft || {};
    const current = await db.get(
        `SELECT reino,classe,familia,raca,grimorio,magia,
                personagem_nome,personagem_idade,personagem_aparencia,personagem_genero,
                numero_roll_escolhido,ficha_status,familia_key,magia_key
         FROM jogadores WHERE id=?`,
        [String(playerId)]
    );
    if (!current) return false;

    const familyLabel = optionLabel('family', draft.familyKey) || '-';
    const magicLabel = optionLabel('magic', draft.magicKey);
    if (!magicLabel) return false;

    const sameCharacter = String(current.personagem_nome || '') === String(draft.name || '')
        && Number(current.personagem_idade || 0) === Number(draft.age || 0)
        && String(current.personagem_aparencia || '') === String(draft.appearance || '')
        && String(current.personagem_genero || '') === String(draft.gender || '')
        && Number(current.numero_roll_escolhido || 0) === Number(draft.rollNumber || 0)
        && String(current.ficha_status || '') === 'aprovada'
        && String(current.familia_key || '') === String(draft.familyKey || '')
        && String(current.magia_key || '') === String(draft.magicKey || '')
        && String(current.reino || '') === String(selectedRoll.kingdom || '')
        && String(current.classe || '') === String(selectedRoll.social_class || '')
        && String(current.familia || '') === String(familyLabel)
        && String(current.raca || '') === String(selectedRoll.race || '')
        && String(current.grimorio || '') === String(selectedRoll.grimoire || '')
        && String(current.magia || '') === String(magicLabel);
    if (!sameCharacter) return false;

    const copied = await db.get('SELECT COUNT(*) AS total FROM player_rolls WHERE player_id=?', [String(playerId)]);
    if (Number(copied?.total || 0) !== Number(expectedRollCount || 0)) return false;

    const selectedLegacy = await db.get(
        `SELECT kingdom_key,social_class_key,race_key,grimoire_key,magic_rarity_key,roll_version
         FROM player_rolls WHERE player_id=? AND roll_number=?`,
        [String(playerId),Number(draft.rollNumber)]
    );
    if (!selectedLegacy) return false;
    return String(selectedLegacy.kingdom_key || '') === String(selectedRoll.kingdom_key || '')
        && String(selectedLegacy.social_class_key || '') === String(selectedRoll.social_class_key || '')
        && String(selectedLegacy.race_key || '') === String(selectedRoll.race_key || '')
        && String(selectedLegacy.grimoire_key || '') === String(selectedRoll.grimoire_key || '')
        && String(selectedLegacy.magic_rarity_key || '') === String(selectedRoll.magic_rarity_key || '')
        && String(selectedLegacy.roll_version || '') === String(selectedRoll.roll_version || '');
}

async function assertFutureLaunchReady(db, playerId, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    await require('./returnPointShopManualService').assertManualLaunchReady(db,playerId,campaignKey);
    const count = await futureRollCount(db, playerId, campaignKey);
    if (!count) return { mode:'blank', playerId:String(playerId), futureRollCount:0, character:null, selectedRoll:null };

    const character = await getFutureCharacter(db, playerId);
    if (!character || character.status !== 'locked') {
        throw new PreResetFuturePromotionError(
            'future_character_not_locked',
            'Jogador iniciou PRE_RESET de criacao, mas a Ficha Nova ainda nao esta LOCKED para o launch.',
            { playerId:String(playerId), futureRollCount:count, status:character?.status || null }
        );
    }
    const selectedRollNumber = Number(character.draft?.rollNumber || 0);
    if (!selectedRollNumber || !character.draft?.name || !character.draft?.magicKey) {
        throw new PreResetFuturePromotionError('future_character_incomplete', 'Ficha futura LOCKED esta incompleta.', { playerId:String(playerId) });
    }
    const selectedRoll = await db.get(
        `SELECT * FROM clover_prereset_future_rolls
         WHERE campaign_key=? AND player_id=? AND roll_number=?`,
        [campaignKey,String(playerId),selectedRollNumber]
    );
    if (!selectedRoll) {
        throw new PreResetFuturePromotionError('future_selected_roll_missing', 'Roll selecionado da ficha futura nao existe.', { playerId:String(playerId), selectedRollNumber });
    }

    await require('./returnPointShopManualService').assertManualBuildBoundary(db,playerId,{
        campaignKey,rollNumber:selectedRollNumber,submit:true,
    });

    const familyLabel = optionLabel('family', character.draft.familyKey) || '-';
    const magicLabel = optionLabel('magic', character.draft.magicKey);
    if (!magicLabel) {
        throw new PreResetFuturePromotionError('future_magic_label_missing', 'Magia futura nao pode ser materializada.', {
            playerId:String(playerId), magicKey:character.draft.magicKey,
        });
    }

    const requiredLimited = [
        limitedSlot('race', selectedRoll.race_key),
        limitedSlot('grimoire', selectedRoll.grimoire_key),
        limitedSlot('family', character.draft.familyKey),
        limitedSlot('magic', character.draft.magicKey),
    ].filter(Boolean);
    const reservationStates = [];
    for (const slot of requiredLimited) {
        const reservation = await db.get(
            `SELECT * FROM clover_prereset_future_slot_reservations
             WHERE campaign_key=? AND player_id=? AND roll_number=? AND category=? AND option_key=?`,
            [campaignKey,String(playerId),selectedRollNumber,slot.category,slot.optionKey]
        );
        if (!reservation || !['held','consumed'].includes(String(reservation.status || ''))) {
            throw new PreResetFuturePromotionError('future_selected_slot_missing', 'Vaga limitada da ficha futura nao esta preservada.', {
                playerId:String(playerId), selectedRollNumber, category:slot.category, optionKey:slot.optionKey,
                status:reservation?.status || null,
            });
        }
        reservationStates.push(String(reservation.status));
    }
    const hasConsumed = reservationStates.some((status) => status === 'consumed');
    const allConsumed = reservationStates.length > 0 && reservationStates.every((status) => status === 'consumed');
    if (hasConsumed && !allConsumed) {
        throw new PreResetFuturePromotionError('future_selected_slots_mixed_state', 'Vagas selecionadas estao em estado misto; promocao nao e segura.', {
            playerId:String(playerId), selectedRollNumber, reservationStates,
        });
    }

    const stray = await db.get(
        `SELECT COUNT(*) AS total FROM clover_prereset_future_slot_reservations
         WHERE campaign_key=? AND player_id=? AND roll_number<>? AND status='held'`,
        [campaignKey,String(playerId),selectedRollNumber]
    );
    if (Number(stray?.total || 0) !== 0) {
        throw new PreResetFuturePromotionError('future_unselected_slots_still_held', 'Existem vagas futuras ainda presas em rolls nao selecionados.', {
            playerId:String(playerId), count:Number(stray.total),
        });
    }

    const launchPlayer = await db.get(
        `SELECT status FROM clover_prereset_launch_players WHERE campaign_key=? AND player_id=?`,
        [campaignKey,String(playerId)]
    ).catch(() => null);
    const materialized = await isFutureAlreadyMaterialized(db, playerId, character, selectedRoll, count);
    if (materialized && (allConsumed || (launchPlayer && launchPlayer.status !== 'pending'))) {
        return {
            mode:'already_promoted', playerId:String(playerId), futureRollCount:count, character, selectedRoll,
            materialization:{ familyLabel, magicLabel },
        };
    }
    if (allConsumed && !materialized) {
        throw new PreResetFuturePromotionError('future_consumed_slots_without_materialization', 'Vagas futuras foram consumidas, mas o personagem promovido nao confere.', {
            playerId:String(playerId), selectedRollNumber,
        });
    }

    return {
        mode:'promote', playerId:String(playerId), futureRollCount:count, character, selectedRoll,
        materialization:{ familyLabel, magicLabel },
    };
}

async function fulfillEconomicEntitlementsAfterReset(db, plan, campaignKey, promotion) {
    const playerId = String(plan?.playerId || '').trim();
    if (!playerId) return promotion;
    const shopFulfillment = await fulfillReturnPointShopEconomicEntitlements(db, playerId, {
        campaignKey,
        actorId:'pre_reset_launch',
    });
    return { ...promotion, shopFulfillment };
}

async function promoteFutureAfterReset(db, plan, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    if (!plan) return { ok:true, promoted:false, mode:'blank' };
    if (plan.mode === 'blank') {
        return fulfillEconomicEntitlementsAfterReset(db, plan, campaignKey, {
            ok:true, promoted:false, mode:'blank', playerId:String(plan.playerId),
        });
    }
    if (plan.mode === 'already_promoted') {
        return fulfillEconomicEntitlementsAfterReset(db, plan, campaignKey, {
            ok:true, promoted:true, duplicate:true, mode:'already_promoted', playerId:String(plan.playerId),
            rollCount:Number(plan.futureRollCount || 0), selectedRollNumber:Number(plan.character?.draft?.rollNumber || 0),
        });
    }
    if (plan.mode !== 'promote' || !plan.character || !plan.selectedRoll) {
        throw new PreResetFuturePromotionError('invalid_future_promotion_plan', 'Plano de promocao futura invalido.');
    }

    const playerId = String(plan.playerId);
    const draft = plan.character.draft || {};
    const selected = plan.selectedRoll;
    const familyLabel = plan.materialization?.familyLabel || optionLabel('family', draft.familyKey) || '-';
    const magicLabel = plan.materialization?.magicLabel || optionLabel('magic', draft.magicKey);
    if (!magicLabel) throw new PreResetFuturePromotionError('future_magic_label_missing', 'Magia futura nao pode ser materializada.', { magicKey:draft.magicKey });

    let promotion;
    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run(
            `INSERT OR IGNORE INTO player_rolls
             (player_id,roll_number,kingdom,social_class,family,race,grimoire,grimoire_rank,grimoire_symbol,
              magic_rarity,magic_scope,summary,roll_version,kingdom_key,social_class_key,race_key,grimoire_key,magic_rarity_key,roll_payload)
             SELECT player_id,roll_number,kingdom,social_class,family,race,grimoire,grimoire_rank,grimoire_symbol,
                    magic_rarity,magic_scope,summary,roll_version,kingdom_key,social_class_key,race_key,grimoire_key,magic_rarity_key,roll_payload
             FROM clover_prereset_future_rolls
             WHERE campaign_key=? AND player_id=?`,
            [campaignKey,playerId]
        );

        const updated = await db.run(
            `UPDATE jogadores SET
                reino=?, classe=?, familia=?, raca=?, grimorio=?, magia=?,
                personagem_nome=?, personagem_idade=?, personagem_aparencia=?, personagem_aparencia_normalizada=?, personagem_genero=?,
                numero_roll_escolhido=?, ficha_status='aprovada', familia_key=?, magia_key=?,
                personagem_aparencia_status='pending', personagem_aparencia_motivo=NULL,
                historia_status='pendente', jogo_status='bloqueado', jogo_bloqueio_motivo='aparencia/historia pendentes apos PRE_RESET',
                ultima_recepcao_em=CURRENT_TIMESTAMP
             WHERE id=?`,
            [
                selected.kingdom,selected.social_class,familyLabel,selected.race,selected.grimoire,magicLabel,
                draft.name,draft.age,draft.appearance,normalizeAppearanceValue(draft.appearance),draft.gender,
                Number(draft.rollNumber),draft.familyKey || null,draft.magicKey || null,playerId,
            ]
        );
        if (Number(updated?.changes || 0) !== 1) {
            throw new PreResetFuturePromotionError('future_player_materialization_failed', 'Jogador nao foi materializado depois do reset.', { playerId });
        }

        await db.run(
            `UPDATE clover_prereset_future_slot_reservations
             SET status='released', released_at=COALESCE(released_at,CURRENT_TIMESTAMP)
             WHERE campaign_key=? AND player_id=? AND roll_number<>? AND status='held'`,
            [campaignKey,playerId,Number(draft.rollNumber)]
        );
        await db.run(
            `UPDATE clover_prereset_future_slot_reservations
             SET status='consumed', consumed_at=COALESCE(consumed_at,CURRENT_TIMESTAMP)
             WHERE campaign_key=? AND player_id=? AND roll_number=? AND status='held'`,
            [campaignKey,playerId,Number(draft.rollNumber)]
        );

        const copied = await db.get('SELECT COUNT(*) AS total FROM player_rolls WHERE player_id=?', [playerId]);
        if (Number(copied?.total || 0) !== Number(plan.futureRollCount)) {
            throw new PreResetFuturePromotionError('future_roll_promotion_count_mismatch', 'Quantidade de rolls promovidos divergiu.', {
                playerId, expected:Number(plan.futureRollCount), actual:Number(copied?.total || 0),
            });
        }
        await db.exec('COMMIT');
        promotion = {
            ok:true, promoted:true, mode:'promote', playerId,
            rollCount:Number(copied.total), selectedRollNumber:Number(draft.rollNumber),
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }

    return fulfillEconomicEntitlementsAfterReset(db, plan, campaignKey, promotion);
}

module.exports = {
    PreResetFuturePromotionError,
    assertFutureLaunchReady,
    isFutureAlreadyMaterialized,
    promoteFutureAfterReset,
};
