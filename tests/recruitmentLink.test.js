'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recruitmentLink } = require('../comandos/divulga');

test('link do bot abre a página de divulgação com o parâmetro aceito pelo site', () => {
    const link = new URL(recruitmentLink('CV-ABC234'));

    assert.equal(link.origin, 'https://clover-multicolor.vercel.app');
    assert.equal(link.pathname, '/personagem/divulgacao');
    assert.equal(link.searchParams.get('codigo'), 'CV-ABC234');
    assert.equal(link.searchParams.has('ref'), false);
});
