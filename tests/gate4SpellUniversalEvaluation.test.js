'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { criarBanco } = require('../database');
const {
    approveSpellEvaluation,
    getSpellEvaluationReviewSheet,
    submitSpellEvaluation,
} = require('../helpers/clover/spellUniversalEvaluationService');
const {
    ensureSpellbookSchema,
    listApprovedSpells,
    saveSpell,
} = require('../helpers/clover/spellbookService');
const {
    createEvaluationSubmission,
    getEvaluationSubmission,
} = require('../helpers/clover/universalEvaluationService');

async function makeDb() {
    const filename = path.join(
        os.tmpdir(),
        `clover-gate4-spell-${process.pid}-${crypto.randomUUID()}.sqlite`
    );
    const db = await criarBanco({ filename });
    return { db, filename };
}

async function insertPlayer(db, id = '5511000000001@s.whatsapp.net') {
    await db.run(
        `INSERT INTO jogadores (id, nome, personagem_nome, dinheiro, estrelas, jogo_status)
         VALUES (?, 'Conta Teste', 'Aster', 0, 0, 'liberado')`,
        [id]
    );
    return id;
}

function spellSheet(overrides = {}) {
    return [
        '♧┃FICHA DE FEITIÇO 𖥔 CLOVER MULTICOLOR',
        '     ── avaliação rápida do grimório ──',
        '',
        '_`─( ✓ )───── Identificação`_',
        '',
        '*Nome do feitiço:*',
        `> ${overrides.name ?? 'Mão de Lama'}`,
        '*Tipo:*',
        `> ${overrides.type ?? 'Criação'}`,
        '*Versão:*',
        `> ${overrides.version ?? 'v1'}`,
        '',
        '_`─( ✦ )───── Uso`_',
        '',
        '*Custo:*',
        `> ${overrides.cost ?? '🔒'}`,
        '*Alcance:*',
        `> ${overrides.reach ?? '🔒'}`,
        '*Duração:*',
        `> ${overrides.duration ?? '🔒'}`,
        '',
        '_`─( ◆ )───── Efeito`_',
        '',
        '*Descrição:*',
        `> ${overrides.effect ?? 'Cria lama sob o alvo.'}`,
        '',
        '_`─( ◇ )───── Travas`_',
        '',
        '*Limites:*',
        `> ${overrides.limits ?? '🔒'}`,
        '*Notas ADM:*',
        `> ${overrides.admNotes ?? '🔒'}`,
    ].join('\n');
}

function finalSpellSheet(overrides = {}) {
    return spellSheet({
        cost: '45 MP',
        reach: '12 m',
        duration: '2 turnos',
        limits: 'Máximo de 2 áreas simultâneas.',
        admNotes: 'Aprovado após ajuste.',
        ...overrides,
    });
}

async function submit(db, index, playerId, overrides = {}) {
    const result = await submitSpellEvaluation(db, {
        playerId,
        whatsappJid: playerId,
        characterId: `char-${playerId}`,
        characterName: 'Aster',
        rawSheet: spellSheet(overrides),
        submissionKey: `gate4:spell:${index}`,
        sourceChatId: playerId,
        sourceMessageId: `msg-${index}`,
        sourceQuotedMessageId: `sheet-${index}`,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.submission;
}

async function seedApprovedSpell(db, playerId, overrides = {}) {
    await ensureSpellbookSchema(db);
    const sheet = {
        name: overrides.name || 'Mão de Lama',
        normalizedName: overrides.normalizedName || 'mao_de_lama',
        version: overrides.version || 1,
        type: overrides.type || 'Criação',
        cost: overrides.cost || '40 MP',
        reach: overrides.reach || '10 m',
        duration: overrides.duration || '1 turno',
        effect: overrides.effect || 'Cria lama.',
        limits: overrides.limits || 'Uma área por vez.',
        admNotes: overrides.admNotes || '-',
    };
    const saved = await saveSpell(db, playerId, sheet, 'seed-admin', { nextVersion: false });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    return saved.spell;
}

test('intake aceita os campos ADM bloqueados e gera protocolo universal', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);

    const submission = await submit(db, 1, playerId);
    assert.equal(submission.protocol, 'A1');
    assert.equal(submission.category, 'spell');
    assert.equal(submission.status, 'waiting');
    assert.match(submission.original_payload, /🔒/);

    const review = await getSpellEvaluationReviewSheet(db, '#A1');
    assert.equal(review.ok, true, JSON.stringify(review));
    assert.match(review.sheet, /\*Custo:\*\n> 🔒/);
    assert.match(review.sheet, /\*Nome do feitiço:\*\n> Mão de Lama/);
});

test('intake rejeita player preenchendo campo que pertence ao ADM', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);

    const result = await submitSpellEvaluation(db, {
        playerId,
        rawSheet: spellSheet({ cost: '10 MP' }),
        submissionKey: 'gate4:forbidden-adm-field',
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'spell_player_filled_adm_fields');
    assert.deepEqual(result.fields, ['cost']);

    const count = await db.get('SELECT COUNT(*) AS total FROM clover_evaluation_submissions');
    assert.equal(Number(count.total), 0);
});

test('aprovação v1 salva Feitiço e resolve a submissão na mesma transação', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    await submit(db, 1, playerId);

    const result = await approveSpellEvaluation(db, {
        selector: '#A1',
        reviewerId: 'admin@s.whatsapp.net',
        finalPayload: finalSpellSheet(),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.submission.status, 'approved');
    assert.equal(result.domainResult.mode, 'created');
    assert.equal(result.domainResult.createsNewSpellSlot, true);
    assert.equal(result.domainResult.spell.version, 1);

    const spells = await listApprovedSpells(db, playerId);
    assert.equal(spells.length, 1);
    assert.equal(spells[0].normalized_name, 'mao_de_lama');
    assert.equal(spells[0].cost, '45 MP');
});

test('slot cheio bloqueia outro Feitiço novo antes de criar submissão', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    await seedApprovedSpell(db, playerId);

    const result = await submitSpellEvaluation(db, {
        playerId,
        whatsappJid: playerId,
        characterId: `char-${playerId}`,
        characterName: 'Aster',
        rawSheet: spellSheet({ name: 'Muralha de Barro' }),
        submissionKey: 'gate4:spell:full-slot-intake',
        sourceChatId: playerId,
        sourceMessageId: 'msg-full-slot-intake',
        sourceQuotedMessageId: 'sheet-full-slot-intake',
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'spell_capacity_full');
    assert.match(result.error, /Ticket de Feitiço/);

    const count = await db.get('SELECT COUNT(*) AS total FROM clover_evaluation_submissions');
    assert.equal(Number(count.total), 0);
    const spells = await listApprovedSpells(db, playerId);
    assert.equal(spells.length, 1);
    assert.equal(spells[0].normalized_name, 'mao_de_lama');
});

test('aprovação mantém a segunda trava de slot para submissão legada já existente', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    await seedApprovedSpell(db, playerId);

    const created = await createEvaluationSubmission(db, {
        category: 'spell',
        playerId,
        whatsappJid: playerId,
        characterId: `char-${playerId}`,
        characterName: 'Aster',
        originalPayload: spellSheet({ name: 'Muralha de Barro' }),
        submissionKey: 'gate4:legacy-full-slot-submission',
        sourceChatId: playerId,
        sourceMessageId: 'msg-legacy-full-slot',
        sourceQuotedMessageId: 'sheet-legacy-full-slot',
    });
    assert.equal(created.ok, true, JSON.stringify(created));

    const result = await approveSpellEvaluation(db, {
        selector: `#${created.submission.protocol}`,
        reviewerId: 'admin@s.whatsapp.net',
        finalPayload: finalSpellSheet({ name: 'Muralha de Barro' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'spell_capacity_full');

    const submission = await getEvaluationSubmission(db, `#${created.submission.protocol}`);
    assert.equal(submission.status, 'waiting');
    assert.equal(submission.reviewer_id, null);
    const spells = await listApprovedSpells(db, playerId);
    assert.equal(spells.length, 1);
    assert.equal(spells[0].normalized_name, 'mao_de_lama');
});

test('atualização v2 do mesmo Feitiço funciona mesmo com todos os slots ocupados', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    await seedApprovedSpell(db, playerId);
    await submit(db, 1, playerId, { version: 'v2', effect: 'Cria lama mais densa.' });

    const result = await approveSpellEvaluation(db, {
        selector: '#A1',
        reviewerId: 'admin@s.whatsapp.net',
        finalPayload: finalSpellSheet({
            version: 'v2',
            effect: 'Cria lama mais densa.',
            cost: '55 MP',
        }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.domainResult.mode, 'updated');
    assert.equal(result.domainResult.createsNewSpellSlot, false);
    assert.equal(result.domainResult.spell.version, 2);

    const latest = await listApprovedSpells(db, playerId);
    assert.equal(latest.length, 1);
    assert.equal(latest[0].version, 2);
    assert.equal(latest[0].cost, '55 MP');
});

test('versão pulada é rejeitada e informa a próxima versão esperada', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    await seedApprovedSpell(db, playerId);
    await submit(db, 1, playerId, { version: 'v3' });

    const result = await approveSpellEvaluation(db, {
        selector: '#A1',
        reviewerId: 'admin@s.whatsapp.net',
        finalPayload: finalSpellSheet({ version: 'v3' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'spell_version_must_follow_latest');
    assert.equal(result.details.expectedVersion, 2);

    const submission = await getEvaluationSubmission(db, '#A1');
    assert.equal(submission.status, 'waiting');
    const latest = await listApprovedSpells(db, playerId);
    assert.equal(latest[0].version, 1);
});

test('ficha final incompleta falha antes de tocar fila ou grimório', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    await submit(db, 1, playerId);

    const result = await approveSpellEvaluation(db, {
        selector: '#A1',
        reviewerId: 'admin@s.whatsapp.net',
        finalPayload: spellSheet(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_spell_final_sheet');
    assert.ok(result.errors.some((error) => error.field === 'cost'));

    const submission = await getEvaluationSubmission(db, '#A1');
    assert.equal(submission.status, 'waiting');
    const spells = await listApprovedSpells(db, playerId);
    assert.equal(spells.length, 0);
});

test('falha de banco no save reverte claim, eventos e grimório', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    await submit(db, 1, playerId);
    await ensureSpellbookSchema(db);
    await db.exec(`
        CREATE TRIGGER gate4_force_spell_save_failure
        BEFORE INSERT ON clover_spellbook_spells
        BEGIN
            SELECT RAISE(ABORT, 'gate4_forced_spell_failure');
        END
    `);

    await assert.rejects(
        approveSpellEvaluation(db, {
            selector: '#A1',
            reviewerId: 'admin@s.whatsapp.net',
            finalPayload: finalSpellSheet(),
        }),
        /gate4_forced_spell_failure/
    );

    const submission = await getEvaluationSubmission(db, '#A1');
    assert.equal(submission.status, 'waiting');
    assert.equal(submission.reviewer_id, null);
    const events = await db.all(
        `SELECT event_type FROM clover_evaluation_submission_events
         WHERE submission_id = ? ORDER BY id`,
        [submission.id]
    );
    assert.deepEqual(events.map((row) => row.event_type), ['submitted']);
    const spells = await listApprovedSpells(db, playerId);
    assert.equal(spells.length, 0);
});
