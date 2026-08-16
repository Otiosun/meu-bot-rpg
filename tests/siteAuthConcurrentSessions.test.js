'use strict';

process.env.CLOVER_SITE_MAX_ACTIVE_SESSIONS = '5';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { createSession, authenticateSiteSession } = require('../helpers/clover/siteAuthService');

test('novo login preserva sessoes anteriores e limita ativas a cinco', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-auth-concurrent-'));
  const filename = path.join(dir, 'auth.sqlite');
  const db = await open({ filename, driver: sqlite3.Database });

  try {
    await db.exec(`
      CREATE TABLE jogadores (
        id TEXT PRIMARY KEY,
        jogo_status TEXT,
        ficha_status TEXT,
        identity_status TEXT,
        lifecycle_status TEXT,
        is_shadow INTEGER DEFAULT 0,
        merged_into TEXT DEFAULT NULL
      );
      CREATE TABLE clover_character_stats (
        player_id TEXT PRIMARY KEY,
        distribution_status TEXT
      );
    `);

    const digits = '5511999999999';
    const playerId = `${digits}@s.whatsapp.net`;
    await db.run(
      `INSERT INTO jogadores
       (id,jogo_status,ficha_status,identity_status,lifecycle_status,is_shadow,merged_into)
       VALUES (?,?,?,?,?,?,?)`,
      [playerId,'liberado','aprovada','active','active',0,null]
    );

    const first = await createSession(db, playerId, digits);
    const second = await createSession(db, playerId, digits);

    const activeAfterSecond = await db.get(
      `SELECT COUNT(*) AS total
       FROM clover_site_sessions
       WHERE player_id=? AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')`,
      [playerId]
    );
    assert.equal(Number(activeAfterSecond.total), 2);

    assert.equal((await authenticateSiteSession(db, first.token)).ok, true);
    assert.equal((await authenticateSiteSession(db, second.token)).ok, true);

    const sessions = [first, second];
    for (let i=0;i<4;i+=1) sessions.push(await createSession(db, playerId, digits));

    const activeFinal = await db.get(
      `SELECT COUNT(*) AS total
       FROM clover_site_sessions
       WHERE player_id=? AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')`,
      [playerId]
    );
    assert.equal(Number(activeFinal.total), 5);
    assert.equal((await authenticateSiteSession(db, sessions.at(-1).token)).ok, true);

    const totalRevoked = await db.get(
      `SELECT COUNT(*) AS total FROM clover_site_sessions WHERE player_id=? AND revoked_at IS NOT NULL`,
      [playerId]
    );
    assert.equal(Number(totalRevoked.total), 1);
  } finally {
    await db.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
