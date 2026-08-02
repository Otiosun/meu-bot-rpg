'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureCloverSquadSchema } = require('../database');
const {
    ensureAdminOperationSchema,
} = require('../helpers/clover/adminOperationServiceBase');
const {
    ensureCanonicalAdminTeamSchema,
} = require('../helpers/clover/canonicalAdminTeamService');
const {
    ensureRaidRewardProposalSchema,
} = require('../helpers/clover/raidRewardProposalCoreService');
const {
    getAdminCommandCenter,
    getAdminUnifiedHistory,
} = require('../helpers/clover/adminCommandCenterService');

async function openOfficialSchemaFixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            ficha_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado'
        );
    `);
    await ensureCloverSquadSchema(db);
    await ensureAdminOperationSchema(db);
    await ensureCanonicalAdminTeamSchema(db);
    await ensureRaidRewardProposalSchema(db);
    return db;
}

function emptyIntegrity() {
    return {
        generatedAt: '2026-08-02T20:00:00Z',
        readOnly: true,
        summary: { total: 0, critical: 0, warning: 0, info: 0 },
        issues: [],
    };
}

test('Inbox consulta os schemas oficiais sem depender de colunas de fixture', async (t) => {
    const db = await openOfficialSchemaFixture();
    t.after(() => db.close());

    const result = await getAdminCommandCenter(db, {
        limit: 20,
        sampleLimit: 5,
        now: '2026-08-02T20:00:00Z',
        integrityResolver: async () => emptyIntegrity(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.readOnly, true);
    assert.deepEqual(result.sections.operations, []);
    assert.deepEqual(result.sections.raidRewardProposals, []);
    assert.deepEqual(result.sections.adminRoleChanges, []);
    assert.deepEqual(result.sections.starAnomalies, []);
    assert.equal(result.summary.total, 0);
});

test('Histórico consulta eventos oficiais vazios sem erro de schema', async (t) => {
    const db = await openOfficialSchemaFixture();
    t.after(() => db.close());

    const result = await getAdminUnifiedHistory(db, { limit: 50 });
    assert.equal(result.ok, true);
    assert.equal(result.readOnly, true);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.sources, {
        operations: 0,
        adminRoles: 0,
        raidRewardProposals: 0,
    });
});
