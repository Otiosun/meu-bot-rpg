'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    PRE_RESET_TRANSITION_MIGRATION,
    inspectPreResetTransitionSchemaState,
} = require('../helpers/clover/preResetTransitionMigration');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec('PRAGMA foreign_keys = ON; CREATE TABLE jogadores (id TEXT PRIMARY KEY);');
    await db.run("INSERT INTO jogadores (id) VALUES ('player@test')");
    await PRE_RESET_TRANSITION_MIGRATION.up(db);
    return db;
}

test('0034 impede decisão já finalizada por INSERT direto', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    assert.equal((await inspectPreResetTransitionSchemaState(db)).kind, 'exact');
    await assert.rejects(
        db.run("INSERT INTO clover_prereset_transition_decisions (player_id,status,revision) VALUES ('player@test','reset',1)"),
        /prereset_transition_insert_must_be_pending/
    );
});

test('0034 congela metadata da decisão final e torna journal append-only', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await db.run("INSERT INTO clover_prereset_transition_decisions (player_id,status,revision) VALUES ('player@test','pending',0)");
    await db.run(`
        UPDATE clover_prereset_transition_decisions
        SET status='reset', revision=1, decided_by='player@test', decision_source='player',
            decision_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
        WHERE player_id='player@test'
    `);

    await assert.rejects(
        db.run("UPDATE clover_prereset_transition_decisions SET revision=2 WHERE player_id='player@test'"),
        /prereset_transition_metadata_frozen/
    );
    await assert.rejects(
        db.run("DELETE FROM clover_prereset_transition_decisions WHERE player_id='player@test'"),
        /prereset_transition_delete_forbidden/
    );
    await assert.rejects(
        db.run(`
            INSERT INTO clover_prereset_transition_operations
            (operation_key,player_id,operation_type,request_hash,resulting_status,resulting_revision,actor_id)
            VALUES ('operation:bad','player@test','reset','hash','reset',2,'player@test')
        `),
        /prereset_transition_operation_decision_mismatch/
    );

    await db.run(`
        INSERT INTO clover_prereset_transition_operations
        (operation_key,player_id,operation_type,request_hash,resulting_status,resulting_revision,actor_id)
        VALUES ('operation:good','player@test','reset','hash','reset',1,'player@test')
    `);
    await assert.rejects(
        db.run("UPDATE clover_prereset_transition_operations SET actor_id='other@test' WHERE operation_key='operation:good'"),
        /prereset_transition_operation_update_forbidden/
    );
    await assert.rejects(
        db.run("DELETE FROM clover_prereset_transition_operations WHERE operation_key='operation:good'"),
        /prereset_transition_operation_delete_forbidden/
    );
});
