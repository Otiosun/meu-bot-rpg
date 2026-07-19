'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'executePlayerIdentityRepairsV2.js');

async function createFixture(root) {
    const dbFile = path.join(root, 'executor-v2.sqlite');
    const db = await open({ filename: dbFile, driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            canonical_player_id TEXT
        );

        CREATE TABLE group_member_welcomes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            player_id TEXT NOT NULL,
            message_id TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (group_id, player_id)
        );

        CREATE TABLE clover_ph_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            kind TEXT NOT NULL,
            source TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            related_id TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        );

        CREATE UNIQUE INDEX idx_test_ph_identity_source_related
        ON clover_ph_ledger (player_id, source, related_id);
    `);

    const sourceId = '5521983819642@s.whatsapp.net';
    const canonicalId = '52609691955295@lid';
    const blockedSource = '551100000099@s.whatsapp.net';
    const blockedCanonical = '999@lid';

    await db.run('INSERT INTO jogadores VALUES (?, ?, ?)', [sourceId, 'Cacador', null]);
    await db.run('INSERT INTO jogadores VALUES (?, ?, ?)', [canonicalId, 'Jogador Real', canonicalId]);
    await db.run('INSERT INTO jogadores VALUES (?, ?, ?)', [blockedSource, 'Conflito A', null]);
    await db.run('INSERT INTO jogadores VALUES (?, ?, ?)', [blockedCanonical, 'Conflito B', blockedCanonical]);

    await db.run(
        `INSERT INTO group_member_welcomes (group_id, player_id, message_id, created_at)
         VALUES (?, ?, ?, ?)`,
        ['grupo-1', canonicalId, null, '2026-01-01 10:00:00']
    );
    await db.run(
        `INSERT INTO group_member_welcomes (group_id, player_id, message_id, created_at)
         VALUES (?, ?, ?, ?)`,
        ['grupo-1', sourceId, 'msg-1', '2026-01-02 10:00:00']
    );
    await db.run(
        `INSERT INTO group_member_welcomes (group_id, player_id, message_id, created_at)
         VALUES (?, ?, ?, ?)`,
        ['grupo-2', sourceId, 'msg-2', '2026-01-03 10:00:00']
    );

    await db.run(
        `INSERT INTO clover_ph_ledger
         (player_id, amount, kind, source, reason, related_id, created_by, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [canonicalId, 5, 'ganho', 'scene', null, 'scene-1', null, null]
    );
    await db.run(
        `INSERT INTO clover_ph_ledger
         (player_id, amount, kind, source, reason, related_id, created_by, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sourceId, 5, 'ganho', 'scene', 'Cena semanal', 'scene-1', 'narrador', '{"scene":1}']
    );

    await db.close();

    const planFile = path.join(root, 'identity-repair-plan-v2.json');
    fs.writeFileSync(planFile, JSON.stringify({
        readOnly: true,
        groups: [
            {
                phone: '5521983819642',
                action: 'transactional_alias_consolidation_ready',
                readyForExecutor: true,
                canonicalId,
                dataOwnerId: canonicalId,
                sources: [{
                    sourceId,
                    unknownReferences: [],
                    references: [
                        { table: 'jogadores', column: 'id', rows: 1, strategy: 'source_record' },
                        { table: 'group_member_welcomes', column: 'player_id', rows: 2, strategy: 'repoint_history' },
                        { table: 'clover_ph_ledger', column: 'player_id', rows: 1, strategy: 'repoint_history' }
                    ]
                }]
            },
            {
                phone: '551100000099',
                action: 'blocked_manual_merge',
                readyForExecutor: false,
                canonicalId: blockedCanonical,
                dataOwnerId: blockedCanonical,
                sources: [{ sourceId: blockedSource, references: [] }]
            }
        ]
    }, null, 2));

    return { dbFile, planFile, sourceId, canonicalId, blockedSource, blockedCanonical };
}

function execute(fixture, root, apply = false, confirm = true) {
    const args = [
        SCRIPT,
        `--db=${fixture.dbFile}`,
        `--plan=${fixture.planFile}`,
        `--output=${root}`,
    ];
    if (apply) {
        args.push('--apply');
        if (confirm) args.push('--confirm=APPLY_READY_IDENTITY_REPAIRS');
    }
    return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

async function snapshot(dbFile) {
    const db = await open({ filename: dbFile, driver: sqlite3.Database });
    const output = {};
    for (const table of ['jogadores', 'group_member_welcomes', 'clover_ph_ledger']) {
        output[table] = await db.all(`SELECT * FROM ${table} ORDER BY 1`);
    }
    await db.close();
    return output;
}

test('V2 simula colisões equivalentes e reverte tudo', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-identity-v2-dry-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = await createFixture(root);
    const before = await snapshot(fixture.dbFile);

    const result = execute(fixture, root, false);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /EXECUTOR DE IDENTIDADES V2/);
    assert.match(result.stdout, /SIMULAÇÃO COM ROLLBACK/);
    assert.match(result.stdout, /Grupos processados: 1/);
    assert.match(result.stdout, /Grupos bloqueados e intocados: 1/);
    assert.deepEqual(await snapshot(fixture.dbFile), before);
});

test('V2 aplica deduplicação genérica e preserva conteúdo complementar', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-identity-v2-apply-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = await createFixture(root);

    const result = execute(fixture, root, true);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Commit no banco: SIM/);

    const db = await open({ filename: fixture.dbFile, driver: sqlite3.Database });
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM jogadores WHERE id = ?', [fixture.sourceId])).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM jogadores WHERE id = ?', [fixture.canonicalId])).n, 1);

    const welcomes = await db.all(
        'SELECT group_id, player_id, message_id FROM group_member_welcomes ORDER BY group_id'
    );
    assert.deepEqual(welcomes, [
        { group_id: 'grupo-1', player_id: fixture.canonicalId, message_id: 'msg-1' },
        { group_id: 'grupo-2', player_id: fixture.canonicalId, message_id: 'msg-2' },
    ]);

    const ledger = await db.all(
        `SELECT player_id, amount, kind, source, reason, related_id, created_by, metadata_json
         FROM clover_ph_ledger`
    );
    assert.deepEqual(ledger, [{
        player_id: fixture.canonicalId,
        amount: 5,
        kind: 'ganho',
        source: 'scene',
        reason: 'Cena semanal',
        related_id: 'scene-1',
        created_by: 'narrador',
        metadata_json: '{"scene":1}',
    }]);

    assert.equal((await db.get(
        'SELECT COUNT(*) AS n FROM jogadores WHERE id IN (?, ?)',
        [fixture.blockedSource, fixture.blockedCanonical]
    )).n, 2);
    await db.close();
});

test('V2 bloqueia divergência real em chave única e mantém o banco intacto', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-identity-v2-conflict-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = await createFixture(root);

    const db = await open({ filename: fixture.dbFile, driver: sqlite3.Database });
    await db.run(
        'UPDATE group_member_welcomes SET message_id = ? WHERE group_id = ? AND player_id = ?',
        ['canonica-diferente', 'grupo-1', fixture.canonicalId]
    );
    await db.close();

    const before = await snapshot(fixture.dbFile);
    const result = execute(fixture, root, false);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Conflito semântico em group_member_welcomes\.player_id/);
    assert.deepEqual(await snapshot(fixture.dbFile), before);
});

test('V2 recusa aplicação sem confirmação literal', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-identity-v2-confirm-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = await createFixture(root);

    const result = execute(fixture, root, true, false);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APPLY_READY_IDENTITY_REPAIRS/);
});
