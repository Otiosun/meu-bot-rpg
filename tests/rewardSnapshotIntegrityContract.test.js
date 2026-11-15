'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function normalizeSquadKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function loadInternals() {
    const defaultPath = path.resolve(__dirname, '../helpers/clover/raidRewardProposalCoreService.js');
    const filename = path.resolve(process.env.CLOVER_REWARD_PROPOSAL_CORE_SERVICE_PATH || defaultPath);
    const source = `${fs.readFileSync(filename, 'utf8')}
module.exports.__test = {
    PROPOSAL_SNAPSHOT_SCHEMA_VERSION,
    assertProposalSnapshotFresh,
    buildProposalSnapshot,
    hashCanonicalSnapshot,
    stableStringify,
};`;

    const stubs = {
        '../groupAccess': {
            isSameUser: (left, right) => String(left || '') === String(right || ''),
            normalizeJid: (value) => String(value || '').trim(),
        },
        './accessControlService': {
            getAccessContext: async () => ({ roleKeys: [] }),
            getRoleLabel: (role) => role,
            hasAccessPermission: async () => true,
        },
        './cavalierService': { normalizeSquadKey },
        './squadMembershipReadService': {
            resolvePlayerSquadMembership: async (db) => ({
                ok: true,
                squadKey: normalizeSquadKey(db.participantSquad),
            }),
        },
        './raidService': {
            completeRaidForRewardProposal: async () => ({ ok: true }),
        },
    };

    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    const nativeRequire = loaded.require.bind(loaded);
    loaded.require = (request) => (
        Object.prototype.hasOwnProperty.call(stubs, request)
            ? stubs[request]
            : nativeRequire(request)
    );
    loaded._compile(source, filename);
    return loaded.exports.__test;
}

const {
    PROPOSAL_SNAPSHOT_SCHEMA_VERSION,
    assertProposalSnapshotFresh,
    buildProposalSnapshot,
} = loadInternals();

const reward = Object.freeze({
    id: 7,
    target_type: 'general',
    target_player_id: null,
    reward_type: 'squad_stars',
    amount: 3,
    template_key: null,
    resource_key: null,
    label: 'Estrelas da missão',
    reason: 'Conclusão',
    status: 'draft',
});

function fixtureDb({ raidSquadKey = null, participantSquad = 'Lobos Cinzentos' } = {}) {
    return {
        participantSquad,
        get: async (sql) => {
            if (sql.includes('FROM clover_raids')) {
                return { id: 1, scope_squad_key: raidSquadKey };
            }
            throw new Error(`Unexpected get SQL: ${sql}`);
        },
        all: async (sql) => {
            if (sql.includes('FROM clover_raid_rewards')) return [{ ...reward }];
            if (sql.includes('FROM clover_raid_participants')) {
                return [{
                    player_id: 'member@lid',
                    status: 'active',
                    finalization_status: 'eligible',
                }];
            }
            throw new Error(`Unexpected all SQL: ${sql}`);
        },
    };
}

test('beneficiário de Estrelas participa do hash canônico', async () => {
    const wolves = await buildProposalSnapshot(
        fixtureDb({ participantSquad: 'Lobos Cinzentos' }),
        1
    );
    const wings = await buildProposalSnapshot(
        fixtureDb({ participantSquad: 'Asas da Liberdade' }),
        1
    );

    assert.equal(wolves.snapshot.version, PROPOSAL_SNAPSHOT_SCHEMA_VERSION);
    assert.equal(
        wolves.snapshot.participants[0].starBeneficiarySquadKey,
        'lobos_cinzentos'
    );
    assert.notEqual(wolves.hash, wings.hash);
});

test('adulteração do beneficiário no JSON armazenado é rejeitada', async () => {
    const submitted = await buildProposalSnapshot(
        fixtureDb({ participantSquad: 'Lobos Cinzentos' }),
        1
    );
    const tampered = structuredClone(submitted.snapshot);
    tampered.participants[0].starBeneficiarySquadKey = 'asas_da_liberdade';

    await assert.rejects(
        () => assertProposalSnapshotFresh(
            fixtureDb({ participantSquad: 'Lobos Cinzentos' }),
            {
                id: 12,
                raid_id: 1,
                snapshot_version: PROPOSAL_SNAPSHOT_SCHEMA_VERSION,
                snapshot_json: JSON.stringify(tampered),
                snapshot_hash: submitted.hash,
            }
        ),
        (error) => error?.code === 'proposal_snapshot_tampered'
    );
});

test('mudança legítima do beneficiário depois da submissão torna proposta stale', async () => {
    const submitted = await buildProposalSnapshot(
        fixtureDb({ participantSquad: 'Lobos Cinzentos' }),
        1
    );

    await assert.rejects(
        () => assertProposalSnapshotFresh(
            fixtureDb({ participantSquad: 'Asas da Liberdade' }),
            {
                id: 13,
                raid_id: 1,
                snapshot_version: PROPOSAL_SNAPSHOT_SCHEMA_VERSION,
                snapshot_json: submitted.canonical,
                snapshot_hash: submitted.hash,
            }
        ),
        (error) => error?.code === 'proposal_stale'
    );
});


test('hash completo inclui o beneficiário e rejeita divergência de versão no JSON', async () => {
    const submitted = await buildProposalSnapshot(
        fixtureDb({ participantSquad: 'Lobos Cinzentos' }),
        1
    );
    const tampered = structuredClone(submitted.snapshot);
    tampered.version = 1;

    await assert.rejects(
        () => assertProposalSnapshotFresh(
            fixtureDb({ participantSquad: 'Lobos Cinzentos' }),
            {
                id: 15,
                raid_id: 1,
                snapshot_version: PROPOSAL_SNAPSHOT_SCHEMA_VERSION,
                snapshot_json: JSON.stringify(tampered),
                snapshot_hash: submitted.hash,
            }
        ),
        (error) => error?.code === 'proposal_snapshot_tampered'
    );
});

test('snapshot legado é rejeitado antes de consultar o estado atual', async () => {
    const db = {
        get: async () => {
            throw new Error('legacy snapshot must fail before DB reads');
        },
        all: async () => {
            throw new Error('legacy snapshot must fail before DB reads');
        },
    };

    await assert.rejects(
        () => assertProposalSnapshotFresh(db, {
            id: 14,
            raid_id: 1,
            snapshot_version: 1,
            snapshot_json: JSON.stringify({ version: 1 }),
            snapshot_hash: '0'.repeat(64),
        }),
        (error) => (
            error?.code === 'proposal_snapshot_legacy'
            && error?.details?.requiredVersion === PROPOSAL_SNAPSHOT_SCHEMA_VERSION
        )
    );
});
