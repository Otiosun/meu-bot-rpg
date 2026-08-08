'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EXPECTED_HELPER_BLOB = '7cf80736cd149660131f3871d7a9e205d5914484';
const EXPECTED_WEEK_RULE = 'monday_scene_v2';
const REPAIR_SETTING_KEY = 'quick_evaluation_week_key_repair';
const REPAIR_SETTING_VALUE = 'scene_utc_sao_paulo_v3';
const EXPECTED_CHANGES = [
  { id: 121, beforeWeekKey: '2026-06-29', afterWeekKey: '2026-06-22' },
  { id: 159, beforeWeekKey: '2026-07-06', afterWeekKey: '2026-06-29' },
  { id: 160, beforeWeekKey: '2026-07-06', afterWeekKey: '2026-06-29' },
  { id: 161, beforeWeekKey: '2026-07-06', afterWeekKey: '2026-06-29' },
  { id: 162, beforeWeekKey: '2026-07-06', afterWeekKey: '2026-06-29' },
  { id: 165, beforeWeekKey: '2026-07-06', afterWeekKey: '2026-06-29' },
];

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function fail(message) {
  const error = new Error(message);
  error.expectedChanges = EXPECTED_CHANGES;
  throw error;
}

function normalizePlan(changes) {
  return [...(changes || [])]
    .map((row) => ({
      id: Number(row.id),
      beforeWeekKey: row.beforeWeekKey || null,
      afterWeekKey: row.afterWeekKey || null,
    }))
    .sort((a, b) => a.id - b.id);
}

function samePlan(actual, expected = EXPECTED_CHANGES) {
  return JSON.stringify(normalizePlan(actual)) === JSON.stringify(normalizePlan(expected));
}

async function verifyDatabase(db) {
  const quick = await db.get('PRAGMA quick_check');
  const fk = await db.all('PRAGMA foreign_key_check');
  return {
    quickCheck: quick ? Object.values(quick)[0] : null,
    foreignKeyViolations: fk.length,
  };
}

async function main() {
  const repo = path.resolve(argValue('repo') || process.cwd());
  const dbPath = path.resolve(argValue('db') || path.join(repo, 'banco.sqlite'));
  const confirm = argValue('confirm');
  if (confirm !== 'APPLY_SIX_WEEK_KEYS_20260808') {
    fail('Aplicacao recusada: use --confirm=APPLY_SIX_WEEK_KEYS_20260808.');
  }

  const helperRelative = 'helpers/clover/quickEvaluationWeekRepairService.js';
  const helperPath = path.join(repo, ...helperRelative.split('/'));
  if (!fs.existsSync(helperPath)) fail(`Helper ausente: ${helperRelative}`);
  const helperBlob = execFileSync('git', ['hash-object', `--path=${helperRelative}`, '--', helperRelative], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (helperBlob !== EXPECTED_HELPER_BLOB) {
    fail(`Helper vivo mudou. Esperado ${EXPECTED_HELPER_BLOB}, atual ${helperBlob}.`);
  }

  const sqlite3 = require(path.join(repo, 'node_modules', 'sqlite3')).verbose();
  const { open } = require(path.join(repo, 'node_modules', 'sqlite'));
  const {
    RPG_TIME_ZONE,
    planQuickEvaluationWeekRepair,
  } = require(helperPath);
  const { backupSqliteDatabase } = require(path.join(repo, 'helpers', 'clover', 'sqliteBackupService.js'));

  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  let transactionOpen = false;
  let backupPath = null;
  let lockedPlan = null;
  try {
    await db.exec('PRAGMA busy_timeout=10000');
    const integrityBefore = await verifyDatabase(db);
    if (integrityBefore.quickCheck !== 'ok' || integrityBefore.foreignKeyViolations !== 0) {
      fail(`Banco recusado: quick_check=${integrityBefore.quickCheck}, fk=${integrityBefore.foreignKeyViolations}.`);
    }

    const settingsTable = await db.get(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='clover_settings' LIMIT 1"
    );
    if (!settingsTable?.present) fail('Tabela clover_settings ausente.');
    const rule = await db.get(
      "SELECT value FROM clover_settings WHERE key='quick_evaluation_week_key_rule' LIMIT 1"
    );
    if (rule?.value !== EXPECTED_WEEK_RULE) {
      fail(`Regra semanal inesperada: ${rule?.value || 'ausente'}.`);
    }

    const preview = await planQuickEvaluationWeekRepair(db, { timeZone: RPG_TIME_ZONE });
    if (preview.changed !== EXPECTED_CHANGES.length || !samePlan(preview.changes)) {
      fail(`Preview mudou. Esperados exatamente os 6 IDs comprovados; atual=${JSON.stringify(normalizePlan(preview.changes))}`);
    }

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const backupDir = path.resolve(repo, '..', 'clover-rpg-release-backups', `week-repair-${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, 'banco.sqlite');
    const backup = await backupSqliteDatabase(dbPath, backupPath);
    const backupDb = await open({ filename: backupPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
      await backupDb.exec('PRAGMA query_only=ON');
      const backupIntegrity = await verifyDatabase(backupDb);
      if (backupIntegrity.quickCheck !== 'ok' || backupIntegrity.foreignKeyViolations !== 0) {
        fail(`Backup recusado: quick_check=${backupIntegrity.quickCheck}, fk=${backupIntegrity.foreignKeyViolations}.`);
      }
    } finally {
      await backupDb.close();
    }
    if (backup.integrity !== 'ok') fail(`Backup SQLite inesperado: ${backup.integrity}.`);

    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    lockedPlan = await planQuickEvaluationWeekRepair(db, { timeZone: RPG_TIME_ZONE });
    if (lockedPlan.changed !== EXPECTED_CHANGES.length || !samePlan(lockedPlan.changes)) {
      fail(`Plano sob lock mudou; nenhuma linha sera aplicada. Atual=${JSON.stringify(normalizePlan(lockedPlan.changes))}`);
    }

    for (const change of EXPECTED_CHANGES) {
      const result = await db.run(
        `UPDATE clover_quick_evaluations
         SET week_key = ?
         WHERE id = ? AND week_key = ?`,
        [change.afterWeekKey, change.id, change.beforeWeekKey]
      );
      if (Number(result?.changes || 0) !== 1) {
        fail(`Update recusado para evaluation_id=${change.id}; changes=${Number(result?.changes || 0)}.`);
      }
    }

    await db.run(
      `INSERT INTO clover_settings (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`,
      [REPAIR_SETTING_KEY, REPAIR_SETTING_VALUE]
    );

    const rows = await db.all(
      `SELECT id, week_key FROM clover_quick_evaluations
       WHERE id IN (${EXPECTED_CHANGES.map(() => '?').join(',')})
       ORDER BY id`,
      EXPECTED_CHANGES.map((change) => change.id)
    );
    if (rows.length !== EXPECTED_CHANGES.length) fail('Validacao transacional encontrou quantidade inesperada de rows.');
    for (const expected of EXPECTED_CHANGES) {
      const row = rows.find((item) => Number(item.id) === expected.id);
      if (!row || row.week_key !== expected.afterWeekKey) {
        fail(`Validacao transacional falhou para evaluation_id=${expected.id}.`);
      }
    }

    await db.exec('COMMIT');
    transactionOpen = false;

    const integrityAfter = await verifyDatabase(db);
    if (integrityAfter.quickCheck !== 'ok' || integrityAfter.foreignKeyViolations !== 0) {
      fail(`Banco pos-reparo invalido: quick_check=${integrityAfter.quickCheck}, fk=${integrityAfter.foreignKeyViolations}.`);
    }
    const settingAfter = await db.get(
      "SELECT value FROM clover_settings WHERE key=? LIMIT 1",
      [REPAIR_SETTING_KEY]
    );
    if (settingAfter?.value !== REPAIR_SETTING_VALUE) fail('Marcador de reparo nao foi persistido corretamente.');

    console.log(JSON.stringify({
      status: 'WEEK_REPAIR_APPLY=PASS',
      applied: EXPECTED_CHANGES.length,
      invalidLeftUntouched: Number(lockedPlan.invalid || 0),
      changes: EXPECTED_CHANGES,
      backupDb: backupPath,
      quickCheck: integrityAfter.quickCheck,
      foreignKeyViolations: integrityAfter.foreignKeyViolations,
      repairRule: settingAfter.value,
      phCompensationApplied: 0,
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
  console.error(`WEEK_REPAIR_ERROR=${error?.message || error}`);
  process.exit(1);
});
