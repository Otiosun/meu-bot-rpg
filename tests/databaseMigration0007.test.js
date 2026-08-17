'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openCloverDatabase, readPragmaScalar } = require('../helpers/clover/databaseConnection');
const { MIGRATION_TABLE, columnExists, migrationChecksum, runCloverSchemaMigrations } = require('../helpers/clover/schemaMigrationService');
const { CURRENT_SCHEMA_MIGRATIONS, ITEM_TEMPLATES_TARGETS } = require('../helpers/clover/schemaMigrationCatalog');
const MIGRATIONS_THROUGH_0006 = Object.freeze(CURRENT_SCHEMA_MIGRATIONS.slice(0, 6));
function tempDatabasePath(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clover-db-0007-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return path.join(dir,'database.sqlite'); }
async function createPrerequisites(db,{templateTable=true,allTemplateColumns=false}={}) {
 await db.exec(`
 CREATE TABLE clover_character_stats (id INTEGER PRIMARY KEY, ph_accumulated INTEGER DEFAULT 0, ph_available INTEGER DEFAULT 0);
 CREATE TABLE clover_box_openings (id INTEGER PRIMARY KEY, roll_basis_points INTEGER DEFAULT NULL);
 CREATE TABLE clover_inventory_reservations (id INTEGER PRIMARY KEY, expires_at TEXT DEFAULT NULL);
 CREATE TABLE clover_consumable_uses (id INTEGER PRIMARY KEY, effect_category TEXT DEFAULT NULL);
 CREATE TABLE player_onboarding (player_id TEXT PRIMARY KEY, step_payload TEXT DEFAULT '{}');
 CREATE TABLE pending_magic_confirmations (player_id TEXT PRIMARY KEY, magic_label TEXT NOT NULL, roll_number INTEGER DEFAULT NULL);
 CREATE TABLE group_settings (group_id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0, reception_enabled INTEGER DEFAULT 0, reception_type TEXT DEFAULT NULL);
 CREATE TABLE clover_market_listings (id INTEGER PRIMARY KEY, idempotency_key TEXT DEFAULT NULL);
 CREATE TABLE clover_weekly_npc_requests (id INTEGER PRIMARY KEY, required_quality TEXT NOT NULL DEFAULT 'qualquer', required_condition TEXT NOT NULL DEFAULT 'qualquer');
 CREATE TABLE clover_quick_evaluations (id INTEGER PRIMARY KEY, quoted_message_key TEXT DEFAULT NULL, scene_sent_at TEXT DEFAULT NULL, scene_source TEXT DEFAULT NULL, evaluated_at TEXT DEFAULT NULL, salary_eligible INTEGER DEFAULT NULL, salary_service_type TEXT DEFAULT NULL);
 CREATE TABLE player_rolls (player_id TEXT NOT NULL, roll_number INTEGER NOT NULL, kingdom TEXT DEFAULT '-', grimoire_rank TEXT DEFAULT '-', grimoire_symbol TEXT DEFAULT '-', magic_scope TEXT DEFAULT '-', roll_version TEXT DEFAULT 'legacy', kingdom_key TEXT DEFAULT NULL, social_class_key TEXT DEFAULT NULL, race_key TEXT DEFAULT NULL, grimoire_key TEXT DEFAULT NULL, magic_rarity_key TEXT DEFAULT NULL, roll_payload TEXT DEFAULT '{}', PRIMARY KEY (player_id, roll_number));
 `);
 if(templateTable){ const cols=allTemplateColumns?", is_custom INTEGER NOT NULL DEFAULT 0, requestable INTEGER NOT NULL DEFAULT 0, marketable INTEGER NOT NULL DEFAULT 1, duplicable INTEGER NOT NULL DEFAULT 1, created_by TEXT DEFAULT 'system', updated_by TEXT DEFAULT NULL, archived_at TEXT DEFAULT NULL":''; await db.exec(`CREATE TABLE clover_item_templates (template_key TEXT PRIMARY KEY${cols})`); }
}
test('0007 versiona exatamente sete colunas de clover_item_templates e segunda execução é no-op', async(t)=>{ const db=await openCloverDatabase({filename:tempDatabasePath(t)}); t.after(()=>db.close()); await createPrerequisites(db); const first=await runCloverSchemaMigrations(db,{migrations:CURRENT_SCHEMA_MIGRATIONS}); assert.equal(first.latestVersion,7); assert.equal(first.appliedCount,7); assert.equal(Number(await readPragmaScalar(db,'user_version')),7); for(const target of ITEM_TEMPLATES_TARGETS) assert.equal(await columnExists(db,target.table,target.column),true,target.column); const rows=await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`); assert.deepEqual(rows.map(r=>Number(r.version)),[1,2,3,4,5,6,7]); const second=await runCloverSchemaMigrations(db,{migrations:CURRENT_SCHEMA_MIGRATIONS}); assert.equal(second.appliedCount,0); });
test('0007 é schema-no-op quando clover_item_templates já possui as sete colunas', async(t)=>{ const db=await openCloverDatabase({filename:tempDatabasePath(t)}); t.after(()=>db.close()); await createPrerequisites(db,{allTemplateColumns:true}); const result=await runCloverSchemaMigrations(db,{migrations:CURRENT_SCHEMA_MIGRATIONS}); assert.equal(result.appliedCount,7); assert.equal(Number(await readPragmaScalar(db,'user_version')),7); });
test('0007 falha fechado se clover_item_templates não existe e preserva ledger em 0006', async(t)=>{ const db=await openCloverDatabase({filename:tempDatabasePath(t)}); t.after(()=>db.close()); await createPrerequisites(db,{templateTable:false}); await runCloverSchemaMigrations(db,{migrations:MIGRATIONS_THROUGH_0006}); await assert.rejects(runCloverSchemaMigrations(db,{migrations:CURRENT_SCHEMA_MIGRATIONS}),e=>e?.code==='migration_precondition_failed'&&e?.table==='clover_item_templates'); assert.equal(Number(await readPragmaScalar(db,'user_version')),6); const rows=await db.all(`SELECT version FROM ${MIGRATION_TABLE} ORDER BY version`); assert.deepEqual(rows.map(r=>Number(r.version)),[1,2,3,4,5,6]); });
test('checksum da 0007 cobre os sete targets externos',()=>{ const migration=CURRENT_SCHEMA_MIGRATIONS[6]; const checksum=migrationChecksum(migration); assert.equal(checksum,'a4145760aade0ef93258e20bc589131dcf2a43c44cc627d62369aa816860205a'); const altered={...migration,checksumMaterial:migration.checksumMaterial.slice(0,6)}; assert.notEqual(migrationChecksum(altered),checksum); });
