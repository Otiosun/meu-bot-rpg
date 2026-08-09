'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CONFIRM = 'APPLY_FIVE_MISSING_SCENE_STARS_20260808';
const SEASON_ID = 'season-2026';
const EXPECTED_BACKUP_BLOB = '74f5333de6679b0bbb0d882e9ba9c815c57046bd';
const EXPECTED = [
  { evaluationId: 48, ledgerId: 24, squadKey: 'coringas_magenta', amount: 1, createdAt: '2026-06-23 21:27:27' },
  { evaluationId: 52, ledgerId: 25, squadKey: 'kings_of_sun', amount: 1, createdAt: '2026-06-23 22:31:05' },
  { evaluationId: 55, ledgerId: 26, squadKey: 'coringas_magenta', amount: 1, createdAt: '2026-06-23 23:07:46' },
  { evaluationId: 56, ledgerId: 27, squadKey: 'coringas_magenta', amount: 1, createdAt: '2026-06-23 23:11:45' },
  { evaluationId: 57, ledgerId: 28, squadKey: 'kings_of_sun', amount: 1, createdAt: '2026-06-23 23:12:32' },
];
const EXPECTED_BEFORE = {
  coringas_magenta: { seasonStars: 11, nativeGrants: 11 },
  kings_of_sun: { seasonStars: 7, nativeGrants: 7 },
};

function argValue(name) {
  const prefix = `--${name}=`;
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

function fail(message) {
  throw new Error(message);
}

async function verifyDatabase(db) {
  const quick = await db.get('PRAGMA quick_check');
  const fk = await db.all('PRAGMA foreign_key_check');
  return {
    quickCheck: quick ? Object.values(quick)[0] : null,
    foreignKeyViolations: fk.length,
  };
}

async function snapshotProtectedState(db) {
  const squadRows = await db.all(
    `SELECT squad_key, current_stars, historical_stars
     FROM clover_squads
     WHERE squad_key IN ('coringas_magenta','kings_of_sun')
     ORDER BY squad_key`
  );
  const legacy = await db.get(
    `SELECT COUNT(*) AS rows, COALESCE(SUM(amount),0) AS stars
     FROM clover_squad_star_ledger
     WHERE id IN (24,25,26,27,28)`
  );
  const quickRows = await db.all(
    `SELECT id, scene_sent_at
     FROM clover_quick_evaluations
     WHERE id IN (48,52,55,56,57)
     ORDER BY id`
  );
  return {
    squads: squadRows.map((row) => ({
      squadKey: row.squad_key,
      currentStars: Number(row.current_stars || 0),
      historicalStars: Number(row.historical_stars || 0),
    })),
    legacy: {
      rows: Number(legacy?.rows || 0),
      stars: Number(legacy?.stars || 0),
    },
    quickRows: quickRows.map((row) => ({ id: Number(row.id), sceneSentAt: row.scene_sent_at || null })),
  };
}

function equalJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function assertSeasonTopology(db, label) {
  const seasons = await db.all(
    `SELECT season_id, status, starts_at, ends_at
     FROM clover_squad_seasons
     ORDER BY season_id`
  );
  if (seasons.length !== 1) fail(`${label}: quantidade de temporadas mudou (${seasons.length}).`);
  const season = seasons[0];
  if (season.season_id !== SEASON_ID || season.status !== 'active' || season.starts_at !== null || season.ends_at !== null) {
    fail(`${label}: topologia da temporada mudou.`);
  }
}

async function getReconciliation(db, squadKey) {
  const row = await db.get(
    `SELECT
       COALESCE((SELECT season_stars FROM clover_squad_season_stars WHERE squad_key=? AND season_id=?),0) AS season_stars,
       COALESCE((SELECT SUM(CASE WHEN kind='grant' AND amount>0 THEN amount ELSE 0 END)
                 FROM clover_squad_star_transactions WHERE squad_key=? AND season_id=?),0) AS native_grants`,
    [squadKey, SEASON_ID, squadKey, SEASON_ID]
  );
  return {
    seasonStars: Number(row?.season_stars || 0),
    nativeGrants: Number(row?.native_grants || 0),
  };
}

async function assertExactCases(db, label) {
  for (const expected of EXPECTED) {
    const q = await db.get(
      `SELECT id, player_id, stars_amount, scene_sent_at
       FROM clover_quick_evaluations
       WHERE id=?`,
      [expected.evaluationId]
    );
    if (!q) fail(`${label}: Quick Evaluation ${expected.evaluationId} ausente.`);
    if (Number(q.stars_amount || 0) !== expected.amount) fail(`${label}: stars_amount mudou em ${expected.evaluationId}.`);
    if (q.scene_sent_at !== null) fail(`${label}: scene_sent_at deixou de ser NULL em ${expected.evaluationId}.`);

    const ledger = await db.get(
      `SELECT id, evaluation_id, squad_key, player_id, amount, kind, source, created_by, created_at
       FROM clover_squad_star_ledger
       WHERE id=?`,
      [expected.ledgerId]
    );
    if (!ledger) fail(`${label}: ledger ${expected.ledgerId} ausente.`);
    if (Number(ledger.evaluation_id) !== expected.evaluationId
      || ledger.squad_key !== expected.squadKey
      || Number(ledger.amount || 0) !== expected.amount
      || ledger.kind !== 'ganho'
      || ledger.source !== 'ficha_avaliacao'
      || ledger.created_at !== expected.createdAt) {
      fail(`${label}: ledger histórico mudou para evaluationId=${expected.evaluationId}.`);
    }
    if ((ledger.player_id || null) !== (q.player_id || null)) {
      fail(`${label}: player do ledger diverge da avaliação ${expected.evaluationId}.`);
    }

    const matches = await db.all(
      `SELECT season_id FROM clover_squad_seasons
       WHERE status IN ('active','closed')
         AND (starts_at IS NULL OR datetime(starts_at)<=datetime(?))
         AND (ends_at IS NULL OR datetime(?)<datetime(ends_at))
       ORDER BY season_id`,
      [ledger.created_at, ledger.created_at]
    );
    if (matches.length !== 1 || matches[0].season_id !== SEASON_ID) {
      fail(`${label}: timestamp do ledger não resolve unicamente para ${SEASON_ID} em ${expected.evaluationId}.`);
    }

    const native = await db.get(
      `SELECT id FROM clover_squad_star_transactions WHERE transaction_key=?`,
      [`quick-evaluation:squad-stars:${expected.evaluationId}`]
    );
    if (native) fail(`${label}: transação nativa já existe para ${expected.evaluationId}.`);
  }

  for (const squadKey of Object.keys(EXPECTED_BEFORE)) {
    const actual = await getReconciliation(db, squadKey);
    const expected = EXPECTED_BEFORE[squadKey];
    if (actual.seasonStars !== expected.seasonStars || actual.nativeGrants !== expected.nativeGrants) {
      fail(`${label}: reconciliação mudou para ${squadKey}: season=${actual.seasonStars}, native=${actual.nativeGrants}.`);
    }
  }
}

async function main() {
  const repo = path.resolve(argValue('repo') || process.cwd());
  const dbPath = path.resolve(argValue('db') || path.join(repo, 'banco.sqlite'));
  if (argValue('confirm') !== CONFIRM) fail(`Aplicação recusada: use --confirm=${CONFIRM}.`);

  const backupRelative = 'helpers/clover/sqliteBackupService.js';
  const backupPathModule = path.join(repo, ...backupRelative.split('/'));
  if (!fs.existsSync(backupPathModule)) fail(`Backup helper ausente: ${backupRelative}.`);
  const backupBlob = execFileSync('git', ['hash-object', `--path=${backupRelative}`, '--', backupRelative], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  if (backupBlob !== EXPECTED_BACKUP_BLOB) {
    fail(`Backup helper vivo mudou. Esperado ${EXPECTED_BACKUP_BLOB}, atual ${backupBlob}.`);
  }

  const sqlite3 = require(path.join(repo, 'node_modules', 'sqlite3')).verbose();
  const { open } = require(path.join(repo, 'node_modules', 'sqlite'));
  const { backupSqliteDatabase } = require(backupPathModule);

  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  let transactionOpen = false;
  let backupDbPath = null;

  try {
    await db.exec('PRAGMA busy_timeout=10000');

    const integrityBefore = await verifyDatabase(db);
    if (integrityBefore.quickCheck !== 'ok' || integrityBefore.foreignKeyViolations !== 0) {
      fail(`Banco recusado: quick=${integrityBefore.quickCheck}, fk=${integrityBefore.foreignKeyViolations}.`);
    }

    await assertSeasonTopology(db, 'preview');
    await assertExactCases(db, 'preview');
    const protectedBefore = await snapshotProtectedState(db);
    if (protectedBefore.legacy.rows !== 5 || protectedBefore.legacy.stars !== 5) {
      fail(`preview: ledger protegido inesperado: rows=${protectedBefore.legacy.rows}, stars=${protectedBefore.legacy.stars}.`);
    }

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const backupDir = path.resolve(repo, '..', 'clover-rpg-release-backups', `star-backfill-five-missing-scene-${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true });
    backupDbPath = path.join(backupDir, 'banco.sqlite');
    const backup = await backupSqliteDatabase(dbPath, backupDbPath);
    if (backup.integrity !== 'ok') fail(`Backup inválido: ${backup.integrity}.`);

    const backupDb = await open({ filename: backupDbPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
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

    await assertSeasonTopology(db, 'locked');
    await assertExactCases(db, 'locked');
    const protectedLocked = await snapshotProtectedState(db);
    if (!equalJson(protectedLocked, protectedBefore)) fail('Estado protegido mudou antes da escrita sob lock.');

    for (const expected of EXPECTED) {
      const ledger = await db.get(
        `SELECT player_id, created_by FROM clover_squad_star_ledger WHERE id=?`,
        [expected.ledgerId]
      );

      await db.run(
        `INSERT OR IGNORE INTO clover_squad_season_stars (squad_key, season_id, season_stars)
         VALUES (?, ?, 0)`,
        [expected.squadKey, SEASON_ID]
      );
      const updated = await db.run(
        `UPDATE clover_squad_season_stars
         SET season_stars=season_stars+?, updated_at=CURRENT_TIMESTAMP
         WHERE squad_key=? AND season_id=?`,
        [expected.amount, expected.squadKey, SEASON_ID]
      );
      if (Number(updated?.changes || 0) !== 1) fail(`season_stars update falhou em ${expected.evaluationId}.`);

      const metadata = JSON.stringify({
        historical_backfill: true,
        evaluation_id: expected.evaluationId,
        legacy_ledger_id: expected.ledgerId,
        scene_sent_at: null,
        missing_scene_sent_at: true,
        season_id: SEASON_ID,
        season_resolution_source: 'legacy_ledger_created_at_unique_season',
        legacy_ledger_created_at: expected.createdAt,
      });

      await db.run(
        `INSERT INTO clover_squad_star_transactions
         (transaction_key, squad_key, season_id, player_id, amount, kind, source,
          reason, related_id, created_by, created_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, 'grant', 'ficha_avaliacao', ?, ?, ?, ?, ?)`,
        [
          `quick-evaluation:squad-stars:${expected.evaluationId}`,
          expected.squadKey,
          SEASON_ID,
          ledger.player_id || null,
          expected.amount,
          'Backfill nativo de Star histórica com scene_sent_at ausente; temporada resolvida pelo timestamp do ledger legado em topologia unívoca.',
          `quick_eval:${expected.evaluationId}`,
          ledger.created_by || 'system',
          expected.createdAt,
          metadata,
        ]
      );
    }

    const protectedAfterWrites = await snapshotProtectedState(db);
    if (!equalJson(protectedAfterWrites, protectedBefore)) {
      fail('Invariante violada: current/historical/ledger/scene_sent_at foram alterados.');
    }

    const expectedAfter = {
      coringas_magenta: { seasonStars: 14, nativeGrants: 14 },
      kings_of_sun: { seasonStars: 9, nativeGrants: 9 },
    };
    for (const [squadKey, expected] of Object.entries(expectedAfter)) {
      const actual = await getReconciliation(db, squadKey);
      if (actual.seasonStars !== expected.seasonStars || actual.nativeGrants !== expected.nativeGrants) {
        fail(`Validação pós-escrita falhou para ${squadKey}: season=${actual.seasonStars}, native=${actual.nativeGrants}.`);
      }
    }

    const inserted = await db.get(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(amount),0) AS stars
       FROM clover_squad_star_transactions
       WHERE transaction_key IN (
         'quick-evaluation:squad-stars:48','quick-evaluation:squad-stars:52',
         'quick-evaluation:squad-stars:55','quick-evaluation:squad-stars:56',
         'quick-evaluation:squad-stars:57'
       )`
    );
    if (Number(inserted?.rows || 0) !== 5 || Number(inserted?.stars || 0) !== 5) {
      fail(`Transações nativas inesperadas: rows=${inserted?.rows}, stars=${inserted?.stars}.`);
    }

    await db.exec('COMMIT');
    transactionOpen = false;

    const integrityAfter = await verifyDatabase(db);
    if (integrityAfter.quickCheck !== 'ok' || integrityAfter.foreignKeyViolations !== 0) {
      fail(`Banco pós-backfill inválido: quick=${integrityAfter.quickCheck}, fk=${integrityAfter.foreignKeyViolations}.`);
    }

    const protectedCommitted = await snapshotProtectedState(db);
    if (!equalJson(protectedCommitted, protectedBefore)) fail('Estado protegido mudou após commit.');

    console.log(JSON.stringify({
      status: 'FIVE_MISSING_SCENE_STAR_BACKFILL=PASS',
      appliedEvaluations: 5,
      appliedStars: 5,
      seasonId: SEASON_ID,
      seasonResolutionSource: 'legacy_ledger_created_at_unique_season',
      coringasMagentaSeasonStarsAfter: 14,
      kingsOfSunSeasonStarsAfter: 9,
      quickCheck: integrityAfter.quickCheck,
      foreignKeyViolations: integrityAfter.foreignKeyViolations,
      currentStarsModified: 0,
      historicalStarsModified: 0,
      legacyLedgerModified: 0,
      sceneSentAtModified: 0,
      quickEvaluationsModified: 0,
      pm2Touched: 0,
      mudzapTouched: 0,
      raidTouched: 0,
      backupDb: backupDbPath,
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
  console.error(`FIVE_MISSING_SCENE_STAR_BACKFILL_ERROR=${error?.message || error}`);
  process.exit(1);
});