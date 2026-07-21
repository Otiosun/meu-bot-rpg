'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderOffGroupWelcomeMessage } = require('../helpers/clover/groupManager');

test('mantém a recepção do OFF e usa somente o site da Vercel', () => {
    const message = renderOffGroupWelcomeMessage('5511999999999@s.whatsapp.net');

    assert.match(message, /𝐁𝐄𝐌-𝐕𝐈𝐍𝐃𝐎 𝐀𝐎 𝐂𝐋𝐎𝐕𝐄𝐑 𝐌𝐔𝐋𝐓𝐈𝐂𝐎𝐋𝐎𝐑/u);
    assert.match(message, /clov.+r rpg · grupo off/iu);
    assert.match(message, /\.#ajuda/u);
    assert.match(message, /https:\/\/clover-multicolor\.vercel\.app\//u);
    assert.doesNotMatch(message, /lovable\.app/iu);
    assert.match(message, /A história e personalidade vêm depois/u);
});
