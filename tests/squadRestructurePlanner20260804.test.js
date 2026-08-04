'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    SANITIZED_EXAMPLE_SOURCE_PATH,
    chooseMatch,
    graphCandidatesFromAuthInfo,
    loadTargetSource,
    normalizeTargetSource,
    planSquadRestructure,
} = require('../scripts/planSquadRestructure20260804.cjs');
const {
    CONFIRMATION,
    assertApplyAuthorized,
} = require('../scripts/applySquadRestructure20260804.cjs');
const { containsSensitiveValue } = require('../scripts/checkSquadRestructurePii.cjs');

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            nome_real TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            esquadrao TEXT,
            ficha_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado',
            identity_status TEXT DEFAULT 'active',
            lifecycle_status TEXT DEFAULT 'active',
            is_shadow INTEGER DEFAULT 0,
            merged_into TEXT
        );
        CREATE TABLE clover_character_stats (
            player_id TEXT PRIMARY KEY,
            distribution_status TEXT
        );
        CREATE TABLE clover_squad_memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            squad_key TEXT,
            player_id TEXT,
            status TEXT
        );
    `);
    return db;
}

async function addPlayer(db, id, name, squad = '-', overrides = {}) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, esquadrao, ficha_status, jogo_status,
          identity_status, lifecycle_status, is_shadow, merged_into)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            overrides.nome || name,
            overrides.display_name || name,
            overrides.personagem_nome === undefined ? name : overrides.personagem_nome,
            squad,
            overrides.ficha_status || 'aprovada',
            overrides.jogo_status || 'liberado',
            overrides.identity_status || 'active',
            overrides.lifecycle_status || 'active',
            overrides.is_shadow || 0,
            overrides.merged_into || null,
        ]
    );
}

function targetEntry(raw) {
    return normalizeTargetSource({
        source: 'unit-test',
        squads: { destino: { name: 'Destino', entries: [raw] } },
    }).squads.destino.entries[0];
}

test('fonte estruturada preserva aliases controlados e source', () => {
    const source = loadTargetSource(SANITIZED_EXAMPLE_SOURCE_PATH);
    const example = source.squads.example_squad.entries[0];

    assert.equal(source.source, 'sanitized-example');
    assert.equal(example.source, 'example');
    assert.deepEqual(
        example.aliases.map((alias) => [alias.type, alias.value, alias.source]),
        [
            ['name', 'Example Alias', 'sanitized-example'],
            ['jid', 'controlled-example@lid', 'sanitized-example'],
        ]
    );
});

test('chooseMatch usa alias JID controlado sem fuzzy global', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db, 'controlled-example@lid', 'Example Character', 'Origem');

    const target = targetEntry({
        personagem: 'Example Character',
        aliases: [{ type: 'jid', value: 'controlled-example@lid', source: 'unit-test' }],
    });
    const players = await db.all('SELECT * FROM jogadores');
    const result = await chooseMatch(db, players, target);

    assert.equal(result.status, 'matched');
    assert.equal(result.method, 'controlled_jid');
    assert.equal(result.player.id, 'controlled-example@lid');
});

test('grafo auth_info resolve telefone para LID mapeado', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-auth-graph-'));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    fs.writeFileSync(
        path.join(tempDir, 'lid-mapping-9999222.json'),
        JSON.stringify({ lid: '2222222@lid' })
    );

    const candidates = graphCandidatesFromAuthInfo('9999222', tempDir);
    assert.deepEqual(candidates.sort(), [
        '2222222@lid',
        '9999222@s.whatsapp.net',
    ]);
});

test('planner classifica transferencias, corretos, extras e unresolved sem escrever', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db, '1000001@s.whatsapp.net', 'Player Um', 'Origem');
    await addPlayer(db, '1000002@s.whatsapp.net', 'Player Dois', 'Destino');
    await addPlayer(db, '1000003@s.whatsapp.net', 'Extra Local', 'Destino');
    await db.run(
        `INSERT INTO clover_squad_memberships (squad_key, player_id, status)
         VALUES ('origem', '1000001@s.whatsapp.net', 'active'),
                ('destino', '1000002@s.whatsapp.net', 'active')`
    );

    const plan = await planSquadRestructure(db, {
        targets: {
            source: 'unit-test',
            squads: {
                destino: {
                    name: 'Destino',
                    entries: [
                        { personagem: 'Player Dois', phone: '1000002', source: 'current' },
                        { personagem: 'Player Um', phone: '1000001', source: 'add' },
                        { personagem: 'Sem Cadastro', source: 'add' },
                    ],
                },
            },
        },
    });

    assert.equal(plan.readOnly, true);
    assert.equal(plan.SafeToDeploy, false);
    assert.equal(plan.counts.needs_transfer, 1);
    assert.equal(plan.counts.already_correct, 1);
    assert.equal(plan.counts.unresolved, 1);
    assert.equal(plan.counts.needs_admission, 0);
    assert.equal(plan.extras.length, 1);
    assert.equal(plan.SafeToApply, false);
    assert.equal(plan.items[0].player.ficha_status, 'aprovada');
    assert.equal(plan.items[0].player.jogo_status, 'liberado');
    assert.equal(plan.items[0].player.identity_state, 'active');
    assert.equal(plan.items[0].player.lifecycle_status, 'active');
    assert.equal(plan.items[0].player.merged_into, null);
    assert.equal(plan.items[0].player.active_memberships.length, 1);

    const unchanged = await db.get(
        'SELECT esquadrao FROM jogadores WHERE id = ?',
        ['1000001@s.whatsapp.net']
    );
    assert.equal(unchanged.esquadrao, 'Origem');
});

test('registros com personagem vazio ou hifen ficam identity_only ou ineligible', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db, '3000001@s.whatsapp.net', 'Pessoa Sem Personagem', 'Origem');
    await addPlayer(db, '3000002@s.whatsapp.net', 'Pessoa Bloqueada', 'Origem', {
        personagem_nome: '-',
        ficha_status: 'incompleta',
        jogo_status: 'bloqueado',
    });

    const plan = await planSquadRestructure(db, {
        targets: {
            source: 'unit-test',
            squads: {
                destino: {
                    name: 'Destino',
                    entries: [
                        { personagem: '-', phone: '3000001', source: 'identity-list' },
                        { personagem: '-', phone: '3000002', source: 'identity-list' },
                    ],
                },
            },
        },
    });

    assert.deepEqual(plan.items.map((item) => item.status), ['identity_only', 'ineligible']);
    assert.equal(plan.counts.needs_transfer || 0, 0);
    assert.equal(plan.SafeToApply, false);
});

test('planner marca ambiguidade, ineligible e divergencia de membership como inseguras', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db, '2000001@s.whatsapp.net', 'Nome Duplicado', 'Destino');
    await addPlayer(db, '2000002@s.whatsapp.net', 'Nome Duplicado', 'Outro');
    await addPlayer(db, '2000003@s.whatsapp.net', 'Player Bloqueado', 'Outro', {
        jogo_status: 'bloqueado',
    });
    await db.run(
        `INSERT INTO clover_squad_memberships (squad_key, player_id, status)
         VALUES ('outro', '2000001@s.whatsapp.net', 'active')`
    );

    const plan = await planSquadRestructure(db, {
        targets: {
            source: 'unit-test',
            squads: {
                destino: {
                    name: 'Destino',
                    entries: [
                        { personagem: 'Nome Duplicado', source: 'current' },
                        { personagem: 'Player Bloqueado', phone: '2000003', source: 'add' },
                    ],
                },
            },
        },
    });

    assert.equal(plan.counts.ambiguous, 1);
    assert.equal(plan.counts.ineligible, 1);
    assert.equal(plan.membership.projectionConflicts.length, 1);
    assert.equal(plan.SafeToApply, false);
});

test('dois candidatos elegiveis com scores legados diferentes continuam ambiguous', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db, 'candidate-a@lid', 'Nome Compartilhado');
    await addPlayer(db, 'candidate-b@lid', 'Nome Compartilhado');
    await db.run(
        `INSERT INTO clover_character_stats (player_id, distribution_status)
         VALUES ('candidate-a@lid', 'confirmed'), ('candidate-b@lid', 'pending')`
    );

    const players = await db.all(
        `SELECT jogadores.*, clover_character_stats.distribution_status
         FROM jogadores
         LEFT JOIN clover_character_stats ON clover_character_stats.player_id = jogadores.id`
    );
    const result = await chooseMatch(db, players, targetEntry({ personagem: 'Nome Compartilhado' }));

    assert.equal(result.status, 'ambiguous');
    assert.equal(result.candidates.length, 2);
});

test('alias JID controlado nao e contaminado pelo telefone direto', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db, 'controlled-alpha@lid', 'Identidade Controlada');
    await addPlayer(db, '1000099@s.whatsapp.net', 'Identidade Telefonica');

    const target = targetEntry({
        personagem: 'Identidade Controlada',
        phone: '1000099',
        aliases: [{ type: 'jid', value: 'controlled-alpha@lid', source: 'unit-test' }],
    });
    const result = await chooseMatch(db, await db.all('SELECT * FROM jogadores'), target);

    assert.equal(result.status, 'matched');
    assert.equal(result.method, 'controlled_jid');
    assert.equal(result.player.id, 'controlled-alpha@lid');
});

test('identidade archived e ineligible', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db, 'archived-player@lid', 'Archived Player', '-', { identity_status: 'archived' });

    const plan = await planSquadRestructure(db, {
        targets: { source: 'unit-test', squads: { destino: { entries: [{ personagem: 'Archived Player' }] } } },
    });
    assert.equal(plan.items[0].status, 'ineligible');
});

test('lifecycle inativo e ineligible', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db, 'inactive-player@lid', 'Inactive Player', '-', { lifecycle_status: 'inactive' });

    const plan = await planSquadRestructure(db, {
        targets: { source: 'unit-test', squads: { destino: { entries: [{ personagem: 'Inactive Player' }] } } },
    });
    assert.equal(plan.items[0].status, 'ineligible');
});

test('identidade com merged_into preenchido e ineligible', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db, 'merged-player@lid', 'Merged Player', '-', { merged_into: 'canonical-player@lid' });

    const plan = await planSquadRestructure(db, {
        targets: { source: 'unit-test', squads: { destino: { entries: [{ personagem: 'Merged Player' }] } } },
    });
    assert.equal(plan.items[0].status, 'ineligible');
});

test('jogador sem membership e sem projecao vira needs_admission', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db, 'admission-player@lid', 'Admission Player', '-');

    const plan = await planSquadRestructure(db, {
        targets: { source: 'unit-test', squads: { destino: { entries: [{ personagem: 'Admission Player' }] } } },
    });
    assert.equal(plan.items[0].status, 'needs_admission');
    assert.equal(plan.items[0].player.active_memberships.length, 0);
});

test('jogador com membership ativo coerente na origem vira needs_transfer', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await addPlayer(db, 'transfer-player@lid', 'Transfer Player', 'Origem');
    await db.run(
        `INSERT INTO clover_squad_memberships (squad_key, player_id, status)
         VALUES ('origem', 'transfer-player@lid', 'active')`
    );

    const plan = await planSquadRestructure(db, {
        targets: { source: 'unit-test', squads: { destino: { entries: [{ personagem: 'Transfer Player' }] } } },
    });
    assert.equal(plan.items[0].status, 'needs_transfer');
    assert.equal(plan.items[0].player.active_memberships[0].squad_key, 'origem');
});

test('apply permanece explicitamente indisponivel nesta PR', () => {
    assert.throws(
        () => assertApplyAuthorized({ apply: true, confirm: CONFIRMATION, actor: 'owner@lid' }),
        { code: 'apply_unavailable' }
    );
});

test('verificador de PII rejeita telefone e LID completos e aceita exemplo sanitizado', () => {
    const numericPhone = ['5511999', '999999'].join('');
    const numericLid = ['1234567', '89012345'].join('');
    assert.equal(containsSensitiveValue(`{"phone":"${numericPhone}"}`), true);
    assert.equal(containsSensitiveValue(`{"value":"${numericLid}@lid"}`), true);
    assert.equal(containsSensitiveValue('{"phoneLast4":"9999","value":"controlled-example@lid"}'), false);
});
