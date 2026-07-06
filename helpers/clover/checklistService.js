const { ensureCloverQuickEvaluationsSchema } = require('../../database');
const { enqueuePrivateText } = require('./deliveryService');

const WEEKLY_COMMON_PH_TARGET = 30;
const WEEKLY_AUTO_NARRATED_TARGET = 1;
const MONTHLY_SPIN_OFF_TARGET = 1;
const MONTHLY_DEVELOPMENT_TARGET = 1;
const WEEKLY_NOTICE_SOURCE = 'weekly_checklist_reset';

function pad2(value) {
    return String(value).padStart(2, '0');
}

function formatDateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatMonthLabel(date) {
    return `${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
}

function getWeekStart(date = new Date()) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday);
    return start;
}

function getMonthStart(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

function addDays(date, amount) {
    const next = new Date(date);
    next.setDate(next.getDate() + amount);
    return next;
}

function addMonths(date, amount) {
    return new Date(date.getFullYear(), date.getMonth() + amount, 1, 0, 0, 0, 0);
}

function dateTimeStartKey(date) {
    return `${formatDateKey(date)} 00:00:00`;
}

function toSqliteDate(date = new Date()) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function addSeconds(date, amount) {
    const next = new Date(date);
    next.setSeconds(next.getSeconds() + Number(amount || 0));
    return next;
}

function cap(value, target) {
    return Math.min(Number(value || 0), target);
}

async function ensureWeeklyNoticeSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_weekly_checklist_notices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            week_key TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'skipped')),
            job_id INTEGER DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL,
            UNIQUE (player_id, week_key)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_weekly_checklist_notices_week
        ON clover_weekly_checklist_notices (week_key, status)
    `);
}

async function getWeeklyCommonPh(db, playerId, weekKey) {
    const row = await db.get(
        `SELECT COALESCE(SUM(ph_amount), 0) AS total
         FROM clover_quick_evaluations
         WHERE player_id = ?
           AND week_key = ?
           AND COALESCE(bypass_weekly_limit, 0) = 0`,
        [playerId, weekKey]
    );
    return Number(row?.total || 0);
}

async function countWeeklyModality(db, playerId, weekKey, modalityKey) {
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_quick_evaluations
         WHERE player_id = ?
           AND week_key = ?
           AND modality_key = ?`,
        [playerId, weekKey, modalityKey]
    );
    return Number(row?.total || 0);
}

async function countMonthlyModality(db, playerId, monthStart, modalityKey) {
    const nextMonthStart = addMonths(monthStart, 1);
    const row = await db.get(
        `SELECT COUNT(*) AS total
         FROM clover_quick_evaluations
         WHERE player_id = ?
           AND modality_key = ?
           AND created_at >= ?
           AND created_at < ?`,
        [
            playerId,
            modalityKey,
            dateTimeStartKey(monthStart),
            dateTimeStartKey(nextMonthStart),
        ]
    );
    return Number(row?.total || 0);
}

async function getWeeklySummary(db, playerId, weekStart = getWeekStart()) {
    const weekKey = formatDateKey(weekStart);
    const commonPh = await getWeeklyCommonPh(db, playerId, weekKey);
    const autoNarrated = await countWeeklyModality(db, playerId, weekKey, 'missao_auto_narrada');

    return {
        key: weekKey,
        commonPh,
        commonPhShown: cap(commonPh, WEEKLY_COMMON_PH_TARGET),
        commonPhTarget: WEEKLY_COMMON_PH_TARGET,
        autoNarrated,
        autoNarratedShown: cap(autoNarrated, WEEKLY_AUTO_NARRATED_TARGET),
        autoNarratedTarget: WEEKLY_AUTO_NARRATED_TARGET,
        complete: commonPh >= WEEKLY_COMMON_PH_TARGET
            && autoNarrated >= WEEKLY_AUTO_NARRATED_TARGET,
    };
}

async function getMonthlySummary(db, playerId, monthStart = getMonthStart()) {
    const spinOff = await countMonthlyModality(db, playerId, monthStart, 'spin_off');
    const development = await countMonthlyModality(db, playerId, monthStart, 'missao_desenvolvimento');

    return {
        key: formatMonthLabel(monthStart),
        spinOff,
        spinOffShown: cap(spinOff, MONTHLY_SPIN_OFF_TARGET),
        spinOffTarget: MONTHLY_SPIN_OFF_TARGET,
        development,
        developmentShown: cap(development, MONTHLY_DEVELOPMENT_TARGET),
        developmentTarget: MONTHLY_DEVELOPMENT_TARGET,
        complete: spinOff >= MONTHLY_SPIN_OFF_TARGET
            && development >= MONTHLY_DEVELOPMENT_TARGET,
    };
}

async function getWeeklyStreak(db, playerId, now = new Date()) {
    let cursor = getWeekStart(now);
    const current = await getWeeklySummary(db, playerId, cursor);
    if (!current.complete) cursor = addDays(cursor, -7);

    let streak = 0;
    for (let safety = 0; safety < 52; safety += 1) {
        const summary = await getWeeklySummary(db, playerId, cursor);
        if (!summary.complete) break;
        streak += 1;
        cursor = addDays(cursor, -7);
    }
    return streak;
}

async function getMonthlyStreak(db, playerId, now = new Date()) {
    let cursor = getMonthStart(now);
    const current = await getMonthlySummary(db, playerId, cursor);
    if (!current.complete) cursor = addMonths(cursor, -1);

    let streak = 0;
    for (let safety = 0; safety < 24; safety += 1) {
        const summary = await getMonthlySummary(db, playerId, cursor);
        if (!summary.complete) break;
        streak += 1;
        cursor = addMonths(cursor, -1);
    }
    return streak;
}

async function getChecklistSummary(db, playerId, now = new Date()) {
    await ensureCloverQuickEvaluationsSchema(db);

    const weekStart = getWeekStart(now);
    const monthStart = getMonthStart(now);
    const [weekly, monthly, weeklyStreak, monthlyStreak] = await Promise.all([
        getWeeklySummary(db, playerId, weekStart),
        getMonthlySummary(db, playerId, monthStart),
        getWeeklyStreak(db, playerId, now),
        getMonthlyStreak(db, playerId, now),
    ]);

    return {
        weekly,
        monthly,
        streak: {
            weekly: weeklyStreak,
            monthly: monthlyStreak,
        },
    };
}

function renderStatus(complete) {
    return complete ? 'completo' : 'em andamento';
}

function renderChecklist(summary, playerLabel) {
    return [
        '♧┃CHECKLIST 𖥔 CLOVER MULTICOLOR',
        '     ── semanal, mensal e streak atual ──',
        '',
        '_`─( ✓ )───── Personagem`_',
        '',
        `*Nome:* ${playerLabel}`,
        '',
        '_`─( ✦ )───── Semanal`_',
        '',
        `*PH comum:* ${summary.weekly.commonPhShown}/${summary.weekly.commonPhTarget}`,
        `*Missão auto-narrada:* ${summary.weekly.autoNarratedShown}/${summary.weekly.autoNarratedTarget}`,
        `*Status:* ${renderStatus(summary.weekly.complete)}`,
        '',
        '_`─( ◆ )───── Mensal`_',
        '',
        `*Spin-Off:* ${summary.monthly.spinOffShown}/${summary.monthly.spinOffTarget}`,
        `*Missão de desenvolvimento:* ${summary.monthly.developmentShown}/${summary.monthly.developmentTarget}`,
        `*Status:* ${renderStatus(summary.monthly.complete)}`,
        '',
        '_`─( ◇ )───── Streak`_',
        '',
        `*Semanal:* ${summary.streak.weekly}`,
        `*Mensal:* ${summary.streak.monthly}`,
        '*Bônus:* desligado por enquanto.',
    ].join('\n');
}

function renderWeeklyResetNotice(summary, playerLabel) {
    return [
        '*♧┃SEMANA RESETADA 𖥔 CLOVER MULTICOLOR*',
        '     ── checklist semanal aberto ──',
        '',
        '_`─( ✓ )───── Nova semana`_',
        '',
        `*Personagem:* ${playerLabel}`,
        '',
        '> A semana virou e seus limites semanais começaram de novo.',
        '> Vai no seu ritmo, mas tenta não deixar tudo para o susto do fim.',
        '',
        '_`─( ✦ )───── Semanal`_',
        '',
        `*PH comum:* ${summary.weekly.commonPhShown}/${summary.weekly.commonPhTarget}`,
        `*Missão auto-narrada:* ${summary.weekly.autoNarratedShown}/${summary.weekly.autoNarratedTarget}`,
        '',
        '_`─( ◆ )───── Mensal`_',
        '',
        `*Spin-Off:* ${summary.monthly.spinOffShown}/${summary.monthly.spinOffTarget}`,
        `*Missão de desenvolvimento:* ${summary.monthly.developmentShown}/${summary.monthly.developmentTarget}`,
        '',
        '_`─( ◇ )───── Streak`_',
        '',
        `*Semanal:* ${summary.streak.weekly}`,
        `*Mensal:* ${summary.streak.monthly}`,
    ].join('\n');
}

function isPlayablePlayer(player = {}) {
    const jogo = String(player.jogo_status || '').trim().toLowerCase();
    const status = String(player.identity_status || 'active').trim().toLowerCase();
    const character = String(player.personagem_nome || '').trim();
    const normalizedCharacter = character.toLowerCase();
    return jogo === 'liberado'
        && status !== 'inactive'
        && Number(player.is_shadow || 0) !== 1
        && !String(player.merged_into || '').trim()
        && character
        && !['-', '.', 'cacador'].includes(normalizedCharacter);
}

async function listWeeklyNoticeTargets(db) {
    const rows = await db.all(`
        SELECT id, nome, display_name, personagem_nome, jogo_status, identity_status, is_shadow, merged_into
        FROM jogadores
        WHERE COALESCE(jogo_status, '') = 'liberado'
        ORDER BY personagem_nome COLLATE NOCASE ASC, nome COLLATE NOCASE ASC
    `);
    return rows.filter(isPlayablePlayer);
}

async function alreadyQueuedWeeklyNotice(db, playerId, weekKey) {
    const row = await db.get(
        `SELECT id FROM clover_weekly_checklist_notices WHERE player_id = ? AND week_key = ?`,
        [playerId, weekKey]
    );
    return Boolean(row);
}

function playerLabel(player) {
    return player?.personagem_nome
        || player?.display_name
        || player?.nome
        || String(player?.id || '').replace(/@.+$/, '')
        || '-';
}

async function queueWeeklyNoticeForPlayer(db, player, weekKey, { now = new Date(), offsetSeconds = 0, force = false } = {}) {
    await ensureWeeklyNoticeSchema(db);
    if (!force && await alreadyQueuedWeeklyNotice(db, player.id, weekKey)) {
        return { ok: true, skipped: true, reason: 'already_queued' };
    }
    if (force) {
        await db.run(
            `UPDATE clover_delivery_jobs
             SET status = 'cancelled',
                 last_error = 'Substituido por reenvio semanal',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id IN (
                SELECT job_id
                FROM clover_weekly_checklist_notices
                WHERE player_id = ? AND week_key = ? AND job_id IS NOT NULL
             )
             AND status = 'pending'`,
            [player.id, weekKey]
        );
    }

    const summary = await getChecklistSummary(db, player.id, now);
    const text = renderWeeklyResetNotice(summary, playerLabel(player));
    const runAfter = toSqliteDate(addSeconds(now, offsetSeconds));
    const job = await enqueuePrivateText(db, {
        targetJid: player.id,
        text,
        source: WEEKLY_NOTICE_SOURCE,
        reason: `weekly_reset:${weekKey}`,
        metadata: {
            week_key: weekKey,
            player_id: player.id,
        },
        priority: 4,
        runAfter,
        maxAttempts: 5,
    });

    if (!job?.ok) {
        return { ok: false, reason: job?.reason || 'enqueue_failed' };
    }

    await db.run(
        `INSERT INTO clover_weekly_checklist_notices
         (player_id, week_key, status, job_id, created_at, metadata_json)
         VALUES (?, ?, 'queued', ?, CURRENT_TIMESTAMP, ?)
         ON CONFLICT(player_id, week_key) DO UPDATE SET
             job_id = excluded.job_id,
             status = 'queued',
             created_at = CURRENT_TIMESTAMP,
             metadata_json = excluded.metadata_json`,
        [
            player.id,
            weekKey,
            job.jobId || null,
            JSON.stringify({ source: WEEKLY_NOTICE_SOURCE, forced: Boolean(force), run_after: runAfter }),
        ]
    );

    return { ok: true, queued: true, jobId: job.jobId || null };
}

async function runWeeklyChecklistResetDispatch(db, {
    now = new Date(),
    force = false,
    spacingSeconds = 45,
    maxTargets = 200,
} = {}) {
    await ensureCloverQuickEvaluationsSchema(db);
    await ensureWeeklyNoticeSchema(db);

    const weekStart = getWeekStart(now);
    const weekKey = formatDateKey(weekStart);
    const isMonday = now.getDay() === 1;

    if (!force && !isMonday) {
        return { ok: true, skipped: true, reason: 'not_monday', weekKey, queued: 0, targets: 0 };
    }

    const targets = (await listWeeklyNoticeTargets(db)).slice(0, Math.max(1, Number(maxTargets) || 200));
    let queued = 0;
    let already = 0;
    let failed = 0;

    for (const player of targets) {
        const result = await queueWeeklyNoticeForPlayer(db, player, weekKey, {
            now,
            offsetSeconds: queued * Number(spacingSeconds || 45),
            force,
        });
        if (result.queued) queued += 1;
        else if (result.skipped) already += 1;
        else failed += 1;
    }

    return {
        ok: true,
        weekKey,
        targets: targets.length,
        queued,
        already,
        failed,
        forced: Boolean(force),
    };
}

async function getWeeklyChecklistNoticeAudit(db, weekKey = formatDateKey(getWeekStart(new Date()))) {
    await ensureWeeklyNoticeSchema(db);
    const stats = await db.all(
        `SELECT n.status, COUNT(*) AS total
         FROM clover_weekly_checklist_notices n
         WHERE n.week_key = ?
         GROUP BY n.status`,
        [weekKey]
    );
    const recent = await db.all(
        `SELECT n.id, n.player_id, n.week_key, n.status, n.job_id, n.created_at,
                j.personagem_nome, j.nome, j.display_name,
                d.status AS delivery_status, d.attempts, d.max_attempts, d.last_error
         FROM clover_weekly_checklist_notices n
         LEFT JOIN jogadores j ON j.id = n.player_id
         LEFT JOIN clover_delivery_jobs d ON d.id = n.job_id
         WHERE n.week_key = ?
         ORDER BY n.id DESC
         LIMIT 15`,
        [weekKey]
    );
    return {
        weekKey,
        stats,
        recent,
    };
}

module.exports = {
    MONTHLY_DEVELOPMENT_TARGET,
    MONTHLY_SPIN_OFF_TARGET,
    WEEKLY_AUTO_NARRATED_TARGET,
    WEEKLY_COMMON_PH_TARGET,
    getChecklistSummary,
    getWeeklyChecklistNoticeAudit,
    runWeeklyChecklistResetDispatch,
    renderChecklist,
    renderWeeklyResetNotice,
};
