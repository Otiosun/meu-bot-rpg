'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { criarBanco } = require('../database');
const { ensureCharacterStats } = require('../helpers/clover/characterStats');
const {
    approvePrototypeEvaluation,
    listHumanPrototypes,
    prototypeLimitForStage,
    submitPrototypeEvaluation,
} = require('../helpers/clover/prototypeUniversalEvaluationService');
const { getEvaluationSubmission } = require('../helpers/clover/universalEvaluationService');

async function makeDb() {
    const filename = path.join(
        os.tmpdir(),
        `clover-gate4-prototype-${process.pid}-${crypto.randomUUID()}.sqlite`
    );
    const db = await criarBanco({ filename });
    return { db, filename };
}

async function insertPlayer(db, id = '5511000000001@s.whatsapp.net', race = 'Humano') {
    await db.run(
        `INSERT INTO jogadores (id, nome, personagem_nome, raca, dinheiro, estrelas, jogo_status)
         VALUES (?, 'Conta Teste', 'Aster', ?, 0, 0, 'liberado')`,
        [id, race]
    );
    await ensureCharacterStats(db, id);
    return id;
}

function prototypeSheet(overrides = {}) {
    return [
        '*♧┃𝐅𝐈𝐂𝐇𝐀 · 𝐏𝐑𝐎𝐓𝐎́𝐓𝐈𝐏𝐎 𖥔 𝐇𝐮𝐦𝐚𝐧𝐨*',
        '     ──  técnica em desenvolvimento  ──',
        '',
        '_`─( ✦ )───── 𝗣𝗿𝗼𝗽𝗼𝘀𝘁𝗮`_',
        '',
        '*𝐍𝐨𝐦𝐞:*',
        `> ${overrides.name ?? 'Passo Quebrado'}`,
        '',
        '*𝐈𝐝𝐞𝐢𝐚:*',
        `> ${overrides.idea ?? 'Desenvolver uma mudança curta de cadência.'}`,
        '',
        '*𝐃𝐞𝐟𝐞𝐢𝐭𝐨:*',
        `> ${overrides.defect ?? '🔒 ADM'}`,
    ].join('\n');
}

async function submit(db, index, playerId, overrides = {}) {
    const result = await submitPrototypeEvaluation(db, {
        playerId,
        whatsappJid: playerId,
        characterId: playerId,
        characterName: 'Aster',
        rawSheet: prototypeSheet(overrides),
        submissionKey: `gate4:prototype:${index}`,
        sourceChatId: playerId,
        sourceMessageId: `prototype-sheet-${index}`,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.submission;
}

test('migration 34 é canônica e limites seguem exatamente 9–6 / 5–2 / 1–0', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const migration = await db.get(
        `SELECT version, migration_key FROM clover_schema_migrations WHERE version = 34`
    );
    assert.equal(Number(migration.version), 34);
    assert.equal(migration.migration_key, '0034_human_prototype_evaluation');

    for (const stage of ['9', '8', '7', '6']) assert.equal(prototypeLimitForStage(stage), 1);
    for (const stage of ['5', '4', '3', '2']) assert.equal(prototypeLimitForStage(stage), 2);
    for (const stage of ['1', '0']) assert.equal(prototypeLimitForStage(stage), 3);
    assert.equal(prototypeLimitForStage('arcano'), null);
});

test('intake aceita Defeito bloqueado e impede player de preencher campo ADM', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);

    const valid = await submitPrototypeEvaluation(db, {
        playerId,
        rawSheet: prototypeSheet(),
        submissionKey: 'prototype:intake:valid',
    });
    assert.equal(valid.ok, true, JSON.stringify(valid));

    const invalid = await submitPrototypeEvaluation(db, {
        playerId,
        rawSheet: prototypeSheet({ defect: 'Fica imóvel por 1 turno.' }),
        submissionKey: 'prototype:intake:invalid',
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'prototype_player_filled_adm_field');
});

test('Humano estágio 9 aprova um Protótipo e ele entra em testing', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    await submit(db, 1, playerId);

    const result = await approvePrototypeEvaluation(db, {
        selector: '#A1',
        reviewerId: 'admin@s.whatsapp.net',
        finalPayload: prototypeSheet({ defect: 'Só pode ser usado uma vez por cena.' }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.submission.status, 'approved');
    assert.equal(result.domainResult.prototype.status, 'testing');
    assert.equal(result.domainResult.capacityBefore.limit, 1);

    const prototypes = await listHumanPrototypes(db, playerId);
    assert.equal(prototypes.length, 1);
    assert.equal(prototypes[0].name, 'Passo Quebrado');
    assert.equal(prototypes[0].defect, 'Só pode ser usado uma vez por cena.');
});

test('não-Humano é bloqueado sem alterar fila nem criar Protótipo', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db, undefined, 'Bruxa');
    await submit(db, 1, playerId);

    const result = await approvePrototypeEvaluation(db, {
        selector: '#A1',
        reviewerId: 'admin@s.whatsapp.net',
        finalPayload: prototypeSheet({ defect: 'Defeito ADM.' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'prototype_requires_human');
    const submission = await getEvaluationSubmission(db, '#A1');
    assert.equal(submission.status, 'waiting');
    const count = await db.get('SELECT COUNT(*) AS total FROM clover_human_prototypes');
    assert.equal(Number(count.total), 0);
});

test('limite ativo é revalidado dentro da aprovação e libera conforme estágio', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);

    await submit(db, 1, playerId, { name: 'Protótipo Um' });
    const first = await approvePrototypeEvaluation(db, {
        selector: '#A1',
        reviewerId: 'admin@s.whatsapp.net',
        finalPayload: prototypeSheet({ name: 'Protótipo Um', defect: 'Defeito 1.' }),
    });
    assert.equal(first.ok, true);

    await submit(db, 2, playerId, { name: 'Protótipo Dois' });
    const blocked = await approvePrototypeEvaluation(db, {
        selector: '#A2',
        reviewerId: 'admin@s.whatsapp.net',
        finalPayload: prototypeSheet({ name: 'Protótipo Dois', defect: 'Defeito 2.' }),
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'prototype_capacity_full');
    assert.equal(blocked.details.capacity.limit, 1);

    await db.run(
        `UPDATE clover_character_stats SET stage_key = '5' WHERE player_id = ?`,
        [playerId]
    );
    const approved = await approvePrototypeEvaluation(db, {
        selector: '#A2',
        reviewerId: 'admin@s.whatsapp.net',
        finalPayload: prototypeSheet({ name: 'Protótipo Dois', defect: 'Defeito 2.' }),
    });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(approved.domainResult.capacityBefore.limit, 2);
});

test('estágio sem regra canônica bloqueia em vez de inventar limite', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    await db.run(`UPDATE clover_character_stats SET stage_key = 'arcano' WHERE player_id = ?`, [playerId]);
    await submit(db, 1, playerId);

    const result = await approvePrototypeEvaluation(db, {
        selector: '#A1',
        reviewerId: 'admin@s.whatsapp.net',
        finalPayload: prototypeSheet({ defect: 'Defeito ADM.' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'prototype_stage_unsupported');
    const submission = await getEvaluationSubmission(db, '#A1');
    assert.equal(submission.status, 'waiting');
});

test('falha no INSERT do Protótipo reverte claim e resolução', async (t) => {
    const { db } = await makeDb();
    t.after(() => db.close());
    const playerId = await insertPlayer(db);
    await submit(db, 1, playerId);
    await db.exec(`
        CREATE TRIGGER gate4_force_prototype_failure
        BEFORE INSERT ON clover_human_prototypes
        BEGIN
            SELECT RAISE(ABORT, 'gate4_forced_prototype_failure');
        END
    `);

    await assert.rejects(
        approvePrototypeEvaluation(db, {
            selector: '#A1',
            reviewerId: 'admin@s.whatsapp.net',
            finalPayload: prototypeSheet({ defect: 'Defeito ADM.' }),
        }),
        /gate4_forced_prototype_failure/
    );

    const submission = await getEvaluationSubmission(db, '#A1');
    assert.equal(submission.status, 'waiting');
    assert.equal(submission.reviewer_id, null);
    const count = await db.get('SELECT COUNT(*) AS total FROM clover_human_prototypes');
    assert.equal(Number(count.total), 0);
});
