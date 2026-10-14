'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const preflight = require('../scripts/preflightUniversalEvaluationLocal');


test('preflight local aponta para branch e processo PM2 canônicos', () => {
    assert.equal(preflight.EXPECTED_BRANCH, 'clover/evaluation-support-migration-2026-10-13');
    assert.equal(preflight.EXPECTED_PM2_NAME, 'clover-rpg');
    assert.equal(path.basename(preflight.ROOT), 'meu-bot-rpg');
});


test('timestamp de backup é estável e seguro para nome de diretório Windows', () => {
    const value = preflight.timestampForPath(new Date('2026-10-13T18:45:12.345Z'));
    assert.equal(value, '2026-10-13T18-45-12-345Z');
    assert.doesNotMatch(value, /:/);
});


test('resolveDatabasePath usa banco.sqlite por padrão e respeita CLOVER_DATABASE_PATH', () => {
    const oldDatabase = process.env.CLOVER_DATABASE_PATH;
    const oldDb = process.env.CLOVER_DB_PATH;
    try {
        delete process.env.CLOVER_DATABASE_PATH;
        delete process.env.CLOVER_DB_PATH;
        assert.equal(preflight.resolveDatabasePath(), path.join(preflight.ROOT, 'banco.sqlite'));

        process.env.CLOVER_DATABASE_PATH = path.join('data', 'custom.sqlite');
        assert.equal(preflight.resolveDatabasePath(), path.join(preflight.ROOT, 'data', 'custom.sqlite'));
    } finally {
        if (oldDatabase === undefined) delete process.env.CLOVER_DATABASE_PATH;
        else process.env.CLOVER_DATABASE_PATH = oldDatabase;
        if (oldDb === undefined) delete process.env.CLOVER_DB_PATH;
        else process.env.CLOVER_DB_PATH = oldDb;
    }
});


test('pm2EnvValue lê flag tanto direta quanto em env aninhado', () => {
    assert.equal(
        preflight.pm2EnvValue({ CLOVER_UNIVERSAL_EVALUATION: '1' }, 'CLOVER_UNIVERSAL_EVALUATION'),
        '1'
    );
    assert.equal(
        preflight.pm2EnvValue({ env: { CLOVER_UNIVERSAL_EVALUATION: '0' } }, 'CLOVER_UNIVERSAL_EVALUATION'),
        '0'
    );
    assert.equal(preflight.pm2EnvValue({}, 'CLOVER_UNIVERSAL_EVALUATION'), null);
});


test('runtime Clover irmão online no mesmo cwd é bloqueador; processos de outro cwd não são', () => {
    const root = preflight.ROOT;
    const processes = [
        { id: 2, name: 'clover-rpg', status: 'online', cwd: root, script: path.join(root, 'index.js') },
        { id: 7, name: 'clover-rpg-core-v2-v21', status: 'online', cwd: root, script: 'C:/runtime-v21/index.js' },
        { id: 8, name: 'clover-rpg-other-copy', status: 'online', cwd: path.join(root, '..', 'other-copy'), script: 'C:/other/index.js' },
        { id: 9, name: 'pokemon-rpg-whatsapp', status: 'online', cwd: root, script: 'C:/pokemon/main.ts' },
    ];

    const siblings = preflight.findOnlineSiblingCloverProcesses(processes, {
        root,
        expectedName: 'clover-rpg',
    });
    assert.deepEqual(siblings.map((item) => item.name), ['clover-rpg-core-v2-v21']);
});
