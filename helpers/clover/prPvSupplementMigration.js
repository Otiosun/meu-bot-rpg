'use strict';
const SQL = `
CREATE TABLE clover_pr_pv_supplements (
 operation_key TEXT PRIMARY KEY,
 campaign_key TEXT NOT NULL, player_id TEXT NOT NULL REFERENCES jogadores(id),
 policy_version TEXT NOT NULL, original_claim_key TEXT,
 source_digest TEXT NOT NULL, source_high_id INTEGER NOT NULL,
 source_units INTEGER NOT NULL CHECK(source_units > 0),
 credited_pv INTEGER NOT NULL CHECK(credited_pv >= 0),
 carry_units INTEGER NOT NULL CHECK(carry_units BETWEEN 0 AND 99),
 pr_debit_id INTEGER REFERENCES clover_pr_ledger(id),
 pv_credit_id INTEGER REFERENCES clover_pv_ledger(id),
 manifest_json TEXT NOT NULL, created_by TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(campaign_key,player_id,source_digest),
 CHECK(source_units = credited_pv * 100 + carry_units),
 CHECK((credited_pv = 0 AND pr_debit_id IS NULL AND pv_credit_id IS NULL)
    OR (credited_pv > 0 AND pr_debit_id IS NOT NULL AND pv_credit_id IS NOT NULL))
);
CREATE TRIGGER pr_pv_supplements_no_update BEFORE UPDATE ON clover_pr_pv_supplements
BEGIN SELECT RAISE(ABORT,'pr_pv_supplement_immutable'); END;
CREATE TRIGGER pr_pv_supplements_no_delete BEFORE DELETE ON clover_pr_pv_supplements
BEGIN SELECT RAISE(ABORT,'pr_pv_supplement_immutable'); END;
`;
const PR_PV_SUPPLEMENT_MIGRATION = Object.freeze({
 version:46, key:'0046_pr_pv_supplement_carry',
 description:'Settlement suplementar PR->PV com carry exato preservado no PR de origem.',
 checksumMaterial:{SQL,revision:1},
 async up(db) { await db.exec(SQL); },
});
module.exports = { PR_PV_SUPPLEMENT_MIGRATION };
