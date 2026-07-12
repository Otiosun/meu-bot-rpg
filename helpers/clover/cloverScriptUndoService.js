const crypto = require('crypto');

const { isOwner } = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const { formatMention, playerDisplayName } = require('./commandTargetUtils');
const {
    ensureCloverScriptSchema,
} = require('./cloverScriptService');
const {
    applyLifecycleUndo,
    previewLifecycleUndo,
} = require('./playerLifecycleUndoService');
const {
    captureArchiveSnapshotForPlayer,
    syncArchiveCardAsDeleted,
    syncArchiveCardForPlayer,
} = require('./archiveManager');
const {
    removeSpellReviewParticipant,
    rotateSpellReviewInviteLink,
    sendSpellReviewInviteToPlayer,
} = require('./groupManager');
const { syncSquadGroupDescription } = require('./squadService');

class CloverScriptUndoError extends Error {
    constructor(message, line = null, code = 'invalid_undo_script', details = null) {
        super(message);
        this.name = 'CloverScriptUndoError';
        this.line = line;
        this.code = code;
        this.details = details || null;
    }
}

function normalizeWord(value) {
    return normalizeText(String(value || ''))
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function stripQuotes(value) {
    const text = String(value || '').trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
    return text;
}

function parseKv(line) {
    const kv = {};
    const regex = /([A-Za-zÀ-ÿ0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    while ((match = regex.exec(String(line || '')))) {
        kv[normalizeWord(match[1])] = stripQuotes(match[2]);
    }
    return kv;
}

function hasTrue(value) {
    return ['true', 'sim', 'yes', '1', 'confirmar'].includes(normalizeWord(value));
}

function meaningfulLines(scriptText) {
    return String(scriptText || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((raw, index) => ({ raw, text: raw.trim(), line: index + 1 }))
        .filter((item) => item.text && !item.text.startsWith('//'));
}

function generateSimulationCode() {
    return `CSU-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function serialize(value) {
    return JSON.stringify(value ?? null);
}

function safeJsonParse(value, fallback = null) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function looksLikeUndoScript(scriptText) {
    return meaningfulLines(scriptText).some((line) => /^(DESFAZER|UNDO|REVERTER)\b/i.test(line.text));
}

function parseUndoScript(scriptText) {
    const lines = meaningfulLines(scriptText);
    if (!lines.length) throw new CloverScriptUndoError('Script vazio.');

    let index = 0;
    let header = { id: null, name: null, mode: 'rigido', confirm: false };
    if (/^LOTE\b/i.test(lines[index].text)) {
        const kv = parseKv(lines[index].text);
        const mode = normalizeWord(kv.modo || kv.mode || 'rigido') || 'rigido';
        if (mode !== 'rigido') {
            throw new CloverScriptUndoError('DESFAZER aceita apenas modo=rigido.', lines[index].line, 'invalid_mode');
        }
        header = {
            id: kv.id || null,
            name: kv.nome || kv.name || null,
            mode,
            confirm: hasTrue(kv.confirmar || kv.confirm),
        };
        index += 1;
    }

    const actionLine = lines[index];
    if (!actionLine || !/^(DESFAZER|UNDO|REVERTER)\b/i.test(actionLine.text)) {
        throw new CloverScriptUndoError('Esperava DESFAZER codigo=... motivo="..." confirmar=true.', actionLine?.line || null);
    }
    const kv = parseKv(actionLine.text);
    const sourceCode = String(kv.codigo || kv.code || kv.evento || kv.event || '').trim().toUpperCase();
    const reason = String(kv.motivo || kv.reason || '').trim();
    const confirm = hasTrue(kv.confirmar || kv.confirm) || header.confirm;

    if (!sourceCode) {
        throw new CloverScriptUndoError('DESFAZER precisa de codigo=CSL-..., codigo=LC-... ou codigo=JOB-....', actionLine.line, 'missing_source_code');
    }
    if (reason.length < 3) {
        throw new CloverScriptUndoError('DESFAZER precisa de motivo="...".', actionLine.line, 'missing_reason');
    }
    if (!confirm) {
        throw new CloverScriptUndoError('DESFAZER é protegido e precisa de confirmar=true.', actionLine.line, 'missing_confirm');
    }

    index += 1;
    if (lines[index] && normalizeWord(lines[index].text) === 'fim') index += 1;
    if (index < lines.length) {
        throw new CloverScriptUndoError('DESFAZER aceita apenas uma ação por simulação.', lines[index].line, 'multiple_undo_actions');
    }

    return {
        kind: 'lifecycle_undo',
        header,
        action: {
            type: 'lifecycle_undo',
            sourceCode,
            reason,
            confirm: true,
            dangerous: true,
            line: actionLine.line,
        },
    };
}

async function hasAppliedBatch(db, batchId) {
    if (!batchId) return null;
    return db.get(
        `SELECT id, code
         FROM clover_script_runs
         WHERE batch_id = ? AND status = 'applied'
         ORDER BY id DESC LIMIT 1`,
        [batchId]
    );
}

function playerFromPreview(preview) {
    return preview.current?.player || preview.desired?.player || { id: preview.event?.player_id };
}

function previewLines(preview) {
    return [
        `> Evento original: ${preview.event.operation_code} (${preview.event.operation_type === 'archive' ? 'arquivamento' : 'reativação'})`,
        `> Player: ${playerDisplayName(playerFromPreview(preview), preview.event.player_id)} (${formatMention(preview.event.player_id)})`,
        `> Ciclo: ${preview.changes.lifecycleStatus[0]} -> ${preview.changes.lifecycleStatus[1]}`,
        `> Jogo: ${preview.changes.gameStatus[0]} -> ${preview.changes.gameStatus[1]}`,
        `> Esquadrão: ${preview.changes.squad[0]} -> ${preview.changes.squad[1]}`,
        `> Fila ativa: ${preview.changes.queueEntries[0]} -> ${preview.changes.queueEntries[1]}`,
        `> Reservas ativas: ${preview.changes.reservations[0]} -> ${preview.changes.reservations[1]}`,
        `> Lideranças: ${preview.changes.leadership[0]} -> ${preview.changes.leadership[1]}`,
        '> O estado atual foi comparado ao snapshot posterior do evento.',
        '> PH, inventário, grimório e histórico não serão reescritos.',
        '> Dados voláteis do anti-ghost não serão restaurados.',
    ];
}

function renderUndoSimulation({ code, parsed, preview }) {
    return [
        '*♧┃SIMULAÇÃO CLOVER 𖥔 CLOVER MULTICOLOR*',
        '     ── desfazer protegido; nada foi aplicado ──',
        '',
        '_`─( ✓ )───── Resumo`_',
        '',
        `*Código:* ${code}`,
        '*Modo:* rigido',
        parsed.header.id ? `*Lote:* ${parsed.header.id}` : null,
        `*Fonte:* ${parsed.action.sourceCode}`,
        '',
        '_`─( ◆ )───── Restauração`_',
        '',
        ...previewLines(preview),
        '',
        `Use *.#clover aplicar codigo=${code}* para confirmar.`,
    ].filter(Boolean).join('\n');
}

async function createUndoSimulation(db, scriptText, options = {}) {
    if (!isOwner(options.actorId)) {
        throw new CloverScriptUndoError('DESFAZER é apenas para Owner.', null, 'permission_denied');
    }
    await ensureCloverScriptSchema(db);
    const parsed = parseUndoScript(scriptText);
    const duplicate = await hasAppliedBatch(db, parsed.header.id);
    if (duplicate && !parsed.header.confirm) {
        throw new CloverScriptUndoError(`Lote já aplicado pelo código ${duplicate.code}.`, null, 'duplicate_batch');
    }

    const preview = await previewLifecycleUndo(db, parsed.action.sourceCode);
    if (!preview.ok) {
        throw new CloverScriptUndoError(preview.error || preview.code || 'Não foi possível simular o desfazer.', parsed.action.line, preview.code, {
            conflicts: preview.conflicts || null,
            sourceCode: parsed.action.sourceCode,
        });
    }

    const code = generateSimulationCode();
    const plan = {
        kind: 'lifecycle_undo',
        header: parsed.header,
        blocks: [{
            targets: [{
                id: preview.event.player_id,
                personagem_nome: preview.current?.player?.personagem_nome || preview.desired?.player?.personagem_nome || null,
            }],
            actions: [parsed.action],
        }],
        undo: {
            sourceCode: parsed.action.sourceCode,
            lifecycleEventCode: preview.event.operation_code,
            lifecycleEventId: preview.event.id,
        },
    };

    const result = await db.run(
        `INSERT INTO clover_script_runs
         (code, batch_id, batch_name, mode, script_hash, script_text, plan_json, status,
          created_by, chat_id, created_at, metadata_json)
         VALUES (?, ?, ?, 'rigido', ?, ?, ?, 'simulated', ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            code,
            parsed.header.id,
            parsed.header.name,
            crypto.createHash('sha256').update(String(scriptText), 'utf8').digest('hex'),
            scriptText,
            serialize(plan),
            options.actorId || null,
            options.chatId || null,
            serialize({ source: 'cloverscript_lifecycle_undo', protected_action: true }),
        ]
    );

    return {
        ok: true,
        runId: result.lastID,
        code,
        plan,
        preview,
        text: renderUndoSimulation({ code, parsed, preview }),
    };
}

async function findPendingRun(db, { code = null, actorId = null, chatId = null } = {}) {
    await ensureCloverScriptSchema(db);
    if (code) {
        return db.get('SELECT * FROM clover_script_runs WHERE code = ?', [String(code).trim().toUpperCase()]);
    }
    return db.get(
        `SELECT * FROM clover_script_runs
         WHERE status = 'simulated' AND created_by = ? AND chat_id = ?
         ORDER BY id DESC LIMIT 1`,
        [actorId || null, chatId || null]
    );
}

async function shouldHandleUndoApply(db, options = {}) {
    const run = await findPendingRun(db, options);
    if (!run) return false;
    if (String(run.code || '').toUpperCase().startsWith('CSU-')) return true;
    const metadata = safeJsonParse(run.metadata_json, {});
    const plan = safeJsonParse(run.plan_json, {});
    return metadata?.source === 'cloverscript_lifecycle_undo' || plan?.kind === 'lifecycle_undo';
}

async function syncUndoSideEffects({ sock, db, preview, applied, archiveCardSnapshot }) {
    const warnings = [];
    if (!sock) return warnings;

    const restoredPlayer = applied.restored?.player || {};
    const restoredArchived = restoredPlayer.lifecycle_status === 'archived';
    const currentSquad = applied.beforeUndo?.player?.esquadrao;
    const restoredSquad = restoredPlayer.esquadrao;

    if (restoredArchived) {
        const removal = await removeSpellReviewParticipant(sock, db, applied.playerId).catch((error) => ({ ok: false, error }));
        if (!removal?.ok && removal?.reason !== 'missing_group') warnings.push('não consegui confirmar a remoção do grupo de avaliação');
        if (archiveCardSnapshot) {
            const archiveSync = await syncArchiveCardAsDeleted({ sock, db, snapshot: archiveCardSnapshot }).catch((error) => ({ ok: false, error }));
            if (!archiveSync?.ok && !archiveSync?.skipped) warnings.push('não consegui arquivar o card visual');
        }
    } else {
        const archiveSync = await syncArchiveCardForPlayer({ sock, db, playerId: applied.playerId }).catch((error) => ({ ok: false, error }));
        if (!archiveSync?.ok && !archiveSync?.skipped) warnings.push('não consegui restaurar o card visual');
        const called = (applied.restored?.queueEntries || []).some((entry) => entry.status === 'called');
        if (called) {
            const invite = await sendSpellReviewInviteToPlayer(sock, db, applied.playerId, {
                rotate: true,
                queueFallback: false,
            }).catch((error) => ({ ok: false, error }));
            if (!invite?.ok) warnings.push('a entrada chamada foi restaurada, mas o convite não foi confirmado');
        }
    }

    if ((applied.beforeUndo?.queueEntries || []).some((entry) => entry.status === 'called')
        && !(applied.restored?.queueEntries || []).some((entry) => entry.status === 'called')) {
        await rotateSpellReviewInviteLink(sock, db).catch(() => {
            warnings.push('não consegui redefinir o link do grupo de avaliação');
        });
    }

    for (const squad of [...new Set([currentSquad, restoredSquad].filter((value) => value && value !== '-'))]) {
        await syncSquadGroupDescription({ sock, db, squadKey: squad }).catch(() => {
            warnings.push(`não consegui sincronizar a descrição do esquadrão ${squad}`);
        });
    }
    return warnings;
}

function renderUndoApplyResult({ run, applied, warnings }) {
    const player = applied.restored?.player || applied.beforeUndo?.player || { id: applied.playerId };
    return [
        '*♧┃CLOVERSCRIPT APLICADO 𖥔 CLOVER MULTICOLOR*',
        '     ── evento de ciclo desfeito com snapshot ──',
        '',
        '_`─( ✓ )───── Resultado`_',
        '',
        `*Código:* ${run.code}`,
        `*Desfazer:* ${applied.code}`,
        `*Evento original:* ${applied.event.operation_code}`,
        `*Player:* ${playerDisplayName(player, applied.playerId)} (${formatMention(applied.playerId)})`,
        `*Ciclo restaurado:* ${player.lifecycle_status || 'active'}`,
        `*Jogo restaurado:* ${player.jogo_status || '-'}`,
        `*Esquadrão restaurado:* ${player.esquadrao || '-'}`,
        `*Fila restaurada:* ${applied.result.queue.restored}`,
        `*Reservas restauradas:* ${applied.result.reservations.restored}`,
        `*Lideranças restauradas:* ${applied.result.leadership.restored}`,
        '',
        '> PH, inventário, grimório e histórico não foram alterados.',
        warnings.length ? '' : null,
        warnings.length ? '_`─( ! )───── Avisos externos`_' : null,
        warnings.length ? '' : null,
        ...warnings.map((warning) => `> ${warning}`),
    ].filter(Boolean).join('\n');
}

async function applyUndoSimulation(db, { code = null, actorId, chatId, sock = null } = {}) {
    if (!isOwner(actorId)) {
        throw new CloverScriptUndoError('DESFAZER é apenas para Owner.', null, 'permission_denied');
    }
    const run = await findPendingRun(db, { code, actorId, chatId });
    if (!run) throw new CloverScriptUndoError('Não encontrei simulação de desfazer pendente.', null, 'missing_simulation');
    if (run.status !== 'simulated') {
        throw new CloverScriptUndoError('Essa simulação não está pendente.', null, 'invalid_status');
    }

    const plan = safeJsonParse(run.plan_json, null);
    if (!plan || plan.kind !== 'lifecycle_undo') {
        throw new CloverScriptUndoError('Plano de desfazer inválido.', null, 'invalid_plan');
    }
    const action = plan.blocks?.[0]?.actions?.[0];
    const target = plan.blocks?.[0]?.targets?.[0];
    if (!action?.sourceCode || !target?.id) {
        throw new CloverScriptUndoError('Plano de desfazer incompleto.', null, 'invalid_plan');
    }

    const freshPreview = await previewLifecycleUndo(db, action.sourceCode);
    if (!freshPreview.ok) {
        throw new CloverScriptUndoError(freshPreview.error || freshPreview.code, action.line, freshPreview.code, {
            conflicts: freshPreview.conflicts || null,
            sourceCode: action.sourceCode,
        });
    }
    const willRestoreArchived = freshPreview.desired?.player?.lifecycle_status === 'archived';
    const archiveCardSnapshot = willRestoreArchived
        ? await captureArchiveSnapshotForPlayer(db, target.id).catch(() => null)
        : null;

    try {
        const applied = await applyLifecycleUndo(db, {
            sourceCode: action.sourceCode,
            reason: action.reason,
            actorId,
        });
        if (!applied.ok) {
            throw new CloverScriptUndoError(applied.error || applied.code || 'Desfazer recusado.', action.line, applied.code);
        }
        const warnings = await syncUndoSideEffects({
            sock,
            db,
            preview: freshPreview,
            applied,
            archiveCardSnapshot,
        });
        const summary = `${playerDisplayName(applied.restored?.player, applied.playerId)}: desfeito ${applied.event.operation_code} (${applied.code})`;

        await db.run(
            `INSERT INTO clover_script_actions
             (run_id, player_id, action_type, summary, status, before_json, after_json, created_at)
             VALUES (?, ?, 'lifecycle_undo', ?, 'applied', ?, ?, CURRENT_TIMESTAMP)`,
            [
                run.id,
                applied.playerId,
                summary,
                serialize(applied.beforeUndo),
                serialize({
                    ...applied.restored,
                    undoCode: applied.code,
                    sourceLifecycleCode: applied.event.operation_code,
                    undoResult: applied.result,
                    warnings,
                }),
            ]
        );
        await db.run(
            `UPDATE clover_script_runs
             SET status = 'applied', applied_by = ?, applied_at = CURRENT_TIMESTAMP, error = NULL
             WHERE id = ?`,
            [actorId || null, run.id]
        );

        return {
            ok: true,
            run,
            plan,
            applied,
            warnings,
            text: renderUndoApplyResult({ run, applied, warnings }),
        };
    } catch (error) {
        const message = error?.message || String(error);
        await db.run(
            `INSERT INTO clover_script_actions
             (run_id, player_id, action_type, summary, status, error, created_at)
             VALUES (?, ?, 'lifecycle_undo', ?, 'failed', ?, CURRENT_TIMESTAMP)`,
            [run.id, target.id, `DESFAZER ${action.sourceCode}`, message]
        ).catch(() => null);
        await db.run(
            `UPDATE clover_script_runs
             SET status = 'failed', applied_by = ?, applied_at = CURRENT_TIMESTAMP, error = ?
             WHERE id = ?`,
            [actorId || null, message, run.id]
        ).catch(() => null);
        throw error;
    }
}

module.exports = {
    CloverScriptUndoError,
    applyUndoSimulation,
    createUndoSimulation,
    isUndoSimulationCode: (code) => String(code || '').trim().toUpperCase().startsWith('CSU-'),
    looksLikeUndoScript,
    parseUndoScript,
    shouldHandleUndoApply,
};
