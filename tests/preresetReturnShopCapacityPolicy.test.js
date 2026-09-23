'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { clearCloverConfigCache, loadCloverConfigs } = require('../helpers/clover/configLoader');

test('config de vagas acompanha a loja de retorno global do pre-reset', () => {
    clearCloverConfigCache();
    const config = loadCloverConfigs({ forceReload: true });

    assert.equal(config.maps.races.get('bruxa').capacity, 11);
    assert.equal(config.maps.races.get('anao').capacity, 10);
    assert.equal(config.maps.races.get('elfo').capacity, 6);

    assert.equal(config.maps.grimoires.get('clover_4f').capacity, 3);
    assert.equal(config.maps.grimoires.get('heart_4f').capacity, 3);
    assert.equal(config.maps.grimoires.get('diamond_4f').capacity, 3);
    assert.equal(config.maps.grimoires.get('spade_4f').capacity, 3);
});
