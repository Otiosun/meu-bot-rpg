'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIRM = 'APPLY_ORPHAN_QE_336_STAR_20260808';
const EVALUATION_ID = 336;
const LEDGER_ID = 79;
const ADMIN_ENTRY_ID = 116;
const SQUAD_KEY = 'lobos_cinzentos';
const SEASON_ID = 'season-2026';
const AMOUNT = 3;
const SCENE_SENT_AT = '2026-07-06 22:04:42';
const EVALUATED_AT = '2026-07-11 07:51:33';
const GRANT_CREATED_AT = '2026-07-11 07:51:35';
const BACKUP_HELPER_BLOB = '74f5333de6679b0bbb0d882e9ba9c815c57046bd';

function argValue(name) {
  const prefix = `--${name}=`;
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

function fail(message) {
  throw new Error(message);
}

function gitBlobSha(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(header).update(buffer).digest('hex');
}

async function verifyDatabase(db) {
  const quick = await db.get('PRAGMA quick_check');
  const fk = await db.all('PRAGMA foreign_key_check');
  return {
    quickCheck: quick ? Object.values(quick)[0] : null,
    foreignKeyViolations: fk.length,
  };
}

async function getReconciliation(db) {
  const row = await db.get(
    `SELECT
       COALESCE((SELECT season_stars
                 FROM clover_squad_season_stars
                 WHERE squad_key=? AND season_id=?),0) AS season_stars,
       COALESCE((SELECT SUM(CASE WHEN kind='grant' AND amount>0 THEN amount ELSE 0 END)
                 FROM clover_squad_star_transactions
                 WHERE squad_key=? AND season_id=?),0) AS native_grants`,
    [SQUAD_KEY, SEASON_ID, SQUAD_KEY, SEASON_ID]
  );
  return {
    seasonStars: Number(row?.season_stars || 0),
    nativeGrants: Number(row?.native_grants || 0),
  };
}

async function assertSeasonResolution(db, label) {
  const matches = await db.all(
    `SELECT season_id, status, starts_at, ends_at
     FROM clover_squad_seasons
     WHERE status IN ('active','closed')
       AND (starts_at IS NULL OR datetime(starts_at)<=datetime(?))
       AND (ends_at IS NULL OR datetime(?)<datetime(ends_at))
     ORDER BY season_id`,
    [SCENE_SENT_AT, SCENE_SENT_AT]
  );
  if (matches.length !== 1 || matches[0].season_id !== SEASON_ID) {
    fail(`${label}: scene_sent_at não resolve unicamente para ${SEASON_ID}.`);
  }
}

async function assertEvidence(db, label) {
  const qe = await db.get(
    'SELECT id FROM clover_quick_evaluations WHERE id=?',
    [EVALUATION_ID]
  );
  if (qe) fail(`${label}: Quick Evaluation 336 reapareceu; plano ficou obsoleto.`);

  const ledger = await db.get(
    `SELECT id, evaluation_id, squad_key, player_id, amount, kind, source,
            reason, created_by, created_at, metadata_json
     FROM clover_squad_star_ledger
     WHERE id=?`,
    [LEDGER_ID]
  );
  if (!ledger) fail(`${label}: ledger 79 ausente.`);
  if (Number(ledger.evaluation_id) !== EVALUATION_ID
      || ledger.squad_key !== SQUAD_KEY
      || Number(ledger.amount || 0) !== AMOUNT
      || ledger.kind !== 'ganho'
      || ledger.source !== 'ficha_avaliacao'
      || ledger.created_at !== GRANT_CREATED_AT) {
    fail(`${label}: evidência do ledger 79 mudou.`);
  }

  const admin = await db.get(
    `SELECT id, evaluation_id, target_player_id, source, reason, status,
            scene_sent_at, scene_week_key, evaluated_at, created_at
     FROM clover_admin_service_entries
     WHERE id=?`,
    [ADMIN_ENTRY_ID]
  );
  if (!admin) fail(`${label}: admin service entry 116 ausente.`);
  if (Number(admin.evaluation_id) !== EVALUATION_ID
      || admin.source !== 'quick_evaluation'
      || admin.reason !== 'Avaliacao aprovada: Missão Auto-Narrada'
      || admin.status !== 'pending'
      || admin.scene_sent_at !== SCENE_SENT_AT
      || admin.scene_week_key !== '2026-07-06'
      || admin.evaluated_at !== EVALUATED_AT
      || admin.created_at !== GRANT_CREATED_AT) {
    fail(`${label}: evidência do serviço ADM 116 mudou.`);
  }
  if (String(admin.target_player_id || '') !== String(ledger.player_id || '')) {
    fail(`${label}: identidade diverge entre ledger 79 e serviço ADM 116.`);
  }

  const native = await db.get(
    'SELECT id FROM clover_squad_star_transactions WHERE transaction_key=?',
    [`quick-evaluation:squad-stars:${EVALUATION_ID}`]
  );
  if (native) fail(`${label}: transação nativa 336 já existe.`);

  await assertSeasonResolution(db, label);

  const reconciliation = await getReconciliation(db);
  if (reconciliation.seasonStars !== reconciliation.nativeGrants) {
    fail(`${label}: Lobos Cinzentos já está desreconciliado (season=${reconciliation.seasonStars}, native=${reconciliation.nativeGrants}).`);
  }

  return { ledger, admin, reconciliation };
}

async function snapshotProtectedState(db) {
  const squad = await db.get(
    `SELECT squad_key, current_stars, historical_stars
     FROM clover_squads WHERE squad_key=?`,
    [SQUAD_KEY]
  );
  const ledgerTotals = await db.get(
    `SELECT COUNT(*) AS rows, COALESCE(SUM(amount),0) AS stars
     FROM clover_squad_star_ledger`
  );
  const ledger = await db.get(
    `SELECT id, evaluation_id, squad_key, player_id, amount, kind, source,
            reason, created_by, created_at, metadata_json
     FROM clover_squad_star_ledger WHERE id=?`,
    [LEDGER_ID]
  );
  const admin = await db.get(
    `SELECT id, evaluation_id, target_player_id, source, reason, status,
            scene_sent_at, scene_week_key, evaluated_at, created_at
     FROM clover_admin_service_entries WHERE id=?`,
    [ADMIN_ENTRY_ID]
  );
  const qe = await db.get(
    'SELECT id FROM clover_quick_evaluations WHERE id=?',
    [EVALUATION_ID]
  );
  return {
    squad: squad ? {
      squadKey: squad.squad_key,
      currentStars: Number(squad.current_stars || 0),
      historicalStars: Number(squad.historical_stars || 0),
    } : null,
    ledgerTotals: {
      rows: Number(ledgerTotals?.rows || 0),
      stars: Number(ledgerTotals?.stars || 0),
    },
    ledger,
    admin,
    quickEvaluationExists: Boolean(qe),
  };
}

function equalJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  const repo = path.resolve(argValue('repo') || process.cwd());
  const dbPath = path.resolve(argValue('db') || path.join(repo, 'banco.sqlite'));
  if (argValue('confirm') !== CONFIRM) {
    fail(`Aplicação recusada: use --confirm=${CONFIRM}.`);
  }

  const backupHelperPath = path.join(repo, 'helpers', 'clover', 'sqliteBackupService.js');
  const backupHelperBytes = fs.readFileSync(backupHelperPath);
  const helperBlob = gitBlobSha(backupHelperBytes);
  if (helperBlob !== BACKUP_HELPER_BLOB) {
    fail(`sqliteBackupService.js mudou: esperado ${BACKUP_HELPER_BLOB}, atual ${helperBlob}.`);
  }

  const sqlite3 = require(path.join(repo, 'node_modules', 'sqlite3')).verbose();
  const { open } = require(path.join(repo, 'node_modules', 'sqlite'));
  const { backupSqliteDatabase } = require(backupHelperPath);

  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  let transactionOpen = false;
  let backupPath = null;

  try {
    await db.exec('PRAGMA busy_timeout=10000');

    const integrityBefore = await verifyDatabase(db);
    if (integrityBefore.quickCheck !== 'ok' || integrityBefore.foreignKeyViolations !== 0) {
      fail(`Banco recusado: quick=${integrityBefore.quickCheck}, fk=${integrityBefore.foreignKeyViolations}.`);
    }

    const preview = await assertEvidence(db, 'preview');
    const protectedBefore = await snapshotProtectedState(db);

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const backupDir = path.resolve(repo, '..', 'clover-rpg-release-backups', `star-backfill-orphan-336-${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, 'banco.sqlite');
    const backup = await backupSqliteDatabase(dbPath, backupPath);
    if (backup.integrity !== 'ok') fail(`Backup inválido: ${backup.integrity}.`);

    const backupDb = await open({ filename: backupPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    try {
      await backupDb.exec('PRAGMA query_only=ON');
      const bi = await verifyDatabase(backupDb);
      if (bi.quickCheck !== 'ok' || bi.foreignKeyViolations !== 0) {
        fail(`Backup recusado: quick=${bi.quickCheck}, fk=${bi.foreignKeyViolations}.`);
      }
    } finally {
      await backupDb.close();
    }

    await db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;

    const locked = await assertEvidence(db, 'locked');
    const protectedLocked = await snapshotProtectedState(db);
    if (!equalJson(protectedLocked, protectedBefore)) {
      fail('Estado protegido mudou antes da escrita sob lock.');
    }
    if (locked.reconciliation.seasonStars !== preview.reconciliation.seasonStars
        || locked.reconciliation.nativeGrants !== preview.reconciliation.nativeGrants) {
      fail('Reconciliação dos Lobos mudou entre preview e lock.');
    }

    await db.run(
      `INSERT OR IGNORE INTO clover_squad_season_stars (squad_key, season_id, season_stars)
       VALUES (?, ?, 0)`,
      [SQUAD_KEY, SEASON_ID]
    );

    const updated = await db.run(
      `UPDATE clover_squad_season_stars
       SET season_stars=season_stars+?, updated_at=CURRENT_TIMESTAMP
       WHERE squad_key=? AND season_id=?`,
      [AMOUNT, SQUAD_KEY, SEASON_ID]
    );
    if (Number(updated?.changes || 0) !== 1) {
      fail('Falha ao incrementar season_stars dos Lobos Cinzentos.');
    }

    const metadata = JSON.stringify({
      historical_backfill: true,
      orphaned_quick_evaluation: true,
      evaluation_id: EVALUATION_ID,
      legacy_ledger_id: LEDGER_ID,
      admin_service_entry_id: ADMIN_ENTRY_ID,
      scene_sent_at: SCENE_SENT_AT,
      evaluated_at: EVALUATED_AT,
      season_id: SEASON_ID,
      season_resolution_source: 'surviving_admin_scene_sent_at_unique_season',
      evidence: [
        'clover_squad_star_ledger:79',
        'clover_admin_service_entries:116'
      ]
    });

    await db.run(
      `INSERT INTO clover_squad_star_transactions
       (transaction_key, squad_key, season_id, player_id, amount, kind, source,
        reason, related_id, created_by, created_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, 'grant', 'ficha_avaliacao', ?, ?, ?, ?, ?)`,
      [
        `quick-evaluation:squad-stars:${EVALUATION_ID}`,
        SQUAD_KEY,
        SEASON_ID,
        locked.ledger.player_id || null,
        AMOUNT,
        'Backfill nativo de grant histórico órfão; Quick Evaluation ausente, grant provado por ledger e serviço ADM concordantes.',
        `quick_eval:${EVALUATION_ID}`,
        locked.ledger.created_by || 'system',
        GRANT_CREATED_AT,
        metadata,
      ]
    );

    const protectedAfterWrites = await snapshotProtectedState(db);
    if (!equalJson(protectedAfterWrites, protectedBefore)) {
      fail('Invariante violada: current/historical/ledger/admin/QE foram alterados.');
    }

    const reconciliationAfter = await getReconciliation(db);
    if (reconciliationAfter.seasonStars !== preview.reconciliation.seasonStars + AMOUNT
        || reconciliationAfter.nativeGrants !== preview.reconciliation.nativeGrants + AMOUNT
        || reconciliationAfter.seasonStars !== reconciliationAfter.nativeGrants) {
      fail(`Reconciliação pós-escrita inválida: season=${reconciliationAfter.seasonStars}, native=${reconciliationAfter.nativeGrants}.`);
    }

    const inserted = await db.get(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(amount),0) AS stars
       FROM clover_squad_star_transactions
       WHERE transaction_key=?`,
      [`quick-evaluation:squad-stars:${EVALUATION_ID}`]
    );
    if (Number(inserted?.rows || 0) !== 1 || Number(inserted?.stars || 0) !== AMOUNT) {
      fail(`Transação 336 inesperada: rows=${inserted?.rows}, stars=${inserted?.stars}.`);
    }

    await db.exec('COMMIT');
    transactionOpen = false;

    const integrityAfter = await verifyDatabase(db);
    if (integrityAfter.quickCheck !== 'ok' || integrityAfter.foreignKeyViolations !== 0) {
      fail(`Banco pós-backfill inválido: quick=${integrityAfter.quickCheck}, fk=${integrityAfter.foreignKeyViolations}.`);
    }

    const protectedCommitted = await snapshotProtectedState(db);
    if (!equalJson(protectedCommitted, protectedBefore)) {
      fail('Estado protegido mudou após commit.');
    }

    const reconciliationCommitted = await getReconciliation(db);
    if (reconciliationCommitted.seasonStars !== reconciliationAfter.seasonStars
        || reconciliationCommitted.nativeGrants !== reconciliationAfter.nativeGrants) {
      fail('Reconciliação mudou após commit.');
    }

    console.log(JSON.stringify({
      status: 'ORPHAN_QE_336_STAR_BACKFILL=PASS',
      evaluationId: EVALUATION_ID,
      appliedStars: AMOUNT,
      squadKey: SQUAD_KEY,
      seasonId: SEASON_ID,
      quickEvaluationRecreated: 0,
      seasonStarsBefore: preview.reconciliation.seasonStars,
      seasonStarsAfter: reconciliationCommitted.seasonStars,
      nativeGrantsBefore: preview.reconciliation.nativeGrants,
      nativeGrantsAfter: reconciliationCommitted.nativeGrants,
      quickCheck: integrityAfter.quickCheck,
      foreignKeyViolations: integrityAfter.foreignKeyViolations,
      currentStarsModified: 0,
      historicalStarsModified: 0,
      legacyLedgerModified: 0,
      adminServiceModified: 0,
      quickEvaluationsModified: 0,
      pm2Touched: 0,
      mudzapTouched: 0,
      raidTouched: 0,
      backupDb: backupPath,
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
  console.error(`ORPHAN_QE_336_STAR_BACKFILL_ERROR=${error?.message || error}`);
  process.exit(1);
});
