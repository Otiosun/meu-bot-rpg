'use strict';
const SQL=`CREATE TABLE IF NOT EXISTS clover_return_shop_custom_requests (
 entitlement_id INTEGER PRIMARY KEY REFERENCES clover_prereset_entitlements(id),
 player_id TEXT NOT NULL, campaign_key TEXT NOT NULL, description TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','delivered')),
 template_key TEXT, template_snapshot_json TEXT, approved_by TEXT, approved_at TEXT,
 inventory_item_id INTEGER, delivered_by TEXT, delivered_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(status='pending' OR (template_key IS NOT NULL AND template_snapshot_json IS NOT NULL AND approved_by IS NOT NULL)),
 CHECK(status!='delivered' OR (inventory_item_id IS NOT NULL AND delivered_by IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS return_custom_no_delete BEFORE DELETE ON clover_return_shop_custom_requests BEGIN SELECT RAISE(ABORT,'custom_request_append_only'); END;
CREATE TRIGGER IF NOT EXISTS return_custom_identity BEFORE UPDATE ON clover_return_shop_custom_requests WHEN NEW.entitlement_id!=OLD.entitlement_id OR NEW.player_id!=OLD.player_id OR NEW.campaign_key!=OLD.campaign_key OR (OLD.description IS NOT NULL AND NEW.description IS NOT OLD.description) OR (OLD.status='pending' AND NEW.status='delivered') OR OLD.status='delivered' OR (OLD.status='approved' AND (NEW.template_key!=OLD.template_key OR NEW.template_snapshot_json!=OLD.template_snapshot_json OR NEW.approved_by!=OLD.approved_by OR NEW.status='pending')) BEGIN SELECT RAISE(ABORT,'custom_request_immutable'); END;`;
const RETURN_SHOP_CUSTOM_ITEM_MIGRATION=Object.freeze({version:45,key:'0045_return_shop_custom_item_requests',description:'Fila auditavel de direito personalizado, aprovado e entregue antes do consumo.',checksumMaterial:{SQL,revision:1},async up(db){
 const parts=[SQL.slice(0,SQL.indexOf(';')+1),...SQL.matchAll(/CREATE TRIGGER[\s\S]*? END;/g)].map(p=>Array.isArray(p)?p[0]:p);
 const normalize=s=>s.replace(/IF NOT EXISTS/gi,'').replace(/;$/,'').replace(/\s+/g,' ').trim().toLowerCase();
 for(const sql of parts){const name=sql.match(/CREATE (?:TABLE|TRIGGER) IF NOT EXISTS (\w+)/)[1];const old=await db.get('SELECT sql FROM sqlite_schema WHERE name=?',[name]);if(old&&normalize(old.sql)!==normalize(sql))throw Object.assign(new Error('Custom request schema differs'),{code:'custom_item_schema_mismatch'});}
 await db.exec(SQL);
}});
module.exports={RETURN_SHOP_CUSTOM_ITEM_MIGRATION};
