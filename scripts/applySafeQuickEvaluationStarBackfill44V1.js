'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXPECTED_HELPER_BLOB = '5e66f4cc7316a29668c8ff2f1f07d7a99444ef86';
const CONFIRM = 'APPLY_SAFE_STAR_BACKFILL_44_20260808';
const EXPECTED_TOTAL_STARS = 49;
const EXPECTED_CANDIDATES = [
  [113,1,'season-2026'],[120,1,'season-2026'],[121,1,'season-2026'],[124,1,'season-2026'],
  [127,1,'season-2026'],[132,1,'season-2026'],[135,1,'season-2026'],[137,1,'season-2026'],
  [138,1,'season-2026'],[139,1,'season-2026'],[140,1,'season-2026'],[151,1,'season-2026'],
  [153,1,'season-2026'],[157,1,'season-2026'],[160,2,'season-2026'],[163,1,'season-2026'],
  [219,3,'season-2026'],[220,1,'season-2026'],[222,3,'season-2026'],[225,1,'season-2026'],
  [226,1,'season-2026'],[230,1,'season-2026'],[233,1,'season-2026'],[234,1,'season-2026'],
  [316,1,'season-2026'],[320,1,'season-2026'],[324,1,'season-2026'],[329,1,'season-2026'],
  [331,1,'season-2026'],[332,1,'season-2026'],[335,1,'season-2026'],[352,1,'season-2026'],
  [355,1,'season-2026'],[356,1,'season-2026'],[373,1,'season-2026'],[374,1,'season-2026'],
  [376,1,'season-2026'],[378,1,'season-2026'],[382,1,'season-2026'],[383,1,'season-2026'],
  [415,1,'season-2026'],[436,1,'season-2026'],[446,1,'season-2026'],[508,1,'season-2026']
].map(([evaluationId, amount, seasonId]) => ({ evaluationId, amount, seasonId }));

const EXPECTED_INVALID = [
  [50,'legacy_ledger_missing'],[51,'legacy_ledger_missing'],[122,'legacy_ledger_missing'],
  [227,'legacy_ledger_missing'],[317,'legacy_ledger_missing'],[330,'legacy_ledger_missing'],
  [437,'legacy_ledger_missing'],[48,'missing_scene_sent_at'],[52,'missing_scene_sent_at'],
  [55,'missing_scene_sent_at'],[56,'missing_scene_sent_at'],[57,'missing_scene_sent_at'],
  [336,'quick_evaluation_missing']
].map(([evaluationId, code]) => ({ evaluationId, code }));

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function normalizeCandidates(items) {
  return [...(items || [])].map((x) => ({
    evaluationId: Number(x.evaluationId),
    amount: Number(x.amount),
    seasonId: String(x.seasonId || ''),
  })).sort((a,b) => a.evaluationId - b.evaluationId);
}

function normalizeInvalid(items) {
  return [...(items || [])].map((x) => ({
    evaluationId: Number(x.evaluationId),
    code: String(x.code || ''),
  })).sort((a,b) => a.evaluationId - b.evaluationId || a.code.localeCompare(b.code));
}

function equalJson(a,b) { return JSON.stringify(a) === JSON.stringify(b); }
function totalStars(items) { return (items || []).reduce((sum, x) => sum + Number(x.amount || 0), 0); }

async function verifyDatabase(db) {
  const quick = await db.get('PRAGMA quick_check');
  const fk = await db.all('PRAGMA foreign_key_check');
  return {
    quickCheck: quick ? Object.values(quick)[0] : null,
    foreignKeyViolations: fk.length,
  };
}

function assertPlan(plan, label) {
  const candidates = normalizeCandidates(plan.candidates);
  const invalid = normalizeInvalid(plan.invalid);
  const expectedCandidates = normalizeCandidates(EXPECTED_CANDIDATES);
  const expectedInvalid = normalizeInvalid(EXPECTED_INVALID);

  if (plan.schemaReady !== true) throw new Error(`${label}: schemaReady=false`);
  if (Number(plan.candidateCount) !== 44) throw new Error(`${label}: candidateCount=${plan.candidateCount}`);
  if (Number(plan.invalidCount) !== 13) throw new Error(`${label}: invalidCount=${plan.invalidCount}`);
  if (Number(plan.alreadyNative) !== 0) throw new Error(`${label}: alreadyNative=${plan.alreadyNative}`);
  if (!equalJson(candidates, expectedCandidates)) throw new Error(`${label}: candidate set mudou`);
  if (!equalJson(invalid, expectedInvalid)) throw new Error(`${label}: invalid set mudou`);
  if (totalStars(plan.candidates) !== EXPECTED_TOTAL_STARS) throw new Error(`${label}: totalStars=${totalStars(plan.candidates)}`);
}

async function main() {
  const repo = path.resolve(argValue('repo') || process.cwd());
  const dbPath = path.resolve(argValue('db') || path.join(repo, 'banco.sqlite'));
  const confirm = argValue('confirm');
  if (confirm !== CONFIRM) throw new Error(`Aplicacao recusada: use --confirm=${CONFIRM}`);

  const helperRelative = 'helpers/clover/quickEvaluationStarBackfillService.js';
  const helperPath = path.join(repo, ...helperRelative.split('/'));
  if (!fs.existsSync(helperPath)) throw new Error(`Helper ausente: ${helperRelative}`);
  const helperBlob = execFileSync('git', ['hash-object', `--path=${helperRelative}`, '--', helperRelative], {
    cwd: repo, encoding: 'utf8', windowsHide: true,
  }).trim();
  if (helperBlob !== EXPECTED_HELPER_BLOB) throw new Error(`Helper vivo mudou: ${helperBlob}`);

  const sqlite3 = require(path.join(repo, 'node_modules', 'sqlite3')).verbose();
  const { open } = require(path.join(repo, 'node_modules', 'sqlite'));
  const { planQuickEvaluationStarBackfill } = require(helperPath);
  const { backupSqliteDatabase } = require(path.join(repo, 'helpers', 'clover', 'sqliteBackupService.js'));

  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  let transactionOpen = false;
  let lockedPlan = null;
  let backupPath = null;

  try {
    await db.exec('PRAGMA busy_timeout=10000');
    const integrityBefore = await verifyDatabase(db);
    if (integrityBefore.quickCheck !== 'ok' || integrityBefore.foreignKeyViolations !== 0) {
      throw new Error(`Banco recusado: quick=${integrityBefore.quickCheck} fk=${integrityBefore.foreignKeyViolations}`);
    }

    const preview = await planQuickEvaluationStarBackfill(db);
    assertPlan(preview, 'preview');

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const backupDir = path.resolve(repo, '..', 'clover-rpg-release-backups', `star-backfill-44-${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, 'banco.sqlite');
    const backup = await backupSqliteDatabase(dbPath, backupPath);
    if (backup.integrity !== 'ok') throw new Error(`Backup invalido: ${backup.integrity}`);

    const backupDb = await open({ filename: backupPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
      await backupDb.exec('PRAGMA query_only=ON');
      const backupIntegrity = await verifyDatabase(backupDb);
      if (backupIntegrity.quickCheck !== 'ok' || backupIntegrity.foreignKeyViolations !== 0) {
        throw new Error(`Backup recusado: quick=${backupIntegrity.quickCheck} fk=${backupIntegrity.foreignKeyViolations}`);
      }
    } finally { await backupDb.close(); }

    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    lockedPlan = await planQuickEvaluationStarBackfill(db);
    assertPlan(lockedPlan, 'locked-plan');

    for (const item of lockedPlan.candidates) {
      await db.run(
        `INSERT OR IGNORE INTO clover_squad_season_stars (squad_key, season_id, season_stars) VALUES (?, ?, 0)`,
        [item.squadKey, item.seasonId]
      );

      const update = await db.run(
        `UPDATE clover_squad_season_stars
         SET season_stars = season_stars + ?, updated_at = CURRENT_TIMESTAMP
         WHERE squad_key = ? AND season_id = ?`,
        [item.amount, item.squadKey, item.seasonId]
      );
      if (Number(update?.changes || 0) !== 1) throw new Error(`season_stars update falhou: evaluationId=${item.evaluationId}`);

      const metadata = JSON.stringify({
        historical_backfill: true,
        evaluation_id: item.evaluationId,
        legacy_ledger_id: item.legacyLedgerId,
        scene_sent_at: item.sceneSentAt,
        season_id: item.seasonId,
      });

      await db.run(
        `INSERT INTO clover_squad_star_transactions
         (transaction_key, squad_key, season_id, player_id, amount, kind, source,
          reason, related_id, created_by, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, 'grant', 'ficha_avaliacao', ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)`,
        [
          item.transactionKey, item.squadKey, item.seasonId, item.playerId, item.amount,
          item.reason, `quick_eval:${item.evaluationId}`, item.createdBy, item.legacyCreatedAt, metadata,
        ]
      );
    }

    await db.exec('COMMIT');
    transactionOpen = false;

    const integrityAfter = await verifyDatabase(db);
    if (integrityAfter.quickCheck !== 'ok' || integrityAfter.foreignKeyViolations !== 0) {
      throw new Error(`Banco pos-backfill invalido: quick=${integrityAfter.quickCheck} fk=${integrityAfter.foreignKeyViolations}`);
    }

    const post = await planQuickEvaluationStarBackfill(db);
    const postInvalid = normalizeInvalid(post.invalid);
    if (Number(post.candidateCount) !== 0) throw new Error(`Pos-backfill candidateCount=${post.candidateCount}`);
    if (Number(post.alreadyNative) !== 44) throw new Error(`Pos-backfill alreadyNative=${post.alreadyNative}`);
    if (Number(post.invalidCount) !== 13 || !equalJson(postInvalid, normalizeInvalid(EXPECTED_INVALID))) {
      throw new Error('Pos-backfill invalid set mudou');
    }

    console.log(JSON.stringify({
      status: 'SAFE_STAR_BACKFILL_44=PASS',
      appliedEvaluations: 44,
      appliedStars: EXPECTED_TOTAL_STARS,
      alreadyNativeAfter: post.alreadyNative,
      remainingCandidates: post.candidateCount,
      invalidLeftUntouched: post.invalidCount,
      invalidByCode: post.invalid.reduce((acc, x) => { acc[x.code] = (acc[x.code] || 0) + 1; return acc; }, {}),
      backupDb: backupPath,
      quickCheck: integrityAfter.quickCheck,
      foreignKeyViolations: integrityAfter.foreignKeyViolations,
      currentStarsModified: 0,
      historicalStarsModified: 0,
      legacyLedgerRowsAdded: 0,
      pm2Touched: 0,
      mudzapTouched: 0,
      raidTouched: 0,
    }, null, 2));
  } catch (error) {
    if (transactionOpen) {
      try { await db.exec('ROLLBACK'); } catch {}
    }
    throw error;
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(`SAFE_STAR_BACKFILL_ERROR=${error?.message || error}`);
  process.exit(1);
});