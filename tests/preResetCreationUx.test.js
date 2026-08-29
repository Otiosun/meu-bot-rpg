'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    formatAvailability,
    renderList,
} = require('../helpers/clover/preResetMagicCommand');
const { getAllMagics } = require('../helpers/magicManager');
const { normalizeFutureDraft } = require('../helpers/clover/preResetCharacterService');
const { buildFutureTraits } = require('../comandos/fichanova');

function source(rel) {
    return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

test('lista PRE_RESET de magia preserva vaga/estado sem spam de hash por roll', () => {
    const all = getAllMagics();
    const limited = all.find((magic) => Number(magic.capacity || 0) > 0);
    assert.ok(limited, 'precisa existir magia limitada para testar a UI');

    const rolls = [{
        roll_number: 1,
        magic_rarity: 'Mitica',
        kingdom: 'Clover',
    }];
    const availability = new Map([[
        limited.key,
        {
            ok:true,
            limited:true,
            usedCount:1,
            capacity:Number(limited.capacity),
            remaining:Math.max(Number(limited.capacity) - 1, 0),
        },
    ]]);

    const rendered = renderList(rolls, null, availability);
    assert.match(rendered, new RegExp(`${limited.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\*\\(1/${limited.capacity}\\)\\*`));
    assert.match(rendered, /· disponível/);
    assert.doesNotMatch(rendered, /#\d+(?:\/#\d+)+/);
    assert.doesNotMatch(rendered, /﹒ .*#\d+/);
});

test('formatacao de disponibilidade distingue livre e limitada', () => {
    assert.equal(formatAvailability({ limited:false }), 'livre');
    assert.equal(formatAvailability({ limited:true, usedCount:2, capacity:5 }), '2/5');
});

test('rascunho futuro preserva escolhas de traco estruturadas', () => {
    const draft = normalizeFutureDraft({
        rollNumber:1,
        traits:{
            aptitude:{ key:'x', name:'Aptidao X', rarity:'rare' },
            mark:{ key:'y', name:'Marca Y', rarity:'common' },
            anomaly:{ key:'z', name:'Anomalia Z', rarity:'anomaly' },
        },
    });
    assert.equal(draft.traits.aptitude.key, 'x');
    assert.equal(draft.traits.mark.name, 'Marca Y');
    assert.equal(draft.traits.anomaly.rarity, 'anomaly');
});

test('Ficha Nova transforma payload de tracos em escolhas futuras', () => {
    const traits = buildFutureTraits({
        commonAptitude:{ key:'comum', name:'Comum' },
        rareAptitude:{ key:'rara', name:'Rara' },
        commonMark:{ key:'marca', name:'Marca' },
        anomaly:{ key:'anom', name:'Anomalia' },
    });
    assert.deepEqual(traits.aptitude, { key:'rara', name:'Rara', rarity:'rare' });
    assert.deepEqual(traits.mark, { key:'marca', name:'Marca', rarity:'common' });
    assert.deepEqual(traits.anomaly, { key:'anom', name:'Anomalia', rarity:'anomaly' });
});

test('Ficha Nova usa identidade futura e reserva anomalia no universo futuro', () => {
    const text = source('comandos/fichanova.js');
    assert.match(text, /getFutureTraitIdentity\(playerId\)/);
    assert.match(text, /validateTraitSubmission\(db, traitIdentity, fields\)/);
    assert.match(text, /category:'anomaly'/);
    assert.match(text, /traits,\s*$/m);
});

test('catalogos PRE_RESET nao dependem mais de placeholder de vaga antiga', () => {
    const family = source('comandos/familias.js');
    const race = source('comandos/racas.js');
    const grimoire = source('comandos/grimorios.js');
    const traits = source('comandos/tracos.js');

    assert.match(family, /renderPreResetFamiliesAvailability/);
    assert.match(race, /renderPreResetRacesAvailability/);
    assert.match(grimoire, /renderPreResetGrimoiresAvailability/);
    assert.match(traits, /renderPreResetAnomaliesAvailability/);

    assert.doesNotMatch(family, /vaga futura verificada na Ficha Nova/);
    assert.doesNotMatch(race, /definida pelo roll futuro/);
    assert.doesNotMatch(grimoire, /definido pelo roll futuro/);
});
