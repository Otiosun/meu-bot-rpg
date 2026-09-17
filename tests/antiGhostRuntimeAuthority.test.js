const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { markCommunityStatus } = require('../helpers/clover/antiGhostService');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('remoção anti-ghost possui uma única autoridade fail-closed', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'helpers/clover/antiGhostSafeService.js')), false);

    const service = read('helpers/clover/antiGhostService.js');
    const start = service.indexOf('async function removePlayerForAntiGhost');
    const end = service.indexOf('\nasync function ', start + 1);
    const implementation = service.slice(start, end);

    assert.notEqual(start, -1);
    assert.match(implementation, /return archiveAndResetPlayer\(/);
    assert.doesNotMatch(implementation, /ensureAntiGhostSchema|groupParticipantsUpdate|writeEvent/);

    for (const relativePath of [
        'comandos/antiGhostSafeRemoval.js',
        'helpers/clover/cloverScriptAntiGhostApplyService.js',
    ]) {
        const source = read(relativePath);
        assert.match(source, /require\(['"](?:\.\.\/helpers\/clover\/|\.\/)antiGhostService['"]\)/);
        assert.doesNotMatch(source, /antiGhostSafeService/);
    }
});

test('bootstrap mantém um único scheduler persistente de anti-ghost', () => {
    const source = read('index.js');
    assert.equal((source.match(/createLifecycleInterval\('anti_ghost\.sweep'/g) || []).length, 1);
    assert.equal((source.match(/runAntiGhostSweep\(\{ sock, db \}\)/g) || []).length, 1);
    assert.match(source, /clearInterval\(runtimeClover\.antiGhostSweepTimer\)/);
    assert.match(source, /6 \* 60 \* 60 \* 1000/);
});

test('runtime registra atividade por uma única entrada de mensagem e comando', () => {
    const source = read('index.js');
    assert.equal((source.match(/recordMessageActivity\(\{/g) || []).length, 1);
    assert.equal((source.match(/recordCommandActivity\(\{/g) || []).length, 1);
    assert.equal((source.match(/handleAntiGhostPrivateReply\(\{/g) || []).length, 1);
});

test('JOIN/LEAVE duplicado atualiza estado sem duplicar evento de transição', async (t) => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    t.after(() => db.close());

    const firstLeave = await markCommunityStatus(db, 'player@lid', false, '2026-09-14 10:00:00');
    const duplicateLeave = await markCommunityStatus(db, 'player@lid', false, '2026-09-14 10:00:01');
    const firstJoin = await markCommunityStatus(db, 'player@lid', true, '2026-09-14 11:00:00');
    const duplicateJoin = await markCommunityStatus(db, 'player@lid', true, '2026-09-14 11:00:01');

    assert.equal(firstLeave.changed, true);
    assert.equal(duplicateLeave.changed, false);
    assert.equal(firstJoin.changed, true);
    assert.equal(duplicateJoin.changed, false);
    assert.deepEqual(
        await db.all('SELECT event_type FROM clover_antighost_events ORDER BY id'),
        [{ event_type: 'community_leave' }, { event_type: 'community_join' }]
    );
    assert.equal(
        (await db.get('SELECT last_community_seen_at FROM clover_antighost_activity WHERE player_id = ?', ['player@lid'])).last_community_seen_at,
        '2026-09-14 11:00:01'
    );
});
