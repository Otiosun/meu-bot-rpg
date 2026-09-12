'use strict';

const crypto = require('crypto');
const {
    MIN_CHARACTER_AGE,
    canonicalGender,
    isAppearanceDetailed,
} = require('../profileForms');
const {
    assertPreResetAdminCapability,
    assertPreResetAdminMutationAllowed,
} = require('./preResetAccessService');

class PreResetCharacterError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreResetCharacterError';
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

function text(value, label, options = {}) {
    const result = String(value ?? '').trim();
    if (options.required && !result) throw new PreResetCharacterError('invalid_draft', `${label} e obrigatorio.`);
    if (result.length > (options.limit || 1000)) throw new PreResetCharacterError('invalid_draft', `${label} excede o limite.`);
    return result || null;
}

function positiveRevision(value) {
    const revision = Number(value);
    if (!Number.isInteger(revision) || revision < 0) {
        throw new PreResetCharacterError('invalid_revision', 'Revisao invalida.');
    }
    return revision;
}

function normalizeTraitChoice(value, label) {
    if (value === undefined || value === null || value === '') return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new PreResetCharacterError('invalid_draft', `${label} invalido.`);
    }
    const key = text(value.key, `${label} key`, { limit:120 });
    const name = text(value.name, `${label} nome`, { limit:160 });
    const rarity = text(value.rarity, `${label} raridade`, { limit:40 });
    if (!key && !name) return null;
    return Object.freeze({ key, name, rarity });
}

function normalizeFutureTraits(value = {}) {
    if (value === undefined || value === null) value = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new PreResetCharacterError('invalid_draft', 'Tracos futuros invalidos.');
    }
    return Object.freeze({
        aptitude: normalizeTraitChoice(value.aptitude, 'Aptidao'),
        mark: normalizeTraitChoice(value.mark, 'Marca'),
        anomaly: normalizeTraitChoice(value.anomaly, 'Anomalia'),
    });
}

function normalizeFutureDraft(value = {}, options = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new PreResetCharacterError('invalid_draft', 'Rascunho invalido.');
    }
    const age = value.age === undefined || value.age === null || value.age === ''
        ? null
        : Number(value.age);
    if (age !== null && (!Number.isInteger(age) || age < MIN_CHARACTER_AGE || age > 1000)) {
        throw new PreResetCharacterError('invalid_draft', `Idade precisa ser inteira e ter no minimo ${MIN_CHARACTER_AGE}.`);
    }
    const gender = value.gender === undefined || value.gender === null || value.gender === ''
        ? null
        : canonicalGender(value.gender);
    if (value.gender && !gender) throw new PreResetCharacterError('invalid_draft', 'Genero invalido.');
    const entitlementKeys = value.entitlementKeys === undefined ? [] : value.entitlementKeys;
    if (!Array.isArray(entitlementKeys) || entitlementKeys.some((key) => !/^[a-z0-9][a-z0-9_.:-]{0,119}$/i.test(String(key)))) {
        throw new PreResetCharacterError('invalid_draft', 'Direitos futuros invalidos.');
    }
    const draft = {
        name: text(value.name, 'Nome', { limit: 120 }),
        age,
        gender,
        appearance: text(value.appearance, 'Aparencia', { limit: 2000 }),
        rollNumber: value.rollNumber === undefined || value.rollNumber === null || value.rollNumber === ''
            ? null : Number(value.rollNumber),
        familyKey: text(value.familyKey, 'Familia', { limit: 120 }),
        magicKey: text(value.magicKey, 'Magia', { limit: 120 }),
        ...(value.traits !== undefined ? { traits: normalizeFutureTraits(value.traits) } : {}),
        entitlementKeys: [...new Set(entitlementKeys.map((key) => String(key)))].sort(),
        notes: text(value.notes, 'Observacoes', { limit: 2000 }),
    };
    if (draft.rollNumber !== null && (!Number.isInteger(draft.rollNumber) || draft.rollNumber <= 0)) {
        throw new PreResetCharacterError('invalid_draft', 'Roll invalido.');
    }
    if (options.forSubmit) {
        if (!draft.name || draft.age === null || !draft.gender || !isAppearanceDetailed(draft.appearance)) {
            throw new PreResetCharacterError('draft_incomplete', 'O rascunho futuro ainda nao possui os campos minimos para envio.');
        }
    }
    return Object.freeze(draft);
}

function parseCharacter(row) {
    if (!row) return null;
    let draft = {};
    try { draft = JSON.parse(row.draft_json); } catch {}
    return {
        playerId: row.player_id,
        status: row.status,
        revision: Number(row.revision),
        draft,
        draftHash: row.draft_hash,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        submittedAt: row.submitted_at,
        approvedAt: row.approved_at,
        lockedAt: row.locked_at,
    };
}

async function getFutureCharacter(db, playerId) {
    return parseCharacter(await db.get('SELECT * FROM clover_prereset_characters WHERE player_id = ?', [String(playerId)]));
}

function requiredOperationKey(value) {
    const key = String(value || '').trim();
    if (!/^[a-zA-Z0-9_.:-]{8,160}$/.test(key)) {
        throw new PreResetCharacterError('invalid_operation_key', 'Chave de operacao invalida.');
    }
    return key;
}

async function assertPlayer(db, playerId) {
    const id = String(playerId || '').trim();
    const player = id && await db.get('SELECT id FROM jogadores WHERE id = ?', [id]);
    if (!player) throw new PreResetCharacterError('player_not_found', 'Player nao encontrado.');
    return id;
}

async function applyFutureCharacterMutation(db, playerId, actorId, request = {}) {
    const id = await assertPlayer(db, playerId);
    const actor = String(actorId || '').trim();
    if (!actor) throw new PreResetCharacterError('missing_actor', 'Autor da operacao obrigatorio.');
    const operationType = request.submit ? 'submit' : (request.operationType || 'update');
    if (!['create', 'update', 'submit'].includes(operationType)) {
        throw new PreResetCharacterError('invalid_operation', 'Operacao futura invalida.');
    }
    const operationKey = requiredOperationKey(request.operationKey);
    const expectedRevision = positiveRevision(request.expectedRevision);
    const draft = normalizeFutureDraft(request.draft, { forSubmit: operationType === 'submit' });
    const requestHash = hash({ operationType, expectedRevision, draft });

    await db.exec('BEGIN IMMEDIATE');
    try {
        const replay = await db.get(
            'SELECT * FROM clover_prereset_character_operations WHERE operation_key = ?',
            [operationKey]
        );
        if (replay) {
            if (replay.player_id !== id || replay.operation_type !== operationType || replay.request_hash !== requestHash) {
                throw new PreResetCharacterError('idempotency_conflict', 'Chave de operacao reutilizada com outro pedido.');
            }
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, character: await getFutureCharacter(db, id) };
        }
        const current = await db.get('SELECT * FROM clover_prereset_characters WHERE player_id = ?', [id]);
        if (!current) {
            if (operationType !== 'create' || expectedRevision !== 0) {
                throw new PreResetCharacterError('revision_conflict', 'O rascunho futuro ainda nao existe.');
            }
            await db.run(
                `INSERT INTO clover_prereset_characters
                 (player_id, status, revision, draft_json, draft_hash, created_by, updated_by, provenance_json)
                 VALUES (?, 'draft', 1, ?, ?, ?, ?, ?)`,
                [id, JSON.stringify(draft), hash(draft), actor, actor, JSON.stringify({ origin: 'prereset_character_service' })]
            );
            await db.run(
                `INSERT INTO clover_prereset_character_operations
                 (operation_key, player_id, operation_type, request_hash, character_revision)
                 VALUES (?, ?, ?, ?, 1)`,
                [operationKey, id, operationType, requestHash]
            );
        } else {
            if (Number(current.revision) !== expectedRevision) {
                throw new PreResetCharacterError('revision_conflict', 'O rascunho foi alterado por outra operacao.', {
                    expectedRevision,
                    currentRevision: Number(current.revision),
                });
            }
            if (current.status !== 'draft') {
                throw new PreResetCharacterError('character_not_editable', 'O rascunho futuro nao esta editavel.');
            }
            const nextRevision = Number(current.revision) + 1;
            const nextStatus = operationType === 'submit' ? 'submitted' : 'draft';
            await db.run(
                `UPDATE clover_prereset_characters
                 SET status = ?, revision = ?, draft_json = ?, draft_hash = ?, updated_by = ?,
                     updated_at = CURRENT_TIMESTAMP,
                     submitted_at = CASE WHEN ? = 'submitted' THEN CURRENT_TIMESTAMP ELSE submitted_at END
                 WHERE player_id = ? AND revision = ?`,
                [nextStatus, nextRevision, JSON.stringify(draft), hash(draft), actor, nextStatus, id, current.revision]
            );
            await db.run(
                `INSERT INTO clover_prereset_character_operations
                 (operation_key, player_id, operation_type, request_hash, character_revision)
                 VALUES (?, ?, ?, ?, ?)`,
                [operationKey, id, operationType, requestHash, nextRevision]
            );
        }
        const character = await getFutureCharacter(db, id);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, character };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

async function reviewFutureCharacter(db, context = {}, request = {}) {
    try {
        assertPreResetAdminMutationAllowed(context);
        assertPreResetAdminCapability(context, 'prereset.review');
    } catch (error) {
        throw new PreResetCharacterError(error.code || 'capability_denied', error.message);
    }
    const playerId = await assertPlayer(db, request.playerId);
    const actorId = String(context.actorId || '').trim();
    if (!actorId) throw new PreResetCharacterError('missing_actor', 'Revisor obrigatorio.');
    const action = String(request.action || '').trim();
    if (!['approve', 'lock'].includes(action)) throw new PreResetCharacterError('invalid_review_action', 'Acao de revisao invalida.');
    const reason = text(request.reason, 'Motivo', { required: true, limit: 500 });
    const operationKey = requiredOperationKey(request.operationKey);
    const expectedRevision = positiveRevision(request.expectedRevision);
    await db.exec('BEGIN IMMEDIATE');
    try {
        const replay = await db.get('SELECT * FROM clover_prereset_character_reviews WHERE operation_key = ?', [operationKey]);
        if (replay) {
            if (replay.player_id !== playerId || replay.action !== action) {
                throw new PreResetCharacterError('idempotency_conflict', 'Chave de revisao reutilizada.');
            }
            await db.exec('COMMIT');
            return { ok: true, duplicate: true, character: await getFutureCharacter(db, playerId) };
        }
        const current = await db.get('SELECT * FROM clover_prereset_characters WHERE player_id = ?', [playerId]);
        if (!current || Number(current.revision) !== expectedRevision) {
            throw new PreResetCharacterError('revision_conflict', 'A revisao nao corresponde ao rascunho atual.');
        }
        const expectedStatus = action === 'approve' ? 'submitted' : 'approved';
        if (current.status !== expectedStatus) {
            throw new PreResetCharacterError('invalid_review_transition', 'Transicao de revisao invalida.');
        }
        const nextRevision = Number(current.revision) + 1;
        const nextStatus = action === 'approve' ? 'approved' : 'locked';
        await db.run(
            `UPDATE clover_prereset_characters
             SET status = ?, revision = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP,
                 approved_at = CASE WHEN ? = 'approved' THEN CURRENT_TIMESTAMP ELSE approved_at END,
                 locked_at = CASE WHEN ? = 'locked' THEN CURRENT_TIMESTAMP ELSE locked_at END
             WHERE player_id = ? AND revision = ?`,
            [nextStatus, nextRevision, actorId, nextStatus, nextStatus, playerId, current.revision]
        );
        await db.run(
            `INSERT INTO clover_prereset_character_reviews
             (operation_key, player_id, previous_revision, resulting_revision, action, reason, reviewed_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [operationKey, playerId, current.revision, nextRevision, action, reason, actorId]
        );
        const character = await getFutureCharacter(db, playerId);
        await db.exec('COMMIT');
        return { ok: true, duplicate: false, character };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    PreResetCharacterError,
    applyFutureCharacterMutation,
    getFutureCharacter,
    hash,
    normalizeFutureDraft,
    normalizeFutureTraits,
    reviewFutureCharacter,
    stable,
};
