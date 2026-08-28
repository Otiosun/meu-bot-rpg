'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const { createPreResetPolicyRegistry } = require('../helpers/clover/preResetPolicyRegistryService');
const {
    applyFutureCharacterMutation,
    reviewFutureCharacter,
} = require('../helpers/clover/preResetCharacterService');
const {
    decideTransition,
    getTransitionDecision,
    getTransitionState,
} = require('../helpers/clover/preResetTransitionService');
const {
    configurePreResetCampaign,
    getPreResetCampaignState,
} = require('../helpers/clover/preResetCampaignStateService');
const { closePreResetCampaign } = require('../helpers/clover/preResetCampaignCloseService');
const {
    getPreResetPlayerDetail,
    searchPreResetPlayers,
} = require('../helpers/clover/preResetAdminService');
const {
    executePreResetPurge,
    previewPreResetPurge,
} = require('../helpers/clover/preResetPurgeService');
const { handlePreResetTransitionAdminHttp } = require('../helpers/clover/preResetTransitionAdminHttp');

function policyRegistry() {
    return createPreResetPolicyRegistry({ testOnly: true, policies: {
        PRE_RESET_MODE: { status: 'ENABLED', policyVersion: 'f6-f9-mode-v1' },
        SESSION_ELIGIBILITY: { status: 'ENABLED', policyVersion: 'f6-f9-session-v1', eligibleReleasedSessions: true },
    } });
}

function adminContext(overrides = {}) {
    return {
        actorId: 'admin-fixture',
        env: { PRE_RESET_LAUNCH_ENABLED: 'true', PRE_RESET_RETURN_ENABLED: 'true' },
        policyRegistry: policyRegistry(),
        capabilities: ['prereset.review', 'player.manage', 'operation.apply'],
        ...overrides,
    };
}

function temporaryFilename() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-f6-f9-'));
    return path.join(dir, 'database.sqlite');
}

async function openFixture(t) {
    const filename = temporaryFilename();
    const db = await database.criarBanco({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });
    return db;
}

async function insertApprovedPlayer(db, id, name = 'Aster') {
    await db.run(
        `INSERT INTO jogadores (
            id, nome, ficha_status, jogo_status, personagem_nome, personagem_idade, personagem_genero,
            personagem_aparencia, personagem_aparencia_status, personagem_aparencia_approved_by,
            personagem_aparencia_approved_at, reino, classe, raca, grimorio, familia, familia_key,
            magia, magia_key, numero_roll_escolhido
        ) VALUES (?, ?, 'aprovada', 'liberado', ?, 19, 'Masculino', ?, 'approved', 'admin-old', ?,
                  'Clover', 'Nobre', 'Humano', 'Tres Folhas', 'Silva', 'silva', 'Vento', 'vento', 1)`,
        [id, `Player ${id}`, name, `Aparencia atual de ${name}.`, '2026-08-20T12:00:00.000Z']
    );
    await db.run(
        `INSERT INTO player_rolls (
            player_id, roll_number, kingdom, kingdom_key, social_class, social_class_key,
            race, race_key, grimoire, grimoire_key, grimoire_rank, magic_rarity,
            magic_rarity_key, roll_version, roll_payload
        ) VALUES (?, 1, 'Clover', 'clover', 'Nobre', 'nobre', 'Humano', 'humano',
                  'Tres Folhas', 'tres_folhas', 'comum', 'comum', 'comum', 'f6-f9-v1', '{}')`,
        [id]
    );
}

function validFutureDraft(name = 'Aster Futuro') {
    return {
        name,
        age: 20,
        gender: 'Masculino',
        appearance: `Aparencia futura isolada de ${name}.`,
        rollNumber: 1,
        familyKey: 'silva',
        magicKey: 'vento',
        entitlementKeys: [],
        notes: null,
    };
}

test('F6: current e future ficam isolados e review usa revisao otimista', async (t) => {
    const db = await openFixture(t);
    await insertApprovedPlayer(db, 'f6-player', 'Atual F6');
    const before = await db.get(
        'SELECT personagem_nome, personagem_aparencia, ficha_status, jogo_status FROM jogadores WHERE id = ?',
        ['f6-player']
    );
    const created = await applyFutureCharacterMutation(db, 'f6-player', 'f6-player', {
        operationType: 'create', expectedRevision: 0, operationKey: 'f6:create:0001', draft: validFutureDraft(),
    });
    assert.equal(created.character.status, 'draft');
    const submitted = await applyFutureCharacterMutation(db, 'f6-player', 'f6-player', {
        submit: true, expectedRevision: 1, operationKey: 'f6:submit:0001', draft: validFutureDraft(),
    });
    assert.equal(submitted.character.status, 'submitted');
    const approved = await reviewFutureCharacter(db, adminContext(), {
        playerId: 'f6-player', expectedRevision: 2, action: 'approve', reason: 'F6 fixture review', operationKey: 'f6:review:0001',
    });
    assert.equal(approved.character.status, 'approved');
    await assert.rejects(
        reviewFutureCharacter(db, adminContext(), {
            playerId: 'f6-player', expectedRevision: 2, action: 'reject', reason: 'stale', operationKey: 'f6:review:stale:0001',
        }),
        (error) => error?.code === 'revision_conflict'
    );
    assert.deepEqual(await db.get(
        'SELECT personagem_nome, personagem_aparencia, ficha_status, jogo_status FROM jogadores WHERE id = ?',
        ['f6-player']
    ), before);
    const detail = await getPreResetPlayerDetail(db, 'f6-player');
    assert.equal(detail.current.name, 'Atual F6');
    assert.equal(detail.future.draft.name, 'Aster Futuro');
    assert.notEqual(detail.current.appearance, detail.future.draft.appearance);
    assert.equal(detail.audit.characterReviews.length, 1);
});

test('F7: deadline bloqueia novas escolhas e fechamento e retomavel/idempotente com AUTO_RESET', async (t) => {
    const db = await openFixture(t);
    await insertApprovedPlayer(db, 'f7-explicit');
    await insertApprovedPlayer(db, 'f7-auto-a');
    await insertApprovedPlayer(db, 'f7-auto-b');
    const ctx = adminContext();
    const deadline = '2026-08-28T00:00:00.000Z';
    await configurePreResetCampaign(db, ctx, {
        deadlineAt: deadline, now: '2026-08-27T22:00:00.000Z', operationKey: 'f7:campaign:configure:0001',
    });
    const explicit = await decideTransition(db, 'f7-explicit', 'f7-explicit', {
        decision: 'reset', source: 'player', operationKey: 'f7:explicit:0001', now: '2026-08-27T23:00:00.000Z',
    });
    assert.equal(explicit.decision.status, 'reset');
    await assert.rejects(
        decideTransition(db, 'f7-auto-a', 'f7-auto-a', {
            decision: 'reset', source: 'player', operationKey: 'f7:late:0001', now: deadline,
        }),
        (error) => error?.code === 'decision_window_closed'
    );
    await assert.rejects(
        closePreResetCampaign(db, adminContext({ env: {} }), {
            operationKey: 'f7:close:off:0001', now: '2026-08-28T00:01:00.000Z',
        }),
        (error) => error?.code === 'prereset_mode_disabled' || error?.code === 'prereset_transition_disabled'
    );
    await assert.rejects(
        closePreResetCampaign(db, ctx, {
            operationKey: 'f7:close:0001', now: '2026-08-28T00:01:00.000Z',
        }, {
            beforePlayer: async (_player, index) => {
                if (index === 1) throw new Error('fixture interruption');
            },
        }),
        (error) => error?.code === 'campaign_close_interrupted' && error?.details?.processedTotal === 1
    );
    const state = await getPreResetCampaignState(db, { now: '2026-08-28T00:02:00.000Z' });
    assert.equal(state.campaign.status, 'closing');
    const resumed = await closePreResetCampaign(db, ctx, {
        operationKey: 'f7:close:0001', now: '2026-08-28T00:03:00.000Z',
    });
    assert.equal(resumed.campaign.status, 'closed');
    assert.equal((await getTransitionDecision(db, 'f7-auto-a')).status, 'auto_reset');
    assert.equal((await getTransitionDecision(db, 'f7-auto-b')).status, 'auto_reset');
    const repeated = await closePreResetCampaign(db, ctx, {
        operationKey: 'f7:close:0001', now: '2026-08-28T00:04:00.000Z',
    });
    assert.equal(repeated.duplicate, true);
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM clover_prereset_transition_operations WHERE operation_type='auto_reset'")).total, 2);
});

test('F8: modulo ADM busca/detalha current-vs-future e HTTP falha fechado sem capability', async (t) => {
    const db = await openFixture(t);
    await insertApprovedPlayer(db, 'f8-player', 'Atual F8');
    await applyFutureCharacterMutation(db, 'f8-player', 'f8-player', {
        operationType: 'create', expectedRevision: 0, operationKey: 'f8:create:0001', draft: validFutureDraft('Futuro F8'),
    });
    const rows = await searchPreResetPlayers(db, 'f8-player');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].current.characterName, 'Atual F8');
    assert.equal(rows[0].future.status, 'draft');
    const detail = await getPreResetPlayerDetail(db, 'f8-player');
    assert.equal(detail.current.name, 'Atual F8');
    assert.equal(detail.future.draft.name, 'Futuro F8');

    const response = {
        headers: {},
        setHeader(key, value) { this.headers[key] = value; },
        end(body = '') { this.body = body; },
    };
    const handled = await handlePreResetTransitionAdminHttp({
        method: 'GET', url: '/pre-reset/admin/players?query=f8', headers: { authorization: 'Bearer fixture' },
    }, response, {
        getDb: () => db,
        authenticateSiteSession: async () => ({ ok: true, player: { id: 'staff-f8' } }),
        getIntegratedAccessContext: async () => ({ owner: false, assignments: [] }),
    });
    assert.equal(handled, true);
    assert.equal(response.statusCode, 403);
    assert.equal(JSON.parse(response.body).error, 'capability_denied');
});

test('F9: purge e manual, exige confirmacao forte, e cria tombstone que bloqueia ressuscitar estado', async (t) => {
    const db = await openFixture(t);
    await insertApprovedPlayer(db, 'f9-player', 'Atual F9');
    const ctx = adminContext();
    const preview = await previewPreResetPurge(db, ctx, { playerId: 'f9-player' });
    assert.equal(preview.confirmationRequired, 'PURGE f9-player');
    await assert.rejects(
        executePreResetPurge(db, ctx, {
            playerId: 'f9-player', confirmation: 'PURGE errado', reason: 'fixture', operationKey: 'f9:purge:wrong:0001',
        }),
        (error) => error?.code === 'confirmation_mismatch'
    );
    assert.equal((await db.get('SELECT ficha_status FROM jogadores WHERE id = ?', ['f9-player'])).ficha_status, 'aprovada');
    const purged = await executePreResetPurge(db, ctx, {
        playerId: 'f9-player', confirmation: 'PURGE f9-player', reason: 'Purge manual F9 fixture', operationKey: 'f9:purge:0001',
    });
    assert.equal(purged.duplicate, false);
    const active = await db.get('SELECT ficha_status, jogo_status, personagem_nome, numero_roll_escolhido FROM jogadores WHERE id = ?', ['f9-player']);
    assert.deepEqual(active, { ficha_status: 'incompleta', jogo_status: 'bloqueado', personagem_nome: '-', numero_roll_escolhido: null });
    assert.equal((await getTransitionState(db, 'f9-player')).kind, 'purged');
    assert.equal((await getPreResetPlayerDetail(db, 'f9-player')).future, null);
    const replay = await executePreResetPurge(db, ctx, {
        playerId: 'f9-player', confirmation: 'PURGE f9-player', reason: 'Purge manual F9 fixture', operationKey: 'f9:purge:0001',
    });
    assert.equal(replay.duplicate, true);
    await assert.rejects(
        db.run("UPDATE jogadores SET ficha_status='aprovada', jogo_status='liberado' WHERE id='f9-player'"),
        /prereset_purged_player_reactivation_forbidden/
    );
    await assert.rejects(
        db.run("INSERT INTO player_rolls (player_id, roll_number) VALUES ('f9-player', 99)"),
        /prereset_purged_roll_forbidden/
    );
    await assert.rejects(
        db.run("DELETE FROM clover_prereset_purge_tombstones WHERE player_id='f9-player'"),
        /prereset_purge_tombstone_delete_forbidden/
    );
    await assert.rejects(
        decideTransition(db, 'f9-player', 'f9-player', {
            decision: 'reset', source: 'player', operationKey: 'f9:transition:0001', now: '2026-08-27T23:00:00.000Z',
        }),
        (error) => error?.code === 'player_purged'
    );
});
