'use strict';

const { DEFAULT_PRE_RESET_CAMPAIGN_KEY } = require('./preResetCampaignStateService');

const REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT = 14;

class ReturnPointShopGateError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ReturnPointShopGateError';
        this.code = code;
        this.details = details;
    }
}

function cleanActor(value) {
    const actorId = String(value || '').trim();
    if (!actorId) throw new ReturnPointShopGateError('missing_actor', 'Owner invalido para alterar a Loja de Retorno.');
    return actorId;
}

function sameIds(left, right) {
    const a = [...left].map(String).sort();
    const b = [...right].map(String).sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function getReturnPointShopRosterReadiness(
    db,
    campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY
) {
    const roster = await db.get(
        `SELECT campaign_key,revision,status,roster_hash,finalized_at
         FROM clover_prereset_launch_rosters
         WHERE campaign_key=?`,
        [campaignKey]
    );

    if (!roster || !['finalized', 'applying', 'completed'].includes(roster.status)) {
        return Object.freeze({
            ok: false,
            code: 'return_shop_roster_not_finalized',
            requiredKeepCount: REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT,
            keepCount: null,
            rosterStatus: roster?.status || null,
            rosterRevision: roster?.revision == null ? null : Number(roster.revision),
            rosterHash: roster?.roster_hash || null,
        });
    }

    const [keepRosterRows, launchKeepRows] = await Promise.all([
        db.all(
            `SELECT player_id,roster_revision
             FROM clover_prereset_launch_keep_roster
             WHERE campaign_key=?
             ORDER BY player_id`,
            [campaignKey]
        ),
        db.all(
            `SELECT player_id,roster_revision
             FROM clover_prereset_launch_players
             WHERE campaign_key=? AND outcome='keep'
             ORDER BY player_id`,
            [campaignKey]
        ),
    ]);

    const revision = Number(roster.revision);
    const revisionConsistent = [...keepRosterRows, ...launchKeepRows]
        .every((row) => Number(row.roster_revision) === revision);
    const membershipConsistent = sameIds(
        keepRosterRows.map((row) => row.player_id),
        launchKeepRows.map((row) => row.player_id)
    );
    const keepCount = keepRosterRows.length;
    const countExact = keepCount === REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT
        && launchKeepRows.length === REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT;

    const ok = revisionConsistent && membershipConsistent && countExact;
    return Object.freeze({
        ok,
        code: ok
            ? null
            : !revisionConsistent || !membershipConsistent
                ? 'return_shop_roster_inconsistent'
                : 'return_shop_keep_count_mismatch',
        requiredKeepCount: REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT,
        keepCount,
        launchKeepCount: launchKeepRows.length,
        rosterStatus: roster.status,
        rosterRevision: revision,
        rosterHash: roster.roster_hash || null,
        finalizedAt: roster.finalized_at || null,
    });
}

function publicGate(row) {
    if (!row) {
        return Object.freeze({
            open: false,
            status: 'closed',
            requiredKeepCount: REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT,
            rosterRevision: null,
            rosterHash: null,
            keepCountAtOpen: null,
            openedAt: null,
            closedAt: null,
        });
    }
    return Object.freeze({
        open: row.status === 'open',
        status: row.status,
        requiredKeepCount: Number(row.required_keep_count),
        rosterRevision: row.roster_revision == null ? null : Number(row.roster_revision),
        rosterHash: row.roster_hash || null,
        keepCountAtOpen: row.keep_count_at_open == null ? null : Number(row.keep_count_at_open),
        openedAt: row.opened_at || null,
        closedAt: row.closed_at || null,
    });
}

async function getReturnPointShopGateState(
    db,
    campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY
) {
    const row = await db.get(
        'SELECT * FROM clover_return_point_shop_gate WHERE campaign_key=?',
        [campaignKey]
    );
    return publicGate(row);
}

async function getReturnPointShopEligibilitySnapshot(
    db,
    campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY
) {
    const rows = await db.all(
        `SELECT outcome,COUNT(*) AS total,MIN(roster_revision) AS min_revision,
                MAX(roster_revision) AS max_revision,MAX(captured_at) AS captured_at
         FROM clover_return_point_shop_eligible
         WHERE campaign_key=?
         GROUP BY outcome`,
        [campaignKey]
    );
    const byOutcome = new Map(rows.map((row) => [row.outcome, row]));
    const keep = Number(byOutcome.get('keep')?.total || 0);
    const reset = Number(byOutcome.get('reset')?.total || 0);
    const revisions = rows.flatMap((row) => [Number(row.min_revision), Number(row.max_revision)])
        .filter(Number.isFinite);
    const revision = revisions.length && revisions.every((value) => value === revisions[0])
        ? revisions[0]
        : null;
    return Object.freeze({
        total: keep + reset,
        keep,
        reset,
        rosterRevision: revision,
        capturedAt: rows.map((row) => row.captured_at).filter(Boolean).sort().at(-1) || null,
    });
}

async function assertReturnPointShopOpen(
    db,
    campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY
) {
    const gate = await getReturnPointShopGateState(db, campaignKey);
    if (!gate.open) {
        throw new ReturnPointShopGateError(
            'return_shop_closed',
            'A Loja de Retorno ainda nao foi liberada pelo Owner.',
            { status: gate.status }
        );
    }
    return gate;
}

async function assertReturnPointShopBuyerEligible(
    db,
    playerId,
    campaignKey = DEFAULT_PRE_RESET_CAMPAIGN_KEY
) {
    const gate = await assertReturnPointShopOpen(db, campaignKey);
    const id = String(playerId || '').trim();
    const row = id
        ? await db.get(
            `SELECT campaign_key,player_id,roster_revision,roster_hash,outcome,captured_at
             FROM clover_return_point_shop_eligible
             WHERE campaign_key=? AND player_id=?`,
            [campaignKey, id]
        )
        : null;
    const sameRevision = row && Number(row.roster_revision) === Number(gate.rosterRevision);
    const sameHash = row && String(row.roster_hash || '') === String(gate.rosterHash || '');
    if (!row || row.outcome !== 'reset' || !sameRevision || !sameHash) {
        throw new ReturnPointShopGateError(
            'return_shop_not_eligible',
            'Seu cadastro nao pertence ao snapshot RESET autorizado quando a Loja de Retorno foi aberta.',
            {
                playerId: id || null,
                rosterRevision: gate.rosterRevision,
                snapshotOutcome: row?.outcome || null,
            }
        );
    }
    return Object.freeze({ gate, eligibility: Object.freeze({ ...row }) });
}

function readinessError(readiness) {
    if (readiness.code === 'return_shop_roster_not_finalized') {
        return new ReturnPointShopGateError(
            readiness.code,
            'A roster precisa estar finalizada antes de abrir a Loja de Retorno.',
            readiness
        );
    }
    if (readiness.code === 'return_shop_keep_count_mismatch') {
        return new ReturnPointShopGateError(
            readiness.code,
            `A Loja de Retorno exige exatamente ${REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT} KEEP.`,
            readiness
        );
    }
    return new ReturnPointShopGateError(
        readiness.code || 'return_shop_roster_inconsistent',
        'A roster finalizada esta inconsistente e a loja permaneceu fechada.',
        readiness
    );
}

async function captureEligibilitySnapshot(db, campaignKey, readiness, actor) {
    const rows = await db.all(
        `SELECT player_id,roster_revision,outcome
         FROM clover_prereset_launch_players
         WHERE campaign_key=?
         ORDER BY player_id`,
        [campaignKey]
    );
    if (!rows.length || rows.some((row) => Number(row.roster_revision) !== Number(readiness.rosterRevision))) {
        throw new ReturnPointShopGateError(
            'return_shop_roster_inconsistent',
            'A roster de jogadores possui revisoes divergentes; a loja permaneceu fechada.',
            { rosterRevision: readiness.rosterRevision, launchPlayerCount: rows.length }
        );
    }
    const keepRows = rows.filter((row) => row.outcome === 'keep');
    if (keepRows.length !== REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT) {
        throw new ReturnPointShopGateError(
            'return_shop_keep_count_mismatch',
            `A Loja de Retorno exige exatamente ${REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT} KEEP.`,
            { keepCount: keepRows.length, requiredKeepCount: REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT }
        );
    }

    await db.run('DELETE FROM clover_return_point_shop_eligible WHERE campaign_key=?', [campaignKey]);
    for (const row of rows) {
        await db.run(
            `INSERT INTO clover_return_point_shop_eligible
             (campaign_key,player_id,roster_revision,roster_hash,outcome,captured_by)
             VALUES (?,?,?,?,?,?)`,
            [campaignKey, row.player_id, readiness.rosterRevision, readiness.rosterHash, row.outcome, actor]
        );
    }
    return Object.freeze({
        total: rows.length,
        keep: keepRows.length,
        reset: rows.filter((row) => row.outcome === 'reset').length,
        rosterRevision: readiness.rosterRevision,
    });
}

async function openReturnPointShop(db, actorId, options = {}) {
    const actor = cleanActor(actorId);
    const campaignKey = String(options.campaignKey || DEFAULT_PRE_RESET_CAMPAIGN_KEY).trim();
    await db.exec('BEGIN IMMEDIATE');
    try {
        const existing = await db.get(
            'SELECT * FROM clover_return_point_shop_gate WHERE campaign_key=?',
            [campaignKey]
        );
        if (existing?.status === 'open') {
            const snapshot = await getReturnPointShopEligibilitySnapshot(db, campaignKey);
            if (!snapshot.total || snapshot.rosterRevision !== Number(existing.roster_revision)) {
                throw new ReturnPointShopGateError(
                    'return_shop_snapshot_missing',
                    'A loja aparece aberta sem snapshot elegivel consistente. Feche e reabra depois de validar a roster.',
                    { snapshot, rosterRevision: Number(existing.roster_revision) }
                );
            }
            await db.exec('COMMIT');
            return Object.freeze({ ok:true, duplicate:true, gate:publicGate(existing), eligibilitySnapshot:snapshot });
        }

        const readiness = await getReturnPointShopRosterReadiness(db, campaignKey);
        if (!readiness.ok) throw readinessError(readiness);
        const eligibilitySnapshot = await captureEligibilitySnapshot(db, campaignKey, readiness, actor);

        await db.run(
            `INSERT INTO clover_return_point_shop_gate
             (campaign_key,status,required_keep_count,roster_revision,roster_hash,keep_count_at_open,
              opened_by,opened_at,closed_by,closed_at,updated_at)
             VALUES (?, 'open', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, NULL, NULL, CURRENT_TIMESTAMP)
             ON CONFLICT(campaign_key) DO UPDATE SET
                status='open',
                required_keep_count=excluded.required_keep_count,
                roster_revision=excluded.roster_revision,
                roster_hash=excluded.roster_hash,
                keep_count_at_open=excluded.keep_count_at_open,
                opened_by=excluded.opened_by,
                opened_at=CURRENT_TIMESTAMP,
                closed_by=NULL,
                closed_at=NULL,
                updated_at=CURRENT_TIMESTAMP`,
            [
                campaignKey,
                REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT,
                readiness.rosterRevision,
                readiness.rosterHash,
                readiness.keepCount,
                actor,
            ]
        );
        await db.run(
            `INSERT INTO clover_return_point_shop_gate_events
             (campaign_key,event_type,actor_id,roster_revision,roster_hash,keep_count)
             VALUES (?, 'open', ?, ?, ?, ?)`,
            [campaignKey, actor, readiness.rosterRevision, readiness.rosterHash, readiness.keepCount]
        );
        const row = await db.get(
            'SELECT * FROM clover_return_point_shop_gate WHERE campaign_key=?',
            [campaignKey]
        );
        await db.exec('COMMIT');
        return Object.freeze({ ok:true, duplicate:false, gate:publicGate(row), readiness, eligibilitySnapshot });
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function closeReturnPointShop(db, actorId, options = {}) {
    const actor = cleanActor(actorId);
    const campaignKey = String(options.campaignKey || DEFAULT_PRE_RESET_CAMPAIGN_KEY).trim();
    await db.exec('BEGIN IMMEDIATE');
    try {
        const existing = await db.get(
            'SELECT * FROM clover_return_point_shop_gate WHERE campaign_key=?',
            [campaignKey]
        );
        if (!existing || existing.status === 'closed') {
            await db.exec('COMMIT');
            return Object.freeze({ ok:true, duplicate:true, gate:publicGate(existing) });
        }
        await db.run(
            `UPDATE clover_return_point_shop_gate
             SET status='closed',closed_by=?,closed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
             WHERE campaign_key=?`,
            [actor, campaignKey]
        );
        await db.run(
            `INSERT INTO clover_return_point_shop_gate_events
             (campaign_key,event_type,actor_id,roster_revision,roster_hash,keep_count)
             VALUES (?, 'close', ?, ?, ?, ?)`,
            [campaignKey, actor, existing.roster_revision, existing.roster_hash, existing.keep_count_at_open]
        );
        const row = await db.get(
            'SELECT * FROM clover_return_point_shop_gate WHERE campaign_key=?',
            [campaignKey]
        );
        await db.exec('COMMIT');
        return Object.freeze({ ok:true, duplicate:false, gate:publicGate(row) });
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    REQUIRED_RETURN_POINT_SHOP_KEEP_COUNT,
    ReturnPointShopGateError,
    assertReturnPointShopBuyerEligible,
    assertReturnPointShopOpen,
    closeReturnPointShop,
    getReturnPointShopEligibilitySnapshot,
    getReturnPointShopGateState,
    getReturnPointShopRosterReadiness,
    openReturnPointShop,
    publicGate,
};
