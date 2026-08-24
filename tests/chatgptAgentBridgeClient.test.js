'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildAgentBridgeConfig,
    buildQuestionId,
    createAgentBridgeClient,
    normalizeEndpoint,
} = require('../helpers/clover/chatgptAgentBridgeClient');
const { runAgentAnswerSweep } = require('../helpers/clover/chatgptAgentBridgeRuntime');

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async text() {
            return JSON.stringify(payload);
        },
    };
}

test('configuração é fail-closed quando bridge ligado sem segredo/URL', () => {
    const config = buildAgentBridgeConfig({ CLOVER_AGENT_BRIDGE_ENABLED: '1' });
    assert.equal(config.enabled, true);
    assert.equal(config.valid, false);
});

test('endpoint aceita apenas HTTPS válido', () => {
    assert.equal(normalizeEndpoint('http://example.com/hook'), '');
    assert.equal(normalizeEndpoint('abc'), '');
    assert.equal(normalizeEndpoint('https://script.google.com/macros/s/abc/exec'), 'https://script.google.com/macros/s/abc/exec');
});

test('enqueue envia somente payload necessário e segredo no corpo', async () => {
    const calls = [];
    const client = createAgentBridgeClient({
        env: {
            CLOVER_AGENT_BRIDGE_ENABLED: '1',
            CLOVER_AGENT_BRIDGE_URL: 'https://script.google.com/macros/s/abc/exec',
            CLOVER_AGENT_BRIDGE_SECRET: 'secret-test',
        },
        fetchImpl: async (url, options) => {
            calls.push({ url: String(url), options });
            return jsonResponse({ ok: true, id: 'q1', status: 'PENDING' });
        },
    });

    const result = await client.enqueueQuestion({
        id: 'q1',
        playerId: 'player',
        playerName: 'Nome',
        chatId: 'chat',
        question: 'Pergunta?',
        context: { source: 'test' },
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.action, 'enqueue');
    assert.equal(body.secret, 'secret-test');
    assert.equal(body.question, 'Pergunta?');
});

test('fetchAnswered limita lote e normaliza lista ausente', async () => {
    let calledUrl = '';
    const client = createAgentBridgeClient({
        env: {
            CLOVER_AGENT_BRIDGE_ENABLED: '1',
            CLOVER_AGENT_BRIDGE_URL: 'https://script.google.com/macros/s/abc/exec',
            CLOVER_AGENT_BRIDGE_SECRET: 'x',
        },
        fetchImpl: async (url) => {
            calledUrl = String(url);
            return jsonResponse({ ok: true });
        },
    });

    const result = await client.fetchAnswered({ limit: 999 });
    assert.deepEqual(result.answers, []);
    assert.match(calledUrl, /limit=50/);
});

test('id de pergunta é determinístico e não expõe o JID bruto', () => {
    const a = buildQuestionId({ idChat: '551199999999@s.whatsapp.net', messageId: 'ABC' });
    const b = buildQuestionId({ idChat: '551199999999@s.whatsapp.net', messageId: 'ABC' });
    assert.equal(a, b);
    assert.match(a, /^wa_[a-f0-9]{24}$/);
    assert.equal(a.includes('551199999999'), false);
});

test('sweep entrega resposta e só então confirma entrega', async () => {
    const actions = [];
    const fetchImpl = async (url, options = {}) => {
        if ((options.method || 'GET') === 'GET') {
            return jsonResponse({
                ok: true,
                answers: [{ id: 'q1', chat_id: 'chat@s.whatsapp.net', answer: 'Resposta.' }],
            });
        }
        const body = JSON.parse(options.body);
        actions.push(body.action);
        return jsonResponse({ ok: true, id: body.id, status: 'DELIVERED' });
    };
    const sent = [];
    const result = await runAgentAnswerSweep({
        sock: {
            async sendMessage(chatId, content) {
                sent.push({ chatId, content });
                return { key: { id: 'sent' } };
            },
        },
        env: {
            CLOVER_AGENT_BRIDGE_ENABLED: '1',
            CLOVER_AGENT_BRIDGE_URL: 'https://script.google.com/macros/s/abc/exec',
            CLOVER_AGENT_BRIDGE_SECRET: 'x',
        },
        fetchImpl,
    });

    assert.equal(result.delivered, 1);
    assert.deepEqual(sent, [{ chatId: 'chat@s.whatsapp.net', content: { text: 'Resposta.' } }]);
    assert.deepEqual(actions, ['ack_delivered']);
});

test('sweep não confirma entrega quando o socket bloqueia o envio', async () => {
    const actions = [];
    const fetchImpl = async (url, options = {}) => {
        if ((options.method || 'GET') === 'GET') {
            return jsonResponse({
                ok: true,
                answers: [{ id: 'q1', chat_id: 'chat@s.whatsapp.net', answer: 'Resposta.' }],
            });
        }
        actions.push(JSON.parse(options.body).action);
        return jsonResponse({ ok: true });
    };
    const result = await runAgentAnswerSweep({
        sock: {
            async sendMessage() {
                return { skipped: true, reason: 'pv_reachout_locked' };
            },
        },
        env: {
            CLOVER_AGENT_BRIDGE_ENABLED: '1',
            CLOVER_AGENT_BRIDGE_URL: 'https://script.google.com/macros/s/abc/exec',
            CLOVER_AGENT_BRIDGE_SECRET: 'x',
        },
        fetchImpl,
    });

    assert.equal(result.delivered, 0);
    assert.equal(result.failed, 1);
    assert.deepEqual(actions, []);
});
