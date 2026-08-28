'use strict';

const { getSlotConfigOption } = require('./configLoader');
const { getFutureCharacter } = require('./preResetCharacterService');
const { DEFAULT_PRE_RESET_CAMPAIGN_KEY } = require('./preResetCampaignStateService');
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

function parsePayload(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try { return JSON.parse(value) || {}; } catch { return {}; }
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

async function assertFutureLaunchReady(db, playerId, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
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

    const requiredLimited = [
        limitedSlot('race', selectedRoll.race_key),
        limitedSlot('grimoire', selectedRoll.grimoire_key),
        limitedSlot('family', character.draft.familyKey),
        limitedSlot('magic', character.draft.magicKey),
    ].filter(Boolean);
    for (const slot of requiredLimited) {
        const reservation = await db.get(
            `SELECT * FROM clover_prereset_future_slot_reservations
             WHERE campaign_key=? AND player_id=? AND roll_number=? AND category=? AND option_key=? AND status='held'`,
            [campaignKey,String(playerId),selectedRollNumber,slot.category,slot.optionKey]
        );
        if (!reservation) {
            throw new PreResetFuturePromotionError('future_selected_slot_missing', 'Vaga limitada da ficha futura nao esta preservada.', {
                playerId:String(playerId), selectedRollNumber, category:slot.category, optionKey:slot.optionKey,
            });
        }
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

    return { mode:'promote', playerId:String(playerId), futureRollCount:count, character, selectedRoll };
}

async function promoteFutureAfterReset(db, plan, campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY) {
    if (!plan || plan.mode === 'blank') return { ok:true, promoted:false, mode:'blank' };
    if (plan.mode !== 'promote' || !plan.character || !plan.selectedRoll) {
        throw new PreResetFuturePromotionError('invalid_future_promotion_plan', 'Plano de promocao futura invalido.');
    }

    const playerId = String(plan.playerId);
    const draft = plan.character.draft || {};
    const selected = plan.selectedRoll;
    const familyLabel = optionLabel('family', draft.familyKey) || '-';
    const magicLabel = optionLabel('magic', draft.magicKey);
    if (!magicLabel) throw new PreResetFuturePromotionError('future_magic_label_missing', 'Magia futura nao pode ser materializada.', { magicKey:draft.magicKey });

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
        return { ok:true, promoted:true, mode:'promote', playerId, rollCount:Number(copied.total), selectedRollNumber:Number(draft.rollNumber) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    PreResetFuturePromotionError,
    assertFutureLaunchReady,
    promoteFutureAfterReset,
};