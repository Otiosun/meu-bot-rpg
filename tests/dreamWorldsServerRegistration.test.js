'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverPath = path.resolve(__dirname, '../helpers/clover/siteApiServer.js');
const httpPath = path.resolve(__dirname, '../helpers/clover/dreamWorldsHttp.js');

function read(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

test('Servidor registra o handler operacional de Mundos dos Sonhos', () => {
    const text = read(serverPath);
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
    const text = read(serverPath);
    const operational = text.indexOf('if (await handleDreamWorldsOperationsHttp(req, res, options))');
    const base = text.indexOf('if (await handleDreamWorldsHttp(req, res, options))');
    assert.notEqual(operational, -1, 'Chamada operacional ausente.');
    assert.notEqual(base, -1, 'Chamada-base ausente.');
    assert.ok(
        operational < base,
        'O handler operacional precisa vir antes para não perder /me e /fragments para a rota genérica /:slug.'
    );
});

test('Aprovação administrativa devolve incursão no contrato serializado', () => {
    const text = read(httpPath);
    assert.match(
        text,
        /const \{ getDreamRun \} = require\(['"]\.\/dreamWorldsOperationsService['"]\)/,
        'A rota de aprovação precisa carregar o serializador operacional.'
    );
    assert.match(
        text,
        /const run = await getDreamRun\(db, result\.run\.id\)/,
        'A incursão aprovada precisa ser recarregada pelo contrato público.'
    );
    assert.match(
        text,
        /sendJson\(res, 200, \{ ok: true, \.\.\.result, run \}\)/,
        'A resposta precisa substituir a linha interna pela incursão serializada.'
    );
});
