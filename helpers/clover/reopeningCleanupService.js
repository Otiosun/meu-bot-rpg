const SAFE_PLACEHOLDER_NAMES = new Set(['', '-', '.', 'cacador']);

const SAFE_STEPS = new Set([
    'recepcao',
    'inicio',
    'roll_gerado',
    'rolls_revisados',
    'limite_rolls',
    'roll_final_sacrificio',
    'escolha_magia',
    'escolha_roll_magia',
    'aguardando_ficha_envio',
    'ficha_pendente_confirmacao',
    'corrigir_ficha',
    'cadastro_aprovado',
]);

function normalizeText(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

function isPlaceholderCharacter(value) {
    return SAFE_PLACEHOLDER_NAMES.has(normalizeText(value));
}

function safePlayerWhereClause(alias = 'j') {
    const prefix = alias ? `${alias}.` : '';
    return `
        COALESCE(${prefix}is_shadow, 0) = 0
        AND (${prefix}merged_into IS NULL OR TRIM(${prefix}merged_into) = '')
        AND COALESCE(${prefix}ficha_status, 'incompleta') = 'incompleta'
        AND COALESCE(${prefix}jogo_status, 'bloqueado') <> 'liberado'
        AND (
            ${prefix}personagem_nome IS NULL
            OR TRIM(${prefix}personagem_nome) IN ('', '-', '.')
            OR LOWER(TRIM(${prefix}personagem_nome)) = 'cacador'
        )
    `;
}

function placeholders(values) {
    return values.map(() => '?').join(', ');
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name = ?
         LIMIT 1`,
        [tableName]
    );
    return Boolean(row);
}

async function getCandidatePlayers(db) {
    const rows = await db.all(
        `SELECT
             j.id,
             j.display_name,
             j.personagem_nome,
             j.numero_roll_escolhido,
             j.ficha_status,
             j.jogo_status,
             j.roll_sacrifice_used,
             o.current_step,
             COALESCE(r.rolls, 0) AS rolls,
             COALESCE(pm.pending_magic, 0) AS pending_magic,
             COALESCE(pp.pending_profile, 0) AS pending_profile,
             COALESCE(sr.slot_reservations, 0) AS slot_reservations
         FROM jogadores j
         LEFT JOIN player_onboarding o ON o.player_id = j.id
         LEFT JOIN (
             SELECT player_id, COUNT(*) AS rolls
             FROM player_rolls
             GROUP BY player_id
         ) r ON r.player_id = j.id
         LEFT JOIN (
             SELECT player_id, COUNT(*) AS pending_magic
             FROM pending_magic_confirmations
             GROUP BY player_id
         ) pm ON pm.player_id = j.id
         LEFT JOIN (
             SELECT player_id, COUNT(*) AS pending_profile
             FROM pending_profile_confirmations
             GROUP BY player_id
         ) pp ON pp.player_id = j.id
         LEFT JOIN (
             SELECT player_id, COUNT(*) AS slot_reservations
             FROM slot_reservations
             WHERE source IN ('roll_race', 'roll_grimoire')
               AND status IN ('pending', 'confirmed')
             GROUP BY player_id
         ) sr ON sr.player_id = j.id
         WHERE ${safePlayerWhereClause('j')}
         ORDER BY COALESCE(o.last_seen_at, o.started_at, j.ultima_recepcao_em, '1970-01-01') ASC`
    );

    return rows.filter((row) => {
        const step = String(row.current_step || 'recepcao').trim() || 'recepcao';
        return SAFE_STEPS.has(step) && isPlaceholderCharacter(row.personagem_nome);
    });
}

function summarizeCandidates(candidates) {
    const byStep = new Map();
    let rolls = 0;
    let selectedRolls = 0;
    let pendingMagic = 0;
    let pendingProfile = 0;
    let slotReservations = 0;
    let sacrificed = 0;

    for (const row of candidates) {
        const step = String(row.current_step || 'recepcao').trim() || 'recepcao';
        byStep.set(step, (byStep.get(step) || 0) + 1);
        rolls += Number(row.rolls || 0);
        if (row.numero_roll_escolhido !== null && row.numero_roll_escolhido !== undefined) selectedRolls += 1;
        pendingMagic += Number(row.pending_magic || 0);
        pendingProfile += Number(row.pending_profile || 0);
        slotReservations += Number(row.slot_reservations || 0);
        if (Number(row.roll_sacrifice_used || 0)) sacrificed += 1;
    }

    return {
        candidates: candidates.length,
        rolls,
        selectedRolls,
        pendingMagic,
        pendingProfile,
        slotReservations,
        sacrificed,
        byStep: [...byStep.entries()].sort((left, right) => right[1] - left[1]),
    };
}

async function getReopeningCleanupStatus(db) {
    const candidates = await getCandidatePlayers(db);
    const totalPlayers = await db.get('SELECT COUNT(*) AS total FROM jogadores');
    const releasedPlayers = await db.get(
        "SELECT COUNT(*) AS total FROM jogadores WHERE COALESCE(jogo_status, '') = 'liberado'"
    );
    const placeholders = await db.get(
        `SELECT COUNT(*) AS total
         FROM jogadores
         WHERE personagem_nome IS NULL
            OR TRIM(personagem_nome) IN ('', '-', '.')
            OR LOWER(TRIM(personagem_nome)) = 'cacador'`
    );

    return {
        totalPlayers: Number(totalPlayers?.total || 0),
        releasedPlayers: Number(releasedPlayers?.total || 0),
        placeholders: Number(placeholders?.total || 0),
        summary: summarizeCandidates(candidates),
        candidates,
    };
}

async function applyReopeningCleanup(db, { actorId = null, reason = 'reabertura' } = {}) {
    const candidates = await getCandidatePlayers(db);
    const ids = candidates.map((row) => row.id);
    const summaryBefore = summarizeCandidates(candidates);

    if (!ids.length) {
        return {
            ok: true,
            applied: false,
            cleaned: 0,
            summaryBefore,
            summaryAfter: summaryBefore,
        };
    }

    const marks = placeholders(ids);
    const nowPayload = JSON.stringify({
        source: 'reopening_cleanup',
        reason,
        actorId,
    });

    await db.exec('BEGIN IMMEDIATE');
    try {
        await db.run(
            `DELETE FROM player_rolls
             WHERE player_id IN (${marks})`,
            ids
        );

        await db.run(
            `DELETE FROM pending_magic_confirmations
             WHERE player_id IN (${marks})`,
            ids
        );

        if (await tableExists(db, 'pending_profile_confirmations')) {
            await db.run(
                `DELETE FROM pending_profile_confirmations
                 WHERE player_id IN (${marks})`,
                ids
            );
        }

        await db.run(
            `UPDATE slot_reservations
             SET status = 'released'
             WHERE player_id IN (${marks})
               AND source IN ('roll_race', 'roll_grimoire')
               AND status IN ('pending', 'confirmed')`,
            ids
        );

        await db.run(
            `DELETE FROM group_member_welcomes
             WHERE player_id IN (${marks})`,
            ids
        );

        await db.run(
            `UPDATE jogadores
             SET reino = '-',
                 classe = '-',
                 familia = '-',
                 raca = '-',
                 grimorio = '-',
                 magia = '-',
                 familia_key = NULL,
                 magia_key = NULL,
                 numero_roll_escolhido = NULL,
                 roll_sacrifice_used = 0,
                 roll_sacrifice_used_at = NULL,
                 ficha_status = 'incompleta',
                 personagem_nome = '-',
                 personagem_idade = NULL,
                 personagem_aparencia = '-',
                 personagem_aparencia_normalizada = NULL,
                 personagem_aparencia_status = 'pending',
                 personagem_aparencia_motivo = NULL,
                 personagem_aparencia_image_path = NULL,
                 personagem_aparencia_image_message_id = NULL,
                 personagem_aparencia_approved_by = NULL,
                 personagem_aparencia_approved_at = NULL,
                 personagem_aparencia_updated_at = NULL,
                 personagem_genero = '-',
                 historia_status = 'pendente',
                 historia_status_updated_at = NULL,
                 historia_aprovada_at = NULL,
                 historia_aprovada_by = NULL,
                 historia_pv_sent_at = NULL,
                 historia_motivo = NULL,
                 jogo_status = 'bloqueado',
                 jogo_liberado_at = NULL,
                 jogo_liberado_by = NULL,
                 jogo_bloqueio_motivo = 'limpeza de reabertura',
                 ultima_recepcao_em = NULL
             WHERE id IN (${marks})
               AND ${safePlayerWhereClause('')}`,
            ids
        );

        await db.run(
            `INSERT INTO player_onboarding
             (player_id, current_step, step_payload, started_at, welcome_sent_at, last_seen_at)
             SELECT id, 'recepcao', ?, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP
             FROM jogadores
             WHERE id IN (${marks})
             ON CONFLICT(player_id) DO UPDATE SET
                 current_step = 'recepcao',
                 step_payload = excluded.step_payload,
                 welcome_sent_at = NULL,
                 last_seen_at = CURRENT_TIMESTAMP`,
            [nowPayload, ...ids]
        );

        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }

    const afterCandidates = await getCandidatePlayers(db);
    return {
        ok: true,
        applied: true,
        cleaned: ids.length,
        summaryBefore,
        summaryAfter: summarizeCandidates(afterCandidates),
    };
}

module.exports = {
    applyReopeningCleanup,
    getReopeningCleanupStatus,
    summarizeCandidates,
};
