'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const {
    applyGlobalPlayerReset,
    getGlobalPlayerResetOperation,
    planGlobalPlayerReset,
} = require('../helpers/clover/globalPlayerResetService');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            nome_real TEXT,
            personagem_nome TEXT,
            personagem_idade INTEGER,
            ficha_status TEXT,
            historia_status TEXT,
            personagem_aparencia_status TEXT,
            jogo_status TEXT,
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            dinheiro INTEGER DEFAULT 0,
            reino TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            patente TEXT DEFAULT '-',
            lifecycle_status TEXT DEFAULT 'active',
            is_shadow INTEGER DEFAULT 0,
            identity_status TEXT DEFAULT 'active',
            merged_into TEXT DEFAULT NULL
        );
        CREATE TABLE clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            kind TEXT NOT NULL,
            source TEXT,
            reason TEXT
        );
        INSERT INTO jogadores
        (id,nome,nome_real,personagem_nome,personagem_idade,ficha_status,historia_status,
         personagem_aparencia_status,jogo_status,dinheiro,is_shadow)
        VALUES ('cas@lid','CAS','Pessoa CAS','Personagem CAS',19,'aprovada','aprovada','approved','liberado',100,0);
    `);
    return db;
}

function setSwitches(t, operationId) {
    const keys = ['CLOVER_GLOBAL_RESET_ENABLED', 'CLOVER_GLOBAL_RESET_OPERATION_ID', 'CLOVER_RESET_EXECUTION_AUTHORIZED'];
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.CLOVER_GLOBAL_RESET_ENABLED = 'YES';
    process.env.CLOVER_GLOBAL_RESET_OPERATION_ID = operationId;
    process.env.CLOVER_RESET_EXECUTION_AUTHORIZED = 'YES';
    t.after(() => {
        for (const key of keys) {
            if (before[key] === undefined) delete process.env[key];
            else process.env[key] = before[key];
        }
    });
}

test('apply não pode retornar completed quando o CAS final afeta zero linhas', async (t) => {
    const rawDb = await createDb();
    t.after(() => rawDb.close());

    const plan = await planGlobalPlayerReset(rawDb, {
        actorId: OWNER,
        reason: 'Drill descartável de CAS final do reset global',
        playerIds: ['cas@lid'],
        selectionSource: 'fixture explícita completion CAS',
        operationId: 'GR-COMPLETION-CAS-0001',
    });
    setSwitches(t, plan.operationId);

    let completionCasIntercepted = false;
    const db = new Proxy(rawDb, {
        get(target, property, receiver) {
            if (property !== 'run') return Reflect.get(target, property, receiver);
            return async (sql, ...args) => {
                const source = String(sql || '');
                if (source.includes("SET status='completed'") && source.includes('execution_token=NULL')) {
                    completionCasIntercepted = true;
                    return { changes: 0 };
                }
                return target.run(sql, ...args);
            };
        },
    });

    await assert.rejects(
        applyGlobalPlayerReset(db, { operationId: plan.operationId, actorId: OWNER }),
        (error) => error?.code === 'global_reset_completion_compare_and_swap_failed'
    );
    assert.equal(completionCasIntercepted, true);

    const after = await getGlobalPlayerResetOperation(rawDb, plan.operationId);
    assert.notEqual(after.operation.status, 'completed');
    assert.equal(after.items[0].status, 'applied');
    assert.equal((await rawDb.get('SELECT COUNT(*) AS total FROM clover_player_reset_events')).total, 1);
});
