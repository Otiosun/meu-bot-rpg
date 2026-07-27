'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

let createDb;
try {
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    createDb = () => open({ filename: ':memory:', driver: sqlite3.Database });
} catch {
    const { DatabaseSync } = require('node:sqlite');
    createDb = async () => {
        const raw = new DatabaseSync(':memory:');
        return {
            exec: async (sql) => raw.exec(sql),
            run: async (sql, params = []) => {
                const result = raw.prepare(sql).run(...params);
                return {
                    changes: Number(result.changes || 0),
                    lastID: Number(result.lastInsertRowid || 0),
                };
            },
            get: async (sql, params = []) => raw.prepare(sql).get(...params),
            all: async (sql, params = []) => raw.prepare(sql).all(...params),
            close: async () => raw.close(),
        };
    };
}

const {
    auditSpellReviewQueue,
    classifyEntry,
} = require('../helpers/clover/spellQueueAuditService');

const NOW = '2026-07-26T18:00:00.000Z';

async function setup() {
    const db = await createDb();
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            nome TEXT,
            display_name TEXT
        );
        CREATE TABLE clover_spell_review_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL,
            requested_at TEXT,
            called_at TEXT,
            closed_at TEXT,
            closed_by TEXT,
            reason TEXT
        );
        CREATE TABLE clover_spellbook_spells (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            status TEXT NOT NULL,
            removed_at TEXT
        );
        CREATE TABLE clover_consumable_uses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            template_key TEXT,
            result TEXT
        );
        CREATE TABLE clover_item_redemptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            template_key TEXT,
            status TEXT
        );
    `);

    for (const [id, name] of [
        ['full@lid', 'Personagem Cheio'],
        ['called@lid', 'Personagem Chamado'],
        ['duplicate@lid', 'Personagem Duplicado'],
        ['debt@lid', 'Personagem em Dívida'],
        ['closed@lid', 'Personagem Histórico'],
    ]) {
        await db.run('INSERT INTO jogadores (id, personagem_nome) VALUES (?, ?)', [id, name]);
    }

    await db.run(
        "INSERT INTO clover_spell_review_queue (player_id, status, requested_at) VALUES ('full@lid', 'waiting', '2026-03-01 10:00:00')"
    );
    await db.run(
        "INSERT INTO clover_spell_review_queue (player_id, status, requested_at, called_at) VALUES ('called@lid', 'called', '2026-07-01 10:00:00', '2026-07-10 10:00:00')"
    );
    await db.run(
        "INSERT INTO clover_spell_review_queue (player_id, status, requested_at) VALUES ('orphan@lid', 'waiting', '2026-07-20 10:00:00')"
    );
    await db.run(
        "INSERT INTO clover_spell_review_queue (player_id, status, requested_at) VALUES ('duplicate@lid', 'waiting', '2026-07-24 10:00:00')"
    );
    await db.run(
        "INSERT INTO clover_spell_review_queue (player_id, status, requested_at) VALUES ('duplicate@lid', 'waiting', '2026-07-25 10:00:00')"
    );
    await db.run(
        "INSERT INTO clover_spell_review_queue (player_id, status, requested_at) VALUES ('debt@lid', 'waiting', '2026-07-25 12:00:00')"
    );
    await db.run(
        "INSERT INTO clover_spell_review_queue (player_id, status, requested_at) VALUES ('closed@lid', 'concluded', '2026-07-01 10:00:00')"
    );

    await db.run(
        "INSERT INTO clover_spellbook_spells (player_id, normalized_name, status) VALUES ('full@lid', 'feitico_um', 'approved')"
    );
    await db.run(
        "INSERT INTO clover_spellbook_spells (player_id, normalized_name, status) VALUES ('debt@lid', 'feitico_um', 'approved')"
    );
    await db.run(
        "INSERT INTO clover_spellbook_spells (player_id, normalized_name, status) VALUES ('debt@lid', 'feitico_dois', 'approved')"
    );

    return db;
}

test('classifica chamado sem data e entrada ativa já fechada para revisão crítica', () => {
    const result = classifyEntry({
        status: 'called',
        requested_at: '2026-07-20 10:00:00',
        called_at: null,
        closed_at: '2026-07-21 10:00:00',
    }, {
        playerExists: true,
        activeCount: 1,
        totalSlots: 1,
        occupiedSlots: 0,
    }, { now: NOW });

    assert.equal(result.severity, 'critical_review');
    assert.ok(result.flags.includes('called_missing_called_at'));
    assert.ok(result.flags.includes('active_has_closed_at'));
    assert.equal(result.recommendedAction, 'review_called_entry');
});

test('audita fila sem escrita, pseudonimiza IDs e separa capacidade de posição', async (t) => {
    const db = await setup();
    t.after(() => db.close());
    await db.exec('PRAGMA query_only = ON');

    const report = await auditSpellReviewQueue(db, { now: NOW });

    assert.equal(report.readOnly, true);
    assert.equal(report.available, true);
    assert.equal(report.summary.totalRows, 7);
    assert.equal(report.summary.activeRows, 6);
    assert.equal(report.summary.activePlayers, 5);
    assert.equal(report.summary.waitingRows, 5);
    assert.equal(report.summary.calledRows, 1);
    assert.equal(report.summary.duplicateActivePlayers, 1);
    assert.equal(report.summary.orphanActiveRows, 1);
    assert.equal(report.summary.waitingCriticalRows, 1);
    assert.equal(report.summary.calledCriticalRows, 1);
    assert.equal(report.summary.capacityBlockedRows, 2);
    assert.equal(report.summary.legacyOverCapacityRows, 1);
    assert.equal(report.summary.fullCapacityRows, 1);
    assert.equal(report.summary.historicalAnomalies, 1);

    const full = report.activeEntries.find((entry) => entry.characterName === 'Personagem Cheio');
    assert.equal(full.capacity.availableSlots, 0);
    assert.equal(full.capacity.queueCountsAsCapacity, false);
    assert.equal(full.recommendedAction, 'preserve_entry_block_approval_until_slot_available');

    const debt = report.activeEntries.find((entry) => entry.characterName === 'Personagem em Dívida');
    assert.equal(debt.capacity.capacityDebt, 1);
    assert.equal(debt.recommendedAction, 'preserve_entry_block_approval_until_capacity_regularized');

    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('full@lid'), false);
    assert.equal(serialized.includes('orphan@lid'), false);
    assert.equal(report.privacy.rawPlayerIdsIncluded, false);
});
