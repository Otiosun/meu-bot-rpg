const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureSpellbookSchema } = require('../helpers/clover/spellbookService');
const {
    callNextHealthyQueueEntry,
    closeQueueEntryById,
    diagnoseSpellReviewQueue,
    getQueueEntryByPosition,
    requeueQueueEntryById,
} = require('../helpers/clover/spellQueueAdminService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            ficha_status TEXT,
            jogo_status TEXT
        )
    `);
    await ensureSpellbookSchema(db);
    return db;
}

async function addPlayer(db, id, personagemNome, options = {}) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, ficha_status, jogo_status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            id,
            options.nome || personagemNome || '-',
            options.displayName || personagemNome || '-',
            personagemNome,
            options.fichaStatus || 'aprovada',
            options.jogoStatus || 'liberado',
        ]
    );
}

async function addQueueEntry(db, playerId, status = 'waiting', requestedAt = null) {
    const result = await db.run(
        `INSERT INTO clover_spell_review_queue
         (player_id, status, requested_at, called_at)
         VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP), CASE WHEN ? = 'called' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
        [playerId, status, requestedAt, status]
    );
    return result.lastID;
}

test('ignora entrada sem cadastro e chama o próximo player válido', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const orphanId = await addQueueEntry(db, 'apagado@lid', 'waiting', '2026-07-01 10:00:00');
    await addPlayer(db, 'valido@lid', 'Asta');
    const validId = await addQueueEntry(db, 'valido@lid', 'waiting', '2026-07-01 11:00:00');

    const result = await callNextHealthyQueueEntry(db, 'owner@lid');

    assert.equal(result.ok, true);
    assert.equal(result.entry.id, validId);
    assert.equal(result.entry.player_id, 'valido@lid');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].id, orphanId);

    const orphan = await db.get('SELECT status, reason FROM clover_spell_review_queue WHERE id = ?', [orphanId]);
    const valid = await db.get('SELECT status FROM clover_spell_review_queue WHERE id = ?', [validId]);
    assert.equal(orphan.status, 'removed');
    assert.match(orphan.reason, /entrada órfã/i);
    assert.equal(valid.status, 'called');
});

test('entrada chamada sem personagem não bloqueia uma entrada válida', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await addPlayer(db, 'sem-personagem@lid', '-');
    const brokenCalledId = await addQueueEntry(db, 'sem-personagem@lid', 'called', '2026-07-01 10:00:00');
    await addPlayer(db, 'proximo@lid', 'Noelle');
    const nextId = await addQueueEntry(db, 'proximo@lid', 'waiting', '2026-07-01 11:00:00');

    const result = await callNextHealthyQueueEntry(db, 'owner@lid');

    assert.equal(result.ok, true);
    assert.equal(result.entry.id, nextId);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].id, brokenCalledId);
    assert.equal(result.skipped[0].previousStatus, 'called');

    const broken = await db.get('SELECT status FROM clover_spell_review_queue WHERE id = ?', [brokenCalledId]);
    assert.equal(broken.status, 'removed');
});

test('posição da fila continua administrável mesmo quando o player não existe', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const firstId = await addQueueEntry(db, 'fantasma@lid', 'waiting', '2026-07-01 10:00:00');
    await addPlayer(db, 'segundo@lid', 'Yuno');
    await addQueueEntry(db, 'segundo@lid', 'waiting', '2026-07-01 11:00:00');

    const found = await getQueueEntryByPosition(db, 1);
    assert.equal(found.ok, true);
    assert.equal(found.entry.id, firstId);
    assert.equal(found.entry.integrity.ok, false);
    assert.equal(found.entry.integrity.blocking[0].code, 'player_not_found');

    const removed = await closeQueueEntryById(db, found.entry.id, 'removed', 'owner@lid', 'entrada órfã');
    assert.equal(removed.ok, true);

    const diagnosis = await diagnoseSpellReviewQueue(db);
    assert.equal(diagnosis.total, 1);
    assert.equal(diagnosis.entries[0].player_id, 'segundo@lid');
});

test('pular por id da entrada manda o chamado para o fim sem depender do cadastro', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const calledId = await addQueueEntry(db, 'fantasma@lid', 'called', '2026-07-01 10:00:00');
    await addPlayer(db, 'outro@lid', 'Mimosa');
    await addQueueEntry(db, 'outro@lid', 'waiting', '2026-07-01 11:00:00');

    const result = await requeueQueueEntryById(db, calledId, 'owner@lid', 'adiado');
    assert.equal(result.ok, true);
    assert.equal(result.previousStatus, 'called');
    assert.equal(result.entry.status, 'waiting');
    assert.equal(result.entry.reason, 'adiado');
});
