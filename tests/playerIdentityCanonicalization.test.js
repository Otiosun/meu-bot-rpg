'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadGroupAccess(authInfoDir) {
    process.env.CLOVER_AUTH_INFO_DIR = authInfoDir;
    const modulePath = require.resolve('../helpers/groupAccess');
    delete require.cache[modulePath];
    return require('../helpers/groupAccess');
}

test('telefone e LID confirmados convergem para uma identidade canônica', (t) => {
    const authInfoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-identity-'));
    const phone = '553197168289';
    const lid = '27702773956629';
    const directJid = `${phone}@s.whatsapp.net`;
    const lidJid = `${lid}@lid`;
    const previousAuthInfoDir = process.env.CLOVER_AUTH_INFO_DIR;
    const modulePath = require.resolve('../helpers/groupAccess');

    t.after(() => {
        if (previousAuthInfoDir === undefined) delete process.env.CLOVER_AUTH_INFO_DIR;
        else process.env.CLOVER_AUTH_INFO_DIR = previousAuthInfoDir;
        delete require.cache[modulePath];
        fs.rmSync(authInfoDir, { recursive: true, force: true });
    });

    let access = loadGroupAccess(authInfoDir);
    assert.equal(access.normalizeJid(directJid), directJid);
    assert.equal(access.extractPhoneNumber(directJid), phone);

    fs.writeFileSync(
        path.join(authInfoDir, `lid-mapping-${phone}.json`),
        JSON.stringify({ lid }),
        'utf8'
    );

    access = loadGroupAccess(authInfoDir);
    assert.equal(
        access.normalizeJid(directJid),
        directJid,
        'mapeamento de mão única não pode trocar a identidade'
    );

    fs.writeFileSync(
        path.join(authInfoDir, `lid-mapping-${lid}_reverse.json`),
        JSON.stringify({ phoneNumber: phone }),
        'utf8'
    );

    access = loadGroupAccess(authInfoDir);
    assert.equal(access.normalizeJid(directJid), lidJid);
    assert.equal(access.normalizeJid(`${phone}:18@s.whatsapp.net`), lidJid);
    assert.equal(access.normalizeJid(lidJid), lidJid);
    assert.equal(access.extractPhoneNumber(directJid), phone);
    assert.equal(access.extractPhoneNumber(lidJid), phone);
    assert.equal(access.isSameUser(directJid, lidJid), true);
    assert.equal(access.normalizeJid('120363000000000000@g.us'), '120363000000000000@g.us');
});
