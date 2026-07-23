'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    PRESENTATION_SCHEMA_VERSION,
    buildCharacterPresentation,
    cleanText,
    getCharacterPresentation,
    repairDisplayText,
    withCapacitySummary,
} = require('../helpers/clover/characterPresentationService');

const legacy = require('./fixtures/characterPresentation/legacy-fragmented.json');
const rich = require('./fixtures/characterPresentation/catalog-rich.json');

function serialized(value) {
    return JSON.stringify(value);
}

function collectKeys(value, result = []) {
    if (!value || typeof value !== 'object') return result;
    if (Array.isArray(value)) {
        value.forEach((item) => collectKeys(item, result));
        return result;
    }
    for (const [key, nested] of Object.entries(value)) {
        result.push(key);
        collectKeys(nested, result);
    }
    return result;
}

test('converte fontes fragmentadas em contrato canônico sem stringify acidental', () => {
    const presentation = buildCharacterPresentation(legacy, {
        audience: 'player',
        generatedAt: '2026-07-23T03:00:00.000Z',
    });

    assert.equal(presentation.schemaVersion, PRESENTATION_SCHEMA_VERSION);
    assert.equal(presentation.audience, 'player');
    assert.equal(presentation.identity.name, 'Emil de Teste');
    assert.equal(presentation.identity.family.name, 'Sem linhagem registrada');
    assert.doesNotMatch(serialized(presentation), /\[object Object\]/);

    assert.deepEqual(
        presentation.narrative.fixedTraits.map((item) => item.name),
        ['Corpo de Rotina', 'Mãos que Tremem']
    );
    assert.equal(presentation.narrative.extraTraits.length, 1);
    assert.equal(presentation.narrative.extraTraits[0].name, 'Corpo de Combate');
    assert.equal(presentation.narrative.hooks.length, 1);
    assert.equal(presentation.narrative.hooks[0].title, 'O Sussurro do Vento');
    assert.equal(presentation.narrative.hooks[0].body, 'Às vezes uma voz incompreensível surge no vento.');

    assert.equal(presentation.progression.stage, '7º Estágio');
    assert.equal(presentation.progression.hexagon.labels.range, '12 metros');
    assert.ok(presentation.capabilities.practicalAbilities.includes('Criação: criar formas simples'));
    assert.ok(presentation.capabilities.currentLimits.includes('Alcance comum: 12 metros.'));
});

test('remove vazios, deduplica conteúdo e preserva texto autoral sem inventar descrição', () => {
    const presentation = buildCharacterPresentation(legacy, { audience: 'player' });

    assert.equal(presentation.narrative.fixedTraits.length, 2);
    assert.equal(presentation.narrative.fixedTraits[0].description, null);
    assert.equal(presentation.narrative.fixedTraits[0].hasDescription, false);
    assert.equal(presentation.narrative.extraAnomalies.length, 0);
    assert.ok(!presentation.narrative.fixedTraits.some((item) => ['-', '—'].includes(item.name)));
});

test('separa bônus, penalidades, descontos e avisos do sistema', () => {
    const presentation = buildCharacterPresentation(legacy, { audience: 'narrator' });

    assert.equal(presentation.modifiers.discounts.length, 1);
    assert.equal(presentation.modifiers.discounts[0].label, 'Árvore Física');
    assert.equal(presentation.modifiers.discounts[0].effect, '10%');
    assert.ok(!presentation.modifiers.discounts.some((item) => item.effect === '0%'));

    assert.ok(presentation.modifiers.penalties.some((item) => item.effect.includes('Resistência -40%')));
    assert.ok(!presentation.modifiers.penalties.some((item) => item.effect.includes('-5% no gasto de mana')));
    assert.ok(presentation.modifiers.conditional.some((item) => item.effect.includes('-5% no gasto de mana')));
    assert.equal(presentation.modifiers.notices.length, 2);
    assert.ok(presentation.modifiers.notices.every((item) => item.source === 'Bônus condicionado'));
});

test('apresenta família estruturada, traços completos e remove duplicatas normalizadas', () => {
    const presentation = buildCharacterPresentation(rich, { audience: 'player' });

    assert.deepEqual(presentation.identity.family, {
        name: 'Rosier',
        summary: 'Linhagem associada ao cultivo mágico de rosas.',
        notes: ['Afinidade narrativa com botânica arcana.'],
    });

    const rare = presentation.narrative.fixedTraits.find((item) => item.name === 'Jardim Interior');
    assert.ok(rare);
    assert.equal(rare.description, 'A personagem mantém um ecossistema mágico interno.');
    assert.equal(rare.effect, '+10% ao estabilizar magia vegetal.');
    assert.equal(rare.restrictions, 'Não cria vida consciente.');
    assert.equal(rare.rarity, 'rara');

    assert.equal(
        presentation.narrative.extraTraits.filter((item) => item.name === 'Voz da Estufa').length,
        1
    );
    assert.equal(presentation.narrative.extraAnomalies[0].name, 'Pólen de Mana');
    assert.equal(presentation.narrative.narrativeItems[0].title, 'Chave de Vidro');
});

test('não expõe chaves técnicas ao jogador ou narrador', () => {
    for (const audience of ['player', 'narrator']) {
        const presentation = buildCharacterPresentation(rich, { audience, includeTechnical: true });
        const keys = new Set(collectKeys(presentation));
        const text = serialized(presentation);

        assert.equal('technical' in presentation, false);
        assert.equal('audit' in presentation, false);
        for (const forbidden of ['playerId', 'stage_key', 'updated_by', 'updatedBy', 'flags', 'weights', 'operationCode']) {
            assert.equal(keys.has(forbidden), false, `${audience} recebeu ${forbidden}`);
        }
        assert.doesNotMatch(text, /ANON-RICH|OP-INTERNAL|SHOULD-NOT-LEAK|TR-INTERNAL/);
    }
});

test('área técnica só existe para ADM com solicitação explícita', () => {
    const standardAdmin = buildCharacterPresentation(rich, { audience: 'admin' });
    assert.ok(standardAdmin.audit);
    assert.equal('technical' in standardAdmin, false);
    assert.deepEqual(standardAdmin.audit.missingDescriptions, []);

    const technicalAdmin = buildCharacterPresentation(rich, {
        audience: 'admin',
        includeTechnical: true,
    });
    assert.equal(technicalAdmin.technical.player.id, 'ANON-RICH');
    assert.equal(technicalAdmin.technical.capacity.stats.stage_key, 'stage_4');
});

test('repara mojibake conservador e nunca transforma objeto em texto', () => {
    assert.equal(repairDisplayText('IntuiÃ§Ã£o'), 'Intuição');
    assert.equal(cleanText('  —  '), null);
    assert.equal(cleanText({ label: 'Rosier' }), null);
});

test('contrato é serializável e não contém valores undefined', () => {
    const presentation = buildCharacterPresentation(rich, {
        audience: 'narrator',
        generatedAt: '2026-07-23T03:00:00.000Z',
    });
    const json = serialized(presentation);
    assert.equal(JSON.parse(json).schemaVersion, PRESENTATION_SCHEMA_VERSION);
    assert.doesNotMatch(json, /undefined/);
});

test('normaliza a síntese humana produzida pelo serviço de capacidade', () => {
    const normalized = withCapacitySummary(
        { ok: true, support: { warning: 'Suporte supervisionado.' } },
        {
            creation: 'Criação simples.',
            reinforcement: 'Reforço próprio.',
            mana: 'Fluxo estável.',
            physical: 'Base física.',
            summary: 'Leitura geral humana.',
        }
    );

    assert.deepEqual(normalized.summary, {
        geral: 'Leitura geral humana.',
        criacao: 'Criação simples.',
        reforco: 'Reforço próprio.',
        mana: 'Fluxo estável.',
        fisico: 'Base física.',
        suporte: 'Suporte supervisionado.',
    });
});

test('wrapper agrega leitores reais sem expor erro interno ao jogador', async () => {
    const db = {
        async get(sql) {
            assert.match(sql, /FROM jogadores/);
            return { id: 'PRIVATE-ID', personagem_nome: 'Teste Seguro' };
        },
    };
    const readers = {
        async getCharacterBonusSummary() {
            throw Object.assign(new Error('SQLITE_PRIVATE_PATH'), { code: 'internal_sqlite_error' });
        },
        async getPlayerTechnicalCapacity() {
            return {
                ok: true,
                stageName: '6º Estágio',
                support: { warning: 'Suporte parcial.' },
                ph: { phAvailable: 12, phAccumulated: 500 },
            };
        },
        buildProfileCapacitySummary() {
            return {
                creation: 'Criação básica.',
                reinforcement: 'Sem reforço.',
                mana: 'Mana básica.',
                physical: 'Base física.',
                summary: 'Resumo operacional.',
            };
        },
        async getAdminPlayerTraitOverview() {
            return { slots: [], extraTraits: [], extraAnomalies: [], hooks: [] };
        },
    };

    const player = await getCharacterPresentation(db, 'PRIVATE-ID', {
        audience: 'player',
        readers,
        generatedAt: '2026-07-23T03:00:00.000Z',
    });
    assert.equal(player.capabilities.headline, 'Resumo operacional.');
    assert.equal(player.partialIssues[0].code, 'source_unavailable');
    assert.equal(player.partialIssues[0].message, 'Uma parte da ficha não pôde ser carregada.');
    assert.doesNotMatch(JSON.stringify(player.partialIssues), /SQLITE_PRIVATE_PATH|internal_sqlite_error/);

    const admin = await getCharacterPresentation(db, 'PRIVATE-ID', {
        audience: 'admin',
        readers,
        generatedAt: '2026-07-23T03:00:00.000Z',
    });
    assert.equal(admin.partialIssues[0].code, 'internal_sqlite_error');
    assert.equal(admin.partialIssues[0].message, 'SQLITE_PRIVATE_PATH');
});
