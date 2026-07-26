'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverPath = path.resolve(__dirname, '../helpers/clover/siteApiServer.js');

function source() {
    return fs.readFileSync(serverPath, 'utf8');
}

test('Servidor registra o handler operacional de Mundos dos Sonhos', () => {
    const text = source();
    assert.match(
        text,
        /require\(['"]\.\/dreamWorldsOperationsHttp['"]\)/,
        'O servidor precisa importar dreamWorldsOperationsHttp.'
    );
    assert.match(
        text,
        /handleDreamWorldsOperationsHttp\(req, res, options\)/,
        'O servidor precisa executar o handler operacional.'
    );
    assert.match(
        text,
        /handleDreamWorldsOperationsHttp\s*,/,
        'O handler operacional precisa ser exportado para testes e diagnóstico.'
    );
});

test('Rotas operacionais têm precedência sobre o handler-base', () => {
    const text = source();
    const operational = text.indexOf('if (await handleDreamWorldsOperationsHttp(req, res, options))');
    const base = text.indexOf('if (await handleDreamWorldsHttp(req, res, options))');
    assert.notEqual(operational, -1, 'Chamada operacional ausente.');
    assert.notEqual(base, -1, 'Chamada-base ausente.');
    assert.ok(
        operational < base,
        'O handler operacional precisa vir antes para não perder /me e /fragments para a rota genérica /:slug.'
    );
});
