'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function withFakeImports(modulePath, fakeImports) {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    const originalLoad = Module._load;
    Module._load = function mockImports(request, parent, isMain) {
        if (parent?.filename === resolved
            && Object.prototype.hasOwnProperty.call(fakeImports, request)) {
            return fakeImports[request];
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        return require(resolved);
    } finally {
        Module._load = originalLoad;
        delete require.cache[resolved];
    }
}

const NOW = new Date('2026-11-17T15:00:00.000Z');
const DEADLINE = '2026-12-01T12:00:00.000Z';

function mission(patch = {}) {
    return {
        missionKey: 'ecos-ruinas',
        status: 'published',
        revision: 2,
        title: 'Ecos nas Ruínas',
        rank: 'E',
        mode: 'auto_narrated',
        location: 'Capital de Clover',
        missionType: 'investigation',
        risk: 'Baixo',
        slots: 4,
        deadlineAt: DEADLINE,
        reward: {
            ph: [3, 8], stars: [0, 1], yulls: [500, 900],
            extra: 'Itens úteis', exceptionalAnnouncement: 'Nota interna',
        },
        description: 'Investigue os arredores.',
        specialConditions: 'Sem mortes',
        failureConsequence: 'Retorno à cidade',
        metadata: { visibility: 'public', staffNotes: 'Confidencial' },
        createdBy: 'staff@s.whatsapp.net',
        updatedBy: 'staff@s.whatsapp.net',
        ...patch,
    };
}

test('o mural nunca revela rascunhos, missões fechadas, privadas, convites ou vencidas', async () => {
    const rows = [
        mission(),
        mission({ missionKey: 'draft-123', status: 'draft' }),
        mission({ missionKey: 'closed-123', status: 'closed' }),
        mission({ missionKey: 'private-123', metadata: { visibility: 'private' } }),
        mission({ missionKey: 'invite-123', metadata: { visibility: 'invite' } }),
        mission({ missionKey: 'hidden-123', metadata: { publicListing: false } }),
        mission({ missionKey: 'expired-123', deadlineAt: '2026-11-16T00:00:00.000Z' }),
        mission({ missionKey: 'missing-deadline', deadlineAt: null }),
    ];
    const calls = [];
    const service = withFakeImports('../helpers/clover/playerMissionBoardService', {
        './adminMissionService': {
            listMissions: async (_db, filters) => { calls.push(filters); return rows; },
            getMission: async () => null,
        },
    });
    const found = await service.listPublicMissions({}, { now: NOW });
    assert.equal(found.total, 1);
    assert.equal(found.missions[0].missionKey, 'ecos-ruinas');
    assert.deepEqual(calls, [{ status: 'published' }]);
    assert.ok(!Object.hasOwn(found.missions[0], 'metadata'));
    assert.ok(!Object.hasOwn(found.missions[0], 'createdBy'));
    assert.ok(!Object.hasOwn(found.missions[0].reward, 'exceptionalAnnouncement'));
});

test('detalhe da missão valida chave, expiração, privacidade e estado', async () => {
    const calls = [];
    let selectedMission = mission();
    const source = {
        './adminMissionService': {
            listMissions: async () => [],
            getMission: async (_db, key) => { calls.push(key); return selectedMission; },
        },
    };
    const service = withFakeImports('../helpers/clover/playerMissionBoardService', source);
    assert.equal(await service.getPublicMission({}, 'bad key'), null);
    assert.deepEqual(calls, []);
    assert.equal((await service.getPublicMission({}, 'ECOS-RUINAS', { now: NOW })).title, 'Ecos nas Ruínas');
    assert.deepEqual(calls, ['ecos-ruinas']);
    selectedMission = mission({ metadata: { visibility: 'private' } });
    assert.equal(await service.getPublicMission({}, 'ecos-ruinas', { now: NOW }), null);
    selectedMission = mission({ status: 'closed' });
    assert.equal(await service.getPublicMission({}, 'ecos-ruinas', { now: NOW }), null);
    selectedMission = mission({ deadlineAt: '2026-11-16T00:00:00.000Z' });
    assert.equal(await service.getPublicMission({}, 'ecos-ruinas', { now: NOW }), null);
});

test('filtro por rank, paginação e total derivam somente de registros públicos', async () => {
    const service = withFakeImports('../helpers/clover/playerMissionBoardService', {
        './adminMissionService': {
            listMissions: async () => Array.from({ length: 15 }, (_, i) =>
                mission({ missionKey: `missao-${i}`, rank: 'D', title: `Missão ${i}` })),
            getMission: async () => null,
        },
    });
    const view = await service.listPublicMissions({}, { rank: 'd', page: 2, limit: 6, now: NOW });
    assert.equal(view.total, 15);
    assert.equal(view.page, 2);
    assert.equal(view.pages, 3);
    assert.equal(view.missions.length, 6);
    await assert.rejects(
        () => service.listPublicMissions({}, { rank: 'Z', now: NOW }),
        (error) => error.code === 'invalid_mission_rank'
    );
    await assert.rejects(
        () => service.listPublicMissions({}, { page: -1, now: NOW }),
        (error) => error.code === 'invalid_mission_page'
    );
});

test('mensagens mostram informações reais e protegem formatação WhatsApp', () => {
    const messages = require('../helpers/clover/playerMissionBoardMessages');
    const sample = mission({ title: 'Ecos *do*\n> perigo', description: 'Investigue\n*os arredores*' });
    const board = messages.renderMissionBoard({
        missions: [sample], total: 1, page: 1, pages: 1, rank: null,
    });
    assert.match(board, /Ecos do perigo/);
    assert.doesNotMatch(board, /Ecos \*do\*/);
    assert.match(board, /\.\#missao <código>/);
    const detail = messages.renderMissionDetail(sample);
    assert.match(detail, /𝐏𝐇:/);
    assert.match(detail, /𝐘𝐮𝐥𝐥𝐬:/);
    assert.match(detail, /Capital de Clover/);
    assert.doesNotMatch(detail, /Confidencial|Nota interna|staff@s\.whatsapp\.net/);
});

test('comando de mural não consulta banco de missões se jogador está bloqueado', async () => {
    const replies = [];
    let queried = 0;
    const command = withFakeImports('../comandos/missoes', {
        '../config/bot': { COMMAND_PREFIX: '.#' },
        '../helpers/chatReply': { sendReply: async ({ text }) => { replies.push(text); } },
        '../helpers/clover/playerPhase': {
            getPlayerPhase: async () => ({ canPlay: false }),
            renderGameBlockedMessage: () => 'Jogo bloqueado',
        },
        '../helpers/clover/playerMissionBoardService': {
            PUBLIC_RANKS: ['E', 'D', 'C', 'B', 'A', 'S'],
            listPublicMissions: async () => { queried++; return {}; },
        },
        '../helpers/clover/playerMissionBoardMessages': { renderMissionBoard: () => 'Mural' },
    });
    await command.executar({ sock: {}, m: {}, idChat: 'grupo', idJogador: 'player', db: {}, body: '' });
    assert.equal(queried, 0);
    assert.equal(replies[0], 'Jogo bloqueado');
});

test('comando de mural valida argumentos e entrega página solicitada', async () => {
    const replies = [];
    const query = [];
    const command = withFakeImports('../comandos/missoes', {
        '../config/bot': { COMMAND_PREFIX: '.#' },
        '../helpers/chatReply': { sendReply: async ({ text }) => { replies.push(text); } },
        '../helpers/clover/playerPhase': {
            getPlayerPhase: async () => ({ canPlay: true }),
            renderGameBlockedMessage: () => 'Bloqueado',
        },
        '../helpers/clover/playerMissionBoardService': {
            PUBLIC_RANKS: ['E', 'D', 'C', 'B', 'A', 'S'],
            listPublicMissions: async (_db, args) => { query.push(args); return { missions: [], total: 0 }; },
        },
        '../helpers/clover/playerMissionBoardMessages': { renderMissionBoard: () => 'Mural vazio' },
    });
    assert.deepEqual(command.parseBoardArguments('b 2'), { rank: 'B', page: 2 });
    assert.deepEqual(command.parseBoardArguments('3'), { rank: null, page: 3 });
    assert.equal(command.parseBoardArguments('Z'), null);
    await command.executar({ sock: {}, m: {}, idChat: 'grupo', idJogador: 'player', db: {}, body: 'D 2' });
    assert.equal(query[0].rank, 'D');
    assert.equal(query[0].page, 2);
    assert.equal(replies[0], 'Mural vazio');
    await command.executar({ sock: {}, m: {}, idChat: 'grupo', idJogador: 'player', db: {}, body: 'desconhecido' });
    assert.match(replies.at(-1), /Uso:/);
    assert.equal(query.length, 1);
});

test('consulta individual não revela missão privada e não exige link de site', async () => {
    const replies = [];
    let queried = '';
    const command = withFakeImports('../comandos/missao', {
        '../config/bot': { COMMAND_PREFIX: '.#' },
        '../helpers/chatReply': { sendReply: async ({ text }) => { replies.push(text); } },
        '../helpers/clover/playerPhase': {
            getPlayerPhase: async () => ({ canPlay: true }),
            renderGameBlockedMessage: () => 'Bloqueado',
        },
        '../helpers/clover/playerMissionBoardService': {
            getPublicMission: async (_db, key) => { queried = key; return null; },
        },
        '../helpers/clover/playerMissionBoardMessages': {
            renderMissionDetail: (result) => result ? 'Encontrada' : 'Missão indisponível',
        },
    });
    await command.executar({ sock: {}, m: {}, idChat: 'grupo', idJogador: 'player', db: {}, body: 'segredo' });
    assert.equal(queried, 'segredo');
    assert.equal(replies[0], 'Missão indisponível');
    await command.executar({ sock: {}, m: {}, idChat: 'grupo', idJogador: 'player', db: {}, body: '' });
    assert.match(replies.at(-1), /Uso:/);
});

test('UX: atalhos sempre usam código estável e mostram modalidades em português', () => {
    const { renderMissionBoard, renderMissionDetail, renderParticipation, renderMyMissions } = require('../helpers/clover/playerMissionBoardMessages');
    const sample = mission({reward:{ph:[10,10],stars:[1,1],yulls:[1200,1200]}});
    const board = renderMissionBoard({missions:[sample],total:1,page:1,pages:1});
    assert.match(board, /\.#missao ecos-ruinas/);
    assert.match(board, /Autonarrada/);
    const detail = renderMissionDetail(sample);
    assert.match(detail, /\.#missao ecos-ruinas aceitar/);
    assert.doesNotMatch(detail, /slot|snapshot|crédito automático/);
    const record = {missionKey:sample.missionKey,title:sample.title,status:'in_progress',reward:{ph:10,yulls:1200,stars:1}};
    assert.match(renderParticipation(record), /\.#missao ecos-ruinas entregar/);
    assert.match(renderMyMissions({missions:[record],total:1,page:1,pages:1}), /\.#missao ecos-ruinas status/);
    assert.doesNotMatch(renderParticipation({...record,status:'submitted'}), /entregar/);
});
