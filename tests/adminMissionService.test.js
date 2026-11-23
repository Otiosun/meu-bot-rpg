'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    createMissionExecutors,
    getMission,
    listMissions,
    normalizeMissionDraft,
    updateMissionInTransaction,
} = require('../helpers/clover/adminMissionService');

async function makeDb() {
    return open({ filename: ':memory:', driver: sqlite3.Database });
}

function validMission(overrides = {}) {
    return {
        missionKey: 'patrulha-fronteira-01',
        title: 'Patrulha na Fronteira',
        rank: 'D',
        mode: 'official',
        location: 'Fronteira de Clover',
        missionType: 'investigation',
        risk: 'Ameaça comum com possibilidade de confronto.',
        slots: 4,
        deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
        reward: {
            ph: [8, 12],
            stars: [1, 1],
            yulls: [900, 1500],
        },
        specialConditions: 'Retornar com relatório.',
        failureConsequence: 'A patrulha inimiga avança.',
        description: 'Investigar movimentações suspeitas e proteger a rota.',
        countsForSalary: true,
        ...overrides,
    };
}

function context(db, action, extra = {}) {
    return {
        db,
        operation: {
            actor: { id: 'admin-1' },
            reason: 'teste administrativo',
        },
        action,
        target: { kind: 'system', systemKey: 'clover' },
        ...extra,
    };
}

test('mission rank guide accepts canonical D reward and requires announcement above 7000 Yulls', () => {
    const normalized = normalizeMissionDraft(validMission());
    assert.deepEqual(normalized.reward.yulls, [900, 1500]);

    assert.throws(
        () => normalizeMissionDraft(validMission({
            rank: 'S',
            reward: {
                ph: [80, 120],
                stars: [5, 8],
                yulls: [6000, 9000],
            },
        })),
        (error) => error?.code === 'exceptional_mission_reward_requires_announcement'
    );

    const exceptional = normalizeMissionDraft(validMission({
        rank: 'S',
        reward: {
            ph: [80, 120],
            stars: [5, 8],
            yulls: [6000, 9000],
            exceptionalAnnouncement: 'Dungeon de trama maior anunciada pela administração.',
        },
    }));
    assert.equal(exceptional.reward.yulls[1], 9000);
});

test('mission create executor is previewed and creates a draft that can be undone while untouched', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const action = {
        type: 'system.mission.create',
        payload: validMission(),
    };
    const executor = createMissionExecutors()['system.mission.create'];
    const preview = await executor.preview(context(db, action));

    assert.equal(preview.before, null);
    assert.equal(preview.after.status, 'draft');
    assert.equal(preview.after.revision, 1);

    const applied = await executor.apply(context(db, action, { after: preview.after }));
    assert.equal(applied.after.status, 'draft');
    assert.equal((await getMission(db, validMission().missionKey)).revision, 1);

    await executor.undo(context(db, action, { after: applied.after }));
    assert.equal(await getMission(db, validMission().missionKey), null);
});

test('mission update fails closed when revision changed after preview', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const createAction = { type: 'system.mission.create', payload: validMission() };
    const createExecutor = createMissionExecutors()['system.mission.create'];
    const createPreview = await createExecutor.preview(context(db, createAction));
    await createExecutor.apply(context(db, createAction, { after: createPreview.after }));

    const updateAction = {
        type: 'system.mission.update',
        payload: {
            missionKey: validMission().missionKey,
            changes: { title: 'Patrulha Revisada' },
        },
    };
    const updateExecutor = createMissionExecutors()['system.mission.update'];
    const preview = await updateExecutor.preview(context(db, updateAction));

    await updateMissionInTransaction(
        db,
        validMission().missionKey,
        1,
        { ...validMission(), title: 'Mudança concorrente' },
        'admin-2'
    );

    await assert.rejects(
        () => updateExecutor.apply(context(db, updateAction, {
            before: preview.before,
            after: preview.after,
        })),
        (error) => error?.code === 'mission_revision_conflict'
    );
});

test('R23: draft ranges are allowed but publication requires exact PH, Stars and Yulls', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());
    const create = createMissionExecutors()['system.mission.create'];
    const publish = createMissionExecutors()['system.mission.status.transition'];
    const action = { type: 'system.mission.create', payload: validMission() };
    const preview = await create.preview(context(db, action));
    await create.apply(context(db, action, { after: preview.after }));
    const transition = { type: 'system.mission.status.transition', payload: { missionKey: action.payload.missionKey, status: 'published' } };
    await assert.rejects(() => publish.preview(context(db, transition)), (error) => error?.code === 'mission_fixed_reward_required');
    const unchanged = await getMission(db, action.payload.missionKey);
    assert.equal(unchanged.status, 'draft');
    assert.equal(unchanged.revision, 1);
    const fixed = { ...action.payload, reward: { ph: [10, 10], stars: [1, 1], yulls: [1000, 1000] } };
    await updateMissionInTransaction(db, action.payload.missionKey, 1, fixed, 'admin-1');
    const publishPreview = await publish.preview(context(db, transition));
    const applied = await publish.apply(context(db, transition, { before: publishPreview.before, after: publishPreview.after }));
    assert.equal(applied.after.status, 'published');
    assert.deepEqual(applied.after.reward.ph, [10, 10]);
});

test('mission lifecycle is draft -> published -> closed -> archived and undo restores prior snapshot', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const createAction = { type: 'system.mission.create', payload: validMission({ reward: { ph: [10, 10], stars: [1, 1], yulls: [1000, 1000] } }) };
    const createExecutor = createMissionExecutors()['system.mission.create'];
    const createPreview = await createExecutor.preview(context(db, createAction));
    await createExecutor.apply(context(db, createAction, { after: createPreview.after }));

    const transitionExecutor = createMissionExecutors()['system.mission.status.transition'];
    const publishAction = {
        type: 'system.mission.status.transition',
        payload: { missionKey: validMission().missionKey, status: 'published' },
    };
    const publishPreview = await transitionExecutor.preview(context(db, publishAction));
    const published = await transitionExecutor.apply(context(db, publishAction, {
        before: publishPreview.before,
        after: publishPreview.after,
    }));
    assert.equal(published.after.status, 'published');

    await transitionExecutor.undo(context(db, publishAction, {
        before: published.before,
        after: published.after,
    }));
    const restored = await getMission(db, validMission().missionKey);
    assert.equal(restored.status, 'draft');
    assert.equal(restored.revision, 3);

    const republishPreview = await transitionExecutor.preview(context(db, publishAction));
    const republished = await transitionExecutor.apply(context(db, publishAction, {
        before: republishPreview.before,
        after: republishPreview.after,
    }));

    const closeAction = {
        type: 'system.mission.status.transition',
        payload: { missionKey: validMission().missionKey, status: 'closed' },
    };
    const closePreview = await transitionExecutor.preview(context(db, closeAction));
    const closed = await transitionExecutor.apply(context(db, closeAction, {
        before: closePreview.before,
        after: closePreview.after,
    }));
    assert.equal(republished.after.status, 'published');
    assert.equal(closed.after.status, 'closed');

    const archiveAction = {
        type: 'system.mission.status.transition',
        payload: { missionKey: validMission().missionKey, status: 'archived' },
    };
    const archivePreview = await transitionExecutor.preview(context(db, archiveAction));
    const archived = await transitionExecutor.apply(context(db, archiveAction, {
        before: archivePreview.before,
        after: archivePreview.after,
    }));
    assert.equal(archived.after.status, 'archived');

    const listed = await listMissions(db);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'archived');
});

test('mission executor rejects non-system targets and invalid lifecycle transitions', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const createAction = { type: 'system.mission.create', payload: validMission() };
    const createExecutor = createMissionExecutors()['system.mission.create'];

    await assert.rejects(
        () => createExecutor.preview({
            ...context(db, createAction),
            target: { kind: 'player', playerId: 'player-1' },
        }),
        (error) => error?.code === 'invalid_system_target'
    );

    const preview = await createExecutor.preview(context(db, createAction));
    await createExecutor.apply(context(db, createAction, { after: preview.after }));

    const invalid = createMissionExecutors()['system.mission.status.transition'];
    await assert.rejects(
        () => invalid.preview(context(db, {
            type: 'system.mission.status.transition',
            payload: { missionKey: validMission().missionKey, status: 'closed' },
        })),
        (error) => error?.code === 'invalid_mission_transition'
    );
});

test('mission publish fails when deadline is missing or expired', async (t) => {
    const db = await makeDb();
    t.after(() => db.close());

    const action = {
        type: 'system.mission.create',
        payload: validMission({ deadlineAt: null }),
    };
    const createExecutor = createMissionExecutors()['system.mission.create'];
    const preview = await createExecutor.preview(context(db, action));
    await createExecutor.apply(context(db, action, { after: preview.after }));

    const publish = createMissionExecutors()['system.mission.status.transition'];
    await assert.rejects(
        () => publish.preview(context(db, {
            type: 'system.mission.status.transition',
            payload: { missionKey: validMission().missionKey, status: 'published' },
        })),
        (error) => error?.code === 'mission_deadline_required'
    );
});
