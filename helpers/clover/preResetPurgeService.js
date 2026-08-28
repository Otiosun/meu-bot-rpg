'use strict';

const crypto = require('crypto');
const {
    assertPreResetAdminCapability,
    assertPreResetAdminMutationAllowed,
} = require('./preResetAccessService');
const { getPreResetPurgeTombstone } = require('./preResetPurgeStateService');

class PreResetPurgeError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'PreResetPurgeError';
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

function requiredText(value, label, limit = 500) {
    const text = String(value || '').trim();
    if (!text) throw new PreResetPurgeError('missing_field', `${label} obrigatorio.`);
    if (text.length > limit) throw new PreResetPurgeError('invalid_field', `${label} excede o limite.`);
    return text;
}

function requiredOperationKey(value) {
    const key = String(value || '').trim();
    if (!/^[a-zA-Z0-9_.:-]{8,180}$/.test(key)) {
        throw new PreResetPurgeError('invalid_operation_key', 'Chave de operacao invalida.');
    }
    return key;
}

function assertReadCapability(context = {}) {
    try {
        assertPreResetAdminCapability(context, 'player.manage');
    } catch (error) {
        throw new PreResetPurgeError(error.code || 'capability_denied', error.message);
    }
}

function assertExecuteCapability(context = {}) {
    try {
        assertPreResetAdminMutationAllowed(context);
        assertPreResetAdminCapability(context, 'player.manage');
        assertPreResetAdminCapability(context, 'operation.apply');
    } catch (error) {
        throw new PreResetPurgeError(error.code || 'capability_denied', error.message);
    }
}

async function requirePlayer(db, playerId) {
    const id = String(playerId || '').trim();
    const player = id && await db.get('SELECT * FROM jogadores WHERE id = ?', [id]);
    if (!player) throw new PreResetPurgeError('player_not_found', 'Player nao encontrado.');
    return player;
}

function currentCharacterSnapshot(player) {
    return Object.freeze({
        playerId: player.id,
        fichaStatus: player.ficha_status || null,
        jogoStatus: player.jogo_status || null,
        name: player.personagem_nome || null,
        age: player.personagem_idade ?? null,
        gender: player.personagem_genero || null,
        appearance: player.personagem_aparencia || null,
        appearanceStatus: player.personagem_aparencia_status || null,
        kingdom: player.reino || null,
        socialClass: player.classe || null,
        race: player.raca || null,
        grimoire: player.grimorio || null,
        family: player.familia || null,
        familyKey: player.familia_key || null,
        magic: player.magia || null,
        magicKey: player.magia_key || null,
        selectedRoll: player.numero_roll_escolhido ?? null,
    });
}

async function buildPurgeSnapshot(db, player) {
    const future = await db.get(
        'SELECT * FROM clover_prereset_characters WHERE player_id = ?',
        [player.id]
    ).catch(() => undefined);
    const decision = await db.get(
        'SELECT * FROM clover_prereset_transition_decisions WHERE player_id = ?',
        [player.id]
    ).catch(() => undefined);
    const rollCount = await db.get(
        'SELECT COUNT(*) AS total FROM player_rolls WHERE player_id = ?',
        [player.id]
    ).catch(() => ({ total: 0 }));
    return Object.freeze({
        version: 1,
        current: currentCharacterSnapshot(player),
        futureCharacterEvidence: future || null,
        transitionEvidence: decision || null,
        historicalRollCount: Number(rollCount?.total || 0),
    });
}

async function previewPreResetPurge(db, context = {}, request = {}) {
    assertReadCapability(context);
    const player = await requirePlayer(db, request.playerId);
    const tombstone = await getPreResetPurgeTombstone(db, player.id);
    const snapshot = await buildPurgeSnapshot(db, player);
    return Object.freeze({
        ok: true,
        playerId: player.id,
        alreadyPurged: Boolean(tombstone),
        confirmationRequired: `PURGE ${player.id}`,
        snapshot,
        snapshotHash: hash(snapshot),
        tombstone,
    });
}

async function executePreResetPurge(db, context = {}, request = {}) {
    assertExecuteCapability(context);
    const player = await requirePlayer(db, request.playerId);
    const actorId = requiredText(context.actorId, 'Autor', 180);
    const reason = requiredText(request.reason, 'Motivo', 500);
    const operationKey = requiredOperationKey(request.operationKey);
    const expectedConfirmation = `PURGE ${player.id}`;
    const confirmation = String(request.confirmation || '').trim();
    if (confirmation !== expectedConfirmation) {
        throw new PreResetPurgeError('confirmation_mismatch', `Confirmacao exata exigida: ${expectedConfirmation}`);
    }
    const requestHash = hash({ playerId: player.id, reason, confirmation: expectedConfirmation });

    await db.exec('BEGIN IMMEDIATE');
    try {
        const operationReplay = await db.get(
            'SELECT * FROM clover_prereset_purge_tombstones WHERE operation_key = ?',
            [operationKey]
        );
        if (operationReplay) {
            if (operationReplay.player_id !== player.id || operationReplay.request_hash !== requestHash) {
                throw new PreResetPurgeError('idempotency_conflict', 'Chave de purge reutilizada com outro pedido.');
            }
            await db.exec('COMMIT');
            return Object.freeze({ ok: true, duplicate: true, tombstone: await getPreResetPurgeTombstone(db, player.id) });
        }
        const existing = await db.get(
            'SELECT * FROM clover_prereset_purge_tombstones WHERE player_id = ?',
            [player.id]
        );
        if (existing) {
            throw new PreResetPurgeError('player_already_purged', 'Player ja possui tombstone definitivo de purge.');
        }

        const snapshot = await buildPurgeSnapshot(db, player);
        const snapshotHash = hash(snapshot);
        await db.run(
            `UPDATE jogadores
             SET ficha_status = 'incompleta',
                 jogo_status = 'bloqueado',
                 personagem_nome = '-',
                 personagem_idade = NULL,
                 personagem_genero = '-',
                 personagem_aparencia = '-',
                 personagem_aparencia_normalizada = NULL,
                 personagem_aparencia_status = 'pending',
                 personagem_aparencia_motivo = 'purge_pre_reset',
                 personagem_aparencia_image_path = NULL,
                 personagem_aparencia_image_message_id = NULL,
                 personagem_aparencia_approved_by = NULL,
                 personagem_aparencia_approved_at = NULL,
                 personagem_aparencia_updated_at = CURRENT_TIMESTAMP,
                 numero_roll_escolhido = NULL,
                 reino = '-',
                 classe = '-',
                 raca = '-',
                 grimorio = '-',
                 familia = '-',
                 familia_key = NULL,
                 magia = '-',
                 magia_key = NULL,
                 aptidao_comum = '-',
                 aptidao_comum_key = NULL,
                 marca_comum = '-',
                 marca_comum_key = NULL,
                 aptidao_rara = '-',
                 aptidao_rara_key = NULL,
                 marca_rara = '-',
                 marca_rara_key = NULL,
                 anomalia = '-',
                 anomalia_key = NULL
             WHERE id = ?`,
            [player.id]
        );
        await db.run(
            `INSERT INTO clover_prereset_purge_tombstones
             (player_id, operation_key, actor_id, reason, request_hash, confirmation_hash, snapshot_json, snapshot_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                player.id,
                operationKey,
                actorId,
                reason,
                requestHash,
                hash(expectedConfirmation),
                JSON.stringify(snapshot),
                snapshotHash,
            ]
        );
        await db.exec('COMMIT');
        return Object.freeze({ ok: true, duplicate: false, tombstone: await getPreResetPurgeTombstone(db, player.id) });
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }
}

module.exports = {
    PreResetPurgeError,
    buildPurgeSnapshot,
    executePreResetPurge,
    hash,
    previewPreResetPurge,
    stable,
};
