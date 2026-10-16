const test = require('node:test');
const assert = require('node:assert/strict');

const {
    assertUniqueCommandOwnership,
    findCommandOwnershipConflicts,
} = require('../helpers/commandRegistry');
const {
    CLOVER_TIME_ZONE,
    getCloverDateKey,
    parseStrictDateOnly,
} = require('../helpers/clover/timeService');
const { parseSpellEvaluationSheet } = require('../helpers/clover/evaluationFormSchemas');

function spellSheet(overrides = {}) {
    return [
        '♧┃FICHA DE FEITIÇO 𖥔 CLOVER MULTICOLOR',
        '     ── avaliação rápida do grimório ──',
        '',
        '*Nome do feitiço:*',
        `> ${overrides.name ?? 'Mão de Lama'}`,
        '*Tipo:*',
        `> ${overrides.type ?? 'Criação'}`,
        '*Versão:*',
        `> ${overrides.version ?? 'v1'}`,
        '',
        '*Custo:*',
        `> ${overrides.cost ?? '🔒'}`,
        '*Alcance:*',
        `> ${overrides.reach ?? '🔒'}`,
        '*Duração:*',
        `> ${overrides.duration ?? '🔒'}`,
        '',
        '*Descrição:*',
        `> ${overrides.effect ?? 'Cria lama sob o alvo.'}`,
        '',
        '*Limites:*',
        `> ${overrides.limits ?? '🔒'}`,
        '*Notas ADM:*',
        `> ${overrides.admNotes ?? '🔒'}`,
    ].join('\n');
}

test('ownership normaliza acentos e acusa owners diferentes', () => {
    const commands = [
        { owner: 'a.js', command: { nome: '.#avaliacao', aliases: ['.#avaliação'] } },
        { owner: 'b.js', command: { nome: '.#avaliação', aliases: [] } },
    ];

    const conflicts = findCommandOwnershipConflicts(commands);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].alias, '.#avaliacao');
    assert.deepEqual(conflicts[0].owners.map((item) => item.owner), ['a.js', 'b.js']);
    assert.throws(() => assertUniqueCommandOwnership(commands), (error) => (
        error.code === 'COMMAND_ALIAS_COLLISION'
        && /a\.js/.test(error.message)
        && /b\.js/.test(error.message)
    ));
});

test('aliases equivalentes do mesmo owner não são conflito', () => {
    const commands = [
        { owner: 'racas.js', command: { nome: '.#racas', aliases: ['.#raças', '.#RACAS'] } },
    ];
    assert.deepEqual(findCommandOwnershipConflicts(commands), []);
    assert.doesNotThrow(() => assertUniqueCommandOwnership(commands));
});

test('timezone canônica é America/Maceio e respeita virada local do dia', () => {
    assert.equal(CLOVER_TIME_ZONE, 'America/Maceio');
    assert.equal(getCloverDateKey(new Date('2026-10-13T02:00:00Z')), '2026-10-12');
    assert.equal(getCloverDateKey(new Date('2026-10-13T03:00:00Z')), '2026-10-13');
});

test('data manual é estrita e rejeita rollover impossível', () => {
    assert.equal(parseStrictDateOnly('2028-02-29').ok, true);
    assert.equal(parseStrictDateOnly('2026-02-29').ok, false);
    assert.equal(parseStrictDateOnly('2026-13-01').ok, false);
    assert.equal(parseStrictDateOnly('13/10/2026').ok, false);
});

test('intake de Feitiço aceita ficha literal com campos ADM bloqueados', () => {
    const result = parseSpellEvaluationSheet(spellSheet(), { phase: 'intake' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.data.name, 'Mão de Lama');
    assert.equal(result.data.normalizedName, 'mao_de_lama');
    assert.equal(result.data.type, 'Criação');
    assert.equal(result.data.version, 1);
    assert.equal(result.data.cost, '-');
});

test('placeholder de Tipo com quatro opções é ambíguo e nunca vira Criação sozinho', () => {
    const result = parseSpellEvaluationSheet(spellSheet({
        type: 'Criação / Reforço / Suporte / Misto',
    }), { phase: 'intake' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'AMBIGUOUS_SPELL_TYPE'));
});

test('fase final exige campos técnicos que o intake não exige', () => {
    const intake = parseSpellEvaluationSheet(spellSheet(), { phase: 'intake' });
    const final = parseSpellEvaluationSheet(spellSheet(), { phase: 'final' });
    assert.equal(intake.ok, true);
    assert.equal(final.ok, false);
    const missing = final.errors.filter((error) => error.code === 'MISSING_FIELD').map((error) => error.field);
    assert.deepEqual(missing.sort(), ['cost', 'duration', 'limits', 'reach']);
});

test('fase final aceita ficha ADM preenchida e normaliza híbrido para Misto', () => {
    const result = parseSpellEvaluationSheet(spellSheet({
        type: 'Híbrido',
        cost: '45 MP',
        reach: '12 m',
        duration: '2 turnos',
        limits: 'Máximo de 2 áreas simultâneas.',
        admNotes: 'Aprovado após ajuste.',
    }), { phase: 'final' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.data.type, 'Misto');
    assert.equal(result.data.cost, '45 MP');
});

test('descrição multiline preserva conteúdo e pontuação', () => {
    const raw = spellSheet({ effect: 'Primeira linha: mantém pontuação.\n> Segunda linha — ainda é descrição.' });
    const result = parseSpellEvaluationSheet(raw, { phase: 'intake' });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.data.effect, 'Primeira linha: mantém pontuação.\nSegunda linha — ainda é descrição.');
});

test('duplicata conflitante bloqueia sem escolher um valor', () => {
    const raw = spellSheet().replace(
        '*Versão:*\n> v1',
        '*Versão:*\n> v1\n*Versão atual:*\n> v2'
    );
    const result = parseSpellEvaluationSheet(raw, { phase: 'intake' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'CONFLICTING_DUPLICATE' && error.field === 'version'));
});

test('duas fichas completas na mesma mensagem são rejeitadas', () => {
    const raw = `${spellSheet()}\n\n${spellSheet({ name: 'Segunda Técnica' })}`;
    const result = parseSpellEvaluationSheet(raw, { phase: 'intake' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.code === 'MULTIPLE_FORMS'));
});
