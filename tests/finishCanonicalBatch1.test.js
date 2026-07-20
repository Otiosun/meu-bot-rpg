'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    assertExpectedCounts,
    isQueueIdle,
    resolveCommandInvocation,
    runChecked,
} = require('../scripts/finishCanonicalBatch1');
const { selectResumeMode } = require('../scripts/completeCanonicalBatch1');

test('fila só é considerada livre quando o health está online e sem atividade', () => {
    assert.equal(isQueueIdle({ ok: true, queue: { depth: 0, active: false } }), true);
    assert.equal(isQueueIdle({ ok: false, queue: { depth: 0, active: false } }), false);
    assert.equal(isQueueIdle({ ok: true, queue: { depth: 1, active: false } }), false);
    assert.equal(isQueueIdle({ ok: true, queue: { depth: 0, active: true } }), false);
    assert.equal(isQueueIdle(null), false);
});

test('contagens finais aceitam exatamente 22 registros e os dois conteúdos de Vitor', () => {
    assert.doesNotThrow(() => assertExpectedCounts({
        totals: [
            { content_type: 'custom_trait', total: 7 },
            { content_type: 'narrative_hook', total: 4 },
            { content_type: 'narrative_item', total: 2 },
            { content_type: 'system_trait', total: 9 },
        ],
        overall: { total: 22 },
        vitor: [
            { content_type: 'system_trait', content_key: 'cria_da_fronteira' },
            { content_type: 'narrative_hook', content_key: 'divida_da_montanha' },
        ],
        pending: { total: 7 },
        linked: { total: 2 },
    }));
});

test('contagens divergentes são bloqueadas', () => {
    assert.throws(() => assertExpectedCounts({
        totals: [
            { content_type: 'custom_trait', total: 7 },
            { content_type: 'narrative_hook', total: 3 },
            { content_type: 'narrative_item', total: 2 },
            { content_type: 'system_trait', total: 9 },
        ],
        overall: { total: 21 },
        vitor: [
            { content_type: 'system_trait', content_key: 'cria_da_fronteira' },
            { content_type: 'narrative_hook', content_key: 'divida_da_montanha' },
        ],
        pending: { total: 7 },
        linked: { total: 2 },
    }), /22/);
});

test('retomada importa somente Vitor quando os outros 20 já existem', () => {
    assert.equal(selectResumeMode({
        total: 20,
        vitor: 0,
        byType: {
            system_trait: 8,
            custom_trait: 7,
            narrative_hook: 3,
            narrative_item: 2,
        },
    }), 'vitor_only');

    assert.equal(selectResumeMode({ total: 0, vitor: 0, byType: {} }), 'full');
    assert.equal(selectResumeMode({ total: 22, vitor: 2, byType: {} }), 'verify_only');
    assert.throws(() => selectResumeMode({ total: 20, vitor: 1, byType: {} }), /inesperado/);
});

test('arquivos cmd são encaminhados ao processador de comandos no Windows', () => {
    assert.deepEqual(
        resolveCommandInvocation(
            'pm2.cmd',
            ['stop', '1'],
            'win32',
            { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
        ),
        {
            command: 'C:\\Windows\\System32\\cmd.exe',
            args: ['/d', '/s', '/c', 'pm2.cmd stop 1'],
        }
    );

    assert.deepEqual(
        resolveCommandInvocation('pm2', ['stop', '1'], 'linux', {}),
        { command: 'pm2', args: ['stop', '1'] }
    );
});

test('runner executa um arquivo cmd real sem EINVAL no Windows', {
    skip: process.platform !== 'win32',
}, () => {
    const fixture = path.join(os.tmpdir(), `clover-cmd-smoke-${process.pid}.cmd`);
    fs.writeFileSync(fixture, '@echo off\r\nexit /b 0\r\n', 'utf8');

    try {
        assert.doesNotThrow(() => {
            runChecked(fixture, [], 'O arquivo cmd de teste falhou.');
        });
    } finally {
        fs.rmSync(fixture, { force: true });
    }
});
