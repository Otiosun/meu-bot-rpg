'use strict';
const assert=require('node:assert/strict'); const fs=require('node:fs'); const path=require('node:path'); const test=require('node:test');
const { collectMigratedColumnTargets, legacyEnsureMarker }=require('../helpers/clover/schemaBaseConsolidationAudit');
const source=fs.readFileSync(path.join(__dirname,'..','database','legacy.js'),'utf8');
test('nenhum dos 53 ensureColumn migrados permanece no legacy',()=>{ for(const t of collectMigratedColumnTargets()) assert.equal(source.includes(legacyEnsureMarker(t.table,t.column)),false,`${t.table}.${t.column}`); });
test('cleanup é estritamente parcial: 72 ensureColumn de domínios ainda não migrados permanecem',()=>{ const calls=source.match(/await ensureColumn\(db,/g)||[]; assert.equal(calls.length,72); });
test('índices e normalizações dependentes permanecem no legacy',()=>{ for(const marker of ['idx_clover_market_listings_idempotency','idx_clover_quick_evaluations_scene','idx_clover_quick_evaluations_quoted_message','normalizeQuickEvaluationWeekKeys','idx_clover_item_templates_requestable','idx_clover_inventory_template_status','idx_clover_inventory_equipped_slot','UPDATE clover_inventory_items']) assert.ok(source.includes(marker),marker); });
