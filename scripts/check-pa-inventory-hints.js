'use strict';

const assert = require('assert');
const {
    formatItemLine,
    getItemUseHint,
} = require('../comandos/inventario');

const box = {
    item_name: 'Caixa Simples de Serviço',
    description: 'Caixa de teste.',
    quantity: 2,
    kind: 'caixa_pa',
};
const coupon = {
    item_name: 'Cupom de Prioridade',
    description: 'Cupom de teste.',
    quantity: 1,
    kind: 'cupom_pa',
};

assert(getItemUseHint(box).includes('pa abrir'));
assert(getItemUseHint(coupon).includes('pa prioridade'));
assert(formatItemLine(box).includes('2x Caixa Simples'));
assert(formatItemLine(box).includes('pa abrir'));
assert(formatItemLine(coupon).includes('pa prioridade'));

console.log('✓ inventário mostra como abrir a Caixa Simples');
console.log('✓ inventário mostra como ativar o Cupom de Prioridade');
