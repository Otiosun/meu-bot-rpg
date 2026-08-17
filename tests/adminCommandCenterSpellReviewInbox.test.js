'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    getAdminSpellReviewInboxReadModel,
} = require('../helpers/clover/adminSpellReviewInboxRead');
const {
    handleAdminCommandCenterHttp,
} = require('../helpers/clover/adminCommandCenterHttp');

function responseMock() {
    return {
        statusCode: 0,
        headers: {},
        body: '',
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = value;
        },
        end(value = '') {
            this.body += String(value);
        },
    };
}

async function spellFixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT
        );
        CREATE TABLE clover_settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE clover_spell_review_queue (
            id INTEGER PRIMARY KEY,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL,
            requested_at TEXT,
            called_at TEXT,
            closed_at TEXT,
            closed_by TEXT,
            reason TEXT,
            review_state TEXT,
            held_at TEXT,
            held_by TEXT,
            hold_reason TEXT
        );
        INSERT INTO jogadores VALUES
            ('called@lid', 'Aster', 'Aster OOC'),
            ('pending@lid', 'Boreal', 'Boreal OOC'),
            ('waiting@lid', 'Cyra', 'Cyra OOC');
        INSERT INTO clover_settings VALUES
            ('clover_spell_review_capacity', '3'),
            ('clover_spell_review_auto_flow', '0');
        INSERT INTO clover_spell_review_queue VALUES
            (1, 'called@lid', 'called', '2026-08-16T15:00:00Z', '2026-08-16T16:00:00Z', NULL, NULL, NULL, 'active', NULL, NULL, NULL),
            (2, 'pending@lid', 'called', '2026-08-16T14:00:00Z', '2026-08-16T15:00:00Z', NULL, NULL, 'Aguardando ajuste', 'pending', '2026-08-16T17:00:00Z', 'admin@lid', 'Aguardando ajuste'),
            (3, 'waiting@lid', 'waiting', '2026-08-16T13:00:00Z', NULL, NULL, NULL, NULL, 'active', NULL, NULL, NULL);
    `);
    return db;
}

async function legacySpellFixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT
        );
        CREATE TABLE clover_spell_review_queue (
            id INTEGER PRIMARY KEY,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL,
            requested_at TEXT,
            called_at TEXT,
            closed_at TEXT,
            closed_by TEXT,
            reason TEXT
        );
        INSERT INTO jogadores VALUES ('legacy@lid', 'Legacy Name');
        INSERT INTO clover_spell_review_queue VALUES
            (7, 'legacy@lid', 'called', '2026-08-15T10:00:00Z', '2026-08-16T10:00:00Z', NULL, NULL, NULL);
    `);
    return db;
}

function baseInboxFixture() {
    return {
        ok: true,
        readOnly: true,
        generatedAt: '2026-08-16T18:00:00Z',
        deferredDomains: ['squad_membership_migration'],
        items: [],
        sections: {
            operations: [],
            raidRewardProposals: [],
            adminRoleChanges: [],
            starAnomalies: [],
            integrity: { summary: { total: 0 }, issues: [] },
        },
    };
}

test('spell review inbox read model e estritamente readonly e resume o fluxo', async (t) => {
    const db = await spellFixture();
    t.after(() => db.close());

    const originalRun = db.run.bind(db);
    const originalExec = db.exec.bind(db);
    db.run = async () => { throw new Error('readonly_reader_attempted_run'); };
    db.exec = async () => { throw new Error('readonly_reader_attempted_exec'); };

    const result = await getAdminSpellReviewInboxReadModel(db, { limit: 20 });

    db.run = originalRun;
    db.exec = originalExec;

    assert.equal(result.items.length, 3);
    assert.deepEqual(
        result.items.map((item) => [item.status, item.priority]),
        [['called', 'high'], ['pending', 'medium'], ['waiting', 'low']]
    );
    assert.equal(result.items[0].title, 'Aster · revisão de feitiço');
    assert.equal(result.items[1].metadata.holdReason, 'Aguardando ajuste');
    assert.equal(result.items[2].actionPath, '/admin/jogadores/waiting%40lid');
    assert.deepEqual(result.flow, {
        capacity: 3,
        autoFlow: false,
        active: 1,
        pending: 1,
        waiting: 1,
        vacancies: 2,
    });
});

test('spell review inbox tolera schema legado sem colunas de flow', async (t) => {
    const db = await legacySpellFixture();
    t.after(() => db.close());

    const result = await getAdminSpellReviewInboxReadModel(db, { limit: 20 });

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].status, 'called');
    assert.equal(result.items[0].priority, 'high');
    assert.equal(result.items[0].title, 'Legacy Name · revisão de feitiço');
    assert.deepEqual(result.flow, {
        capacity: 5,
        autoFlow: true,
        active: 1,
        pending: 0,
        waiting: 0,
        vacancies: 4,
    });
});

test('player.manage recebe spell reviews, resumo e flow pela inbox HTTP', async () => {
    const req = { method: 'GET', url: '/admin/inbox?limit=20', headers: {} };
    const res = responseMock();
    const handled = await handleAdminCommandCenterHttp(req, res, {
        resolveAdminContext: async () => ({
            db: {},
            access: {
                actor: {
                    role: 'evaluator',
                    capabilities: ['player.manage'],
                },
            },
        }),
        commandCenterResolver: async () => baseInboxFixture(),
        spellReviewInboxResolver: async () => ({
            items: [{
                id: 'spell-review:9',
                category: 'spell_review',
                priority: 'high',
                title: 'Teste · revisão de feitiço',
                summary: 'Aguardando conclusão.',
                status: 'called',
                reference: '9',
                updatedAt: '2026-08-16T17:00:00Z',
                actionPath: '/admin/jogadores/teste',
            }],
            flow: {
                capacity: 5,
                autoFlow: true,
                active: 1,
                pending: 0,
                waiting: 4,
                vacancies: 4,
            },
        }),
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.permissions.canManageSpellReviews, true);
    assert.equal(payload.summary.total, 1);
    assert.equal(payload.summary.spellReviews, 1);
    assert.equal(payload.items[0].category, 'spell_review');
    assert.equal(payload.sections.spellReviews.length, 1);
    assert.equal(payload.sections.spellReviewFlow.waiting, 4);
});

test('perfil sem player.manage nao recebe dados da fila de feitiços', async () => {
    const req = { method: 'GET', url: '/admin/inbox', headers: {} };
    const res = responseMock();
    await handleAdminCommandCenterHttp(req, res, {
        resolveAdminContext: async () => ({
            db: {},
            access: {
                actor: {
                    role: 'assistant',
                    capabilities: ['operation.view'],
                },
            },
        }),
        commandCenterResolver: async () => baseInboxFixture(),
        spellReviewInboxResolver: async () => ({
            items: [{
                id: 'spell-review:10',
                category: 'spell_review',
                priority: 'high',
                title: 'Oculto',
                summary: 'Oculto',
                status: 'called',
                reference: '10',
                updatedAt: '2026-08-16T17:00:00Z',
                actionPath: '/admin/jogadores/oculto',
            }],
            flow: { capacity: 5, autoFlow: true, active: 1, pending: 0, waiting: 0, vacancies: 4 },
        }),
    });

    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.permissions.canManageSpellReviews, false);
    assert.equal(payload.summary.spellReviews, 0);
    assert.deepEqual(payload.sections.spellReviews, []);
    assert.equal(payload.sections.spellReviewFlow, null);
    assert.equal(payload.items.length, 0);
});
