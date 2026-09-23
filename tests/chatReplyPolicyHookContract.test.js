'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const CHAT_REPLY_PATH = require.resolve('../helpers/chatReply');

function freshChatReply() {
    delete require.cache[CHAT_REPLY_PATH];
    return require(CHAT_REPLY_PATH);
}

function makeSocket() {
    const calls = [];
    return {
        calls,
        sock: {
            async sendMessage(jid, message) {
                calls.push({ jid, message });
                return {
                    key: { id: 'message-' + calls.length, remoteJid: jid },
                    message,
                };
            },
        },
    };
}

function withEnv(values, fn) {
    const previous = {};
    for (const [key, value] of Object.entries(values)) {
        previous[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        });
}

test('modo off mantém envio privado legado sem metadados', async () => {
    await withEnv({
        CLOVER_PV_POLICY_MODE: 'off',
        CLOVER_PRIVATE_SEND_THROTTLE: '0',
    }, async () => {
        const { sendPrivateText } = freshChatReply();
        const { sock, calls } = makeSocket();
        const result = await sendPrivateText({
            sock,
            playerId: '5511999999999@s.whatsapp.net',
            text: 'teste',
        });
        assert.equal(calls.length, 0);
        assert.equal(result.skipped, true);
        assert.equal(result.reason, 'pv_policy_blocked');
    });
});

test('modo observe mede desconhecido sem impedir envio', async () => {
    await withEnv({
        CLOVER_PV_POLICY_MODE: 'observe',
        CLOVER_PRIVATE_SEND_THROTTLE: '0',
    }, async () => {
        const { sendPrivateText } = freshChatReply();
        const { sock, calls } = makeSocket();
        const result = await sendPrivateText({
            sock,
            playerId: '5511888888888@s.whatsapp.net',
            text: 'teste',
        });
        assert.equal(calls.length, 0);
        assert.equal(result.reason, 'pv_policy_blocked');
    });
});

test('modo enforce bloqueia privado desconhecido antes do socket', async () => {
    await withEnv({
        CLOVER_PV_POLICY_MODE: 'enforce',
        CLOVER_PRIVATE_SEND_THROTTLE: '0',
    }, async () => {
        const { sendPrivateText } = freshChatReply();
        const { sock, calls } = makeSocket();
        const result = await sendPrivateText({
            sock,
            playerId: '5511777777777@s.whatsapp.net',
            text: 'teste',
        });
        assert.equal(calls.length, 0);
        assert.equal(result.skipped, true);
        assert.equal(result.reason, 'pv_policy_blocked');
        assert.equal(result.policy.decisionReason, 'private_source_not_allowlisted');
    });
});

test('modo enforce preserva transação identificada e deduplicável', async () => {
    await withEnv({
        CLOVER_PV_POLICY_MODE: 'enforce',
        CLOVER_PRIVATE_SEND_THROTTLE: '0',
    }, async () => {
        const { sendPrivateText } = freshChatReply();
        const { sock, calls } = makeSocket();
        const result = await sendPrivateText({
            sock,
            playerId: '5511666666666@s.whatsapp.net',
            text: 'aparência aprovada',
            policy: {
                source: 'appearance_approved',
                dedupeKey: 'appearance:player:revision-1',
            },
        });
        assert.equal(calls.length, 1);
        assert.equal(result?.key?.id, 'message-1');
    });
});

test('resposta a comando no PV é inferida como reativa', async () => {
    await withEnv({
        CLOVER_PV_POLICY_MODE: 'enforce',
        CLOVER_PRIVATE_SEND_THROTTLE: '0',
        CLOVER_HUMAN_TYPING_ENABLED: '0',
    }, async () => {
        const { sendReply } = freshChatReply();
        const { sock, calls } = makeSocket();
        await sendReply({
            sock,
            idChat: '5511555555555@s.whatsapp.net',
            m: { message: { conversation: '.#site' } },
            text: 'codigo',
        });
        assert.equal(calls.length, 1);
    });
});

test('comando privado diferente de site e bloqueado antes do socket', async () => {
    await withEnv({
        CLOVER_PV_POLICY_MODE: 'enforce',
        CLOVER_PRIVATE_SEND_THROTTLE: '0',
        CLOVER_HUMAN_TYPING_ENABLED: '0',
    }, async () => {
        const { sendReply } = freshChatReply();
        const { sock, calls } = makeSocket();
        const result = await sendReply({
            sock,
            idChat: '5511555555555@s.whatsapp.net',
            m: { message: { conversation: '.#ajuda' } },
            text: 'menu',
        });
        assert.equal(calls.length, 0);
        assert.equal(result.reason, 'pv_policy_blocked');
        assert.equal(result.policy.decisionReason, 'private_source_not_allowlisted');
    });
});

test('alvo de grupo continua fora da política privada', async () => {
    await withEnv({
        CLOVER_PV_POLICY_MODE: 'enforce',
        CLOVER_PRIVATE_SEND_THROTTLE: '0',
    }, async () => {
        const { sendReply } = freshChatReply();
        const { sock, calls } = makeSocket();
        await sendReply({
            sock,
            idChat: '120363000000000000@g.us',
            text: 'grupo',
        });
        assert.equal(calls.length, 1);
    });
});
