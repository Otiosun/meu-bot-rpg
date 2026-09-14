'use strict';

const { RETURN_POINT_SHOP_PURCHASE_OBJECTS, inspectReturnPointShopPurchaseSchemaState, normalizeSql } = require('./returnPointShopPurchaseMigration');

// Historical obligations share the modern entitlement lifecycle, never a fake
// purchase or a fake PR ledger entry. Recorded migrations 0041-0043 stay intact.
const MANUAL_ENTITLEMENT_SQL = RETURN_POINT_SHOP_PURCHASE_OBJECTS.find(o => o.name === 'clover_prereset_entitlements').sql
    .replace('purchase_id INTEGER NOT NULL,', 'purchase_id INTEGER DEFAULT NULL,\n    manual_import_id INTEGER DEFAULT NULL,')
    .replace('FOREIGN KEY (purchase_id)', 'CHECK ((purchase_id IS NOT NULL) != (manual_import_id IS NOT NULL)),\n    FOREIGN KEY (manual_import_id) REFERENCES clover_return_shop_manual_imports(id),\n    FOREIGN KEY (purchase_id)');

const MANUAL_IMPORT_SQL = `CREATE TABLE clover_return_shop_manual_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL REFERENCES jogadores(id),
    operation_key TEXT NOT NULL UNIQUE,
    external_reference TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    source_row_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    imported_by TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source,source_row_id)
)`;
const MANUAL_AUDIT_SQL = `CREATE TABLE clover_return_shop_manual_operations (
    operation_key TEXT PRIMARY KEY,
    manual_import_id INTEGER NOT NULL REFERENCES clover_return_shop_manual_imports(id),
    operation_type TEXT NOT NULL CHECK(operation_type IN ('assign','fulfill','conflict')),
    request_hash TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;
const MANUAL_GUARDS_SQL = `
CREATE TRIGGER return_shop_manual_owner_insert BEFORE INSERT ON clover_prereset_entitlements
WHEN NEW.manual_import_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM clover_return_shop_manual_imports WHERE id=NEW.manual_import_id AND player_id=NEW.player_id)
BEGIN SELECT RAISE(ABORT,'manual entitlement owner mismatch'); END;
CREATE TRIGGER return_shop_manual_origin_update BEFORE UPDATE OF player_id,manual_import_id,purchase_id,entitlement_key ON clover_prereset_entitlements
WHEN OLD.manual_import_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'manual entitlement origin immutable'); END;
CREATE TRIGGER return_shop_manual_entitlement_delete BEFORE DELETE ON clover_prereset_entitlements
WHEN OLD.manual_import_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'manual entitlement must be preserved'); END;
CREATE TRIGGER return_shop_manual_import_update BEFORE UPDATE ON clover_return_shop_manual_imports
BEGIN SELECT RAISE(ABORT,'manual provenance immutable'); END;
CREATE TRIGGER return_shop_manual_import_delete BEFORE DELETE ON clover_return_shop_manual_imports
BEGIN SELECT RAISE(ABORT,'manual provenance immutable'); END;
CREATE TRIGGER return_shop_manual_audit_update BEFORE UPDATE ON clover_return_shop_manual_operations
BEGIN SELECT RAISE(ABORT,'manual audit immutable'); END;
CREATE TRIGGER return_shop_manual_audit_delete BEFORE DELETE ON clover_return_shop_manual_operations
BEGIN SELECT RAISE(ABORT,'manual audit immutable'); END;`;
async function inspectManualSchema(db) {
    const expected = [
        ['clover_return_shop_manual_imports',MANUAL_IMPORT_SQL],
        ['clover_return_shop_manual_operations',MANUAL_AUDIT_SQL],
        ['clover_prereset_entitlements',MANUAL_ENTITLEMENT_SQL],
        ['idx_return_shop_manual_entitlements','CREATE INDEX idx_return_shop_manual_entitlements ON clover_prereset_entitlements(manual_import_id,status)'],
        ...[...MANUAL_GUARDS_SQL.matchAll(/CREATE TRIGGER (\w+)[\s\S]*?END;/g)].map(match=>[match[1],match[0]]),
    ];
    const rows = await db.all(`SELECT name,sql FROM sqlite_schema WHERE name IN (${expected.map(()=>'?').join(',')})`,expected.map(([name])=>name));
    return expected.every(([name,sql])=>rows.some(row=>row.name===name && normalizeSql(row.sql).replace(/;$/,'')===normalizeSql(sql).replace(/;$/,'')));
}

const RETURN_POINT_SHOP_MANUAL_MIGRATION = Object.freeze({
    version:44, key:'0044_return_shop_manual_obligations',
    description:'Origem historica auditavel sem debito, no lifecycle moderno de entitlements.',
    checksumMaterial:{ MANUAL_IMPORT_SQL, MANUAL_ENTITLEMENT_SQL, MANUAL_AUDIT_SQL, MANUAL_GUARDS_SQL, revision:1 },
    async up(db) {
        if (await inspectManualSchema(db)) return;
        const state = await inspectReturnPointShopPurchaseSchemaState(db);
        if (state.kind !== 'exact') throw Object.assign(new Error('Manual import requires exact modern schema.'), {code:'manual_schema_reconciliation_required'});
        const sequence = await db.get("SELECT seq FROM sqlite_sequence WHERE name='clover_prereset_entitlements'");
        const before = await db.get('SELECT COUNT(*) AS total FROM clover_prereset_entitlements');
        await db.exec(MANUAL_IMPORT_SQL);
        await db.exec(MANUAL_AUDIT_SQL);
        await db.exec(MANUAL_ENTITLEMENT_SQL.replace('CREATE TABLE clover_prereset_entitlements', 'CREATE TABLE clover_prereset_entitlements_manual_upgrade'));
        await db.exec(`INSERT INTO clover_prereset_entitlements_manual_upgrade
            (id,player_id,entitlement_key,purchase_id,status,metadata_json,created_at,consumed_at)
            SELECT id,player_id,entitlement_key,purchase_id,status,metadata_json,created_at,consumed_at
            FROM clover_prereset_entitlements`);
        await db.exec('DROP TABLE clover_prereset_entitlements');
        await db.exec('ALTER TABLE clover_prereset_entitlements_manual_upgrade RENAME TO clover_prereset_entitlements');
        if (sequence) {
            await db.run("INSERT INTO sqlite_sequence(name,seq) SELECT 'clover_prereset_entitlements',? WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='clover_prereset_entitlements')",[sequence.seq]);
            await db.run("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='clover_prereset_entitlements'",[sequence.seq]);
        }
        const after = await db.get('SELECT COUNT(*) AS total FROM clover_prereset_entitlements');
        if (before.total !== after.total) throw new Error('Manual entitlement upgrade copy mismatch');
        for (const object of RETURN_POINT_SHOP_PURCHASE_OBJECTS.filter(o => o.type === 'index' && o.table === 'clover_prereset_entitlements')) await db.exec(object.sql);
        await db.exec('CREATE INDEX idx_return_shop_manual_entitlements ON clover_prereset_entitlements(manual_import_id,status)');
        await db.exec(MANUAL_GUARDS_SQL);
        if (!await inspectManualSchema(db)) throw new Error('Manual entitlement upgrade schema mismatch');
    },
});

module.exports = { MANUAL_ENTITLEMENT_SQL, RETURN_POINT_SHOP_MANUAL_MIGRATION, inspectManualSchema };
