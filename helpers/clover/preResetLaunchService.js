'use strict';

const crypto = require('crypto');
const {
    assertPreResetAdminCapability,
    assertPreResetAdminMutationAllowed,
} = require('./preResetAccessService');
const {
    DEFAULT_PRE_RESET_CAMPAIGN_KEY,
    normalizeCampaignKey,
    requiredOperationKey,
} = require('./preResetCampaignStateService');
const { isPreResetPlayerPurged } = require('./preResetPurgeStateService');
const { BOX_CATALOGS } = require('./seasonalEventCatalog');
const { getPrBalance, mutatePrInTransaction, DEFAULT_EVENT_KEY } = require('./prService');
const { appendPvInTransaction, getPvBalance } = require('./pvService');
const { resetPlayer } = require('./playerResetService');

class PreResetLaunchError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreResetLaunchError';
        this.code = code;
        this.details = details;
    }
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value ?? null;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}
function actorId(context = {}) {
    const id = String(context.actorId || '').trim();
    if (!id) throw new PreResetLaunchError('missing_actor', 'Autor administrativo obrigatorio.');
    return id;
}
function guard(context, capability = 'prereset.review') {
    try {
        assertPreResetAdminMutationAllowed(context);
        assertPreResetAdminCapability(context, capability);
    } catch (error) {
        throw new PreResetLaunchError(error.code || 'capability_denied', error.message);
    }
}
function assertRealApplyEnabled(context = {}) {
    guard(context, 'operation.apply');
    if (String((context.env || process.env).PRE_RESET || '').trim().toUpperCase() !== 'ON') {
        throw new PreResetLaunchError('prereset_real_apply_disabled', 'Aplicacao destrutiva permanece desativada com PRE_RESET diferente de ON.');
    }
}
function canonicalId(value) {
    const id = String(value || '').trim();
    if (!id || id.length > 255) throw new PreResetLaunchError('invalid_player_id', 'Player ID invalido.');
    return id;
}

async function eligiblePlayers(db) {
    const rows = await db.all(`SELECT * FROM jogadores WHERE ficha_status = 'aprovada' ORDER BY id ASC`);
    const result = [];
    for (const row of rows) {
        if (Number(row.is_shadow || 0) === 1) continue;
        if (await isPreResetPlayerPurged(db, row.id)) continue;
        result.push(row);
    }
    return result;
}

async function ensureRoster(db, campaignKey) {
    await db.run(
        `INSERT INTO clover_prereset_launch_rosters (campaign_key)
         VALUES (?) ON CONFLICT(campaign_key) DO NOTHING`,
        [campaignKey]
    );
    await db.run(
        `INSERT INTO clover_prereset_pr_pv_policies (campaign_key)
         VALUES (?) ON CONFLICT(campaign_key) DO NOTHING`,
        [campaignKey]
    );
    return db.get('SELECT * FROM clover_prereset_launch_rosters WHERE campaign_key = ?', [campaignKey]);
}

async function validateKeepIds(db, ids) {
    const unique = [...new Set((Array.isArray(ids) ? ids : []).map(canonicalId))].sort();
    const eligible = await eligiblePlayers(db);
    const byId = new Map(eligible.map((row) => [String(row.id), row]));
    const invalid = unique.filter((id) => !byId.has(id));
    if (invalid.length) {
        throw new PreResetLaunchError('keep_roster_invalid_players', 'A whitelist contem player nao elegivel.', { invalid });
    }
    return unique;
}

async function replaceKeepRoster(db, context = {}, request = {}) {
    guard(context);
    const actor = actorId(context);
    const campaignKey = normalizeCampaignKey(request.campaignKey || DEFAULT_PRE_RESET_CAMPAIGN_KEY);
    const operationKey = requiredOperationKey(request.operationKey);
    const keepIds = await validateKeepIds(db, request.keepPlayerIds);
    const requestHash = hash({ campaignKey, keepIds, expectedRevision:Number(request.expectedRevision ?? 0) });

    await db.exec('BEGIN IMMEDIATE');
    try {
        const existingEvent = await db.get('SELECT * FROM clover_prereset_launch_events WHERE operation_key = ?', [operationKey]);
        if (existingEvent) {
            if (existingEvent.request_hash !== requestHash) throw new PreResetLaunchError('idempotency_conflict', 'Chave de operacao pertence a outro roster.');
            const roster = await db.get('SELECT * FROM clover_prereset_launch_rosters WHERE campaign_key = ?', [campaignKey]);
            await db.exec('COMMIT');
            return { ok:true, duplicate:true, roster, ...(await previewRoster(db, { campaignKey })) };
        }
        let roster = await ensureRoster(db, campaignKey);
        if (roster.status !== 'draft') throw new PreResetLaunchError('roster_finalized', 'Roster finalizado nao pode ser alterado.');
        const expected = Number(request.expectedRevision ?? roster.revision);
        if (!Number.isInteger(expected) || expected !== Number(roster.revision)) {
            throw new PreResetLaunchError('roster_revision_conflict', 'Revisao do roster mudou.', { expected, actual:Number(roster.revision) });
        }
        const revision = Number(roster.revision) + 1;
        await db.run('DELETE FROM clover_prereset_launch_keep_roster WHERE campaign_key = ?', [campaignKey]);
        for (const id of keepIds) {
            await db.run(
                `INSERT INTO clover_prereset_launch_keep_roster
                 (campaign_key, player_id, roster_revision, added_by) VALUES (?,?,?,?)`,
                [campaignKey, id, revision, actor]
            );
        }
        const rosterHash = hash({ campaignKey, revision, authorityMode:'admin_roster', keepIds });
        await db.run(
            `UPDATE clover_prereset_launch_rosters
             SET revision=?, roster_hash=?, updated_at=CURRENT_TIMESTAMP
             WHERE campaign_key=? AND status='draft'`,
            [revision, rosterHash, campaignKey]
        );
        await db.run(
            `INSERT INTO clover_prereset_launch_events
             (operation_key,campaign_key,event_type,actor_id,request_hash,payload_json)
             VALUES (?,?, 'roster_replace', ?, ?, ?)`,
            [operationKey,campaignKey,actor,requestHash,JSON.stringify({ revision, keepIds, authorityMode:'admin_roster' })]
        );
        roster = await db.get('SELECT * FROM clover_prereset_launch_rosters WHERE campaign_key = ?', [campaignKey]);
        await db.exec('COMMIT');
        return { ok:true, duplicate:false, roster, ...(await previewRoster(db, { campaignKey })) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function previewRoster(db, request = {}) {
    const campaignKey = normalizeCampaignKey(request.campaignKey || DEFAULT_PRE_RESET_CAMPAIGN_KEY);
    const roster = await db.get('SELECT * FROM clover_prereset_launch_rosters WHERE campaign_key = ?', [campaignKey]);
    const keepRows = await db.all(
        'SELECT player_id FROM clover_prereset_launch_keep_roster WHERE campaign_key = ? ORDER BY player_id',
        [campaignKey]
    );
    const keepSet = new Set(keepRows.map((row) => String(row.player_id)));
    const eligible = await eligiblePlayers(db);
    const players = eligible.map((row) => ({
        playerId:String(row.id),
        outcome:keepSet.has(String(row.id)) ? 'keep' : 'reset',
        characterName:row.personagem_nome || row.nome || null,
    }));
    return {
        campaignKey,
        authorityMode:'admin_roster',
        roster:roster || null,
        counts:{
            eligible:players.length,
            keep:players.filter((p) => p.outcome === 'keep').length,
            reset:players.filter((p) => p.outcome === 'reset').length,
        },
        players,
    };
}

async function finalizeRoster(db, context = {}, request = {}) {
    guard(context);
    const actor = actorId(context);
    const campaignKey = normalizeCampaignKey(request.campaignKey || DEFAULT_PRE_RESET_CAMPAIGN_KEY);
    const operationKey = requiredOperationKey(request.operationKey);
    const expectedRevision = Number(request.expectedRevision);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const duplicate = await db.get('SELECT * FROM clover_prereset_launch_events WHERE operation_key = ?', [operationKey]);
        if (duplicate) {
            const roster = await db.get('SELECT * FROM clover_prereset_launch_rosters WHERE campaign_key = ?', [campaignKey]);
            await db.exec('COMMIT');
            return { ok:true, duplicate:true, roster };
        }
        const roster = await ensureRoster(db, campaignKey);
        if (roster.status !== 'draft') throw new PreResetLaunchError('roster_finalized', 'Roster ja foi finalizado.');
        if (!Number.isInteger(expectedRevision) || expectedRevision !== Number(roster.revision) || expectedRevision <= 0) {
            throw new PreResetLaunchError('roster_revision_conflict', 'Finalizacao exige revisao exata e nao vazia.', { actual:Number(roster.revision) });
        }
        const preview = await previewRoster(db, { campaignKey });
        await db.run('DELETE FROM clover_prereset_launch_players WHERE campaign_key = ?', [campaignKey]);
        for (const player of preview.players) {
            await db.run(
                `INSERT INTO clover_prereset_launch_players
                 (campaign_key,player_id,roster_revision,outcome,status)
                 VALUES (?,?,?,?, 'pending')`,
                [campaignKey,player.playerId,expectedRevision,player.outcome]
            );
        }
        const requestHash = hash({ campaignKey, expectedRevision, rosterHash:roster.roster_hash, counts:preview.counts });
        await db.run(
            `UPDATE clover_prereset_launch_rosters
             SET status='finalized', finalized_by=?, finalized_at=CURRENT_TIMESTAMP,
                 finalization_operation_key=?, updated_at=CURRENT_TIMESTAMP
             WHERE campaign_key=? AND status='draft' AND revision=?`,
            [actor,operationKey,campaignKey,expectedRevision]
        );
        await db.run(
            `INSERT INTO clover_prereset_launch_events
             (operation_key,campaign_key,event_type,actor_id,request_hash,payload_json)
             VALUES (?,?, 'roster_finalize', ?, ?, ?)`,
            [operationKey,campaignKey,actor,requestHash,JSON.stringify({ revision:expectedRevision, counts:preview.counts })]
        );
        const finalized = await db.get('SELECT * FROM clover_prereset_launch_rosters WHERE campaign_key = ?', [campaignKey]);
        await db.exec('COMMIT');
        return { ok:true, duplicate:false, roster:finalized, counts:preview.counts };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function configurePrPvPolicy(db, context = {}, request = {}) {
    guard(context);
    const actor = actorId(context);
    const campaignKey = normalizeCampaignKey(request.campaignKey || DEFAULT_PRE_RESET_CAMPAIGN_KEY);
    const operationKey = requiredOperationKey(request.operationKey);
    const policyVersion = String(request.policyVersion || '').trim();
    const numerator = Number(request.numerator);
    const denominator = Number(request.denominator);
    const rounding = String(request.rounding || '').trim().toLowerCase();
    if (!/^[a-zA-Z0-9_.:-]{3,120}$/.test(policyVersion)
        || !Number.isInteger(numerator) || numerator <= 0
        || !Number.isInteger(denominator) || denominator <= 0
        || !['floor','ceil'].includes(rounding)) {
        throw new PreResetLaunchError('invalid_conversion_policy', 'Politica PR->PV invalida.');
    }
    await db.exec('BEGIN IMMEDIATE');
    try {
        await ensureRoster(db, campaignKey);
        const current = await db.get('SELECT * FROM clover_prereset_pr_pv_policies WHERE campaign_key = ?', [campaignKey]);
        if (current.status === 'approved') {
            if (current.operation_key === operationKey
                && current.policy_version === policyVersion
                && Number(current.numerator) === numerator
                && Number(current.denominator) === denominator
                && current.rounding === rounding) {
                await db.exec('COMMIT');
                return { ok:true, duplicate:true, policy:current };
            }
            throw new PreResetLaunchError('conversion_policy_locked', 'Politica PR->PV aprovada e imutavel para esta campanha.');
        }
        await db.run(
            `UPDATE clover_prereset_pr_pv_policies
             SET status='approved',policy_version=?,numerator=?,denominator=?,rounding=?,
                 approved_by=?,approved_at=CURRENT_TIMESTAMP,operation_key=?,updated_at=CURRENT_TIMESTAMP
             WHERE campaign_key=? AND status='pending'`,
            [policyVersion,numerator,denominator,rounding,actor,operationKey,campaignKey]
        );
        await db.run(
            `INSERT INTO clover_prereset_launch_events
             (operation_key,campaign_key,event_type,actor_id,request_hash,payload_json)
             VALUES (?,?, 'policy_approve', ?, ?, ?)`,
            [operationKey,campaignKey,actor,hash({policyVersion,numerator,denominator,rounding}),
             JSON.stringify({policyVersion,numerator,denominator,rounding})]
        );
        const policy = await db.get('SELECT * FROM clover_prereset_pr_pv_policies WHERE campaign_key = ?', [campaignKey]);
        await db.exec('COMMIT');
        return { ok:true, duplicate:false, policy };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function prSnapshot(db, playerId) {
    const rows = await db.all(
        `SELECT id,amount,kind,source,week_key,reason,related_id,idempotency_key,created_by,created_at
         FROM clover_pr_ledger WHERE player_id=? ORDER BY id ASC`,
        [playerId]
    );
    return { balance:await getPrBalance(db, playerId), digest:hash(rows), entryCount:rows.length };
}

function calculatePv(balance, policy) {
    if (balance <= 0) return 0;
    const raw = (balance * Number(policy.numerator)) / Number(policy.denominator);
    return policy.rounding === 'ceil' ? Math.ceil(raw) : Math.floor(raw);
}

async function convertLegacyPrToPv(db, playerId, campaignKey, actor) {
    const existing = await db.get(
        'SELECT * FROM clover_prereset_pr_pv_claims WHERE campaign_key=? AND player_id=?',
        [campaignKey,playerId]
    );
    if (existing) return { ok:true, duplicate:true, claim:existing, pvBalance:await getPvBalance(db,playerId) };
    const policy = await db.get('SELECT * FROM clover_prereset_pr_pv_policies WHERE campaign_key=?', [campaignKey]);
    const source = await prSnapshot(db, playerId);
    if (source.balance > 0 && (!policy || policy.status !== 'approved')) {
        throw new PreResetLaunchError('pr_pv_policy_required', 'Existe PR legado e a taxa PR->PV ainda nao foi aprovada.', {
            playerId, sourcePrBalance:source.balance,
        });
    }
    const pvBefore = await getPvBalance(db, playerId);
    const calculatedPv = source.balance > 0 ? calculatePv(source.balance, policy) : 0;
    const operationKey = `pr-pv:${hash(`${campaignKey}:${playerId}`).slice(0,32)}`;
    await db.exec('BEGIN IMMEDIATE');
    try {
        const freshExisting = await db.get(
            'SELECT * FROM clover_prereset_pr_pv_claims WHERE campaign_key=? AND player_id=?',
            [campaignKey,playerId]
        );
        if (freshExisting) {
            await db.exec('COMMIT');
            return { ok:true, duplicate:true, claim:freshExisting, pvBalance:await getPvBalance(db,playerId) };
        }
        const fresh = await prSnapshot(db, playerId);
        if (fresh.digest !== source.digest || fresh.balance !== source.balance) {
            throw new PreResetLaunchError('legacy_pr_source_changed', 'O ledger PR mudou durante a conversao.');
        }
        let pvLedgerId = null;
        let prLedgerId = null;
        if (calculatedPv > 0) {
            const pv = await appendPvInTransaction(db, playerId, {
                amount:calculatedPv, entryKind:'migration', operationKey:`${operationKey}:pv`,
                source:'legacy_pr_conversion', reason:'Conversao final de PR legado para PV.',
                policyVersion:policy.policy_version, resetCycleKey:campaignKey, relatedId:source.digest,
                correlationId:operationKey, createdBy:actor,
                metadata:{ source_pr_balance:source.balance, source_pr_digest:source.digest },
            });
            pvLedgerId = pv.ledgerId;
        }
        if (source.balance > 0) {
            const pr = await mutatePrInTransaction(db, playerId, {
                amount:-source.balance, kind:'ajuste_admin', source:'ajuste_admin',
                reason:'Conversao final de PR legado para PV.', createdBy:actor,
                eventKey:DEFAULT_EVENT_KEY, idempotencyKey:`${operationKey}:pr`,
                relatedId:operationKey,
                metadata:{ converted_to_pv:calculatedPv, policy_version:policy.policy_version, source_pr_digest:source.digest },
            });
            prLedgerId = pr.ledgerId;
        }
        await db.run(
            `INSERT INTO clover_prereset_pr_pv_claims
             (campaign_key,player_id,policy_version,operation_key,source_pr_balance,source_pr_digest,
              pv_before,calculated_pv,pv_ledger_id,pr_ledger_id,metadata_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [campaignKey,playerId,policy?.policy_version || 'no-pr',operationKey,source.balance,source.digest,
             pvBefore,calculatedPv,pvLedgerId,prLedgerId,JSON.stringify({ source_entry_count:source.entryCount })]
        );
        const claim = await db.get(
            'SELECT * FROM clover_prereset_pr_pv_claims WHERE campaign_key=? AND player_id=?',
            [campaignKey,playerId]
        );
        await db.exec('COMMIT');
        return { ok:true, duplicate:false, claim, pvBalance:await getPvBalance(db,playerId) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

function boxTemplateKeys() {
    return [...new Set(Object.values(BOX_CATALOGS).map((entry) => String(entry.templateKey || '').trim()).filter(Boolean))];
}

async function registerBoxPreservations(db, campaignKey, playerId) {
    const keys = boxTemplateKeys();
    if (!keys.length) return [];
    const rows = await db.all(
        `SELECT * FROM clover_inventory_items
         WHERE player_id=? AND template_key IN (${keys.map(() => '?').join(',')})
         ORDER BY id`,
        [playerId,...keys]
    );
    for (const row of rows) {
        const snapshotJson = JSON.stringify(row);
        await db.run(
            `INSERT INTO clover_prereset_launch_inventory_preservations
             (campaign_key,player_id,inventory_item_id,template_key,snapshot_json,snapshot_hash,status)
             VALUES (?,?,?,?,?,?,'active')
             ON CONFLICT(campaign_key,player_id,inventory_item_id) DO UPDATE SET
               template_key=excluded.template_key,snapshot_json=excluded.snapshot_json,
               snapshot_hash=excluded.snapshot_hash,status='active',released_at=NULL`,
            [campaignKey,playerId,row.id,row.template_key,snapshotJson,hash(row)]
        );
    }
    return rows;
}

async function previewLaunchEconomy(db, request = {}) {
    const campaignKey = normalizeCampaignKey(request.campaignKey || DEFAULT_PRE_RESET_CAMPAIGN_KEY);
    const policy = await db.get('SELECT * FROM clover_prereset_pr_pv_policies WHERE campaign_key=?', [campaignKey]);
    const players = await db.all(
        `SELECT player_id,outcome,status FROM clover_prereset_launch_players WHERE campaign_key=? ORDER BY player_id`,
        [campaignKey]
    );
    const details = [];
    for (const player of players) {
        const pr = await prSnapshot(db, player.player_id);
        const pv = await getPvBalance(db, player.player_id);
        details.push({
            playerId:player.player_id, outcome:player.outcome, status:player.status,
            legacyPr:pr.balance, pv,
            conversionReady:pr.balance === 0 || policy?.status === 'approved',
            projectedPv:pr.balance > 0 && policy?.status === 'approved' ? pv + calculatePv(pr.balance,policy) : pv,
        });
    }
    return {
        campaignKey,
        policy:policy || { status:'pending' },
        blockedByConversionPolicy:details.some((row) => !row.conversionReady),
        players:details,
    };
}

async function applyLaunch(db, context = {}, request = {}, options = {}) {
    assertRealApplyEnabled(context);
    const actor = actorId(context);
    const campaignKey = normalizeCampaignKey(request.campaignKey || DEFAULT_PRE_RESET_CAMPAIGN_KEY);
    const operationKey = requiredOperationKey(request.operationKey);
    let roster = await db.get('SELECT * FROM clover_prereset_launch_rosters WHERE campaign_key=?', [campaignKey]);
    if (!roster || !['finalized','applying'].includes(roster.status)) {
        if (roster?.status === 'completed' && roster.apply_operation_key === operationKey) return { ok:true, duplicate:true, completed:true };
        throw new PreResetLaunchError('roster_not_finalized', 'Roster precisa estar finalizado.');
    }
    if (roster.apply_operation_key && roster.apply_operation_key !== operationKey) {
        throw new PreResetLaunchError('apply_operation_conflict', 'Outra operacao de launch ja assumiu este roster.');
    }
    if (roster.status === 'finalized') {
        await db.exec('BEGIN IMMEDIATE');
        try {
            await db.run(
                `UPDATE clover_prereset_launch_rosters
                 SET status='applying',apply_operation_key=?,updated_at=CURRENT_TIMESTAMP
                 WHERE campaign_key=? AND status='finalized'`,
                [operationKey,campaignKey]
            );
            await db.run(
                `INSERT INTO clover_prereset_launch_events
                 (operation_key,campaign_key,event_type,actor_id,request_hash,payload_json)
                 VALUES (?,?, 'apply_begin', ?, ?, ?)`,
                [`${operationKey}:begin`,campaignKey,actor,hash({campaignKey,operationKey}),JSON.stringify({ rosterRevision:roster.revision })]
            );
            await db.exec('COMMIT');
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => {});
            throw error;
        }
    }

    const players = await db.all(
        `SELECT * FROM clover_prereset_launch_players
         WHERE campaign_key=? AND status<>'completed' ORDER BY player_id`,
        [campaignKey]
    );
    let completedNow = 0;
    for (const player of players) {
        if (typeof options.beforePlayer === 'function') await options.beforePlayer(player, completedNow);
        try {
            const conversion = await convertLegacyPrToPv(db, player.player_id, campaignKey, actor);
            if (player.outcome === 'keep') {
                await db.run(
                    `UPDATE clover_prereset_launch_players
                     SET status='completed',economy_snapshot_json=?,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
                     WHERE campaign_key=? AND player_id=?`,
                    [JSON.stringify({ conversion }),campaignKey,player.player_id]
                );
            } else {
                const boxes = await registerBoxPreservations(db, campaignKey, player.player_id);
                const resetCode = player.reset_operation_code || `RS-F10-${hash(`${campaignKey}:${player.player_id}`).slice(0,16).toUpperCase()}`;
                await db.run(
                    `UPDATE clover_prereset_launch_players
                     SET status='applying',reset_operation_code=?,economy_snapshot_json=?,last_error_code=NULL,last_error_message=NULL,updated_at=CURRENT_TIMESTAMP
                     WHERE campaign_key=? AND player_id=?`,
                    [resetCode,JSON.stringify({ conversion, preservedBoxIds:boxes.map((row) => row.id) }),campaignKey,player.player_id]
                );
                const reset = await resetPlayer(db, {
                    playerId:player.player_id,
                    reason:`launch reset ${campaignKey}: fora da whitelist administrativa`,
                    actorId:actor,
                    operationCode:resetCode,
                });
                if (!reset.ok) throw new PreResetLaunchError(reset.code || 'launch_reset_failed', reset.error || 'Reset do launch falhou.', reset.details || {});
                await db.run(
                    `UPDATE clover_prereset_launch_players
                     SET status='completed',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
                     WHERE campaign_key=? AND player_id=?`,
                    [campaignKey,player.player_id]
                );
            }
            await db.run(
                `INSERT OR IGNORE INTO clover_prereset_launch_events
                 (operation_key,campaign_key,event_type,actor_id,request_hash,payload_json)
                 VALUES (?,?, 'player_complete', ?, ?, ?)`,
                [`${operationKey}:player:${hash(player.player_id).slice(0,20)}`,campaignKey,actor,
                 hash({playerId:player.player_id,outcome:player.outcome}),
                 JSON.stringify({playerId:player.player_id,outcome:player.outcome})]
            );
            completedNow += 1;
        } catch (error) {
            await db.run(
                `UPDATE clover_prereset_launch_players
                 SET status='blocked',last_error_code=?,last_error_message=?,updated_at=CURRENT_TIMESTAMP
                 WHERE campaign_key=? AND player_id=?`,
                [error?.code || 'launch_player_failed',String(error?.message || error),campaignKey,player.player_id]
            ).catch(() => {});
            throw new PreResetLaunchError('launch_interrupted', 'Launch interrompido e retomavel.', {
                playerId:player.player_id, causeCode:error?.code || null, causeMessage:error?.message || String(error),
                completedNow,
            });
        }
    }

    const remaining = await db.get(
        `SELECT COUNT(*) AS total FROM clover_prereset_launch_players
         WHERE campaign_key=? AND status<>'completed'`,
        [campaignKey]
    );
    if (Number(remaining?.total || 0) !== 0) throw new PreResetLaunchError('launch_incomplete', 'Ainda existem players nao concluidos.');
    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run(
            `UPDATE clover_prereset_launch_rosters SET status='completed',updated_at=CURRENT_TIMESTAMP
             WHERE campaign_key=? AND status='applying' AND apply_operation_key=?`,
            [campaignKey,operationKey]
        );
        await db.run(
            `INSERT OR IGNORE INTO clover_prereset_launch_events
             (operation_key,campaign_key,event_type,actor_id,request_hash,payload_json)
             VALUES (?,?, 'apply_complete', ?, ?, ?)`,
            [`${operationKey}:complete`,campaignKey,actor,hash({campaignKey,operationKey}),JSON.stringify({ completedNow })]
        );
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
    roster = await db.get('SELECT * FROM clover_prereset_launch_rosters WHERE campaign_key=?', [campaignKey]);
    return { ok:true, duplicate:false, completed:true, completedNow, roster };
}

module.exports = {
    PreResetLaunchError,
    applyLaunch,
    boxTemplateKeys,
    configurePrPvPolicy,
    convertLegacyPrToPv,
    eligiblePlayers,
    finalizeRoster,
    previewLaunchEconomy,
    previewRoster,
    registerBoxPreservations,
    replaceKeepRoster,
};
