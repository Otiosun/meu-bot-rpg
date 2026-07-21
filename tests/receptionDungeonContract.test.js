'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DEFAULT_RECEPTION_INVITE_URL,
    getPublicReceptionState,
    normalizeWhatsAppInviteUrl,
} = require('../helpers/clover/receptionService');
const { getSeasonalTemplate } = require('../helpers/clover/seasonalEventCatalog');

test('recepção pública expõe apenas convite válido do WhatsApp', async () => {
    assert.equal(normalizeWhatsAppInviteUrl('javascript:alert(1)'), null);
    assert.equal(normalizeWhatsAppInviteUrl('https://example.com/grupo'), null);
    assert.equal(
        normalizeWhatsAppInviteUrl('https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv'),
        'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv'
    );

    const db = {
        get: async (_sql, [key]) => key === 'clover_reception_group_invite_link'
            ? { value: 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv' }
            : null,
    };
    const state = await getPublicReceptionState(db, {
        env: { CLOVER_SITE_PUBLIC_URL: 'https://clover-multicolor.vercel.app/' },
    });

    assert.equal(state.public, true);
    assert.equal(state.canJoinReception, true);
    assert.equal(state.paths.existingPlayer, '/personagem');
    assert.equal(state.receptionInviteUrl, 'https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv');
});

test('recepção usa o convite oficial quando a configuração dedicada ainda não existe', async () => {
    const db = { get: async () => null };
    const state = await getPublicReceptionState(db);
    assert.equal(state.canJoinReception, true);
    assert.equal(state.receptionInviteUrl, DEFAULT_RECEPTION_INVITE_URL);
    assert.equal(state.paths.newcomer, DEFAULT_RECEPTION_INVITE_URL);
});

test('passe da Dungeon é individual, vinculado e fora de venda ou troca', () => {
    const pass = getSeasonalTemplate('acesso_dungeon_exclusiva');
    assert.ok(pass);
    assert.equal(pass.itemName, 'Passe da Dungeon Exclusiva');
    assert.equal(pass.stackable, false);
    assert.equal(pass.transferable, false);
    assert.equal(pass.properties.bound, true);
    assert.equal(pass.properties.sellable, false);
    assert.equal(pass.properties.tradable, false);
    assert.equal(pass.metadata.nonSellable, true);
    assert.equal(pass.metadata.nonTransferable, true);
    assert.equal(pass.metadata.eventGlobalStock, 8);
});