'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    buildIdentityGraph,
    canonicalIdentityFor,
    collectIdentityCandidates,
    connectedIdentities,
} = require('../helpers/clover/siteIdentityGraph');

function fixture(t) {
    const authInfoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-identity-graph-'));
    t.after(() => fs.rmSync(authInfoDir, { recursive: true, force: true }));
    return authInfoDir;
}

function write(authInfoDir, name, value) {
    fs.writeFileSync(path.join(authInfoDir, name), JSON.stringify(value));
}

test('percorre telefone para LID para outro identificador no componente completo', (t) => {
    const authInfoDir = fixture(t);
    write(authInfoDir, 'lid-mapping-31000001.json', { nested: { lid: '41000001@lid' } });
    write(authInfoDir, 'lid-mapping-41000001_reverse.json', {
        links: [{ phoneNumber: '31000001' }, { lid: '41000002@lid' }],
    });
    write(authInfoDir, 'lid-mapping-41000002_reverse.json', { phoneNumber: '31000002' });

    const graph = buildIdentityGraph(authInfoDir);
    assert.deepEqual(connectedIdentities(graph, ['31000001@s.whatsapp.net']), [
        '31000001@s.whatsapp.net',
        '41000001@lid',
        '41000002@lid',
        '31000002@s.whatsapp.net',
    ]);
    assert.equal(canonicalIdentityFor(graph, ['31000001@s.whatsapp.net']), '41000001@lid');
});

test('parser percorre JSON aninhado e arrays com multiplos candidatos', () => {
    const output = new Set();
    collectIdentityCandidates({ payload: [{ phoneNumber: '32000001' }, { lid: '42000001@lid' }] }, 'lid', output);
    assert.deepEqual([...output].sort(), ['32000001@s.whatsapp.net', '42000001@lid']);
});

test('forward sem reverse ainda forma aresta bidirecional sem adivinhar', (t) => {
    const authInfoDir = fixture(t);
    write(authInfoDir, 'lid-mapping-33000001.json', { lid: '43000001@lid' });
    const graph = buildIdentityGraph(authInfoDir);
    assert.deepEqual(connectedIdentities(graph, ['43000001@lid']), [
        '43000001@lid',
        '33000001@s.whatsapp.net',
    ]);
});

test('reverse inconsistente conecta todos os valores e permite falha fechada posterior', (t) => {
    const authInfoDir = fixture(t);
    write(authInfoDir, 'lid-mapping-34000001.json', { lid: '44000001@lid' });
    write(authInfoDir, 'lid-mapping-44000001_reverse.json', { phoneNumber: '34000002' });
    const graph = buildIdentityGraph(authInfoDir);
    assert.deepEqual(connectedIdentities(graph, ['34000001@s.whatsapp.net']), [
        '34000001@s.whatsapp.net',
        '44000001@lid',
        '34000002@s.whatsapp.net',
    ]);
});
