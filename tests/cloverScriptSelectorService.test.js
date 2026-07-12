const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const { ensureTargetResolverTables } = require('../helpers/clover/targetResolverSchemaGuard');
const {
    expandSelectorScript,
    hasSelectorTargets,
    parseFilterExpression,
    selectPlayers,
    selectorFromLine,
} = require('../helpers/clover/cloverScriptSelectorService');
const { resolveCommand } = require('../helpers/commandRegistry');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            jogo_status TEXT,
            ficha_status TEXT,
            historia_status TEXT,
            personagem_aparencia_status TEXT,
            esquadrao TEXT,
            lifecycle_status TEXT DEFAULT 'active',
            patente TEXT DEFAULT '-',
            reino TEXT DEFAULT 'Clover',
            is_shadow INTEGER DEFAULT 0,
            canonical_player_id TEXT DEFAULT NULL,
            merged_into TEXT DEFAULT NULL,
            identity_status TEXT DEFAULT 'active'
        );

        CREATE TABLE clover_antighost_activity (
            player_id TEXT PRIMARY KEY,
            community_status TEXT DEFAULT 'unknown',
            last_activity_at TEXT DEFAULT NULL
        );
    `);
    await ensureTargetResolverTables(db);
    return db;
}

async function addPlayer(db, values) {
    await db.run(
        `INSERT INTO jogadores
         (id, nome, display_name, personagem_nome, jogo_status, ficha_status,
          historia_status, personagem_aparencia_status, esquadrao, lifecycle_status,
          patente, reino, is_shadow, canonical_player_id, merged_into, identity_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            values.id,
            values.nome || values.personagem || '-',
            values.displayName || values.personagem || '-',
            values.personagem ?? '-',
            values.jogo || 'liberado',
            values.ficha || 'aprovada',
            values.historia || 'aprovada',
            values.aparencia || 'approved',
            values.esquadrao || '-',
            values.lifecycle || 'active',
            values.patente || 'Cavaleiro Novato',
            values.reino || 'Clover',
            values.shadow ? 1 : 0,
            values.canonicalPlayerId || null,
            values.mergedInto || null,
            values.identityStatus || 'active',
        ]
    );
    if (values.community || values.lastActivity) {
        await db.run(
            `INSERT INTO clover_antighost_activity
             (player_id, community_status, last_activity_at)
             VALUES (?, ?, ?)`,
            [values.id, values.community || 'unknown', values.lastActivity || null]
        );
    }
}

async function seed(db) {
    await addPlayer(db, {
        id: 'asta@lid',
        personagem: 'Asta',
        esquadrao: 'Touros Negros',
        community: 'in',
        lastActivity: '2026-07-11 12:00:00',
    });
    await addPlayer(db, {
        id: 'noelle@lid',
        personagem: 'Noelle Silva',
        esquadrao: 'Touros Negros',
        community: 'out',
        lastActivity: '2026-06-20 12:00:00',
    });
    await addPlayer(db, {
        id: 'yuno@lid',
        personagem: 'Yuno',
        esquadrao: 'Alvorecer Dourado',
        community: 'in',
        lastActivity: '2026-07-12 09:00:00',
    });
    await addPlayer(db, {
        id: 'sem-personagem@lid',
        personagem: '-',
        esquadrao: 'Touros Negros',
        community: 'out',
        lastActivity: '2026-06-01 09:00:00',
    });
    await addPlayer(db, {
        id: 'sombra@lid',
        personagem: 'Espelho',
        esquadrao: 'Touros Negros',
        shadow: true,
        mergedInto: 'asta@lid',
        identityStatus: 'merged',
    });
}

test('detecta linhas ALVOS onde e TODOS', () => {
    assert.equal(hasSelectorTargets('ALVOS onde jogo=liberado confirmar=true\nPH +10 motivo="x"\nFIM'), true);
    assert.equal(hasSelectorTargets('TODOS jogo=liberado confirmar=true\nPH +10 motivo="x"\nFIM'), true);
    assert.equal(hasSelectorTargets('ALVOS lista="x"\nPH +10 motivo="x"\nFIM'), false);
});

test('analisa filtros com aspas e comparadores', () => {
    const filters = parseFilterExpression(
        'jogo=liberado esquadrao="Touros Negros" dias_inativo>=10 confirmar=true',
        3
    );
    assert.deepEqual(filters.map((filter) => [filter.key, filter.operator, filter.value]), [
        ['jogo_status', '=', 'liberado'],
        ['esquadrao', '=', 'Touros Negros'],
        ['inactive_days', '>=', '10'],
    ]);
});

test('exige confirmação e rejeita inclusão de sombras', () => {
    assert.throws(
        () => parseFilterExpression('jogo=liberado', 1),
        (error) => error.code === 'selector_confirmation_required'
    );
    assert.throws(
        () => parseFilterExpression('jogo=liberado sombra=true confirmar=true', 1),
        (error) => error.code === 'shadow_selector_forbidden'
    );
});

test('seleciona players canônicos e deduplica cadastro sombra', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seed(db);

    const selector = selectorFromLine(
        'ALVOS onde jogo=liberado esquadrao="Touros Negros" confirmar=true',
        1
    );
    const result = await selectPlayers(db, selector, {
        actorId: OWNER,
        now: new Date('2026-07-12T12:00:00Z'),
    });

    assert.deepEqual(result.players.map((player) => player.id).sort(), ['asta@lid', 'noelle@lid']);
    assert.equal(result.excluded.personagem_ausente, 1);
    assert.equal(result.players.filter((player) => player.id === 'asta@lid').length, 1);
});

test('filtra comunidade e dias de inatividade', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seed(db);

    const selector = selectorFromLine(
        'ALVOS onde comunidade=fora dias_inativo>=10 jogo=liberado confirmar=true',
        1
    );
    const result = await selectPlayers(db, selector, {
        actorId: OWNER,
        now: new Date('2026-07-12T12:00:00Z'),
    });

    assert.deepEqual(result.players.map((player) => player.id), ['noelle@lid']);
});

test('expande cada player em bloco ALVO canônico preservando ações', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seed(db);

    const script = [
        'LOTE id="touros" nome="Touros" modo=rigido',
        '',
        'ALVOS onde jogo=liberado esquadrao="Touros Negros" confirmar=true',
        'PH +12 fonte=missao_esquadrao teto=fora motivo="Missão concluída"',
        'ESTRELAS +1 alvo=esquadrao motivo="Missão concluída"',
        'FIM',
    ].join('\n');
    const expanded = await expandSelectorScript(db, script, {
        actorId: OWNER,
        now: new Date('2026-07-12T12:00:00Z'),
    });

    assert.equal(expanded.expanded, true);
    assert.equal(expanded.selections[0].players.length, 2);
    assert.match(expanded.scriptText, /ALVO id="asta@lid" confirmar=true/);
    assert.match(expanded.scriptText, /ALVO id="noelle@lid" confirmar=true/);
    assert.equal((expanded.scriptText.match(/PH \+12/g) || []).length, 2);
    assert.equal((expanded.scriptText.match(/^FIM$/gm) || []).length, 2);
    assert.match(expanded.summaryText, /2 player\(s\)/);
});

test('seletor não aceita ações protegidas em massa', async (t) => {
    const db = await createDb();
    t.after(() => db.close());
    await seed(db);

    const script = [
        'ALVOS onde jogo=liberado confirmar=true',
        'PLAYER arquivar motivo="Teste" confirmar=true',
        'FIM',
    ].join('\n');
    await assert.rejects(
        expandSelectorScript(db, script, { actorId: OWNER }),
        (error) => error.code === 'protected_action_selector_forbidden'
    );
});

test('comando específico de simulação vence o comando base no registro', () => {
    const base = require('../comandos/cloverScript');
    const simulation = require('../comandos/cloverSimulation');
    const commands = new Map([
        [base.nome, base],
        [simulation.nome, simulation],
    ]);
    const resolved = resolveCommand('.#clover simular\nALVO id="x"\nFIM', commands);
    assert.equal(resolved.command, simulation);
    assert.match(resolved.body, /ALVO id="x"/);
});
