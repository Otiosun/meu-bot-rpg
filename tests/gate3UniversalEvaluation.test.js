'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { criarBanco } = require('../database');
const { openCloverDatabase } = require('../helpers/clover/databaseConnection');
const {
    UniversalEvaluationError,
    cancelWaitingEvaluationSubmission,
    claimEvaluationSubmission,
    createEvaluationSubmission,
    getEvaluationSubmission,
    getEvaluationSubmissionEvents,
    listPlayerSubmissions,
    listWaitingSubmissions,
    normalizeEvaluationCategory,
    preflightResumeEvaluationFollowup,
    resolveEvaluationSubmissionAtomic,
    resumeEvaluationFollowup,
    returnEvaluationSubmissionToQueue,
    takeoverEvaluationSubmission,
} = require('../helpers/clover/universalEvaluationService');

async function makeDb() {
    const filename = path.join(
        os.tmpdir(),
        `clover-gate3-${process.pid}-${crypto.randomUUID()}.sqlite`
    );
    const db = await criarBanco({ filename });
    return { db, filename };
}

function submissionInput(index, overrides = {}) {
    const playerId = overrides.playerId || '5511000000001@s.whatsapp.net';
    return {
        category: overrides.category || 'spell',
        playerId,
        whatsappJid: playerId,
        characterId: overrides.characterId || `char-${playerId}`,
        characterName: overrides.characterName || 'Aster',
        originalPayload: overrides.originalPayload || `Ficha original ${index}`,
        submissionKey: overrides.submissionKey || `gate3:${index}`,
        sourceChatId: overrides.sourceChatId || playerId,
        sourceMessageId: overrides.sourceMessageId || `msg-${index}`,
        sourceQuotedMessageId: overrides.sourceQuotedMessageId || `sheet-${index}`,
        metadata: overrides.metadata || { gate: 3 },
    };
}

async function submit(db, index, overrides = {}) {
    const result = await createEvaluationSubmission(db, submissionInput(index, overrides));
    assert.equal(result.ok, true);
    return result.submission;
}

test('migration 33 cria fila universal, protocolos permanentes e eventos imutáveis', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());

    const migration = await db.get(
        `SELECT version, migration_key FROM clover_schema_migrations WHERE version = 33`
    );
    assert.equal(Number(migration.version), 33);
    assert.equal(migration.migration_key, '0033_universal_evaluation_queue');

    const submission = await submit(db, 1);
    assert.equal(submission.protocol, 'A1');
    const events = await getEvaluationSubmissionEvents(db, '#A1');
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'submitted');

    await assert.rejects(
        db.run(`UPDATE clover_evaluation_submissions SET protocol = 'A999' WHERE id = ?`, [submission.id]),
        /evaluation_protocol_immutable/
    );
    await assert.rejects(
        db.run(`UPDATE clover_evaluation_submissions SET original_payload = 'mutado' WHERE id = ?`, [submission.id]),
        /evaluation_original_submission_immutable/
    );
    await assert.rejects(
        db.run(`UPDATE clover_evaluation_submission_events SET event_type = 'fake' WHERE id = ?`, [events[0].id]),
        /evaluation_event_immutable/
    );
    await assert.rejects(
        db.run(`DELETE FROM clover_evaluation_submission_events WHERE id = ?`, [events[0].id]),
        /evaluation_event_immutable/
    );
});

test('mesmo player pode ocupar várias posições e filtro preserva posição global', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());

    const p1 = '5511000000001@s.whatsapp.net';
    const p2 = '5511000000002@s.whatsapp.net';
    const a1 = await submit(db, 1, { playerId: p1, category: 'feitiço' });
    const a2 = await submit(db, 2, { playerId: p2, category: 'protótipo' });
    const a3 = await submit(db, 3, { playerId: p1, category: 'spell' });

    assert.deepEqual([a1.protocol, a2.protocol, a3.protocol], ['A1', 'A2', 'A3']);
    const all = await listWaitingSubmissions(db);
    assert.deepEqual(all.map((row) => [row.protocol, Number(row.global_position)]), [
        ['A1', 1],
        ['A2', 2],
        ['A3', 3],
    ]);
    const spells = await listWaitingSubmissions(db, { category: 'feitiço' });
    assert.deepEqual(spells.map((row) => [row.protocol, Number(row.global_position)]), [
        ['A1', 1],
        ['A3', 3],
    ]);
    const mine = await listPlayerSubmissions(db, p1);
    assert.equal(mine.length, 2);
    assert.deepEqual(new Set(mine.map((row) => row.protocol)), new Set(['A1', 'A3']));
});

test('categorias são fechadas: não inventa Obra-Prima, Lei & Preço ou sistema élfico', async () => {
    assert.equal(normalizeEvaluationCategory('Feitiço'), 'spell');
    assert.equal(normalizeEvaluationCategory('Protótipo'), 'prototype');
    assert.equal(normalizeEvaluationCategory('Adaptação'), 'adaptation');
    assert.equal(normalizeEvaluationCategory('Protocolo'), 'protocol');
    assert.equal(normalizeEvaluationCategory('Receita'), 'witch_recipe');
    assert.equal(normalizeEvaluationCategory('Reforja'), 'reforge');

    for (const invalid of ['obra prima', 'obra-prima', 'lei e preço', 'lei & preço', 'elfo', 'harmonia elfica']) {
        assert.throws(
            () => normalizeEvaluationCategory(invalid),
            (error) => error instanceof UniversalEvaluationError && error.code === 'unsupported_evaluation_category'
        );
    }
});

test('submission_key é idempotente para mesma intenção e conflita com payload diferente', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());

    const first = await createEvaluationSubmission(db, submissionInput(1));
    const duplicate = await createEvaluationSubmission(db, submissionInput(1));
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.submission.protocol, first.submission.protocol);

    await assert.rejects(
        createEvaluationSubmission(db, submissionInput(1, { originalPayload: 'conteúdo diferente' })),
        (error) => error instanceof UniversalEvaluationError
            && error.code === 'evaluation_submission_idempotency_conflict'
    );
    const count = await db.get('SELECT COUNT(*) AS total FROM clover_evaluation_submissions');
    assert.equal(Number(count.total), 1);
});

test('claim por posição usa fila global, colapsa posições e devolver restaura prioridade cronológica', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    await submit(db, 1, { category: 'spell' });
    await submit(db, 2, { category: 'prototype' });
    await submit(db, 3, { category: 'spell' });

    const claim = await claimEvaluationSubmission(db, {
        selector: 2,
        reviewerId: 'admin1@s.whatsapp.net',
    });
    assert.equal(claim.ok, true);
    assert.equal(claim.submission.protocol, 'A2');
    assert.equal(claim.submission.status, 'reviewing');

    const afterClaim = await listWaitingSubmissions(db);
    assert.deepEqual(afterClaim.map((row) => [row.protocol, Number(row.global_position)]), [
        ['A1', 1],
        ['A3', 2],
    ]);

    const otherAdmin = await claimEvaluationSubmission(db, {
        selector: '#A2',
        reviewerId: 'admin2@s.whatsapp.net',
    });
    assert.equal(otherAdmin.ok, false);
    assert.equal(otherAdmin.code, 'evaluation_already_claimed');

    const sameAdmin = await claimEvaluationSubmission(db, {
        selector: '#A2',
        reviewerId: 'admin1@s.whatsapp.net',
    });
    assert.equal(sameAdmin.ok, true);
    assert.equal(sameAdmin.duplicate, true);

    const returned = await returnEvaluationSubmissionToQueue(db, {
        protocol: '#A2',
        reviewerId: 'admin1@s.whatsapp.net',
        reason: 'cena depende de consulta adicional',
    });
    assert.equal(returned.ok, true);
    assert.equal(returned.submission.status, 'waiting');

    const restored = await listWaitingSubmissions(db);
    assert.deepEqual(restored.map((row) => [row.protocol, Number(row.global_position)]), [
        ['A1', 1],
        ['A2', 2],
        ['A3', 3],
    ]);
});

test('dois handles não conseguem assumir o mesmo protocolo com revisores diferentes', async (t) => {
    const { db, filename } = await makeDb();
    const second = await openCloverDatabase({ filename });
    t.after(async () => {
        await second.close();
        await db.close();
    });
    await submit(db, 1);

    const [r1, r2] = await Promise.all([
        claimEvaluationSubmission(db, { selector: '#A1', reviewerId: 'admin1@s.whatsapp.net' }),
        claimEvaluationSubmission(second, { selector: '#A1', reviewerId: 'admin2@s.whatsapp.net' }),
    ]);
    const successes = [r1, r2].filter((row) => row.ok);
    const blocked = [r1, r2].filter((row) => !row.ok);
    assert.equal(successes.length, 1);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].code, 'evaluation_already_claimed');
    const persisted = await getEvaluationSubmission(db, '#A1');
    assert.equal(persisted.reviewer_id, successes[0].submission.reviewer_id);
});

test('takeover exige motivo e mantém trilha explícita do revisor anterior', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    await submit(db, 1);
    await claimEvaluationSubmission(db, { selector: '#A1', reviewerId: 'admin1@s.whatsapp.net' });

    await assert.rejects(
        takeoverEvaluationSubmission(db, { protocol: '#A1', reviewerId: 'admin2@s.whatsapp.net' }),
        (error) => error instanceof UniversalEvaluationError
            && error.code === 'missing_evaluation_override_reason'
    );

    const taken = await takeoverEvaluationSubmission(db, {
        protocol: '#A1',
        reviewerId: 'admin2@s.whatsapp.net',
        reason: 'ADM original saiu do turno',
    });
    assert.equal(taken.ok, true);
    assert.equal(taken.submission.reviewer_id, 'admin2@s.whatsapp.net');
    const events = await getEvaluationSubmissionEvents(db, '#A1');
    const event = events.find((row) => row.event_type === 'takeover');
    assert.ok(event);
    assert.equal(JSON.parse(event.metadata_json).previous_reviewer_id, 'admin1@s.whatsapp.net');
});

test('player só cancela própria submissão enquanto ela ainda espera', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const p1 = '5511000000001@s.whatsapp.net';
    const p2 = '5511000000002@s.whatsapp.net';
    await submit(db, 1, { playerId: p1 });
    await submit(db, 2, { playerId: p1 });

    const wrong = await cancelWaitingEvaluationSubmission(db, { protocol: '#A1', playerId: p2 });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'evaluation_submission_not_found');

    await claimEvaluationSubmission(db, { selector: '#A1', reviewerId: 'admin@s.whatsapp.net' });
    const claimedCancel = await cancelWaitingEvaluationSubmission(db, { protocol: '#A1', playerId: p1 });
    assert.equal(claimedCancel.ok, false);
    assert.equal(claimedCancel.code, 'evaluation_cannot_cancel');

    const cancelled = await cancelWaitingEvaluationSubmission(db, {
        protocol: '#A2',
        playerId: p1,
        reason: 'desisti desta proposta',
    });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.submission.status, 'cancelled');
    const duplicate = await cancelWaitingEvaluationSubmission(db, { protocol: '#A2', playerId: p1 });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);
});

test('resolução direta por posição é atômica e final não altera o payload original', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    await submit(db, 1, { originalPayload: 'PROPOSTA ORIGINAL' });
    await submit(db, 2, { originalPayload: 'OUTRA PROPOSTA' });

    const result = await resolveEvaluationSubmissionAtomic(db, {
        selector: 2,
        reviewerId: 'admin@s.whatsapp.net',
        outcome: 'approved',
        finalPayload: 'FICHA FINAL CANÔNICA',
        domainMutator: async ({ db: txDb, submission }) => {
            await txDb.run(
                `INSERT INTO clover_evaluation_submission_events
                 (submission_id, event_type, actor_id, metadata_json)
                 VALUES (?, 'domain_probe', 'system', '{}')`,
                [submission.id]
            );
            return { saved: true };
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.submission.protocol, 'A2');
    assert.equal(result.submission.status, 'approved');
    assert.equal(result.submission.original_payload, 'OUTRA PROPOSTA');
    assert.equal(result.submission.final_payload, 'FICHA FINAL CANÔNICA');
    assert.equal(result.domainResult.saved, true);

    await assert.rejects(
        db.run(`UPDATE clover_evaluation_submissions SET final_payload = 'MUTADO' WHERE id = ?`, [result.submission.id]),
        /evaluation_terminal_decision_immutable/
    );
    const persisted = await getEvaluationSubmission(db, '#A2');
    assert.equal(persisted.final_payload, 'FICHA FINAL CANÔNICA');
    assert.equal(persisted.original_payload, 'OUTRA PROPOSTA');
});

test('negação exige motivo e falha do domainMutator reverte claim, evento e domínio', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    await submit(db, 1);

    await assert.rejects(
        resolveEvaluationSubmissionAtomic(db, {
            selector: '#A1',
            reviewerId: 'admin@s.whatsapp.net',
            outcome: 'denied',
        }),
        (error) => error instanceof UniversalEvaluationError
            && error.code === 'missing_evaluation_denial_reason'
    );

    await db.exec(`CREATE TABLE gate3_domain_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`);
    await assert.rejects(
        resolveEvaluationSubmissionAtomic(db, {
            selector: '#A1',
            reviewerId: 'admin@s.whatsapp.net',
            outcome: 'approved',
            finalPayload: 'final',
            domainMutator: async ({ db: txDb }) => {
                await txDb.run(`INSERT INTO gate3_domain_probe (value) VALUES ('should_rollback')`);
                throw new Error('gate3_forced_domain_failure');
            },
        }),
        /gate3_forced_domain_failure/
    );

    const submission = await getEvaluationSubmission(db, '#A1');
    assert.equal(submission.status, 'waiting');
    assert.equal(submission.reviewer_id, null);
    assert.equal(submission.final_payload, null);
    const rows = await db.get('SELECT COUNT(*) AS total FROM gate3_domain_probe');
    assert.equal(Number(rows.total), 0);
    const events = await getEvaluationSubmissionEvents(db, '#A1');
    assert.deepEqual(events.map((row) => row.event_type), ['submitted']);
});

test('awaiting_followup sai da FIFO e pode ser retomado explicitamente sem perder protocolo', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    await submit(db, 1, { category: 'reforge' });
    await submit(db, 2, { category: 'spell' });

    const staged = await resolveEvaluationSubmissionAtomic(db, {
        selector: '#A1',
        reviewerId: 'admin1@s.whatsapp.net',
        outcome: 'awaiting_followup',
        finalPayload: 'Reforja pré-aprovada; aguarda cena de 500 palavras.',
        reason: 'proposta aprovada; falta cena',
    });
    assert.equal(staged.ok, true);
    assert.equal(staged.submission.status, 'awaiting_followup');
    assert.equal(staged.submission.resolved_at, null);
    assert.equal(staged.submission.protocol, 'A1');

    const waiting = await listWaitingSubmissions(db);
    assert.deepEqual(waiting.map((row) => row.protocol), ['A2']);

    const preflight = await preflightResumeEvaluationFollowup(db, '#A1', 'admin1@s.whatsapp.net');
    assert.equal(preflight.ok, true);
    const resumed = await resumeEvaluationFollowup(db, {
        protocol: '#A1',
        reviewerId: 'admin1@s.whatsapp.net',
        reason: 'cena entregue para conferência final',
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.submission.status, 'reviewing');
    assert.equal(resumed.submission.protocol, 'A1');

    const final = await resolveEvaluationSubmissionAtomic(db, {
        selector: '#A1',
        reviewerId: 'admin1@s.whatsapp.net',
        outcome: 'approved',
        finalPayload: 'Reforja concluída.',
    });
    assert.equal(final.ok, true);
    assert.equal(final.submission.status, 'approved');
    assert.ok(final.submission.resolved_at);
});
