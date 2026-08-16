'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    handleAdminRaidRewardReviewReadHttp,
} = require('../helpers/clover/adminRaidRewardReviewReadHttp');

function responseRecorder() {
    const headers = new Map();
    return {
        statusCode: 0,
        body: '',
        headers,
        setHeader(name, value) {
            headers.set(String(name).toLowerCase(), String(value));
        },
        end(value = '') {
            this.body += String(value || '');
        },
    };
}

function request(url = '/admin/raid-reward-proposals?status=pending') {
    return {
        method: 'GET',
        url,
        headers: { authorization: 'Bearer test-token' },
    };
}

function fixtureDb() {
    const proposerId = '5511999990001@s.whatsapp.net';
    const targetId = '5511999990002@s.whatsapp.net';
    const participantId = '5511999990003@s.whatsapp.net';
    const row = {
        id: 7,
        raid_id: 41,
        raid_key: 'R-V15',
        raid_name: 'Raid de validação',
        scope_squad_key: 'veu_negro',
        squad_name: 'Véu Negro',
        proposed_by: proposerId,
        status: 'pending',
        proposed_at: '2026-08-16 04:00:00',
        reviewed_at: null,
        review_note: null,
        snapshot_version: 1,
        snapshot_hash: 'abcdef1234567890abcdef1234567890',
        snapshot_json: JSON.stringify({
            version: 1,
            rewards: [
                {
                    id: 91,
                    targetType: 'player',
                    targetPlayerId: targetId,
                    rewardType: 'ph',
                    amount: 25,
                    templateKey: null,
                    resourceKey: 'ph',
                    label: 'Pontos de Habilidade',
                    reason: 'Conclusão da Raid',
                    status: 'draft',
                },
            ],
            participants: [
                {
                    playerId: participantId,
                    status: 'active',
                    finalizationStatus: 'approved',
                    starBeneficiarySquadKey: 'veu_negro',
                },
            ],
        }),
    };

    const db = {
        async all(sql) {
            if (sql.includes('FROM clover_raid_reward_proposals')) return [row];
            if (sql.includes('FROM jogadores')) {
                return [
                    { id: proposerId, personagem_nome: 'Proponente', display_name: null, nome: null },
                    { id: targetId, personagem_nome: 'Alvo Seguro', display_name: null, nome: null },
                    { id: participantId, personagem_nome: 'Participante Seguro', display_name: null, nome: null },
                ];
            }
            if (sql.includes('FROM clover_squads')) {
                return [{ squad_key: 'veu_negro', name: 'Véu Negro' }];
            }
            throw new Error(`SQL inesperado: ${sql}`);
        },
    };
    return { db, proposerId, targetId, participantId };
}

test('admin reward review read returns 401 without authenticated session', async () => {
    const { db } = fixtureDb();
    const res = responseRecorder();
    const handled = await handleAdminRaidRewardReviewReadHttp(request(), res, {
        getDb: () => db,
        authenticateSession: async () => ({ ok: false, reason: 'invalid_token' }),
    });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'invalid_token');
});

test('admin reward review read fails closed without raid.reward.review', async () => {
    const { db } = fixtureDb();
    const res = responseRecorder();
    await handleAdminRaidRewardReviewReadHttp(request(), res, {
        getDb: () => db,
        authenticateSession: async () => ({ ok: true, player: { id: 'reviewer@s.whatsapp.net' } }),
        permissionCheck: async (_db, _actorId, permission) => permission === 'never.allowed',
    });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'forbidden');
});

test('admin reward review read exposes exact stored snapshot without raw player identities', async () => {
    const { db, proposerId, targetId, participantId } = fixtureDb();
    const res = responseRecorder();
    await handleAdminRaidRewardReviewReadHttp(request(), res, {
        getDb: () => db,
        authenticateSession: async () => ({ ok: true, player: { id: 'reviewer@s.whatsapp.net' } }),
        permissionCheck: async (_db, _actorId, permission) => permission === 'raid.reward.review',
    });

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.status, 'pending');
    assert.equal(payload.proposals.length, 1);
    const proposal = payload.proposals[0];
    assert.equal(proposal.proposer.displayName, 'Proponente');
    assert.equal(proposal.snapshot.fingerprint, 'abcdef123456');
    assert.equal(proposal.snapshot.rewards[0].amount, 25);
    assert.equal(proposal.snapshot.rewards[0].targetDisplayName, 'Alvo Seguro');
    assert.equal(proposal.snapshot.participants[0].displayName, 'Participante Seguro');
    assert.equal(proposal.snapshot.participants[0].starBeneficiarySquad.name, 'Véu Negro');
    assert.equal(proposal.canReview, true);

    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(proposerId), false);
    assert.equal(serialized.includes(targetId), false);
    assert.equal(serialized.includes(participantId), false);
});

test('admin reward review read keeps self-review blocked', async () => {
    const { db, proposerId } = fixtureDb();
    const res = responseRecorder();
    await handleAdminRaidRewardReviewReadHttp(request(), res, {
        getDb: () => db,
        authenticateSession: async () => ({ ok: true, player: { id: proposerId } }),
        permissionCheck: async () => true,
    });
    assert.equal(res.statusCode, 200);
    const proposal = JSON.parse(res.body).proposals[0];
    assert.equal(proposal.selfReviewBlocked, true);
    assert.equal(proposal.canReview, false);
});

test('siteApiServer wires the admin reward review read interceptor before legacy handling', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'helpers', 'clover', 'siteApiServer.js'),
        'utf8'
    );
    assert.match(source, /handleAdminRaidRewardReviewReadHttp/);
    assert.match(source, /Promise\.resolve\(handleAdminRaidRewardReviewReadHttp\(req, res, options\)\)/);
});
