const test = require('node:test');
const assert = require('node:assert/strict');

const { serializeSpellForSite } = require('../helpers/clover/siteSpellbookService');

test('serializa a ficha aprovada sem expor campos administrativos internos', () => {
    const serialized = serializeSpellForSite({
        id: 7,
        player_id: 'privado',
        name: 'Lâmina de Vento',
        version: 2,
        type: 'Criação',
        cost: '500 de Mana',
        reach: '20 metros',
        duration: '1 turno',
        effect: 'Forma uma lâmina de ar.',
        limits: 'Duas vezes por cena.',
        adm_notes: 'Aprovado com limite.',
        updated_at: '2026-07-18 01:00:00',
        created_by: 'adm-privado',
    });

    assert.deepEqual(serialized, {
        id: 7,
        name: 'Lâmina de Vento',
        version: 2,
        type: 'Criação',
        cost: '500 de Mana',
        reach: '20 metros',
        duration: '1 turno',
        effect: 'Forma uma lâmina de ar.',
        limits: 'Duas vezes por cena.',
        admNotes: 'Aprovado com limite.',
        updatedAt: '2026-07-18 01:00:00',
    });
});

test('normaliza valores ausentes para uma ficha legível', () => {
    const serialized = serializeSpellForSite({ name: '  ', version: 0, effect: null });
    assert.equal(serialized.name, 'Feitiço sem nome');
    assert.equal(serialized.version, 1);
    assert.equal(serialized.effect, '-');
    assert.equal(serialized.updatedAt, null);
});
