'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    delegatedRewardAction,
    normalizeRewardEntriesV2,
} = require('../helpers/clover/adminRewardServiceV2');

test('Rewards V2 normalizes title trait and hook entries', () => {
    const entries = normalizeRewardEntriesV2([
        { type: 'title', titleKey: 'titulo_campeao', label: 'Título especial' },
        { type: 'trait', traitId: 'TR-EXEMPLO', slotKey: 'marca_rara' },
        { type: 'hook', hookId: 'HK-EXEMPLO', title: 'Convocação', priority: 'high' },
    ]);

    assert.deepEqual(entries[0], {
        type: 'title',
        templateKey: 'titulo_campeao',
        label: 'Título especial',
    });
    assert.equal(entries[1].type, 'trait');
    assert.equal(entries[1].traitId, 'TR-EXEMPLO');
    assert.equal(entries[1].slotKey, 'marca_rara');
    assert.equal(entries[2].type, 'hook');
    assert.equal(entries[2].hookId, 'HK-EXEMPLO');
    assert.equal(entries[2].title, 'Convocação');
});

test('universal reward entries delegate to canonical admin actions', () => {
    assert.deepEqual(
        delegatedRewardAction({ type: 'title', templateKey: 'titulo_campeao' }),
        { type: 'player.title.grant', payload: { templateKey: 'titulo_campeao' } }
    );
    assert.deepEqual(
        delegatedRewardAction({ type: 'trait', traitId: 'TR-1', slotKey: 'marca_rara' }),
        { type: 'player.trait.assign', payload: { traitId: 'TR-1', slotKey: 'marca_rara' } }
    );
    assert.deepEqual(
        delegatedRewardAction({ type: 'hook', hookId: 'HK-1', title: 'Gancho' }),
        { type: 'player.hook.assign', payload: { hookId: 'HK-1', title: 'Gancho' } }
    );
});
