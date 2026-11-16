'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('ajuda administrativa anuncia apenas ações de Raid realmente suportadas pelo bot', async () => {
    const replies = [];
    const helpPath = require.resolve('../comandos/ajuda.js');
    const originalLoad = Module._load;

    Module._load = function withRaidHelpFakes(request, parent, isMain) {
        if (parent?.filename === helpPath) {
            if (request === '../config/bot') return { COMMAND_PREFIX: '.#' };
            if (request === '../helpers/chatReply') {
                return { sendReply: async ({ text }) => replies.push(text) };
            }
            if (request === '../helpers/groupAccess') return { isOwner: () => true };
            if (request === '../helpers/clover/commandTargetUtils') {
                return { canManagePlayer: async () => false };
            }
            if (request === '../helpers/clover/playerPhase') {
                return { PHASES: {}, getPlayerPhase: async () => ({ canPlay: true }) };
            }
            if (request === '../helpers/clover/playerMenuMessages') {
                return { renderPostFichaHelp: () => 'PLAYER HELP' };
            }
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    delete require.cache[helpPath];
    try {
        const help = require('../comandos/ajuda.js');
        await help.executar({
            sock: {},
            m: {},
            idChat: 'grupo@g.us',
            idJogador: 'owner@s.whatsapp.net',
            db: {},
        });
    } finally {
        Module._load = originalLoad;
        delete require.cache[helpPath];
    }

    const output = replies.join('\n');
    assert.match(output, /\.\#raid listar/);
    assert.match(output, /\.\#raid status <código>/);
    assert.match(output, /\.\#raid <código>/);
    assert.match(output, /\.\#raid entrar <código>/);
    assert.match(output, /\.\#raid sair <código>/);
    assert.match(output, /Central ADM do site/);
    assert.doesNotMatch(output, /\.\#raid (criar|abrir|add|remover|marcar|recompensas|simular|aplicar)\b/);
});
