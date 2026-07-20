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
    const dbFile = path.join(root, 'partial-unique.sqlite');
    const db = await open({ filename: dbFile, driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            canonical_player_id TEXT
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

        CREATE UNIQUE INDEX idx_clover_ph_initial_once
        ON clover_ph_ledger(player_id, source, related_id)
        WHERE source = 'initial_ph' AND related_id = 'initial_ph_v1';
    `);

    const sourceId = '244952203657@s.whatsapp.net';
    const canonicalId = '59537340022832@lid';

    await db.run('INSERT INTO jogadores VALUES (?, ?, ?)', [sourceId, 'Cacador', null]);
    await db.run('INSERT INTO jogadores VALUES (?, ?, ?)', [canonicalId, 'Jogador Real', canonicalId]);

    await db.run(
        `INSERT INTO clover_ph_ledger
         (player_id, amount, kind, source, reason, related_id, created_by, metadata_json)
         VALUES (?, 15, 'ganho', 'initial_ph', NULL, 'initial_ph_v1', 'system', NULL)`,
        [canonicalId]
    );
    await db.run(
        `INSERT INTO clover_ph_ledger
         (player_id, amount, kind, source, reason, related_id, created_by, metadata_json)
         VALUES (?, 15, 'ganho', 'initial_ph', 'PH inicial do personagem', 'initial_ph_v1', 'system', ?)`,
        [sourceId, '{"initial_ph":true,"version":1}']
    );

    await db.close();

    const planFile = path.join(root, 'identity-repair-plan-partial.json');
    fs.writeFileSync(planFile, JSON.stringify({
        readOnly: true,
        groups: [{
            phone: '244952203657',
            action: 'transactional_alias_consolidation_ready',
            readyForExecutor: true,
            canonicalId,
            dataOwnerId: canonicalId,
            sources: [{
                sourceId,
                unknownReferences: [],
                references: [
                    { table: 'jogadores', column: 'id', rows: 1, strategy: 'source_record' },
                    { table: 'clover_ph_ledger', column: 'player_id', rows: 1, strategy: 'repoint_history' },
                ],
            }],
        }],
    }, null, 2));

    return { dbFile, planFile, sourceId, canonicalId };
}

function execute(fixture, root, apply = false) {
    const args = [
        SCRIPT,
        `--db=${fixture.dbFile}`,
        `--plan=${fixture.planFile}`,
        `--output=${root}`,
    ];
    if (apply) {
        args.push('--apply', '--confirm=APPLY_READY_IDENTITY_REPAIRS');
    }
    return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

async function snapshot(dbFile) {
    const db = await open({ filename: dbFile, driver: sqlite3.Database });
    const rows = {
        jogadores: await db.all('SELECT * FROM jogadores ORDER BY id'),
        ledger: await db.all('SELECT * FROM clover_ph_ledger ORDER BY id'),
    };
    await db.close();
    return rows;
}

test('simulação reconhece índice parcial de PH e reverte integralmente', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-partial-dry-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = await createFixture(root);
    const before = await snapshot(fixture.dbFile);

    const result = execute(fixture, root, false);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /SIMULAÇÃO COM ROLLBACK/);
    assert.deepEqual(await snapshot(fixture.dbFile), before);
});

test('aplicação consolida duplicata protegida por índice parcial', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-partial-apply-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = await createFixture(root);

    const result = execute(fixture, root, true);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Commit no banco: SIM/);

    const db = await open({ filename: fixture.dbFile, driver: sqlite3.Database });
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM jogadores WHERE id = ?', [fixture.sourceId])).n, 0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM jogadores WHERE id = ?', [fixture.canonicalId])).n, 1);

    const ledger = await db.all(
        `SELECT player_id, amount, kind, source, reason, related_id, created_by, metadata_json
         FROM clover_ph_ledger`
    );
    assert.deepEqual(ledger, [{
        player_id: fixture.canonicalId,
        amount: 15,
        kind: 'ganho',
        source: 'initial_ph',
        reason: 'PH inicial do personagem',
        related_id: 'initial_ph_v1',
        created_by: 'system',
        metadata_json: '{"initial_ph":true,"version":1}',
    }]);
    await db.close();
});
