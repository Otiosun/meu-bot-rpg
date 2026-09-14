'use strict';
const crypto = require('node:crypto');
const { getPrBalance, mutatePrInTransaction, DEFAULT_EVENT_KEY } = require('./prService');
const { appendPvInTransaction } = require('./pvService');
const { assertPreResetAdminMutationAllowed, assertPreResetAdminCapability } = require('./preResetAccessService');
const POLICY = 'PRPV_1TO1_LRM_20260828_V1';
function fail(code) { throw Object.assign(new Error(code), {code}); }
function units(balance) {
 const scaled = balance * 100;
 const exact = Math.round(scaled);
 // Only binary representation noise is accepted, never an economic sub-cent.
 if (!Number.isSafeInteger(exact) || Math.abs(scaled-exact)>1e-8 || exact<0) fail('supplement_balance_not_exact_cents');
 return exact;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function historicalClaimDust(row,campaignKey) {
 let m;try{m=JSON.parse(row.metadata_json);}catch{return false;}
 return row.kind==='ajuste_admin' && row.source==='ajuste_admin'
  && row.idempotency_key?.startsWith('clover:prereset:pr-dust-final:20260828:')
  && m.cleanup_kind==='legacy_pr_ieee754_dust' && m.phase==='post_conversion_exact_zero'
  && m.campaign_key===campaignKey && m.policy_version===POLICY && m.approval_id==='owner-prpv-20260828-1502'
  && row.amount<0 && Math.abs(row.amount)<1e-9 && row.amount===m.applied_delta && row.amount===-m.observed_balance;
}
async function policy(db,campaignKey) {
 const p=await db.get('SELECT * FROM clover_prereset_pr_pv_policies WHERE campaign_key=?',[campaignKey]);
 if (!p || p.status!=='approved' || p.policy_version!==POLICY || p.numerator!==1 || p.denominator!==1 || p.rounding!=='floor') fail('supplement_policy_not_approved');
 return p;
}
async function buildSupplementManifest(db,playerId,campaignKey) {
 await policy(db,campaignKey);
 const claim=await db.get('SELECT * FROM clover_prereset_pr_pv_claims WHERE campaign_key=? AND player_id=?',[campaignKey,playerId]);
 const rows=await db.all('SELECT * FROM clover_pr_ledger WHERE player_id=? ORDER BY id',[playerId]);
 const sourceUnits=units(await getPrBalance(db,playerId));
 if (claim && (claim.policy_version!==POLICY || !claim.pr_ledger_id
  || Math.abs(rows.filter(r=>r.id<=claim.pr_ledger_id).reduce((s,r)=>s+r.amount,0))>1e-8)) fail('supplement_original_claim_not_settled');
 const previous=await db.get('SELECT operation_key,source_high_id,pr_debit_id FROM clover_pr_pv_supplements WHERE campaign_key=? AND player_id=? ORDER BY rowid DESC LIMIT 1',[campaignKey,playerId]);
 const posterior=rows.filter(r=>r.id>(previous?(previous.pr_debit_id||previous.source_high_id):(claim?.pr_ledger_id||0)));
 const firstCredit=posterior.find(r=>r.amount>0)?.id||Infinity;
 const baselineDust=!previous && claim?posterior.filter(r=>r.id<firstCredit && historicalClaimDust(r,campaignKey)):[];
 if((claim||previous) && posterior.some(r=>r.amount<=0 && !baselineDust.includes(r))) fail('supplement_not_positive_posterior_credit');
 return {playerId,campaignKey,policyVersion:POLICY,originalClaimKey:claim?.operation_key||null,
  originalClaimDigest:claim?digest(claim):null,
  settlementKind:claim||previous?'supplemental_delta':'initial_balance_with_carry',
  sourceHighId:rows.at(-1)?.id||0,sourceDigest:digest(rows),sourceUnits,
  previousSettlementKey:previous?.operation_key||null,
  baselineDustIds:baselineDust.map(r=>r.id),posteriorIds:posterior.filter(r=>r.amount>0).map(r=>r.id)};
}
async function verifiedSupplementCarry(db,playerId,campaignKey) {
 const exists=await db.get("SELECT 1 AS ok FROM sqlite_schema WHERE name='clover_pr_pv_supplements' AND type='table'");
 if (!exists) return null;
 const s=await db.get('SELECT * FROM clover_pr_pv_supplements WHERE campaign_key=? AND player_id=? ORDER BY rowid DESC LIMIT 1',[campaignKey,playerId]);
 if (!s) return null;
 await policy(db,campaignKey);
 const claim=await db.get('SELECT * FROM clover_prereset_pr_pv_claims WHERE campaign_key=? AND player_id=?',[campaignKey,playerId]);
 if ((claim?digest(claim):null)!==JSON.parse(s.manifest_json).originalClaimDigest) fail('supplement_original_claim_changed');
 const high=await db.get('SELECT MAX(id) id FROM clover_pr_ledger WHERE player_id=?',[playerId]);
 if (high.id!==(s.pr_debit_id||s.source_high_id) || units(await getPrBalance(db,playerId))!==s.carry_units) fail('supplement_source_changed');
 const rows=await db.all('SELECT * FROM clover_pr_ledger WHERE player_id=? AND id<=? ORDER BY id',[playerId,s.source_high_id]);
 if(digest(rows)!==s.source_digest) fail('supplement_source_changed');
 if(s.credited_pv>0){
  const pr=await db.get('SELECT player_id,amount,idempotency_key FROM clover_pr_ledger WHERE id=?',[s.pr_debit_id]);
  const pv=await db.get('SELECT player_id,amount,operation_key FROM clover_pv_ledger WHERE id=?',[s.pv_credit_id]);
  if(pr?.player_id!==playerId || pr.amount!==-s.credited_pv || pr.idempotency_key!==s.operation_key+':pr'
   || pv?.player_id!==playerId || pv.amount!==s.credited_pv || pv.operation_key!==s.operation_key+':pv') fail('supplement_pair_invalid');
 }
 return {operationKey:s.operation_key,carryUnits:s.carry_units,carryPr:s.carry_units/100,creditedPv:s.credited_pv};
}
async function settleSupplement(db,context,request) {
 assertPreResetAdminMutationAllowed(context); assertPreResetAdminCapability(context,'operation.apply');
 const {manifest,operationKey}=request;
 if(!context.actorId || !/^[a-zA-Z0-9_.:-]{8,180}$/.test(operationKey||'') || !manifest) fail('supplement_invalid_request');
 await db.exec('BEGIN IMMEDIATE');
 try {
  const replay=await db.get('SELECT * FROM clover_pr_pv_supplements WHERE operation_key=?',[operationKey]);
  if(replay){if(replay.manifest_json!==JSON.stringify(manifest))fail('supplement_idempotency_conflict');await db.exec('COMMIT');return {ok:true,duplicate:true,creditedPv:replay.credited_pv,carryUnits:replay.carry_units};}
  const current=await buildSupplementManifest(db,manifest.playerId,manifest.campaignKey);
  if(JSON.stringify(current)!==JSON.stringify(manifest))fail('supplement_manifest_changed');
  if(current.sourceUnits<=0)fail('supplement_no_source');
  const creditedPv=Math.trunc(current.sourceUnits/100),carryUnits=current.sourceUnits%100;
  let pvId=null,prId=null;
  if(creditedPv>0){
   const pv=await appendPvInTransaction(db,current.playerId,{amount:creditedPv,entryKind:'migration',operationKey:operationKey+':pv',source:'pr_pv_supplement',reason:'Settlement suplementar autorizado PR->PV 1:1.',policyVersion:POLICY,resetCycleKey:current.campaignKey,createdBy:context.actorId,metadata:{manifest,carryUnits}});
   if(pv.duplicate)fail('supplement_ledger_key_conflict');pvId=pv.ledgerId;
   const pr=await mutatePrInTransaction(db,current.playerId,{amount:-creditedPv,kind:'ajuste_admin',source:'ajuste_admin',eventKey:DEFAULT_EVENT_KEY,idempotencyKey:operationKey+':pr',reason:'Settlement suplementar autorizado PR->PV 1:1; fracao permanece como carry.',createdBy:context.actorId,metadata:{manifest,carryUnits}});
   if(pr.duplicate)fail('supplement_ledger_key_conflict');prId=pr.ledgerId;
  }
  await db.run(`INSERT INTO clover_pr_pv_supplements(operation_key,campaign_key,player_id,policy_version,original_claim_key,source_digest,source_high_id,source_units,credited_pv,carry_units,pr_debit_id,pv_credit_id,manifest_json,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[operationKey,current.campaignKey,current.playerId,POLICY,current.originalClaimKey,current.sourceDigest,current.sourceHighId,current.sourceUnits,creditedPv,carryUnits,prId,pvId,JSON.stringify(manifest),context.actorId]);
  await verifiedSupplementCarry(db,current.playerId,current.campaignKey);
  await db.exec('COMMIT');return {ok:true,duplicate:false,creditedPv,carryUnits};
 }catch(e){await db.exec('ROLLBACK').catch(()=>{});throw e;}
}
module.exports={buildSupplementManifest,settleSupplement,verifiedSupplementCarry};
