'use strict';

const { assertDreamSlotPlayerPolicy } = require('./dreamWorldsSlotPolicyService');

const REQUIRED_TABLES = Object.freeze([
    'clover_dream_worlds',
    'clover_dream_requests',
    'clover_dream_runs',
    'clover_dream_slots',
    'clover_resonance_fragments',
    'clover_resonance_fragment_versions',
    'clover_dream_audit',
]);

function issue(severity, code, message, details = {}) {
    return { severity, code, message, details };
}

async function tableExists(db, table) {
    const row = await db.get(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [table]
    );
    return Boolean(row);
}

async function auditDreamWorldsV1(db, options = {}) {
    const issues = [];
    const tables = {};
    for (const table of REQUIRED_TABLES) {
        tables[table] = await tableExists(db, table);
        if (!tables[table]) {
            issues.push(issue('critical', 'missing_table', `Tabela obrigatória ausente: ${table}.`, { table }));
        }
    }

    const installed = REQUIRED_TABLES.every((table) => tables[table]);
    if (!installed) {
        return {
            version: 'dream-worlds-audit.v1',
            databaseLabel: options.databaseLabel || null,
            generatedAt: new Date().toISOString(),
            installed: false,
            tables,
            summary: summarize(issues, {}),
            counts: {},
            issues,
        };
    }

    const counts = {};
    for (const [key, table] of Object.entries({
        worlds: 'clover_dream_worlds',
        requests: 'clover_dream_requests',
        runs: 'clover_dream_runs',
        slots: 'clover_dream_slots',
        fragments: 'clover_resonance_fragments',
        fragmentVersions: 'clover_resonance_fragment_versions',
        auditEvents: 'clover_dream_audit',
    })) {
        counts[key] = Number((await db.get(`SELECT COUNT(*) AS total FROM ${table}`))?.total || 0);
    }

    const invalidWorlds = await db.all(
        `SELECT id, world_key, name, min_players, max_players,
                squad_slots, invited_slots, public_slots,
                yulls_price, manual_payment_enabled, manual_price_label
         FROM clover_dream_worlds
         WHERE min_players > max_players
            OR squad_slots + invited_slots + public_slots != max_players
            OR yulls_price <= 0
            OR manual_payment_enabled != 1
            OR manual_price_label IS NULL
            OR trim(manual_price_label) = ''`
    );
    for (const world of invalidWorlds) {
        issues.push(issue('critical', 'invalid_world_contract', 'Fenda viola o contrato estrutural.', world));
    }

    const duplicatedRequests = await db.all(
        `SELECT world_id, requester_player_id, COUNT(*) AS total
         FROM clover_dream_requests
         WHERE status IN ('submitted', 'under_review', 'awaiting_confirmation', 'approved')
         GROUP BY world_id, requester_player_id
         HAVING COUNT(*) > 1`
    );
    for (const row of duplicatedRequests) {
        issues.push(issue('critical', 'duplicate_active_request', 'Jogador possui solicitações ativas duplicadas na mesma Fenda.', row));
    }

    const approvedWithoutRun = await db.all(
        `SELECT request.id, request.request_key, request.world_id, request.requester_player_id
         FROM clover_dream_requests request
         LEFT JOIN clover_dream_runs run ON run.request_id = request.id
         WHERE request.status = 'approved' AND run.id IS NULL`
    );
    for (const row of approvedWithoutRun) {
        issues.push(issue('critical', 'approved_request_without_run', 'Solicitação aprovada não possui incursão.', row));
    }

    const wrongSlotCounts = await db.all(
        `SELECT run.id, run.run_key, world.max_players,
                SUM(CASE WHEN slot.status IN ('open', 'invited', 'confirmed') THEN 1 ELSE 0 END) AS slot_total
         FROM clover_dream_runs run
         JOIN clover_dream_worlds world ON world.id = run.world_id
         LEFT JOIN clover_dream_slots slot ON slot.run_id = run.id
         GROUP BY run.id
         HAVING slot_total != world.max_players`
    );
    for (const row of wrongSlotCounts) {
        issues.push(issue('critical', 'run_slot_count_mismatch', 'Quantidade de vagas difere do máximo da Fenda.', row));
    }

    const duplicatedPlayers = await db.all(
        `SELECT run_id, player_id, COUNT(*) AS total
         FROM clover_dream_slots
         WHERE player_id IS NOT NULL AND status IN ('invited', 'confirmed')
         GROUP BY run_id, player_id
         HAVING COUNT(*) > 1`
    );
    for (const row of duplicatedPlayers) {
        issues.push(issue('critical', 'duplicate_active_player_slot', 'Personagem ocupa mais de uma vaga ativa na incursão.', row));
    }

    const underMinimum = await db.all(
        `SELECT run.id, run.run_key, run.status, world.min_players,
                SUM(CASE WHEN slot.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed
         FROM clover_dream_runs run
         JOIN clover_dream_worlds world ON world.id = run.world_id
         LEFT JOIN clover_dream_slots slot ON slot.run_id = run.id
         WHERE run.status IN ('ready', 'running', 'paused')
         GROUP BY run.id
         HAVING confirmed < world.min_players`
    );
    for (const row of underMinimum) {
        issues.push(issue('critical', 'active_run_under_minimum', 'Incursão ativa ou pronta está abaixo do mínimo confirmado.', row));
    }

    const activeSquadSlots = await db.all(
        `SELECT slot.id, slot.run_id, slot.player_id
         FROM clover_dream_slots slot
         WHERE slot.category = 'squad'
           AND slot.player_id IS NOT NULL
           AND slot.status IN ('invited', 'confirmed')`
    );
    for (const row of activeSquadSlots) {
        try {
            await assertDreamSlotPlayerPolicy(db, row.run_id, row.id, row.player_id);
        } catch (error) {
            issues.push(issue(
                error?.code === 'squad_slot_forbidden' ? 'critical' : 'warning',
                error?.code || 'squad_slot_policy_check_failed',
                error?.message || 'Não foi possível validar uma vaga de esquadrão.',
                { ...row, ...(error?.details || {}) }
            ));
        }
    }

    const orphanFragments = await db.all(
        `SELECT fragment.id, fragment.fragment_key, fragment.owner_player_id
         FROM clover_resonance_fragments fragment
         LEFT JOIN jogadores player ON player.id = fragment.owner_player_id
         WHERE fragment.owner_player_id IS NOT NULL AND player.id IS NULL`
    );
    for (const row of orphanFragments) {
        issues.push(issue('critical', 'fragment_owner_missing', 'Fragmento aponta para portador inexistente.', row));
    }

    const versionMismatches = await db.all(
        `SELECT fragment.id, fragment.fragment_key, fragment.version,
                COALESCE(MAX(version.version), 0) AS latest_snapshot
         FROM clover_resonance_fragments fragment
         LEFT JOIN clover_resonance_fragment_versions version ON version.fragment_id = fragment.id
         GROUP BY fragment.id
         HAVING latest_snapshot != fragment.version`
    );
    for (const row of versionMismatches) {
        issues.push(issue('warning', 'fragment_version_mismatch', 'Versão atual do Fragmento não possui snapshot equivalente.', row));
    }

    if (await tableExists(db, 'clover_yulls_ledger')) {
        const ledgerMismatches = await db.all(
            `SELECT request.id, request.request_key, request.yulls_ledger_id
             FROM clover_dream_requests request
             LEFT JOIN clover_yulls_ledger ledger ON ledger.id = request.yulls_ledger_id
             WHERE request.status = 'approved'
               AND request.payment_method = 'yulls'
               AND (request.yulls_ledger_id IS NULL OR ledger.id IS NULL)`
        );
        for (const row of ledgerMismatches) {
            issues.push(issue('critical', 'approved_yulls_without_ledger', 'Aquisição aprovada por Yuls não possui lançamento financeiro válido.', row));
        }
    } else {
        issues.push(issue('warning', 'yulls_ledger_unavailable', 'Tabela de extrato de Yuls não foi encontrada para conferência.'));
    }

    const statusMismatches = await db.all(
        `SELECT world.id, world.world_key, world.status,
                SUM(CASE WHEN run.status IN ('forming_group', 'ready', 'running', 'paused') THEN 1 ELSE 0 END) AS active_runs
         FROM clover_dream_worlds world
         LEFT JOIN clover_dream_runs run ON run.world_id = world.id
         GROUP BY world.id
         HAVING (world.status IN ('reserved', 'forming_group', 'running') AND active_runs = 0)
             OR (world.status IN ('announced', 'available') AND active_runs > 0)`
    );
    for (const row of statusMismatches) {
        issues.push(issue('warning', 'world_run_status_mismatch', 'Estado público da Fenda diverge das incursões vinculadas.', row));
    }

    return {
        version: 'dream-worlds-audit.v1',
        databaseLabel: options.databaseLabel || null,
        generatedAt: new Date().toISOString(),
        installed: true,
        tables,
        summary: summarize(issues, counts),
        counts,
        issues,
    };
}

function summarize(issues, counts) {
    const bySeverity = {};
    for (const item of issues) bySeverity[item.severity] = (bySeverity[item.severity] || 0) + 1;
    return {
        healthy: issues.every((item) => item.severity !== 'critical'),
        issueCount: issues.length,
        bySeverity,
        counts,
    };
}

module.exports = {
    REQUIRED_TABLES,
    auditDreamWorldsV1,
    tableExists,
};
