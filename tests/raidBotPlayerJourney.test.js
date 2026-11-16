'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadRaidWithFakeServices() {
    const calls = { listed: 0, opened: [], joined: [], left: [], replies: [] };
    class RaidServiceError extends Error {
        constructor(code, message) {
            super(message);
            this.code = code;
        }
    }
    const fakeRaid = {
        key: 'RAID-7',
        name: 'Ruínas do Norte',
        category: 'C',
        status: 'lobby',
        location: 'Norte',
        maxPlayers: 5,
    };
    const fakes = {
        '../config/bot': { COMMAND_PREFIX: '.#' },
        '../helpers/chatReply': {
            sendReply: async (message) => { calls.replies.push(message.text); },
        },
        '../helpers/clover/raidService': {
            RaidServiceError,
            listActorRaids: async () => {
                calls.listed += 1;
                return [fakeRaid];
            },
            getRaidDashboard: async (_db, key) => {
                calls.opened.push(key);
                return { raid: fakeRaid, participants: [] };
            },
            joinRaid: async (_db, key) => {
                calls.joined.push(key);
                return { raid: fakeRaid };
            },
            leaveRaid: async (_db, key) => {
                calls.left.push(key);
                return { ok: true };
            },
        },
        '../helpers/clover/sitePublicUrl': {
            getPublicSiteUrl: () => 'https://clover-multicolor.vercel.app',
        },
    };

    const modulePath = require.resolve('../comandos/raid');
    delete require.cache[modulePath];
    const originalLoad = Module._load;
    Module._load = function withFakes(request, parent, isMain) {
        if (parent?.filename === modulePath && Object.prototype.hasOwnProperty.call(fakes, request)) {
            return fakes[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    let command;
    try {
        command = require(modulePath);
    } finally {
        Module._load = originalLoad;
        delete require.cache[modulePath];
    }

    return {
        calls,
        execute: (body) => command.executar({
            sock: {},
            m: {},
            idChat: 'grupo@g.us',
            idJogador: 'player@s.whatsapp.net',
            db: {},
            body,
        }),
    };
}

test('raid bot: listar, lista, minhas e comando vazio mostram raids do ator', async () => {
    for (const body of ['listar', 'lista', 'minhas', 'meus', '']) {
        const { calls, execute } = loadRaidWithFakeServices();
        await execute(body);
        assert.equal(calls.listed, 1, `listActorRaids deveria ser chamado: ${body}`);
        assert.deepEqual(calls.opened, []);
        assert.match(calls.replies.at(-1), /Ruínas do Norte/);
    }
});

test('raid bot: status com código abre o painel da raid correta', async () => {
    const { calls, execute } = loadRaidWithFakeServices();
    await execute('status RAID-7');
    assert.deepEqual(calls.opened, ['RAID-7']);
    assert.equal(calls.listed, 0);
    assert.match(calls.replies.at(-1), /Lobby aberto/);
});

test('raid bot: código direto mantém acesso ao painel', async () => {
    const { calls, execute } = loadRaidWithFakeServices();
    await execute('RAID-7');
    assert.deepEqual(calls.opened, ['RAID-7']);
});

test('raid bot: status sem código explica como recuperar', async () => {
    const { calls, execute } = loadRaidWithFakeServices();
    await execute('status');
    assert.deepEqual(calls.opened, []);
    assert.match(calls.replies.at(-1), /Informe o código da raid/);
});

test('ajuda do jogador não anuncia comandos inexistentes e explica o escopo de listar', () => {
    const { renderPostFichaHelp } = require('../helpers/clover/playerMenuMessages');
    const help = renderPostFichaHelp();
    assert.ok(!help.includes('.#atividade'));
    assert.ok(!help.includes('.#presente'));
    assert.ok(help.includes('.#raid listar'));
    assert.ok(help.includes('em que você participa ou organiza'));
});

test('status pós-ficha usa o estado real da aparência', () => {
    const { renderPostFichaStatusMessage } = require('../helpers/clover/playerMenuMessages');
    const pending = renderPostFichaStatusMessage({
        personagem_aparencia: 'Retrato',
        personagem_aparencia_status: 'pending',
        historia_status: 'pendente',
        jogo_status: 'liberado',
    });
    const pendingLine = pending.split('\n').find((line) => line.includes('𝐀𝐩𝐚𝐫𝐞̂𝐧𝐜𝐢𝐚'));
    assert.ok(pendingLine?.endsWith('pendente'), pendingLine);

    const rejected = renderPostFichaStatusMessage({
        personagem_aparencia: 'Retrato',
        personagem_aparencia_status: 'rejected',
        jogo_status: 'liberado',
    });
    const rejectedLine = rejected.split('\n').find((line) => line.includes('𝐀𝐩𝐚𝐫𝐞̂𝐧𝐜𝐢𝐚'));
    assert.ok(rejectedLine?.endsWith('precisa de ajuste'), rejectedLine);
});
