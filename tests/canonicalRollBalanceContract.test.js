'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'clover', name), 'utf8'));
const byKey = (list) => new Map(list.map((item) => [item.key, item]));
const sum = (values) => values.reduce((total, value) => total + Number(value || 0), 0);

test('referencia canonica: reinos somam 100 e usam 35/25/15/25', () => {
    const kingdoms = readJson('reinos.json');
    assert.deepEqual(
        kingdoms.map(({ key, chance }) => [key, chance]),
        [['clover', 35], ['spade', 25], ['diamond', 15], ['heart', 25]]
    );
    assert.equal(sum(kingdoms.map((item) => item.chance)), 100);
});

test('referencia canonica: matriz reino x raca e capacidades ficam exatas', () => {
    const races = byKey(readJson('racas.json'));
    assert.deepEqual(races.get('humano').weightsByKingdom, { clover:70, spade:90, diamond:100, heart:95 });
    assert.deepEqual(races.get('bruxa').weightsByKingdom, { clover:18 });
    assert.deepEqual(races.get('anao').weightsByKingdom, { clover:10, spade:10 });
    assert.deepEqual(races.get('elfo').weightsByKingdom, { clover:2, heart:5 });
    assert.equal(races.get('bruxa').capacity, 11);
    assert.equal(races.get('anao').capacity, 10);
    assert.equal(races.get('elfo').capacity, 6);

    const expected = {
        clover: { humano:70, bruxa:18, anao:10, elfo:2 },
        spade: { humano:90, anao:10 },
        diamond: { humano:100 },
        heart: { humano:95, elfo:5 },
    };
    for (const [kingdom, pool] of Object.entries(expected)) {
        const actual = Object.fromEntries([...races.entries()]
            .map(([key, race]) => [key, Number(race.weightsByKingdom?.[kingdom] || 0)])
            .filter(([, weight]) => weight > 0));
        assert.deepEqual(actual, pool, kingdom);
        assert.equal(sum(Object.values(actual)), 100, kingdom);
    }
});

test('referencia canonica: grimorios de roll usam 95/5 e narrativos ficam em 0', () => {
    const grimoires = readJson('grimorios.json');
    const expected = {
        clover: [['clover_3f',95], ['clover_4f',5], ['clover_demonic',0]],
        spade: [['spade_3f',95], ['spade_4f',5], ['spade_demonic',0]],
        heart: [['heart_3f',95], ['heart_4f',5], ['heart_demonic',0]],
        diamond: [['diamond_3f',95], ['diamond_4f',5], ['diamond_broken',0], ['diamond_demonic',0]],
    };
    for (const [kingdom, contract] of Object.entries(expected)) {
        const pool = grimoires.filter((item) => item.kingdomKey === kingdom);
        assert.deepEqual(pool.map(({ key, chance }) => [key, chance]), contract, kingdom);
        assert.equal(sum(pool.map((item) => item.chance)), 100, kingdom);
    }
    const map = byKey(grimoires);
    for (const key of ['clover_4f','spade_4f','heart_4f','diamond_4f']) assert.equal(map.get(key).capacity, 2, key);
    for (const key of ['clover_demonic','spade_demonic','heart_demonic','diamond_broken','diamond_demonic']) {
        assert.equal(map.get(key).chance, 0, key);
        assert.equal(map.get(key).rollEnabled, false, key);
    }
    assert.equal(map.get('clover_demonic').displayCapacity, 0);
    assert.equal(map.get('spade_demonic').displayCapacity, 0);
    assert.equal(map.get('heart_demonic').displayCapacity, 0);
    assert.equal(map.get('diamond_broken').displayCapacity, 0);
    assert.equal(map.get('diamond_demonic').displayCapacity, null);
});

test('referencia canonica: Comum nao participa do pool e Mitica permanece em 1%', () => {
    const rarities = readJson('raridadesMagicas.json');
    assert.deepEqual(
        rarities.map(({ key, chance }) => [key, chance]),
        [['incomum',42], ['rara',30], ['epica',17], ['lendaria',10], ['mitica',1]]
    );
    assert.equal(sum(rarities.map((item) => item.chance)), 100);
    assert.equal(rarities.some((item) => item.key === 'comum'), false);
});

test('PRE_RESET Heart bloqueia Lendaria, mas nao bloqueia Mitica', () => {
    const source = fs.readFileSync(path.join(ROOT, 'helpers', 'clover', 'preResetFutureRollService.js'), 'utf8');
    const functionBody = source.match(/function invalidHeartRarity\(roll\) \{[\s\S]*?\n\}/)?.[0] || '';
    assert.match(functionBody, /=== 'lendaria'/);
    assert.doesNotMatch(functionBody, /mitica/);
});
