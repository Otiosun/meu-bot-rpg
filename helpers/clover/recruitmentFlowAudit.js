'use strict';

function parseSqliteDate(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const normalized = text.includes('T') ? text : text.replace(' ', 'T');
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function safeJson(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [tableName]
    );
    return Boolean(row);
}

async function tableColumns(db, tableName) {
    if (!await tableExists(db, tableName)) return [];
    return db.all(`PRAGMA table_info(${tableName})`);
}

function playerName(player = {}) {
    return String(player.personagem_nome || player.nome || player.display_name || '').trim() || 'Sem nome';
}

function addIssue(issues, severity, code, message, details = {}) {
    issues.push({ severity, code, message, ...details });
}

function statusCounts(rows, field = 'status') {
    return rows.reduce((result, row) => {
        const key = String(row[field] || 'sem_status');
        result[key] = (result[key] || 0) + 1;
        return result;
    }, {});
}

async function firstEvaluationsByPlayer(db) {
    if (!await tableExists(db, 'clover_quick_evaluations')) return new Map();
    const rows = await db.all(
        `SELECT q.*
         FROM clover_quick_evaluations q
         JOIN (
             SELECT player_id, MIN(id) AS first_id
             FROM clover_quick_evaluations
             GROUP BY player_id
         ) first_q ON first_q.first_id = q.id`
    );
    return new Map(rows.map((row) => [row.player_id, row]));
}

async function referralDeliveryEvidence(db, referralId) {
    const evidence = {
        delivery: null,
        recruiterPr: null,
        recruitYulls: null,
        recruitPh: null,
        recruitItem: null,
    };

    if (await tableExists(db, 'clover_recruitment_reward_deliveries')) {
        evidence.delivery = await db.get(
            'SELECT * FROM clover_recruitment_reward_deliveries WHERE referral_id = ?',
            [referralId]
        );
    }
    if (await tableExists(db, 'clover_pr_ledger')) {
        evidence.recruiterPr = await db.get(
            'SELECT * FROM clover_pr_ledger WHERE idempotency_key = ?',
            [`pr:recruitment:referral:${referralId}`]
        );
    }
    if (await tableExists(db, 'clover_yulls_ledger')) {
        evidence.recruitYulls = await db.get(
            'SELECT * FROM clover_yulls_ledger WHERE idempotency_key = ?',
            [`yulls:recruitment:referral:${referralId}`]
        );
    }
    if (await tableExists(db, 'clover_ph_ledger')) {
        const columns = new Set((await tableColumns(db, 'clover_ph_ledger')).map((item) => item.name));
        if (columns.has('related_id')) {
            evidence.recruitPh = await db.get(
                'SELECT * FROM clover_ph_ledger WHERE related_id = ?',
                [`recruitment_referral:${referralId}`]
            );
        }
    }
    if (await tableExists(db, 'clover_inventory_items')) {
        evidence.recruitItem = await db.get(
            `SELECT * FROM clover_inventory_items
             WHERE source = 'recrutamento' AND related_id = ?
             ORDER BY id ASC LIMIT 1`,
            [`recruitment_referral:${referralId}`]
        );
    }
    return evidence;
}

async function auditRecruitmentFlow(db, options = {}) {
    const now = new Date(options.at || new Date());
    const issues = [];
    const requiredTables = [
        'jogadores',
        'clover_recruitment_events',
        'clover_recruitment_codes',
        'clover_recruitment_referrals',
        'clover_recruitment_reward_deliveries',
        'clover_pr_ledger',
    ];
    const schema = {};
    for (const table of requiredTables) schema[table] = await tableExists(db, table);

    for (const [table, exists] of Object.entries(schema)) {
        if (!exists) addIssue(issues, 'critical', 'missing_table', `Tabela obrigatória ausente: ${table}.`, { table });
    }

    const players = schema.jogadores
        ? await db.all(
            `SELECT id, personagem_nome, nome, display_name, ficha_status,
                    personagem_aparencia_status, jogo_status, jogo_liberado_at
             FROM jogadores`
        )
        : [];
    const playerMap = new Map(players.map((row) => [row.id, row]));
    const releasedPlayers = players.filter((row) => String(row.jogo_status || '').toLowerCase() === 'liberado');
    const blockedPlayers = players.filter((row) => String(row.jogo_status || '').toLowerCase() !== 'liberado');
    const unnamedPlayers = players.filter((row) => {
        const name = String(row.personagem_nome || '').trim();
        return !name || name === '-';
    });

    const events = schema.clover_recruitment_events
        ? await db.all('SELECT * FROM clover_recruitment_events ORDER BY id ASC')
        : [];
    const event = events.find((row) => row.event_key === (options.eventKey || 'divulgacao_v1')) || events[0] || null;
    if (!event && schema.clover_recruitment_events) {
        addIssue(issues, 'critical', 'event_missing', 'Nenhum Evento de Divulgação foi encontrado.');
    }

    const codes = schema.clover_recruitment_codes
        ? await db.all('SELECT * FROM clover_recruitment_codes ORDER BY id ASC')
        : [];
    for (const code of codes) {
        const owner = playerMap.get(code.player_id);
        if (!owner) {
            addIssue(issues, 'critical', 'orphan_recruitment_code', 'Código aponta para player inexistente.', {
                codeId: code.id,
                playerId: code.player_id,
            });
        } else if (Number(code.active) === 1 && String(owner.jogo_status || '').toLowerCase() !== 'liberado') {
            addIssue(issues, 'warning', 'active_code_blocked_owner', 'Código ativo pertence a personagem não liberado e não pode ser usado.', {
                codeId: code.id,
                playerId: code.player_id,
                characterName: playerName(owner),
            });
        }
    }

    const referrals = schema.clover_recruitment_referrals
        ? await db.all('SELECT * FROM clover_recruitment_referrals ORDER BY id ASC')
        : [];
    const firstEvaluations = await firstEvaluationsByPlayer(db);
    const referralDetails = [];

    for (const referral of referrals) {
        const recruit = playerMap.get(referral.recruit_player_id) || null;
        const recruiter = playerMap.get(referral.recruiter_player_id) || null;
        const firstEvaluation = firstEvaluations.get(referral.recruit_player_id) || null;
        const deadline = parseSqliteDate(referral.deadline_at);
        const releaseAt = parseSqliteDate(recruit?.jogo_liberado_at);
        const evaluationAt = parseSqliteDate(firstEvaluation?.scene_sent_at || firstEvaluation?.created_at);
        const evidence = await referralDeliveryEvidence(db, referral.id);

        if (!recruit) {
            addIssue(issues, 'critical', 'missing_recruit', 'Indicação aponta para novato inexistente.', {
                referralId: referral.id,
                playerId: referral.recruit_player_id,
            });
        }
        if (!recruiter) {
            addIssue(issues, 'critical', 'missing_recruiter', 'Indicação aponta para recrutador inexistente.', {
                referralId: referral.id,
                playerId: referral.recruiter_player_id,
            });
        }
        if (referral.recruit_player_id === referral.recruiter_player_id) {
            addIssue(issues, 'critical', 'self_referral_in_database', 'Autoindicação encontrada no banco.', {
                referralId: referral.id,
                playerId: referral.recruit_player_id,
            });
        }
        if (recruit && String(recruit.jogo_status || '').toLowerCase() !== 'liberado') {
            addIssue(issues, 'warning', 'referral_recruit_blocked', 'Indicação pertence a novato que voltou a ficar bloqueado.', {
                referralId: referral.id,
                playerId: recruit.id,
                characterName: playerName(recruit),
            });
        }
        if (['pending', 'validated'].includes(referral.status) && deadline && now > deadline) {
            addIssue(issues, 'warning', 'referral_past_deadline', 'Indicação continua pendente após o prazo registrado.', {
                referralId: referral.id,
                playerId: referral.recruit_player_id,
                deadlineAt: referral.deadline_at,
            });
        }
        if (referral.status === 'pending' && firstEvaluation) {
            const evaluationAfterRelease = !releaseAt || !evaluationAt || evaluationAt >= releaseAt;
            if (evaluationAfterRelease) {
                addIssue(issues, 'critical', 'pending_referral_with_up', 'Novato já possui UP, mas a indicação ainda está pendente.', {
                    referralId: referral.id,
                    playerId: referral.recruit_player_id,
                    evaluationId: firstEvaluation.id,
                });
            }
        }
        if (referral.status === 'rewarded') {
            if (!evidence.delivery || evidence.delivery.status !== 'completed') {
                addIssue(issues, 'critical', 'rewarded_without_completed_delivery', 'Indicação marcada como recompensada sem entrega concluída.', {
                    referralId: referral.id,
                    deliveryStatus: evidence.delivery?.status || null,
                });
            }
            if (!evidence.recruiterPr) {
                addIssue(issues, 'critical', 'rewarded_without_recruiter_pr', 'Recrutamento recompensado sem lançamento idempotente de PR.', {
                    referralId: referral.id,
                    playerId: referral.recruiter_player_id,
                });
            }
            if (Number(event?.recruit_yulls_reward || 0) > 0 && !evidence.recruitYulls) {
                addIssue(issues, 'critical', 'rewarded_without_yulls', 'Recrutamento recompensado sem Yulls do novato.', {
                    referralId: referral.id,
                    playerId: referral.recruit_player_id,
                });
            }
            if (Number(event?.recruit_ph_reward || 0) > 0 && !evidence.recruitPh) {
                addIssue(issues, 'critical', 'rewarded_without_ph', 'Recrutamento recompensado sem PH do novato.', {
                    referralId: referral.id,
                    playerId: referral.recruit_player_id,
                });
            }
            if (Number(event?.recruit_item_quantity || 0) > 0 && !evidence.recruitItem) {
                addIssue(issues, 'critical', 'rewarded_without_item', 'Recrutamento recompensado sem item do novato.', {
                    referralId: referral.id,
                    playerId: referral.recruit_player_id,
                });
            }
        }

        referralDetails.push({
            id: referral.id,
            status: referral.status,
            recruitPlayerId: referral.recruit_player_id,
            recruitName: playerName(recruit || {}),
            recruiterPlayerId: referral.recruiter_player_id,
            recruiterName: playerName(recruiter || {}),
            deadlineAt: referral.deadline_at,
            firstEvaluationId: firstEvaluation?.id || null,
            deliveryStatus: evidence.delivery?.status || null,
            hasRecruiterPr: Boolean(evidence.recruiterPr),
            hasYulls: Boolean(evidence.recruitYulls),
            hasPh: Boolean(evidence.recruitPh),
            hasItem: Boolean(evidence.recruitItem),
        });
    }

    const groupEntries = schema.clover_pr_ledger
        ? await db.all(
            `SELECT * FROM clover_pr_ledger
             WHERE source = 'divulgacao_grupo'
             ORDER BY id ASC`
        )
        : [];
    let groupEntriesWithCount = 0;
    for (const row of groupEntries) {
        const metadata = safeJson(row.metadata_json);
        if (Number.isFinite(Number(metadata?.group_count ?? metadata?.groups))) groupEntriesWithCount += 1;
    }

    const prColumns = await tableColumns(db, 'clover_pr_ledger');
    const amountColumn = prColumns.find((column) => column.name === 'amount') || null;
    const hasGroupSubmissionTable = await tableExists(db, 'clover_recruitment_group_submissions');
    const fractionalPrStoredNatively = Boolean(amountColumn)
        && /REAL|NUMERIC|DECIMAL/i.test(String(amountColumn.type || ''));

    if (!fractionalPrStoredNatively) {
        addIssue(issues, 'critical', 'fractional_pr_unsupported', 'O ledger atual não suporta 0,4 PR de forma nativa.', {
            amountColumnType: amountColumn?.type || null,
        });
    }
    if (!hasGroupSubmissionTable) {
        addIssue(issues, 'critical', 'group_count_not_persisted', 'Não existe registro próprio para salvar a quantidade real de grupos acima do teto.', {
            groupLedgerEntries: groupEntries.length,
            entriesWithCountMetadata: groupEntriesWithCount,
        });
    }

    const eventWindow = event ? {
        key: event.event_key,
        name: event.name,
        status: event.status,
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        referralWindowDays: Number(event.referral_window_days || 0),
        recruiterPrReward: Number(event.recruiter_pr_reward || 0),
        groupWeeklyPrLimit: Number(event.group_weekly_pr_limit || 0),
        shopEnabled: Boolean(event.shop_enabled),
        activeAtAudit: event.status === 'active'
            && (!parseSqliteDate(event.starts_at) || now >= parseSqliteDate(event.starts_at))
            && (!parseSqliteDate(event.ends_at) || now <= parseSqliteDate(event.ends_at)),
    } : null;

    return {
        generatedAt: now.toISOString(),
        mode: 'read_only',
        databaseLabel: options.databaseLabel || null,
        schema,
        event: eventWindow,
        summary: {
            players: players.length,
            releasedPlayers: releasedPlayers.length,
            blockedPlayers: blockedPlayers.length,
            unnamedPlayers: unnamedPlayers.length,
            codes: codes.length,
            activeCodes: codes.filter((row) => Number(row.active) === 1).length,
            referrals: referrals.length,
            referralsByStatus: statusCounts(referrals),
            groupLedgerEntries: groupEntries.length,
            groupEntriesWithCount,
            issues: issues.length,
            critical: issues.filter((item) => item.severity === 'critical').length,
            warning: issues.filter((item) => item.severity === 'warning').length,
        },
        capabilities: {
            unreleasedPlayerCanOpenDashboard: false,
            unreleasedPlayerCanSubmitReferral: false,
            draftEventStartsOnFirstDashboardOrSubmission: true,
            referralValidationTrigger: 'first_up',
            rewardDeliveryTransactional: true,
            rewardDeliveryIdempotent: true,
            shopEnabled: Boolean(event?.shop_enabled),
            fractionalPrStoredNatively,
            groupCountStoredSeparately: hasGroupSubmissionTable,
            excessGroupCountPreserved: hasGroupSubmissionTable,
        },
        players: {
            released: releasedPlayers.map((row) => ({ id: row.id, name: playerName(row), releasedAt: row.jogo_liberado_at })),
            blocked: blockedPlayers.map((row) => ({
                id: row.id,
                name: playerName(row),
                fichaStatus: row.ficha_status,
                appearanceStatus: row.personagem_aparencia_status,
                gameStatus: row.jogo_status,
            })),
        },
        referrals: referralDetails,
        issues,
    };
}

module.exports = {
    auditRecruitmentFlow,
    parseSqliteDate,
    safeJson,
    tableExists,
};
