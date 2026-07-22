'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleAdminApiSupport, parsePlayerDetailPath } = require('../helpers/clover/adminApiSupport');

function responseRecorder() {
    return {
        statusCode: 200,
        headers: {},
        body: '',
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = value;
        },
        end(value = '') {
            this.body += String(value || '');
        },
    };
}

function request(url) {
    return {
        method: 'GET',
        url,
        headers: { authorization: 'Bearer test' },
    };
}

function authorizedOptions(capabilities = ['player.view']) {
    return {
        getDb: () => ({ fake: true }),
        authenticateSession: async () => ({
            ok: true,
            player: { id: 'owner@lid', personagem_nome: 'Owner' },
        }),
        accessResolver: async () => ({
            ok: true,
            actor: { id: 'owner@lid', role: 'owner', capabilities },
        }),
    };
}

test('extrai player_id codificado sem confundir rota de busca', () => {
    assert.equal(parsePlayerDetailPath('/admin/players/search'), null);
    assert.equal(
        parsePlayerDetailPath('/admin/players/231426393948202%40lid'),
        '231426393948202@lid'
    );
});

test('carrega ficha administrativa por player_id', async () => {
    const res = responseRecorder();
    let receivedId = null;

    const handled = await handleAdminApiSupport(
        request('/admin/players/231426393948202%40lid'),
        res,
        {
            ...authorizedOptions(),
            playerDetail: async (_db, playerId) => {
                receivedId = playerId;
                return {
                    ok: true,
                    player: { playerId, characterName: 'Gohhan' },
                    identity: { canonical: true, aliases: [] },
                    modules: {},
                };
            },
        }
    );

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(receivedId, '231426393948202@lid');
    assert.equal(JSON.parse(res.body).player.characterName, 'Gohhan');
});

test('bloqueia ficha sem player.view', async () => {
    const res = responseRecorder();
    await handleAdminApiSupport(
        request('/admin/players/231426393948202%40lid'),
        res,
        {
            ...authorizedOptions(['operation.view']),
            playerDetail: async () => {
                throw new Error('não deveria executar');
            },
        }
    );

    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'missing_capability');
});

test('propaga 404 da ficha administrativa', async () => {
    const res = responseRecorder();
    await handleAdminApiSupport(
        request('/admin/players/missing%40lid'),
        res,
        {
            ...authorizedOptions(),
            playerDetail: async () => {
                const error = new Error('Jogador não encontrado.');
                error.code = 'player_not_found';
                error.status = 404;
                throw error;
            },
        }
    );

    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'player_not_found');
});
