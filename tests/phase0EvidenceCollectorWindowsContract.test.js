'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pm2Invocation } = require('../scripts/collectCloverPhase0Evidence');

test('coletor consulta PM2 pelo cmd.exe no Windows', () => {
    const invocation = pm2Invocation('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });

    assert.deepEqual(invocation, {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', 'pm2', 'jlist'],
    });
});

test('coletor consulta PM2 diretamente fora do Windows', () => {
    assert.deepEqual(pm2Invocation('linux', {}), {
        file: 'pm2',
        args: ['jlist'],
    });
});
