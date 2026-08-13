'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const V2_HEAD = '287bfd81d15bddc3787054d90b12ad083230ffac';
const ROUTING_HEAD = '1eb4fdf3360a07bdb29a62043c8badc47794c8ec';
const CURRENT_MAIN = 'ffbe1c835781e6383ab1108429a4abad6cb8b888';

function git(args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function read(relative) {
    return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function write(relative, content) {
    const target = path.join(ROOT, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
}

function historical(commit, relative) {
    return git(['show', `${commit}:${relative}`]);
}

function replaceOnce(source, before, after, label) {
    const parts = source.split(before);
    if (parts.length !== 2) {
        throw new Error(`${label}: esperado 1 match, encontrado ${parts.length - 1}`);
    }
    return parts[0] + after + parts[1];
}

function assertCurrentMainAncestor() {
    try {
        git(['merge-base', '--is-ancestor', CURRENT_MAIN, 'HEAD']);
    } catch {
        throw new Error(`A candidata deve descender do backend main ${CURRENT_MAIN}.`);
    }
}

function copyCanonicalV2Files() {
    for (const relative of [
        'helpers/clover/adminHookV2Service.js',
        'helpers/clover/adminHookV2Persistence.js',
    ]) {
        write(relative, historical(V2_HEAD, relative));
    }

    // A API de leitura V2 já preservava V1 e acrescentava schema/enriquecimento.
    write('helpers/clover/adminHooksReadApi.js', historical(V2_HEAD, 'helpers/clover/adminHooksReadApi.js'));

    // Testes históricos são copiados com nomes de port para não sobrescrever suítes atuais.
    write('tests/cloverAdminHookV2CurrentMain.test.js', historical(V2_HEAD, 'tests/cloverAdminHookV2.test.js'));
    write('tests/cloverAdminSupplementaryRoutingCurrentMain.test.js', historical(ROUTING_HEAD, 'tests/cloverAdminSupplementaryRouting.test.js'));
}

function patchAdminApiSupport() {
    const file = 'helpers/clover/adminApiSupport.js';
    let source = read(file);

    if (!source.includes("require('./adminItemsReadApi')")) {
        source = replaceOnce(
            source,
            "const { getOperationByCode } = require('./adminOperationService');\n",
            "const { getOperationByCode } = require('./adminOperationService');\nconst { handleAdminItemsReadApi } = require('./adminItemsReadApi');\nconst { handleAdminHooksReadApi } = require('./adminHooksReadApi');\nconst { handleAdminRewardsReadApi } = require('./adminRewardsReadApi');\n",
            'imports suplementares',
        );
    }

    if (!source.includes('async function handleSupplementaryAdminReads(')) {
        source = replaceOnce(
            source,
            'async function handleAdminApiSupport(req, res, options = {}) {\n',
            "async function handleSupplementaryAdminReads(req, res, options = {}) {\n    if (await handleAdminItemsReadApi(req, res, options)) return true;\n    if (await handleAdminHooksReadApi(req, res, options)) return true;\n    return handleAdminRewardsReadApi(req, res, options);\n}\n\nasync function handleAdminApiSupport(req, res, options = {}) {\n    if (await handleSupplementaryAdminReads(req, res, options)) return true;\n",
            'despacho suplementar',
        );
    }

    if (!source.includes('    handleSupplementaryAdminReads,\n')) {
        source = replaceOnce(
            source,
            '    handlePolicyCatalog,\n',
            '    handlePolicyCatalog,\n    handleSupplementaryAdminReads,\n',
            'export suplementar',
        );
    }

    write(file, source);
}

function patchOperationRegistry() {
    const file = 'helpers/clover/adminOperationRegistry.js';
    let source = read(file);

    if (!source.includes("require('./adminHookV2Service')")) {
        source = replaceOnce(
            source,
            "const base = require('./adminOperationRegistryBase');\n",
            "const base = require('./adminOperationRegistryBase');\nconst { decorateHookExecutors } = require('./adminHookV2Service');\nconst { hardenHookV2Executors } = require('./adminHookV2Persistence');\n",
            'imports V2 registry',
        );
    }

    source = replaceOnce(
        source,
        'function getAdminOperationExecutors() {\n    return markAtomicSafety(base.getAdminOperationExecutors());\n}',
        'function getAdminOperationExecutors() {\n    const v2 = decorateHookExecutors(base.getAdminOperationExecutors());\n    return markAtomicSafety(hardenHookV2Executors(v2));\n}',
        'composicao V2 registry',
    );

    write(file, source);
}

function createFocusedContract() {
    write('tests/adminHooksV2CurrentMainPortContract.test.js', `'use strict';\n\nconst assert = require('node:assert/strict');\nconst test = require('node:test');\n\nconst hooksApi = require('../helpers/clover/adminHooksReadApi');\nconst registry = require('../helpers/clover/adminOperationRegistry');\nconst v2 = require('../helpers/clover/adminHookV2Service');\nconst persistence = require('../helpers/clover/adminHookV2Persistence');\nconst adminApi = require('../helpers/clover/adminApiSupport');\n\ntest('schema V2 e rota schema estao materializados', () => {\n    const schema = v2.getHookV2Schema();\n    assert.equal(schema.ok, true);\n    assert.equal(schema.version, 2);\n    assert.equal(hooksApi.isAdminHooksPath('/admin/hooks/schema'), true);\n    assert.equal(hooksApi.parseHookDetailPath('/admin/hooks/schema'), null);\n});\n\ntest('roteador principal expoe leituras suplementares', () => {\n    assert.equal(typeof adminApi.handleSupplementaryAdminReads, 'function');\n});\n\ntest('registry atual compoe decoracao e hardening V2', () => {\n    assert.equal(typeof v2.decorateHookExecutors, 'function');\n    assert.equal(typeof persistence.hardenHookV2Executors, 'function');\n    const executors = registry.getAdminOperationExecutors();\n    assert.ok(executors['catalog.hook.create']);\n    assert.ok(executors['catalog.hook.update']);\n    assert.ok(executors['player.hook.assign']);\n});\n`);
}

function verifyStatic() {
    const required = [
        'helpers/clover/adminHookV2Service.js',
        'helpers/clover/adminHookV2Persistence.js',
        'helpers/clover/adminHooksReadApi.js',
        'helpers/clover/adminApiSupport.js',
        'helpers/clover/adminOperationRegistry.js',
        'tests/adminHooksV2CurrentMainPortContract.test.js',
    ];
    for (const relative of required) {
        execFileSync(process.execPath, ['--check', path.join(ROOT, relative)], { stdio: 'inherit' });
    }

    const api = read('helpers/clover/adminHooksReadApi.js');
    const support = read('helpers/clover/adminApiSupport.js');
    const registry = read('helpers/clover/adminOperationRegistry.js');
    const service = read('helpers/clover/adminHookV2Service.js');

    const checks = [
        ['schema route', api.includes("pathname === '/admin/hooks/schema'")],
        ['schema version', service.includes('const HOOK_V2_VERSION = 2')],
        ['supplementary routing', support.includes('handleSupplementaryAdminReads')],
        ['registry decoration', registry.includes('decorateHookExecutors')],
        ['registry persistence hardening', registry.includes('hardenHookV2Executors')],
    ];
    for (const [label, ok] of checks) {
        console.log(`${ok ? 'PASS' : 'FAIL'} :: ${label}`);
        if (!ok) throw new Error(`Contrato estatico ausente: ${label}`);
    }
}

assertCurrentMainAncestor();
copyCanonicalV2Files();
patchAdminApiSupport();
patchOperationRegistry();
createFocusedContract();
verifyStatic();

console.log('ADMIN_HOOKS_V2_CURRENT_MAIN_PREPARE=PASS');
console.log(`sourceV2=${V2_HEAD}`);
console.log(`sourceRouting=${ROUTING_HEAD}`);
console.log(`currentMain=${CURRENT_MAIN}`);
