'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    getCloverGroup,
    getCloverGroups,
    isConfiguredCloverGroup,
    parseConfiguredCloverGroups,
    setCloverGroup,
} = require('../helpers/clover/groupManager');
const {
    looksLikeQuickEvaluation,
    parseEvaluation,
    renderQuickEvaluationSuccess,
} = require('../helpers/clover/quickEvaluationService');

async function createSettingsDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    return db;
}

test('parseConfiguredCloverGroups preserva valor legado unico', () => {
    assert.deepEqual(parseConfiguredCloverGroups('111@g.us'), ['111@g.us']);
});

test('parseConfiguredCloverGroups aceita JSON e deduplica', () => {
    assert.deepEqual(
        parseConfiguredCloverGroups(JSON.stringify(['111@g.us', '222@g.us', '111@g.us'])),
        ['111@g.us', '222@g.us']
    );
});

test('parseConfiguredCloverGroups aceita CSV e quebras de linha', () => {
    assert.deepEqual(
        parseConfiguredCloverGroups('111@g.us, 222@g.us\n333@g.us;222@g.us'),
        ['111@g.us', '222@g.us', '333@g.us']
    );
});

test('setCloverGroup acumula grupos ON e getCloverGroup preserva compatibilidade', async (t) => {
    const db = await createSettingsDb();
    t.after(() => db.close());

    await setCloverGroup(db, 'on', '111@g.us');
    await setCloverGroup(db, 'on', '222@g.us');
    await setCloverGroup(db, 'on', '111@g.us');

    assert.deepEqual(await getCloverGroups(db, 'on'), ['222@g.us', '111@g.us']);
    assert.equal(await getCloverGroup(db, 'on'), '111@g.us');
    assert.equal(await isConfiguredCloverGroup(db, 'on', '222@g.us'), true);
    assert.equal(await isConfiguredCloverGroup(db, 'on', '333@g.us'), false);
});

test('setCloverGroup mantem grupo unico para tipos nao-ON', async (t) => {
    const db = await createSettingsDb();
    t.after(() => db.close());

    await setCloverGroup(db, 'off', '111@g.us');
    await setCloverGroup(db, 'off', '222@g.us');

    assert.deepEqual(await getCloverGroups(db, 'off'), ['222@g.us']);
});

test('detecta ficha tradicional de avaliacao rapida', () => {
    const text = [
        'Ficha de Avaliacao',
        'Pessoa: Jogador Teste',
        'PH: 10',
        'Yulls: 100',
        'Tipo de treino: (x) Treino Solo',
    ].join('\n');

    assert.equal(looksLikeQuickEvaluation(text), true);
    const parsed = parseEvaluation(text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.modality.key, 'treino_solo');
});

test('detecta ficha estrutural sem marca Clover', () => {
    const text = [
        'Pessoa: Jogador Teste',
        'PH: 20',
        'Estrelas: 1',
        'Inventario: Gancho narrativo',
        'Modalidade: (x) Cena Interativa',
    ].join('\n');

    assert.equal(looksLikeQuickEvaluation(text), true);
});

test('nao gera falso positivo com texto solto', () => {
    const text = 'Hoje teve treino legal e talvez renda PH algum dia, mas sem ficha nem campos estruturais.';

    assert.equal(looksLikeQuickEvaluation(text), false);
});

test('recibo de sucesso renderiza uma unica confirmacao aplicada', () => {
    const receipt = renderQuickEvaluationSuccess({
        player: {
            id: '5511999990000@s.whatsapp.net',
            personagem_nome: 'Player Teste',
            esquadrao: null,
        },
        data: {
            modality: { label: 'Treino Solo', bypassWeeklyLimit: false },
            salaryEligible: false,
            ph: 10,
            yulls: 500,
            stars: 0,
        },
        inventoryItems: [],
        phResult: null,
        weeklyAfter: 10,
        squadAfter: null,
        squadSync: null,
        yullsAfter: 500,
        starsAfter: 0,
    });

    assert.equal((receipt.match(/recompensas registradas/gi) || []).length, 1);
    assert.match(receipt, /Player Teste/);
});
