'use strict';

const crypto = require('crypto');
const { normalizeFutureDraft, hash: hashDraft } = require('./preResetCharacterService');
const { isPreResetLaunchEnabled } = require('./preResetAccessService');

class PreResetTransitionError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreResetTransitionError';
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

function canonical(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function present(value) {
    const text = String(value ?? '').trim();
    return text && text !== '-' ? text : null;
}

function envEnabled(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function isPreResetTransitionEnabled(env = process.env) {
    return isPreResetLaunchEnabled(env) && envEnabled(env.PRE_RESET_RETURN_ENABLED);
}

function isApprovedLegacyCharacter(player) {
    return canonical(player?.ficha_status) === 'aprovada';
}

function isApprovedAppearance(player) {
    return ['approved', 'aprovada'].includes(canonical(player?.personagem_aparencia_status));
}

function assertTransitionLaunchEnabled(env = process.env) {
    if (!isPreResetTransitionEnabled(env)) {
        throw new PreResetTransitionError('prereset_transition_disabled', 'A transicao pre-reset esta desativada.');
    }
    return true;
}

async function getTransitionDecision(db, playerId) {
    const row = await db.get(
        `SELECT player_id, status, revision, baseline_json, baseline_hash,
                decided_by, decision_source, decision_at, created_at, updated_at
         FROM clover_prereset_transition_decisions
         WHERE player_id = ?`,
        [String(playerId)]
    );
    if (!row) return null;
    let baseline = null;
    try { baseline = row.baseline_json ? JSON.parse(row.baseline_json) : null; } catch {}
    return Object.freeze({
        playerId: row.player_id,
        status: row.status,
        revision: Number(row.revision || 0),
        baseline,
        baselineHash: row.baseline_hash || null,
        decidedBy: row.decided_by || null,
        decisionSource: row.decision_source || null,
        decisionAt: row.decision_at || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
    });
}

function rollMatchesApprovedPlayer(player, roll) {
    const pairs = [
        [player?.reino, roll?.kingdom],
        [player?.classe, roll?.social_class],
        [player?.raca, roll?.race],
        [player?.grimorio, roll?.grimoire],
    ];
    const comparable = pairs.filter(([left]) => present(left));
    if (comparable.length < 4) return false;
    return comparable.every(([left, right]) => canonical(left) === canonical(right));
}

async function resolveApprovedRollBaseline(db, player) {
    const rolls = await db.all(
        'SELECT * FROM player_rolls WHERE player_id = ? ORDER BY roll_number ASC',
        [player.id]
    );
    const matches = rolls.filter((roll) => rollMatchesApprovedPlayer(player, roll));
    if (matches.length !== 1) {
        throw new PreResetTransitionError(
            'keep_baseline_roll_ambiguous',
            'Nao foi possivel provar com seguranca qual roll originou a ficha aprovada.',
            { playerId: player.id, rollCount: rolls.length, matchCount: matches.length }
        );
    }
    return matches[0];
}

function buildRollEvidence(roll) {
    return Object.freeze({
        rollNumber: Number(roll.roll_number),
        kingdom: roll.kingdom || null,
        kingdomKey: roll.kingdom_key || null,
        socialClass: roll.social_class || null,
        socialClassKey: roll.social_class_key || null,
        race: roll.race || null,
        raceKey: roll.race_key || null,
        grimoire: roll.grimoire || null,
        grimoireKey: roll.grimoire_key || null,
        grimoireRank: roll.grimoire_rank || null,
        magicRarity: roll.magic_rarity || null,
        magicRarityKey: roll.magic_rarity_key || null,
        rollVersion: roll.roll_version || null,
        rollPayload: roll.roll_payload || null,
    });
}

async function buildKeepBaseline(db, playerId) {
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [String(playerId)]);
    if (!player) throw new PreResetTransitionError('player_not_found', 'Player nao encontrado.');
    if (!isApprovedLegacyCharacter(player)) {
        throw new PreResetTransitionError('legacy_character_not_approved', 'Nao existe personagem antigo aprovado para manter.');
    }
    if (!isApprovedAppearance(player) || !present(player.personagem_aparencia)) {
        throw new PreResetTransitionError('keep_baseline_appearance_not_approved', 'A aparencia atual precisa estar aprovada antes de MANTER.');
    }
    if (!present(player.personagem_nome) || !Number.isInteger(Number(player.personagem_idade)) || !present(player.personagem_genero)) {
        throw new PreResetTransitionError('keep_baseline_character_incomplete', 'A ficha aprovada esta incompleta para congelamento seguro.');
    }

    const roll = await resolveApprovedRollBaseline(db, player);
    const baseline = Object.freeze({
        version: 1,
        source: 'approved_legacy_reconstruction',
        playerId: player.id,
        character: Object.freeze({
            name: player.personagem_nome,
            age: Number(player.personagem_idade),
            gender: player.personagem_genero,
            appearance: player.personagem_aparencia,
            familyKey: player.familia_key || null,
            magicKey: player.magia_key || null,
            familyLabel: present(player.familia),
            magicLabel: present(player.magia),
            traits: Object.freeze({
                commonAptitude: present(player.aptidao_comum),
                commonAptitudeKey: player.aptidao_comum_key || null,
                commonMark: present(player.marca_comum),
                commonMarkKey: player.marca_comum_key || null,
                rareAptitude: present(player.aptidao_rara),
                rareAptitudeKey: player.aptidao_rara_key || null,
                rareMark: present(player.marca_rara),
                rareMarkKey: player.marca_rara_key || null,
                anomaly: present(player.anomalia),
                anomalyKey: player.anomalia_key || null,
            }),
        }),
        roll: buildRollEvidence(roll),
        approval: Object.freeze({
            fichaStatus: player.ficha_status,
            appearanceStatus: player.personagem_aparencia_status,
            appearanceApprovedBy: player.personagem_aparencia_approved_by || null,
            appearanceApprovedAt: player.personagem_aparencia_approved_at || null,
        }),
    });
    return Object.freeze({ baseline, baselineHash: hash(baseline) });
}

function normalizeDecision(value) {
    const decision = canonical(value).replace(/\s+/g, '_');
    if (['manter', 'keep'].includes(decision)) return 'keep';
    if (['resetar', 'reset'].includes(decision)) return 'reset';
    if (decision === 'auto_reset') return 'auto_reset';
    throw new PreResetTransitionError('invalid_transition_decision', 'Decisao invalida.');
}

function requiredOperationKey(value) {
    const key = String(value || '').trim();
    if (!/^[a-zA-Z0-9_.:-]{8,180}$/.test(key)) {
        throw new PreResetTransitionError('invalid_operation_key', 'Chave de operacao invalida.');
    }
    return key;
}

async function ensurePendingDecisionRow(db, playerId) {
    await db.run(
        `INSERT OR IGNORE INTO clover_prereset_transition_decisions
         (player_id, status, revision)
         VALUES (?, 'pending', 0)`,
        [playerId]
    );
}

async function lockFutureCharacterFromKeep(db, player, baseline, baselineHash, actorId, operationKey) {
    const existing = await db.get('SELECT * FROM clover_prereset_characters WHERE player_id = ?', [player.id]);
    if (existing) {
        let provenance = {};
        try { provenance = JSON.parse(existing.provenance_json || '{}'); } catch {}
        if (existing.status === 'locked' && provenance.baselineHash === baselineHash) return;
        throw new PreResetTransitionError(
            'future_character_conflict',
            'Ja existe personagem futuro incompativel com a decisao MANTER.',
            { status: existing.status }
        );
    }

    const draft = normalizeFutureDraft({
        name: baseline.character.name,
        age: baseline.character.age,
        gender: baseline.character.gender,
        appearance: baseline.character.appearance,
        rollNumber: baseline.roll.rollNumber,
        familyKey: baseline.character.familyKey,
        magicKey: baseline.character.magicKey,
        entitlementKeys: [],
        notes: null,
    }, { forSubmit: true });

    await db.run(
        `INSERT INTO clover_prereset_characters
         (player_id, status, revision, draft_json, draft_hash, created_by, updated_by,
          provenance_json, submitted_at, approved_at, locked_at)
         VALUES (?, 'locked', 1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
            player.id,
            JSON.stringify(draft),
            hashDraft(draft),
            actorId,
            actorId,
            JSON.stringify({
                origin: 'prereset_keep_baseline',
                baselineHash,
                transitionOperationKey: operationKey,
            }),
        ]
    );
}

async function decideTransition(db, playerId, actorId, request = {}) {
    const id = String(playerId || '').trim();
    const actor = String(actorId || '').trim();
    if (!id) throw new PreResetTransitionError('player_not_found', 'Player invalido.');
    if (!actor) throw new PreResetTransitionError('missing_actor', 'Autor da decisao obrigatorio.');
    const decision = normalizeDecision(request.decision);
    if (decision === 'auto_reset' && request.allowAutoReset !== true) {
        throw new PreResetTransitionError('auto_reset_requires_system_path', 'AUTO_RESET exige o fluxo de deadline.');
    }
    const operationKey = requiredOperationKey(request.operationKey);
    const decisionSource = String(request.source || (decision === 'auto_reset' ? 'deadline' : 'player')).trim() || 'player';

    await db.exec('BEGIN IMMEDIATE');
    try {
        const replay = await db.get(
            'SELECT * FROM clover_prereset_transition_operations WHERE operation_key = ?',
            [operationKey]
        );
        if (replay) {
            if (replay.player_id !== id || replay.operation_type !== decision) {
                throw new PreResetTransitionError('idempotency_conflict', 'Chave de decisao reutilizada com outro pedido.');
            }
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, decision: await getTransitionDecision(db, id) };
        }

        const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [id]);
        if (!player) throw new PreResetTransitionError('player_not_found', 'Player nao encontrado.');
        if (!isApprovedLegacyCharacter(player)) {
            throw new PreResetTransitionError('no_legacy_character', 'Este player nao possui personagem antigo aprovado para decidir.');
        }

        let keep = null;
        if (decision === 'keep') keep = await buildKeepBaseline(db, id);
        const requestHash = hash({ decision, decisionSource, baselineHash: keep?.baselineHash || null });

        await ensurePendingDecisionRow(db, id);
        const current = await db.get('SELECT * FROM clover_prereset_transition_decisions WHERE player_id = ?', [id]);
        if (current.status !== 'pending') {
            throw new PreResetTransitionError('transition_decision_irreversible', 'A decisao de retorno ja foi registrada e e irreversivel.', {
                currentStatus: current.status,
            });
        }

        if (decision === 'keep') {
            await lockFutureCharacterFromKeep(db, player, keep.baseline, keep.baselineHash, actor, operationKey);
        }

        const nextRevision = Number(current.revision || 0) + 1;
        const update = await db.run(
            `UPDATE clover_prereset_transition_decisions
             SET status = ?, revision = ?, baseline_json = ?, baseline_hash = ?,
                 decided_by = ?, decision_source = ?, decision_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE player_id = ? AND status = 'pending' AND revision = ?`,
            [
                decision,
                nextRevision,
                keep ? JSON.stringify(keep.baseline) : null,
                keep?.baselineHash || null,
                actor,
                decisionSource,
                id,
                current.revision,
            ]
        );
        if (update.changes !== 1) {
            throw new PreResetTransitionError('transition_revision_conflict', 'A decisao mudou durante a operacao.');
        }
        await db.run(
            `INSERT INTO clover_prereset_transition_operations
             (operation_key, player_id, operation_type, request_hash, resulting_status,
              resulting_revision, actor_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [operationKey, id, decision, requestHash, decision, nextRevision, actor]
        );
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, decision: await getTransitionDecision(db, id) };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function getTransitionState(db, playerId) {
    const id = String(playerId || '').trim();
    const player = id ? await db.get('SELECT * FROM jogadores WHERE id = ?', [id]) : null;
    if (!player) return Object.freeze({ kind: 'new_player', player: null, decision: null });
    const decision = await getTransitionDecision(db, id);
    if (!isApprovedLegacyCharacter(player)) {
        return Object.freeze({ kind: 'new_player', player, decision });
    }
    if (!decision || decision.status === 'pending') {
        return Object.freeze({ kind: 'decision_pending', player, decision });
    }
    return Object.freeze({ kind: 'decided', player, decision });
}

async function applyAutoResetToUndecided(db, actorId = 'system:prereset-deadline') {
    const players = await db.all(
        `SELECT p.id
         FROM jogadores p
         LEFT JOIN clover_prereset_transition_decisions d ON d.player_id = p.id
         WHERE p.ficha_status = 'aprovada'
           AND (d.player_id IS NULL OR d.status = 'pending')
         ORDER BY p.id ASC`
    );
    const results = [];
    for (const player of players) {
        const operationKey = `prereset:auto_reset:${hash(player.id).slice(0, 24)}`;
        results.push(await decideTransition(db, player.id, actorId, {
            decision: 'auto_reset',
            operationKey,
            source: 'deadline',
            allowAutoReset: true,
        }));
    }
    return Object.freeze({ ok: true, total: results.length, results: Object.freeze(results) });
}

async function getTransitionDashboard(db) {
    const legacy = await db.get("SELECT COUNT(*) AS total FROM jogadores WHERE ficha_status = 'aprovada'");
    const explicit = await db.all(
        `SELECT status, COUNT(*) AS total
         FROM clover_prereset_transition_decisions
         GROUP BY status`
    );
    const characters = await db.all(
        `SELECT status, COUNT(*) AS total
         FROM clover_prereset_characters
         GROUP BY status`
    );
    const byDecision = Object.fromEntries(explicit.map((row) => [row.status, Number(row.total || 0)]));
    const explicitTotal = Object.values(byDecision).reduce((sum, value) => sum + value, 0);
    const implicitPending = Math.max(0, Number(legacy?.total || 0) - explicitTotal);
    const byCharacter = Object.fromEntries(characters.map((row) => [row.status, Number(row.total || 0)]));
    return Object.freeze({
        legacyTotal: Number(legacy?.total || 0),
        decision: Object.freeze({
            pending: implicitPending + Number(byDecision.pending || 0),
            keep: Number(byDecision.keep || 0),
            reset: Number(byDecision.reset || 0),
            autoReset: Number(byDecision.auto_reset || 0),
        }),
        futureCharacter: Object.freeze({
            draft: Number(byCharacter.draft || 0),
            submitted: Number(byCharacter.submitted || 0),
            approved: Number(byCharacter.approved || 0),
            locked: Number(byCharacter.locked || 0),
        }),
    });
}

module.exports = {
    PreResetTransitionError,
    applyAutoResetToUndecided,
    assertTransitionLaunchEnabled,
    buildKeepBaseline,
    decideTransition,
    getTransitionDashboard,
    getTransitionDecision,
    getTransitionState,
    hash,
    isApprovedLegacyCharacter,
    isPreResetTransitionEnabled,
    resolveApprovedRollBaseline,
};
