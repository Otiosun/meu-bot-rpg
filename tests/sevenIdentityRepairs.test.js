'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const planner = path.join(__dirname, '..', 'scripts', 'planSevenIdentityRepairs.js');
const executor = path.join(__dirname, '..', 'scripts', 'executeSevenIdentityRepairs.js');

const cases = [
    ['5511959362194', '206545145098459@lid', '206545145098459@lid', 'manual', 'Alpha'],
    ['554799685887', '86663984324791@lid', '554799685887@s.whatsapp.net', 'manual', 'Beta'],
    ['559985412280', '149701705904226@lid', '149701705904226@lid', 'manual', 'Gamma'],
    ['244947382093', '65683454992605@lid', '244947382093@s.whatsapp.net', 'migration', 'Delta'],
    ['5521982456465', '42297542578405@lid', '5521982456465@s.whatsapp.net', 'migration', 'Maksim'],
    ['557999178806', '19533913923724@lid', '557999178806@s.whatsapp.net', 'migration', 'Zeta'],
    ['559888768701', '76738801471621@lid', '559888768701@s.whatsapp.net', 'migration', 'Eta'],
];

function source(phone) {
    return `${phone}@s.whatsapp.net`;
}

function run(script, args) {
    return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

async function fixture(root) {
    const dbFile = path.join(root, 'seven.sqlite');
    const db = await open({ filename: dbFile, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            personagem_nome TEXT,
            magia TEXT,
            grimorio TEXT,
            ficha_status TEXT,
            jogo_status TEXT,
            canonical_player_id TEXT,
            merged_into TEXT
        );
        CREATE TABLE clover_archive_cards (
            player_id TEXT PRIMARY KEY,
            title TEXT,
            note TEXT
        );
    `);

    for (const [phone, canonical, owner, , name] of cases) {
        const sourceId = source(phone);
        const ownerIsSource = owner === sourceId;
        const canonicalMagic = ownerIsSource || phone === '5511959362194'
            ? null
            : `${name} Magia`;
        await db.run(
            'INSERT INTO jogadores VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [canonical, ownerIsSource ? `${name} Placeholder` : name, ownerIsSource ? '-' : `${name} Personagem`, canonicalMagic, phone === '554799685887' ? 'Grimório preservado' : '-', ownerIsSource ? 'incompleta' : 'aprovada', ownerIsSource ? 'bloqueado' : 'liberado', canonical, null]
        );
        await db.run(
            'INSERT INTO jogadores VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [sourceId, ownerIsSource ? name : 'Cacador', ownerIsSource ? `${name} Personagem` : '-', ownerIsSource ? `${name} Magia` : phone === '5511959362194' ? 'Magia complementar' : null, '-', ownerIsSource ? 'aprovada' : 'incompleta', ownerIsSource ? 'liberado' : 'bloqueado', sourceId, sourceId]
        );
    }

    await db.run('INSERT INTO clover_archive_cards VALUES (?, ?, ?)', [source('554799685887'), 'Ficha Beta', 'principal']);
    await db.run('INSERT INTO clover_archive_cards VALUES (?, ?, ?)', ['86663984324791@lid', 'Ficha Placeholder', null]);
    await db.close();

    const groups = cases.map(([phone, canonical, owner, kind]) => {
        const refs = [{ table: 'jogadores', column: 'id', rows: 1, strategy: 'source_record' }];
        if (phone === '554799685887') refs.push({ table: 'clover_archive_cards', column: 'player_id', rows: 1, strategy: 'unknown' });
        return {
            phone,
            classification: kind === 'manual' ? 'manual_merge_required' : 'canonical_migration_required',
            canonicalId: canonical,
            dataOwnerId: owner,
            action: kind === 'manual' ? 'blocked_manual_merge' : 'transactional_canonical_migration',
            readyForExecutor: false,
            sources: [{
                sourceId: source(phone),
                references: refs,
                unknownReferences: refs.filter((ref) => ref.strategy === 'unknown'),
            }],
        };
    });

    const basePlan = path.join(root, 'identity-repair-plan-base.json');
    fs.writeFileSync(basePlan, JSON.stringify({ readOnly: true, database: dbFile, groups }, null, 2));
    return { dbFile, basePlan };
}

async function players(dbFile) {
    const db = await open({ filename: dbFile, driver: sqlite3.Database });
    const rows = await db.all('SELECT * FROM jogadores ORDER BY id');
    await db.close();
    return rows;
}

test('consolida os sete casos, preserva o dono dos dados e registra auditoria', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-seven-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const data = await fixture(root);

    const planned = run(planner, [`--plan=${data.basePlan}`, `--output=${root}`]);
    assert.equal(planned.status, 0, planned.stderr || planned.stdout);
    assert.match(planned.stdout, /Casos preparados: 7/);

    const planFile = path.join(root, fs.readdirSync(root).find((name) => name.startsWith('identity-seven-repair-plan-')));
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    assert.equal(plan.groups.length, 7);
    assert.equal(plan.groups.filter((group) => group.action === 'transactional_manual_merge').length, 3);

    const before = await players(data.dbFile);
    const dry = run(executor, [`--db=${data.dbFile}`, `--plan=${planFile}`, `--output=${root}`]);
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    assert.deepEqual(await players(data.dbFile), before);

    const applied = run(executor, [
        `--db=${data.dbFile}`,
        `--plan=${planFile}`,
        `--output=${root}`,
        '--apply',
        '--confirm=APPLY_SEVEN_IDENTITY_REPAIRS',
    ]);
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    assert.match(applied.stdout, /Casos processados: 7/);
    assert.match(applied.stdout, /Commit no banco: SIM/);

    const db = await open({ filename: data.dbFile, driver: sqlite3.Database });
    for (const [phone, canonical, , , name] of cases) {
        assert.equal((await db.get('SELECT COUNT(*) AS total FROM jogadores WHERE id = ?', [source(phone)])).total, 0);
        const row = await db.get('SELECT * FROM jogadores WHERE id = ?', [canonical]);
        assert.ok(row);
        assert.equal(row.nome, name);
        assert.equal(row.canonical_player_id, canonical);
        assert.notEqual(row.merged_into, canonical);
    }
    assert.equal((await db.get('SELECT magia FROM jogadores WHERE id = ?', ['206545145098459@lid'])).magia, 'Magia complementar');
    assert.equal((await db.get('SELECT grimorio FROM jogadores WHERE id = ?', ['86663984324791@lid'])).grimorio, 'Grimório preservado');
    assert.equal((await db.get('SELECT title FROM clover_archive_cards WHERE player_id = ?', ['86663984324791@lid'])).title, 'Ficha Beta');
    assert.equal((await db.get('SELECT COUNT(*) AS total FROM clover_identity_merge_events')).total, 1);
    await db.close();
});
