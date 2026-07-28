'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { assignAccessRole } = require('../helpers/clover/accessControlService');
const { canUseQuickEvaluation } = require('../helpers/clover/quickEvaluationService');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await db.run(
        `INSERT INTO clover_settings (key, value) VALUES ('clover_on_group_jid', ?)`,
        ['on-group@g.us']
    );
    return db;
}

test('avaliador com cargo pode aplicar ficha no grupo ON', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await assignAccessRole(db, {
        subjectId: '5511999990000@s.whatsapp.net',
        role: 'avaliador',
        assignedBy: '557998868223@s.whatsapp.net',
        reason: 'teste',
    });

    const result = await canUseQuickEvaluation({
        sock: {},
        db,
        idChat: 'on-group@g.us',
        evaluatorId: '5511999990000@s.whatsapp.net',
    });

    assert.equal(result.ok, true);
});

test('admin local do WhatsApp sem cargo nao aplica ficha', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const result = await canUseQuickEvaluation({
        sock: {
            groupMetadata: async () => ({
                participants: [{ id: '5521888880000@s.whatsapp.net', admin: 'admin' }],
            }),
        },
        db,
        idChat: 'on-group@g.us',
        evaluatorId: '5521888880000@s.whatsapp.net',
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /avaliadores autorizados/i);
});

test('owner continua autorizado sem linha de cargo', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const result = await canUseQuickEvaluation({
        sock: {},
        db,
        idChat: 'on-group@g.us',
        evaluatorId: '557998868223@s.whatsapp.net',
    });

    assert.equal(result.ok, true);
});
