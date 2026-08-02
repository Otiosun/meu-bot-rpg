'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const CHAT_REPLY_PATH = require.resolve('../helpers/chatReply');

function freshChatReply() {
    delete require.cache[CHAT_REPLY_PATH];
    return require(CHAT_REPLY_PATH);
}

async function withEnvironment(values, fn) {
    const previous = {};

    for (const [key, value] of Object.entries(values)) {
        previous[key] = process.env[key];

        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    try {
        return await fn();
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

async function withReachoutLock(fn) {
    const previousRuntime = global.runtimeClover;

    global.runtimeClover = {
        ...(previousRuntime || {}),
        pvReachoutLock: {
            isActive: true,
            enforcementType: 'rate_limit',
            timeEnforcementEnds: new Date(Date.now() + 60000),
        },
    };

    try {
        return await fn();
    } finally {
        global.runtimeClover = previousRuntime;
    }
}

test('resposta ao .#site embrulhado tenta envio durante reachout lock', async () => {
    await withEnvironment({
        CLOVER_PV_POLICY_MODE: 'off',
        CLOVER_PRIVATE_SEND_THROTTLE: '0',
        CLOVER_HUMAN_TYPING_ENABLED: '0',
    }, () => withReachoutLock(async () => {
        const calls = [];
        const { sendReply } = freshChatReply();

        const sock = {
            async sendMessage(jid, message, options = {}) {
                calls.push({ jid, message, options });

                return {
                    key: {
                        id: 'site-message-1',
                        remoteJid: jid,
                    },
                    message,
                };
            },
        };

        const result = await sendReply({
            sock,
            idChat: '5511999999999@s.whatsapp.net',
            m: {
                message: {
                    ephemeralMessage: {
                        message: {
                            conversation: '.#site',
                        },
                    },
                },
            },
            text: 'Código temporário do site',
        });

        assert.equal(calls.length, 1);
        assert.equal(result.key.id, 'site-message-1');

        assert.equal(
            calls[0].options.forcePrivateDuringReachoutLock,
            true
        );

        assert.equal(
            calls[0]
                .options
                .quoted
                .message
                .ephemeralMessage
                .message
                .conversation,
            '.#site'
        );
    }));
});

test('mensagem automática permanece bloqueada', async () => {
    await withEnvironment({
        CLOVER_PV_POLICY_MODE: 'off',
        CLOVER_PRIVATE_SEND_THROTTLE: '0',
    }, () => withReachoutLock(async () => {
        const calls = [];
        const { sendPrivateText } = freshChatReply();

        const sock = {
            async sendMessage(jid, message, options) {
                calls.push({ jid, message, options });

                return {
                    key: {
                        id: 'automatic-message-1',
                        remoteJid: jid,
                    },
                    message,
                };
            },
        };

        const result = await sendPrivateText({
            sock,
            playerId: '5511888888888@s.whatsapp.net',
            text: 'Mensagem automática',
        });

        assert.equal(calls.length, 0);
        assert.equal(result.skipped, true);
        assert.equal(result.reason, 'pv_reachout_locked');
    }));
});

test('opção interna é removida antes do Baileys', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'index.js'),
        'utf8'
    );

    assert.match(
        source,
        /forcePrivateDuringReachoutLock = false/
    );

    assert.match(
        source,
        /if \(lock && !forcePrivateDuringReachoutLock\)/
    );

    assert.match(
        source,
        /return sendMessageOriginal\(jid, content, sendOptions\);/
    );
});
