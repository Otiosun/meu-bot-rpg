'use strict';

const crypto = require('crypto');
const {
    ensureCloverInventorySchema,
    ensureCloverQuickEvaluationsSchema,
    ensureCloverRecruitmentSchema,
} = require('../../database');
const { addPhInTransaction, ensurePhState } = require('./phService');
const {
    DEFAULT_EVENT_KEY,
    addRecruitmentPrInTransaction,
    getEvent,
    getPrHistory,
    getPrSummary,
} = require('./prService');
const {
    addYullsInTransaction,
    ensureYullsState,
} = require('./yullsService');
const {
    addCatalogItemInTransaction,
    ensureInventoryV1,
} = require('./inventoryService');
const { retryPendingReferralFromExistingUp } = require('./recruitmentRecoveryService');
const { isRecruitmentFeatureEnabled } = require('./recruitmentFeatureState');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class RecruitmentServiceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'RecruitmentServiceError';
        this.code = code;
        this.details = details;
    }
}

function normalizeCode(value) {
    return String(value || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '')
        .replace(/^CV(?!-)/, 'CV-');
}

function randomCode() {
    let suffix = '';
    for (let index = 0; index < 6; index += 1) {
        suffix += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    return `CV-${suffix}`;
}

function parseSqliteDate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const parsed = new Date(text.includes('T') ? text : text.replace(' ', 'T'));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatSqliteDate(date) {
    const value = new Date(date);
    if (Number.isNaN(value.getTime())) return null;
    const pad = (part) => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + Number(days || 0));
    return result;
}

function displayName(player = {}) {
    const value = String(player.personagem_nome || player.nome || player.display_name || '').trim();
    return value && value !== '-' ? value : 'Personagem';
}

function serializeEvent(event) {
    const enabled = isRecruitmentFeatureEnabled();
    return {
        key: event.event_key,
        name: event.name,
        status: enabled ? event.status : 'paused',
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        durationDays: Number(event.duration_days),
        referralWindowDays: Number(event.referral_window_days),
        recruiterPrReward: Number(event.recruiter_pr_reward),
        groupWeeklyPrLimit: Number(event.group_weekly_pr_limit),
        recruitReward: {
            yulls: Number(event.recruit_yulls_reward),
            phOutsideCap: Number(event.recruit_ph_reward),
            item: event.recruit_item_reward,
            itemQuantity: Number(event.recruit_item_quantity),
        },
        shop: {
            enabled: enabled && Boolean(event.shop_enabled),
            status: enabled && event.shop_enabled ? 'available' : 'temporarily_unavailable',
        },
    };
}

function isEventActive(event, at = new Date()) {
    if (!isRecruitmentFeatureEnabled()) return false;
    if (event.status !== 'active') return false;
    const now = new Date(at);
    const startsAt = parseSqliteDate(event.starts_at);
    const endsAt = parseSqliteDate(event.ends_at);
    if (startsAt && now < startsAt) return false;
    if (endsAt && now > endsAt) return false;
    return true;
}

async function getActivePlayer(db, playerId) {
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!player) {
        throw new RecruitmentServiceError('player_not_found', 'Player não encontrado.');
    }
    if (String(player.jogo_status || '').trim().toLowerCase() !== 'liberado') {
        throw new RecruitmentServiceError('game_not_released', 'O personagem ainda não está liberado para o jogo.');
    }
    return player;
}

async function ensureRecruitmentCode(db, playerId) {
    if (!isRecruitmentFeatureEnabled()) {
        throw new RecruitmentServiceError('event_not_active', 'O Evento de Divulgação está temporariamente em dormência.');
    }
    await ensureCloverRecruitmentSchema(db);
    await getActivePlayer(db, playerId);
    const existing = await db.get(
        'SELECT * FROM clover_recruitment_codes WHERE player_id = ?',
        [playerId]
    );
    if (existing) {
        if (!existing.active) {
            await db.run(
                `UPDATE clover_recruitment_codes
                 SET active = 1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [existing.id]
            );
        }
        return existing.code;
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
        const code = randomCode();
        try {
            await db.run(
                `INSERT INTO clover_recruitment_codes
                 (player_id, code, active, created_at, updated_at)
                 VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [playerId, code]
            );
            return code;
        } catch (error) {
            if (!String(error?.code || '').includes('CONSTRAINT')) throw error;
        }
    }
    throw new RecruitmentServiceError('code_generation_failed', 'Não consegui gerar um código único agora.');
}

async function getReferralEligibility(db, playerId, options = {}) {
    await ensureCloverRecruitmentSchema(db);
    const event = await getEvent(db, options.eventKey || DEFAULT_EVENT_KEY);
    const player = await getActivePlayer(db, playerId);
    const existing = await db.get(
        `SELECT * FROM clover_recruitment_referrals
         WHERE event_id = ? AND recruit_player_id = ?`,
        [event.id, playerId]
    );
    if (existing) {
        return {
            canSubmit: false,
            reason: 'already_submitted',
            deadlineAt: existing.deadline_at,
            referral: existing,
        };
    }

    if (!isEventActive(event, options.at || new Date())) {
        return { canSubmit: false, reason: 'event_not_active', deadlineAt: null, referral: null };
    }

    const releasedAt = parseSqliteDate(player.jogo_liberado_at);
    if (!releasedAt) {
        return { canSubmit: false, reason: 'activation_date_missing', deadlineAt: null, referral: null };
    }
    const deadline = addDays(releasedAt, event.referral_window_days);
    const now = new Date(options.at || new Date());
    if (now > deadline) {
        return {
            canSubmit: false,
            reason: 'referral_window_expired',
            deadlineAt: formatSqliteDate(deadline),
            referral: null,
        };
    }

    return {
        canSubmit: true,
        reason: null,
        deadlineAt: formatSqliteDate(deadline),
        referral: null,
    };
}

async function findFirstUpEvaluation(db, playerId, releasedAt = null) {
    await ensureCloverQuickEvaluationsSchema(db);
    const params = [playerId];
    let releaseFilter = '';
    if (releasedAt) {
        releaseFilter = 'AND datetime(COALESCE(scene_sent_at, created_at)) >= datetime(?)';
        params.push(releasedAt);
    }
    return db.get(
        `SELECT *
         FROM clover_quick_evaluations
         WHERE player_id = ?
         ${releaseFilter}
         ORDER BY datetime(COALESCE(scene_sent_at, created_at)) ASC, id ASC
         LIMIT 1`,
        params
    );
}

async function insertRewardItem(db, referral, event) {
    const relatedId = `recruitment_referral:${referral.id}`;
    const existing = await db.get(
        `SELECT * FROM clover_inventory_items
         WHERE player_id = ? AND source = 'recrutamento' AND related_id = ?
         ORDER BY id ASC LIMIT 1`,
        [referral.recruit_player_id, relatedId]
    );
    if (existing) return existing.id;
    if (!event.recruit_item_reward || Number(event.recruit_item_quantity) <= 0) return null;

    const added = await addCatalogItemInTransaction(
        db,
        referral.recruit_player_id,
        'box_simple_v1',
        Number(event.recruit_item_quantity),
        {
            source: 'recrutamento',
            relatedId,
            createdBy: 'system',
            bound: true,
            metadata: { event_key: event.event_key, referral_id: referral.id },
        }
    );
    return added.items[0]?.id || null;
}

async function deliverReferralRewards(db, referral, evaluation, actorId = 'system') {
    if (!isRecruitmentFeatureEnabled()) {
        return { ok: true, duplicate: false, dormant: true, referral, delivery: null, event: null };
    }
    await ensureCloverRecruitmentSchema(db);
    await ensureCloverInventorySchema(db);
    await ensureInventoryV1(db);
    const event = await db.get('SELECT * FROM clover_recruitment_events WHERE id = ?', [referral.event_id]);
    if (!event) throw new RecruitmentServiceError('event_not_found', 'Evento não encontrado.');

    await ensurePhState(db, referral.recruit_player_id);
    await ensureYullsState(db, referral.recruit_player_id);

    await db.exec('BEGIN IMMEDIATE');
    try {
        const current = await db.get(
            'SELECT * FROM clover_recruitment_referrals WHERE id = ?',
            [referral.id]
        );
        if (current.status === 'rewarded') {
            const delivery = await db.get(
                'SELECT * FROM clover_recruitment_reward_deliveries WHERE referral_id = ?',
                [current.id]
            );
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, referral: current, delivery, event: serializeEvent(event) };
        }
        if (!['pending', 'validated'].includes(current.status)) {
            throw new RecruitmentServiceError('referral_not_pending', 'A indicação não pode mais ser validada.');
        }

        await db.run(
            `INSERT INTO clover_recruitment_reward_deliveries
             (referral_id, status, attempts, created_at, updated_at)
             VALUES (?, 'processing', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(referral_id) DO UPDATE SET
                 status = 'processing',
                 attempts = attempts + 1,
                 last_error = NULL,
                 updated_at = CURRENT_TIMESTAMP`,
            [current.id]
        );

        let prResult = null;
        if (Number(event.recruiter_pr_reward) > 0) {
            prResult = await addRecruitmentPrInTransaction(
                db,
                current.recruiter_player_id,
                Number(event.recruiter_pr_reward),
                `Recrutamento validado: indicação ${current.id}`,
                actorId,
                {
                    eventKey: event.event_key,
                    relatedId: `referral:${current.id}`,
                    idempotencyKey: `pr:recruitment:referral:${current.id}`,
                    metadata: { recruit_player_id: current.recruit_player_id },
                }
            );
        }

        let yullsResult = null;
        if (Number(event.recruit_yulls_reward) > 0) {
            yullsResult = await addYullsInTransaction(
                db,
                current.recruit_player_id,
                Number(event.recruit_yulls_reward),
                'recrutamento',
                'Boas-vindas do Evento de Divulgação',
                actorId,
                {
                    relatedId: `referral:${current.id}`,
                    idempotencyKey: `yulls:recruitment:referral:${current.id}`,
                    metadata: { recruiter_player_id: current.recruiter_player_id },
                }
            );
        }

        let phResult = null;
        if (Number(event.recruit_ph_reward) > 0) {
            phResult = await addPhInTransaction(
                db,
                current.recruit_player_id,
                Number(event.recruit_ph_reward),
                'recrutamento',
                'Boas-vindas do Evento de Divulgação — fora do teto semanal',
                actorId,
                { outside_weekly_cap: true, referral_id: current.id },
                `recruitment_referral:${current.id}`
            );
        }

        const inventoryItemId = await insertRewardItem(db, current, event);
        await db.run(
            `UPDATE clover_recruitment_referrals
             SET status = 'rewarded',
                 validation_source = 'first_up',
                 validation_evaluation_id = ?,
                 validated_at = COALESCE(validated_at, CURRENT_TIMESTAMP),
                 rewarded_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [evaluation.id, current.id]
        );
        await db.run(
            `UPDATE clover_recruitment_reward_deliveries
             SET status = 'completed',
                 yulls_ledger_id = ?,
                 ph_ledger_id = ?,
                 inventory_item_id = ?,
                 completed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE referral_id = ?`,
            [yullsResult?.ledgerId || null, phResult?.ledgerId || null, inventoryItemId, current.id]
        );
        const updated = await db.get('SELECT * FROM clover_recruitment_referrals WHERE id = ?', [current.id]);
        const delivery = await db.get(
            'SELECT * FROM clover_recruitment_reward_deliveries WHERE referral_id = ?',
            [current.id]
        );
        await db.exec('COMMIT');
        return {
            ok: true,
            duplicate: false,
            referral: updated,
            delivery,
            event: serializeEvent(event),
            prResult,
            yullsResult,
            phResult,
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

async function tryValidateReferralFromEvaluation(db, options = {}) {
    if (!isRecruitmentFeatureEnabled()) {
        return { ok: true, validated: false, reason: 'feature_dormant' };
    }
    await ensureCloverRecruitmentSchema(db);
    const evaluation = options.evaluationId
        ? await db.get(
            'SELECT * FROM clover_quick_evaluations WHERE id = ? AND player_id = ?',
            [options.evaluationId, options.playerId]
        )
        : await findFirstUpEvaluation(db, options.playerId, options.releasedAt || null);
    if (!evaluation) return { ok: true, validated: false, reason: 'no_up_evaluation' };

    const referral = await db.get(
        `SELECT * FROM clover_recruitment_referrals
         WHERE recruit_player_id = ? AND status IN ('pending', 'validated')
         ORDER BY id ASC LIMIT 1`,
        [options.playerId]
    );
    if (!referral) return { ok: true, validated: false, reason: 'no_pending_referral' };
    const result = await deliverReferralRewards(db, referral, evaluation, options.actorId || 'system');
    return { ...result, validated: true, evaluation };
}

async function ensureRecruitmentEventStarted(db, options = {}) {
    await ensureCloverRecruitmentSchema(db);
    const eventKey = options.eventKey || DEFAULT_EVENT_KEY;
    const event = await getEvent(db, eventKey);
    if (!isRecruitmentFeatureEnabled()) return event;
    if (event.status !== 'draft') return event;

    const startsAt = new Date(options.at || new Date());
    return configureRecruitmentEvent(db, {
        eventKey,
        status: 'active',
        startsAt,
        durationDays: Number(event.duration_days || 30),
        groupWeeklyPrLimit: Number(event.group_weekly_pr_limit || 20),
        shopEnabled: Boolean(event.shop_enabled),
    });
}

async function submitReferralCode(db, playerId, codeInput, options = {}) {
    await ensureCloverRecruitmentSchema(db);
    const event = await ensureRecruitmentEventStarted(db, options);
    if (!isEventActive(event, options.at || new Date())) {
        throw new RecruitmentServiceError('event_not_active', 'O Evento de Divulgação ainda não está ativo.');
    }
    const player = await getActivePlayer(db, playerId);
    const code = normalizeCode(codeInput);
    if (!/^CV-[A-Z2-9]{6}$/.test(code)) {
        throw new RecruitmentServiceError('invalid_code', 'Código de recrutamento inválido.');
    }

    const eligibility = await getReferralEligibility(db, playerId, options);
    if (!eligibility.canSubmit) {
        if (eligibility.reason === 'already_submitted') {
            const sameCode = normalizeCode(eligibility.referral.recruitment_code) === code;
            if (!sameCode) {
                throw new RecruitmentServiceError('referral_already_submitted', 'Você já confirmou outro recrutador.');
            }
            const validation = await retryPendingReferralFromExistingUp(db, playerId, {
                eventKey: options.eventKey || DEFAULT_EVENT_KEY,
                actorId: options.createdBy || playerId,
                deliver: deliverReferralRewards,
            });
            return { ok: true, duplicate: true, referral: eligibility.referral, validation };
        }
        throw new RecruitmentServiceError(
            eligibility.reason,
            eligibility.reason === 'referral_window_expired'
                ? 'O prazo de 7 dias para informar o código terminou.'
                : 'Você não pode informar um código neste momento.',
            eligibility
        );
    }

    const codeRow = await db.get(
        `SELECT c.*, j.jogo_status, j.personagem_nome, j.nome, j.display_name
         FROM clover_recruitment_codes c
         JOIN jogadores j ON j.id = c.player_id
         WHERE c.code = ? COLLATE NOCASE AND c.active = 1`,
        [code]
    );
    if (!codeRow || String(codeRow.jogo_status || '').toLowerCase() !== 'liberado') {
        throw new RecruitmentServiceError('code_not_found', 'Código de recrutamento não encontrado.');
    }
    if (codeRow.player_id === playerId) {
        throw new RecruitmentServiceError('self_referral', 'Você não pode usar o próprio código.');
    }

    await db.exec('BEGIN IMMEDIATE');
    let referral;
    try {
        const inserted = await db.run(
            `INSERT INTO clover_recruitment_referrals
             (event_id, recruit_player_id, recruiter_player_id, recruitment_code, status,
              submitted_at, deadline_at, created_by, metadata_json)
             VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, ?, ?, ?)`,
            [
                event.id,
                playerId,
                codeRow.player_id,
                code,
                eligibility.deadlineAt,
                options.createdBy || playerId,
                JSON.stringify({ via: options.via || 'site' }),
            ]
        );
        referral = await db.get('SELECT * FROM clover_recruitment_referrals WHERE id = ?', [inserted.lastID]);
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }

    const firstUp = await findFirstUpEvaluation(db, playerId, player.jogo_liberado_at);
    const validation = firstUp
        ? await tryValidateReferralFromEvaluation(db, {
            playerId,
            evaluationId: firstUp.id,
            actorId: options.createdBy || 'system',
        })
        : { ok: true, validated: false, reason: 'waiting_first_up' };
    return { ok: true, duplicate: false, referral, validation };
}

async function getRecruitmentDashboard(db, playerId, options = {}) {
    await ensureCloverRecruitmentSchema(db);
    const enabled = isRecruitmentFeatureEnabled();
    const event = enabled
        ? await ensureRecruitmentEventStarted(db, options)
        : await getEvent(db, options.eventKey || DEFAULT_EVENT_KEY);
    const player = await getActivePlayer(db, playerId);
    let recovery = { ok: true, validated: false, attempted: false, reason: 'feature_dormant' };
    if (enabled) {
        try {
            recovery = await retryPendingReferralFromExistingUp(db, playerId, {
                eventKey: options.eventKey || DEFAULT_EVENT_KEY,
                actorId: options.actorId || 'system:recruitment-dashboard-recovery',
                deliver: deliverReferralRewards,
            });
        } catch (error) {
            recovery = {
                ok: false,
                validated: false,
                attempted: true,
                reason: 'delivery_failed',
                error: error?.message || String(error),
            };
        }
    }
    const code = enabled ? await ensureRecruitmentCode(db, playerId) : null;
    const [eligibility, pr, prHistory, referral, counts] = await Promise.all([
        enabled
            ? getReferralEligibility(db, playerId, options)
            : Promise.resolve({ canSubmit: false, reason: 'event_not_active', deadlineAt: null, referral: null }),
        getPrSummary(db, playerId, options),
        getPrHistory(db, playerId, options.historyLimit || 10),
        db.get(
            `SELECT r.*, j.personagem_nome AS recruiter_character_name,
                    j.nome AS recruiter_name, j.display_name AS recruiter_display_name
             FROM clover_recruitment_referrals r
             LEFT JOIN jogadores j ON j.id = r.recruiter_player_id
             WHERE r.event_id = ? AND r.recruit_player_id = ?`,
            [event.id, playerId]
        ),
        db.get(
            `SELECT
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
                COALESCE(SUM(CASE WHEN status IN ('validated', 'rewarded') THEN 1 ELSE 0 END), 0) AS validated
             FROM clover_recruitment_referrals
             WHERE event_id = ? AND recruiter_player_id = ?`,
            [event.id, playerId]
        ),
    ]);

    return {
        event: serializeEvent(event),
        active: isEventActive(event, options.at || new Date()),
        player: { id: player.id, name: displayName(player) },
        code,
        recovery,
        eligibility,
        referredBy: referral ? {
            status: referral.status,
            code: referral.recruitment_code,
            recruiterName: displayName({
                personagem_nome: referral.recruiter_character_name,
                nome: referral.recruiter_name,
                display_name: referral.recruiter_display_name,
            }),
            submittedAt: referral.submitted_at,
            validatedAt: referral.validated_at,
            rewardedAt: referral.rewarded_at,
        } : null,
        recruiting: {
            total: Number(counts?.total || 0),
            pending: Number(counts?.pending || 0),
            validated: Number(counts?.validated || 0),
        },
        pr,
        prHistory,
    };
}

async function configureRecruitmentEvent(db, patch = {}) {
    await ensureCloverRecruitmentSchema(db);
    const event = await getEvent(db, patch.eventKey || DEFAULT_EVENT_KEY);
    const status = patch.status || event.status;
    if (!['draft', 'active', 'paused', 'ended'].includes(status)) {
        throw new RecruitmentServiceError('invalid_status', 'Status de evento inválido.');
    }
    const startsAt = patch.startsAt === undefined ? event.starts_at : formatSqliteDate(patch.startsAt);
    const durationDays = Number(patch.durationDays ?? event.duration_days);
    let endsAt = patch.endsAt === undefined ? event.ends_at : formatSqliteDate(patch.endsAt);
    if (status === 'active' && !startsAt) {
        throw new RecruitmentServiceError('missing_start_date', 'Defina a data inicial antes de ativar o evento.');
    }
    if (status === 'active' && (patch.startsAt !== undefined && patch.endsAt === undefined || !endsAt)) {
        endsAt = formatSqliteDate(addDays(parseSqliteDate(startsAt), durationDays));
    }

    await db.run(
        `UPDATE clover_recruitment_events
         SET status = ?, starts_at = ?, ends_at = ?, duration_days = ?,
             group_weekly_pr_limit = ?, shop_enabled = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
            status,
            startsAt,
            endsAt,
            durationDays,
            Number(patch.groupWeeklyPrLimit ?? event.group_weekly_pr_limit),
            patch.shopEnabled === undefined ? event.shop_enabled : (patch.shopEnabled ? 1 : 0),
            event.id,
        ]
    );
    return getEvent(db, event.event_key);
}

module.exports = {
    RecruitmentServiceError,
    configureRecruitmentEvent,
    deliverReferralRewards,
    ensureRecruitmentCode,
    ensureRecruitmentEventStarted,
    findFirstUpEvaluation,
    getRecruitmentDashboard,
    getReferralEligibility,
    isEventActive,
    normalizeCode,
    serializeEvent,
    submitReferralCode,
    tryValidateReferralFromEvaluation,
};
