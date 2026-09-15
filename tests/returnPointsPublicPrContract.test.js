'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { COMMAND_PREFIX } = require('../config/bot');
const prCommand = require('../comandos/pr');
const { PHASES, canUseCommandInPhase } = require('../helpers/clover/playerPhase');
const { retireLegacyRecruitmentPrHttp } = require('../helpers/clover/siteApiServer');

test('PR publico significa somente Pontos de Retorno', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'comandos', 'pr.js'), 'utf8');

    assert.equal(prCommand.nome, `${COMMAND_PREFIX}pr`);
    assert.equal(prCommand.descricao, 'Consulta seus Pontos de Retorno.');
    assert.ok(prCommand.aliases.includes(`${COMMAND_PREFIX}pontosretorno`));

    assert.match(source, /returnPointsService/);
    assert.match(source, /getReturnPointsBalance/);
    assert.match(source, /PONTOS 𝐃𝐄 𝐑𝐄𝐓𝐎𝐑𝐍𝐎|PONTOS DE RETORNO|𝐏𝐎𝐍𝐓𝐎𝐒 𝐃𝐄 𝐑𝐄𝐓𝐎𝐑𝐍𝐎/u);
    assert.doesNotMatch(source, /prService/);
    assert.doesNotMatch(source, /recruitmentService/);
    assert.doesNotMatch(source, /recruitmentGroupService/);
    assert.doesNotMatch(source, /PONTOS DE RECRUTAMENTO/i);
    assert.doesNotMatch(source, /pontosrecrutamento/i);
    assert.doesNotMatch(source, /pontosdivulgacao/i);
    assert.doesNotMatch(source, /getPhLedgerAuthoritySnapshot/);
    assert.doesNotMatch(source, /clover_admin_service_entries/);
    assert.doesNotMatch(source, /INDIVIDUAL_RETURN_POINTS_BONUS/);
    assert.doesNotMatch(source, /getProjectedReturnPoints/);
});

test('PR de Retorno continua consultavel durante todas as fases PRE_RESET', () => {
    for (const phase of [PHASES.PRE_RESET_DECISION, PHASES.PRE_RESET_BUILD, PHASES.PRE_RESET_WAIT]) {
        assert.equal(canUseCommandInPhase(`${COMMAND_PREFIX}pr`, phase), true, phase);
    }
});

test('resumo publico consulta somente o saldo do ledger de Retorno', async () => {
    const queries = [];
    const sent = [];
    const db = {
        async get(sql) {
            queries.push(String(sql));
            return { balance: 37 };
        },
    };
    const sock = {
        async sendMessage(target, payload) {
            sent.push({ target, payload });
            return { key: { id: 'return-points-contract' } };
        },
    };

    await prCommand.executar({
        sock,
        m: null,
        idChat: 'return-points-contract@g.us',
        idJogador: 'return-points-player',
        db,
        body: '',
    });

    assert.equal(queries.length, 1);
    assert.match(queries[0], /clover_return_points_ledger/);
    assert.equal(sent.length, 1);
    assert.match(sent[0].payload.text, /Saldo atual:\*? 37 PR/);
});

test('comandos publicos do antigo Recruitment PR foram removidos', () => {
    for (const file of ['divulga.js', 'comprardivulga.js', 'lojadivulga.js']) {
        assert.equal(fs.existsSync(path.join(__dirname, '..', 'comandos', file)), false, file);
    }
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'comandos', 'divulgacao.js')), true);
});

test('rota web da antiga loja Recruitment PR responde 410 antes do legado', () => {
    const headers = {};
    let body = '';
    const req = { method: 'GET', url: '/recruitment/shop' };
    const res = {
        statusCode: 200,
        setHeader(name, value) { headers[name] = value; },
        end(value = '') { body += String(value); },
    };

    assert.equal(retireLegacyRecruitmentPrHttp(req, res), true);
    assert.equal(res.statusCode, 410);
    assert.equal(headers['Cache-Control'], 'no-store');
    const payload = JSON.parse(body);
    assert.equal(payload.error, 'legacy_recruitment_pr_retired');
    assert.match(payload.message, /PR agora significa Pontos de Retorno/);

    assert.equal(retireLegacyRecruitmentPrHttp({ method: 'GET', url: '/reception' }, res), false);
});
