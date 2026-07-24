'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    APPLY_CONFIRMATION,
    EXPECTED_TOTALS,
    PACKAGES,
    PLAYER_MANIFEST,
    calculateTotals,
    phoneVariants,
    validateManifest,
} = require('../scripts/applyNightmareEventRewards');
const {
    NIGHTMARE_EVENT_KEY,
    NIGHTMARE_ITEM_KEYS,
    NIGHTMARE_TITLE,
    PROVISIONAL_BLACK_WAND_TEMPLATE,
    keyFor,
} = require('../helpers/clover/nightmareEventRewardService');

test('manifesto fecha os totais aprovados para os 25 jogadores', () => {
    assert.deepEqual(validateManifest(), EXPECTED_TOTALS);
    assert.deepEqual(calculateTotals(), EXPECTED_TOTALS);
    assert.equal(PLAYER_MANIFEST.length, 25);
    assert.equal(PLAYER_MANIFEST.filter((entry) => entry.packageKey === 'base').length, 22);
});

test('pódio substitui o pacote base com os valores finais corretos', () => {
    const kanon = PLAYER_MANIFEST.find((entry) => entry.characterName === 'Kame');
    const fernando = PLAYER_MANIFEST.find((entry) => entry.characterName === 'Leonhardt');
    const polly = PLAYER_MANIFEST.find((entry) => entry.characterName === 'Aylin');

    assert.equal(kanon.packageKey, 'third');
    assert.deepEqual(PACKAGES.third, {
        yulls: 20000,
        ph: 80,
        rareBoxes: 2,
        commonBoxes: 2,
        spellTickets: 1,
        priorityCoupons: 1,
        provisionalBlackWands: 0,
    });

    assert.equal(fernando.packageKey, 'second');
    assert.equal(PACKAGES.second.provisionalBlackWands, 1);
    assert.equal(PACKAGES.second.spellTickets, 1);

    assert.equal(polly.packageKey, 'first');
    assert.equal(PACKAGES.first.provisionalBlackWands, 1);
    assert.equal(PACKAGES.first.spellTickets, 2);
});

test('título e itens usam as chaves nativas fechadas', () => {
    assert.deepEqual(NIGHTMARE_TITLE, {
        key: 'sobrevivente_do_pesadelo',
        name: 'Sobrevivente do Pesadelo',
    });
    assert.equal(NIGHTMARE_ITEM_KEYS.commonBox, 'box_simple_v1');
    assert.equal(NIGHTMARE_ITEM_KEYS.rareBox, 'box_rare_v1');
    assert.equal(NIGHTMARE_ITEM_KEYS.spellTicket, 'ticket_feitico');
    assert.equal(NIGHTMARE_ITEM_KEYS.priorityCoupon, 'cupom_prioridade');
});

test('Vareta Negra provisória fica vinculada e sem uso, venda ou transferência', () => {
    assert.equal(PROVISIONAL_BLACK_WAND_TEMPLATE.properties.bound, true);
    assert.equal(PROVISIONAL_BLACK_WAND_TEMPLATE.properties.usable, false);
    assert.equal(PROVISIONAL_BLACK_WAND_TEMPLATE.properties.sellable, false);
    assert.equal(PROVISIONAL_BLACK_WAND_TEMPLATE.properties.tradable, false);
    assert.equal(PROVISIONAL_BLACK_WAND_TEMPLATE.properties.transferable, false);
    assert.equal(PROVISIONAL_BLACK_WAND_TEMPLATE.metadata.pendingMigration, true);
});

test('chaves idempotentes são estáveis por jogador e componente', () => {
    assert.equal(APPLY_CONFIRMATION, 'PESADELO-25');
    assert.equal(NIGHTMARE_EVENT_KEY, 'pesadelo_v1');
    assert.equal(
        keyFor('5511999999999@s.whatsapp.net', 'ph'),
        'pesadelo_v1:5511999999999@s.whatsapp.net:ph'
    );
});

test('telefone brasileiro aceita forma com e sem nono dígito', () => {
    assert.deepEqual(phoneVariants('+55 92 9326-3023'), [
        '559293263023',
        '5592993263023',
    ]);
    assert.deepEqual(phoneVariants('+55 11 99783-5674'), [
        '5511997835674',
        '551197835674',
    ]);
});

test('telefone internacional não recebe alteração brasileira', () => {
    assert.deepEqual(phoneVariants('+351 922 286 910'), ['351922286910']);
    assert.deepEqual(phoneVariants('+244 951 532 202'), ['244951532202']);
});
