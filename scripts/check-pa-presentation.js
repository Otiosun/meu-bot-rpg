'use strict';

const assert = require('assert');
const {
    buildIdempotencyKey,
    renderPurchaseResult,
} = require('../helpers/clover/paCommandPresentationFinal');

function main() {
    const success = renderPurchaseResult({
        ok: true,
        item: {
            key: 'estrela_esquadrao',
            name: 'Estrela de esquadrão',
            rewardLabel: '+1 estrela',
        },
        quantity: 1,
        paCost: 30,
        availablePaAfter: 42,
        usedBefore: 0,
        limit: 1,
        reward: {
            squadKey: 'touros_negros',
            squadName: 'Touros Negros',
        },
    }, { squadSync: { ok: true } });

    assert(success.includes('𝐂𝐎𝐌𝐏𝐑𝐀 𝐂𝐎𝐍𝐂𝐋𝐔𝐈́𝐃𝐀'));
    assert(success.includes('𝐄𝐬𝐭𝐫𝐞𝐥𝐚 𝐝𝐞 𝐞𝐬𝐪𝐮𝐚𝐝𝐫𝐚̃𝐨'));
    assert(success.includes('*𝐏𝐀 𝐫𝐞𝐬𝐭𝐚𝐧𝐭𝐞:* 42'));
    assert(success.includes('*𝐔𝐬𝐨 𝐬𝐞𝐦𝐚𝐧𝐚𝐥:* 1/1'));
    assert(success.includes('*𝐃𝐞𝐬𝐜𝐫𝐢𝐜̧𝐚̃𝐨:* sincronizada'));

    const failure = renderPurchaseResult({
        ok: false,
        code: 'duplicate',
    });
    assert(failure.includes('𝐂𝐎𝐌𝐏𝐑𝐀 𝐍𝐀̃𝐎 𝐀𝐏𝐋𝐈𝐂𝐀𝐃𝐀'));
    assert(failure.includes('Nenhum PA foi retirado novamente'));

    for (const output of [success, failure]) {
        assert(!output.includes('undefined'));
        assert(!output.includes('[object Object]'));
        assert(output.length < 4096);
    }

    const baseArgs = {
        idChat: 'grupo@g.us',
        idJogador: 'avaliador@s.whatsapp.net',
        body: 'comprar 1 10',
        m: {
            key: { id: 'MESSAGE_A' },
            messageTimestamp: 12345,
        },
    };
    const first = buildIdempotencyKey(baseArgs, 'avaliador@s.whatsapp.net');
    const repeated = buildIdempotencyKey(baseArgs, 'avaliador@s.whatsapp.net');
    const different = buildIdempotencyKey({
        ...baseArgs,
        m: { ...baseArgs.m, key: { id: 'MESSAGE_B' } },
    }, 'avaliador@s.whatsapp.net');

    assert.strictEqual(first, repeated);
    assert.notStrictEqual(first, different);
    assert(first.startsWith('pa_shop:'));
    assert(first.length < 80);

    console.log('✓ retorno de compra aprovado');
    console.log('✓ retorno de erro aprovado');
    console.log('✓ idempotência estável por mensagem');
    console.log('\nResultado: apresentação final de PA passou.');
}

main();