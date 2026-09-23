'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    applyUrgentOperationalPlan,
    buildUrgentOperationalPlan,
    readUrgentOperationalSnapshot,
} = require('../helpers/clover/urgentOperationalRepairService');

async function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-urgent-repair-'));
    const filename = path.join(directory, 'fixture.sqlite');
    const db = await open({ filename, driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT,
            display_name TEXT,
            personagem_nome TEXT,
            esquadrao TEXT,
            ficha_status TEXT,
            jogo_status TEXT,
            identity_status TEXT,
            lifecycle_status TEXT,
            is_shadow INTEGER,
            merged_into TEXT,
            canonical_player_id TEXT,
            archived_at TEXT
        );
        CREATE TABLE clover_squads (
            squad_key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            captain_name TEXT,
            captain_player_id TEXT,
            vice_captain_player_id TEXT,
            group_id TEXT
        );
        CREATE TABLE clover_squad_memberships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            squad_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
            ended_at TEXT,
            changed_by TEXT NOT NULL,
            reason TEXT,
            metadata_json TEXT
        );
        CREATE UNIQUE INDEX idx_clover_squad_memberships_active_player
        ON clover_squad_memberships (player_id)
        WHERE status = 'active';
        CREATE TABLE clover_squad_membership_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            membership_id INTEGER,
            squad_key TEXT NOT NULL,
            player_id TEXT NOT NULL,
            action TEXT NOT NULL,
            performed_by TEXT NOT NULL,
            reason TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT
        );
        CREATE TABLE clover_admin_roles (
            player_id TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            granted_by TEXT NOT NULL,
            granted_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            revoked_by TEXT,
            revoked_at TEXT
        );
        CREATE TABLE clover_role_grants (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id TEXT NOT NULL,
            role_key TEXT NOT NULL,
            scope_type TEXT NOT NULL,
            scope_key TEXT NOT NULL DEFAULT '*',
            status TEXT NOT NULL DEFAULT 'active',
            valid_from TEXT DEFAULT CURRENT_TIMESTAMP,
            valid_until TEXT,
            granted_by TEXT NOT NULL,
            grant_reason TEXT,
            origin_type TEXT NOT NULL DEFAULT 'manual',
            origin_ref TEXT,
            metadata_json TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            revoked_at TEXT,
            revoked_by TEXT,
            revoke_reason TEXT
        );
    `);
    await db.run(`
        INSERT INTO jogadores
        (id, nome, display_name, personagem_nome, esquadrao,
         ficha_status, jogo_status, identity_status, lifecycle_status,
         is_shadow, merged_into, canonical_player_id)
        VALUES ('member@lid', 'Membro', 'Membro', 'Membro', 'Véu Negro',
                'aprovada', 'liberado', 'active', 'active', 0, NULL, 'member@lid')
    `);
    await db.run(`
        INSERT INTO jogadores
        (id, nome, display_name, personagem_nome, esquadrao,
         ficha_status, jogo_status, identity_status, lifecycle_status,
         is_shadow, merged_into, canonical_player_id)
        VALUES ('eval@lid', 'Avaliador', 'Avaliador', 'Avaliador', '-',
                'aprovada', 'liberado', 'active', 'active', 0, NULL, 'eval@lid')
    `);
    await db.run(`
        INSERT INTO clover_squads
        (squad_key, name, captain_name)
        VALUES ('veu_negro', 'Véu Negro', 'Capitão')
    `);
    await db.run(`
        INSERT INTO clover_role_grants
        (subject_id, role_key, scope_type, scope_key, status,
         valid_from, granted_by, origin_type)
        VALUES ('eval@lid', 'evaluator', 'global', '*', 'active',
                datetime('now', '-1 day'), 'owner@lid', 'test')
    `);
    return {
        db,
        filename,
        cleanup: async () => {
            await db.close().catch(() => null);
            fs.rmSync(directory, { recursive: true, force: true });
        },
    };
}

test('aplicação SQLite sincroniza ADM e vínculo em uma transação', async () => {
    const context = await fixture();
    try {
        const before = buildUrgentOperationalPlan(
            await readUrgentOperationalSnapshot(context.db),
            { approvedMembershipMap: [{ playerId: 'member@lid', squadKey: 'veu_negro' }] }
        );
        assert.equal(before.safeToApply, true);
        assert.equal(before.admin.candidates.length, 1);
        assert.equal(before.squads.candidates.length, 1);

        const result = await applyUrgentOperationalPlan(context.db, before);
        assert.equal(result.adminRows, 1);
        assert.equal(result.membershipRows, 1);

        const legacy = await context.db.get(
            'SELECT role, active FROM clover_admin_roles WHERE player_id = ?',
            ['eval@lid']
        );
        assert.deepEqual(legacy, { role: 'evaluator', active: 1 });

        const membership = await context.db.get(
            "SELECT squad_key, status FROM clover_squad_memberships WHERE player_id = 'member@lid'"
        );
        assert.deepEqual(membership, { squad_key: 'veu_negro', status: 'active' });

        const event = await context.db.get(
            "SELECT action FROM clover_squad_membership_events WHERE player_id = 'member@lid'"
        );
        assert.equal(event.action, 'added');

        const after = buildUrgentOperationalPlan(
            await readUrgentOperationalSnapshot(context.db),
            { approvedMembershipMap: [{ playerId: 'member@lid', squadKey: 'veu_negro' }] }
        );
        assert.equal(after.safeToApply, true);
        assert.equal(after.admin.candidates.length, 0);
        assert.equal(after.squads.candidates.length, 0);
    } finally {
        await context.cleanup();
    }
});

test('segunda aplicação retorna recibo idempotente sem duplicar linhas', async () => {
    const context = await fixture();
    try {
        const firstPlan = buildUrgentOperationalPlan(
            await readUrgentOperationalSnapshot(context.db),
            { approvedMembershipMap: [{ playerId: 'member@lid', squadKey: 'veu_negro' }] }
        );
        await applyUrgentOperationalPlan(context.db, firstPlan);

        const secondPlan = buildUrgentOperationalPlan(
            await readUrgentOperationalSnapshot(context.db),
            { approvedMembershipMap: [{ playerId: 'member@lid', squadKey: 'veu_negro' }] }
        );
        const second = await applyUrgentOperationalPlan(context.db, secondPlan);
        assert.equal(second.idempotent, true);

        const memberships = await context.db.get(
            'SELECT COUNT(*) AS total FROM clover_squad_memberships'
        );
        const events = await context.db.get(
            'SELECT COUNT(*) AS total FROM clover_squad_membership_events'
        );
        assert.equal(memberships.total, 1);
        assert.equal(events.total, 1);
    } finally {
        await context.cleanup();
    }
});
