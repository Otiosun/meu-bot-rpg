const test = require('node:test');
const assert = require('node:assert/strict');

const { OWNER_NUMBERS } = require('../helpers/groupAccess');
const command = require('../comandos/playerControle');

const OWNER = `${[...OWNER_NUMBERS][0]}@s.whatsapp.net`;

function createSock(messages) {
    return {
        sendMessage: async (chatId, content) => {
            messages.push({ chatId, content });
            return { key: { id: `reply-${messages.length}` } };
        },
    };
}

for (const action of ['ativarplayer', 'desativarplayer']) {
    test(`${action} permanece manual-only e não consulta nem altera o player`, async () => {
        const messages = [];
        const db = new Proxy({}, {
            get() {
                throw new Error('playerControle não deve acessar o DB');
            },
        });

        await command.executar({
            sock: createSock(messages),
            m: { key: { id: `message-${action}`, remoteJid: 'admin@g.us' } },
            idChat: 'admin@g.us',
            idJogador: OWNER,
            db,
            body: '@player motivo administrativo',
            matchedCommand: `.#${action}`,
        });

        assert.equal(messages.length, 1);
        assert.match(messages[0].content.text, /bloqueada/i);
        assert.match(messages[0].content.text, /opera[cç][aã]o can[oô]nica/i);
    });
}
