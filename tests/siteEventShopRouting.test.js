'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    remapCurrentEventShopHttp,
    retireLegacyRecruitmentPrHttp,
} = require('../helpers/clover/siteApiServer');

function responseFixture() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
        end(value = '') { this.body += String(value); },
    };
}

test('site: URL antiga de recruitment shop permanece aposentada com 410', () => {
    const req = { method:'GET', url:'/recruitment/shop' };
    const res = responseFixture();
    assert.equal(retireLegacyRecruitmentPrHttp(req, res), true);
    assert.equal(res.statusCode, 410);
    assert.equal(JSON.parse(res.body).error, 'legacy_recruitment_pr_retired');
});

test('site: URL atual de PV e remapeada sem mudar query string', () => {
    const req = { method:'GET', url:'/event-points/shop?view=compact' };
    assert.equal(remapCurrentEventShopHttp(req), true);
    assert.equal(req.url, '/recruitment/shop?view=compact');
});

test('site: compra PV preserva item e subrota de purchase', () => {
    const req = { method:'POST', url:'/event-points/shop/caixa_rara/purchase' };
    assert.equal(remapCurrentEventShopHttp(req), true);
    assert.equal(req.url, '/recruitment/shop/caixa_rara/purchase');
});

test('site: remapeador ignora qualquer outra rota', () => {
    const req = { method:'GET', url:'/pre-reset/status' };
    assert.equal(remapCurrentEventShopHttp(req), false);
    assert.equal(req.url, '/pre-reset/status');
});
