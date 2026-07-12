const crypto = require('crypto');

const { isOwner, normalizeJid } = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const {
    formatMention,
    playerDisplayName,
    resolveTargetPlayer,
} = require('./commandTargetUtils');
const { ensureCloverScriptSchema } = require('./cloverScriptService');
const {
    captureArchiveSnapshotForPlayer,
    syncArchiveCardAsDeleted,
    syncArchiveCardForPlayer,
} = require('./archiveManager');
const {
    removeSpellReviewParticipant,
} = require('./groupManager');
const { syncSquadGroupDescription } = require('./squadService');
const {
    ensurePlayerResetSchema,
    generateResetCode,
    generateRestoreCode,
    previewResetPlayer,
    previewRestoreReset,
    resetPlayer,
    restorePlayerReset,
} = require('./playerResetService');

class CloverScriptResetError extends Error {
    constructor(message, line = null, code = 'invalid_reset_script', details = null) {
        super(message);
        this.name = 'CloverScriptResetError';
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

function tokenize(line) {
    return [...String(line || '').matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g)]
        .map((match) => stripQuotes(match[0]));
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

function truthy(value) {
    return ['true', 'sim', 'yes', '1', 'confirmar'].includes(normalizeWord(value));
}

function meaningfulLines(scriptText) {
    return String(scriptText || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((raw, index) => ({ raw, text: raw.trim(), line: index + 1 }))
        .filter((item) => item.text && !item.text.startsWith('//'));
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

function generateSimulationCode(kind) {
    const prefix = kind === 'restore' ? 'CSRR' : 'CSR';
    return `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function looksLikeResetScript(scriptText) {
    return meaningfulLines(scriptText).some((line) => (
        /^(PLAYER|JOGADOR)\s+(resetar|reset)\b/i.test(line.text)
        || /^(DESFAZER_RESET|RESTAURAR_RESET|UNDO_RESET)\b/i.test(line.text)
    ));
}

function parseHeader(line) {
    const kv = parseKv(line.text);
    const mode = normalizeWord(kv.modo || kv.mode || 'rigido') || 'rigido';
    if (mode !== 'rigido') {
        throw new CloverScriptResetError('Reset aceita apenas modo=rigido.', line.line, 'invalid_mode');
    }
    return {
        id: kv.id || null,
        name: kv.nome || kv.name || null,
        mode,
        confirm: truthy(kv.confirmar || kv.confirm),
    };
}

function parseTarget(line, options = {}) {
    const kv = parseKv(line.text);
    const tokens = tokenize(line.text);
    const name = kv.nome || kv.personagem || kv.character || null;
    const identifier = kv.id || kv.jid || kv.tel || kv.telefone || kv.phone || null;
    const mentionToken = tokens.find((token) => token.startsWith('@'));
    const responseToken = tokens.some((token) => normalizeWord(token) === 'resposta');
    const targetId = mentionToken ? options.mentions?.[0] : responseToken ? options.quotedParticipant : identifier;
    const loose = tokens.slice(1).filter((token) => !token.includes('=') && !token.startsWith('@') && normalizeWord(token) !== 'resposta').join(' ');
    const targetText = name || (!targetId ? loose : '');
    if (!targetId && !targetText) {
        throw new CloverScriptResetError('ALVO sem identificação.', line.line, 'missing_target');
    }
    return { targetId: targetId ? normalizeJid(targetId) : null, targetText, line: line.line, raw: line.text };
}

function parseResetAction(line, header) {
    const tokens = tokenize(line.text);
    const command = normalizeWord(tokens[0]);
    const operation = normalizeWord(tokens[1]);
    if (!['player', 'jogador'].includes(command) || !['resetar', 'reset'].includes(operation)) {
        throw new CloverScriptResetError('Ação esperada: PLAYER resetar.', line.line, 'invalid_reset_action');
    }
    const kv = parseKv(line.text);
    const scope = normalizeWord(kv.escopo || kv.scope || 'personagem');
    if (!['personagem', 'character'].includes(scope)) {
        throw new CloverScriptResetError('Nesta versão, PLAYER resetar aceita apenas escopo=personagem.', line.line, 'invalid_reset_scope');
    }
    if (!truthy(kv.preservar_identidade || kv.preserve_identity)) {
        throw new CloverScriptResetError(
            'Reset seguro precisa de preservar_identidade=true.',
            line.line,
            'identity_preservation_required'
        );
    }
    const reason = String(kv.motivo || kv.reason || '').trim();
    if (reason.length < 3) {
        throw new CloverScriptResetError('PLAYER resetar precisa de motivo="...".', line.line, 'missing_reason');
    }
    if (!(truthy(kv.confirmar || kv.confirm) || header.confirm)) {
        throw new CloverScriptResetError('PLAYER resetar precisa de confirmar=true.', line.line, 'missing_confirm');
    }
    return {
        type: 'player_reset',
        op: 'reset',
        scope: 'character',
        preserveIdentity: true,
        reason,
        dangerous: true,
        line: line.line,
    };
}

function parseRestoreAction(line, header) {
    const kv = parseKv(line.text);
    const sourceCode = String(kv.codigo || kv.code || '').trim().toUpperCase();
    if (!sourceCode.startsWith('RS-')) {
        throw new CloverScriptResetError('DESFAZER_RESET precisa de codigo=RS-....', line.line, 'missing_reset_code');
    }
    const reason = String(kv.motivo || kv.reason || '').trim();
    if (reason.length < 3) {
        throw new CloverScriptResetError('DESFAZER_RESET precisa de motivo="...".', line.line, 'missing_reason');
    }
    if (!(truthy(kv.confirmar || kv.confirm) || header.confirm)) {
        throw new CloverScriptResetError('DESFAZER_RESET precisa de confirmar=true.', line.line, 'missing_confirm');
    }
    return {
        type: 'player_reset_restore',
        op: 'restore',
        sourceCode,
        reason,
        dangerous: true,
        line: line.line,
    };
}

function parseResetScript(scriptText, options = {}) {
    const lines = meaningfulLines(scriptText);
    if (!lines.length) throw new CloverScriptResetError('Script vazio.');

    let index = 0;
    let header = { id: null, name: null, mode: 'rigido', confirm: false };
    if (/^LOTE\b/i.test(lines[index].text)) {
        header = { ...header, ...parseHeader(lines[index]) };
        index += 1;
    }

    const current = lines[index];
    if (!current) throw new CloverScriptResetError('Script sem ação.');
    if (/^(DESFAZER_RESET|RESTAURAR_RESET|UNDO_RESET)\b/i.test(current.text)) {
        const action = parseRestoreAction(current, header);
        index += 1;
        if (!lines[index] || normalizeWord(lines[index].text) !== 'fim') {
            throw new CloverScriptResetError('DESFAZER_RESET precisa terminar com FIM.', current.line, 'missing_fim');
        }
        index += 1;
        if (index < lines.length) {
            throw new CloverScriptResetError('DESFAZER_RESET aceita apenas uma ação por simulação.', lines[index].line, 'single_action_required');
        }
        return { kind: 'player_reset_restore', header, action };
    }

    if (!/^ALVO\b/i.test(current.text)) {
        throw new CloverScriptResetError('PLAYER resetar exige exatamente um bloco ALVO.', current.line, 'missing_target_block');
    }
    const target = parseTarget(current, options);
    index += 1;
    const actionLine = lines[index];
    if (!actionLine) throw new CloverScriptResetError('Bloco sem PLAYER resetar.', current.line, 'empty_block');
    const action = parseResetAction(actionLine, header);
    index += 1;
    if (!lines[index] || normalizeWord(lines[index].text) !== 'fim') {
        throw new CloverScriptResetError('Bloco sem FIM.', actionLine.line, 'missing_fim');
    }
    index += 1;
    if (index < lines.length) {
        throw new CloverScriptResetError('PLAYER resetar aceita apenas um player por simulação.', lines[index].line, 'single_target_required');
    }
    return { kind: 'player_reset', header, target, action };
}

async function resolveTarget(db, parsed) {
    const resolved = await resolveTargetPlayer(
        db,
        parsed.target.targetId,
        parsed.target.targetText,
        { mechanical: true }
    );
    if (!resolved.ok) {
        throw new CloverScriptResetError(
            resolved.error || 'Player não encontrado.',
            parsed.target.line,
            'target_not_found',
            resolved.details
        );
    }
    if (Number(resolved.player.is_shadow || 0) === 1) {
        throw new CloverScriptResetError('Cadastro sombra não pode ser resetado.', parsed.target.line, 'shadow_target');
    }
    return resolved.player;
}

function renderTableCounts(tables = {}) {
    const labels = {
        clover_ph_ledger: 'lançamentos de PH',
        clover_inventory_items: 'itens',
        player_rolls: 'rolls',
        player_skill_trees: 'árvores',
        clover_spellbook_spells: 'feitiços',
        clover_quick_evaluations: 'avaliações',
        clover_character_bonuses: 'bônus',
    };
    return Object.entries(tables)
        .filter(([, total]) => Number(total) > 0)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
        .slice(0, 8)
        .map(([table, total]) => `> ${labels[table] || table}: ${total}`);
}

function renderResetSimulation({ code, parsed, player, preview, operationCode }) {
    return [
        '*♧┃SIMULAÇÃO CLOVER 𖥔 CLOVER MULTICOLOR*',
        '     ── reset seguro; nada foi aplicado ──',
        '',
        '_`─( ! )───── Operação protegida`_',
        '',
        `*Código:* ${code}`,
        `*Reset reservado:* ${operationCode}`,
        parsed.header.id ? `*Lote:* ${parsed.header.id}` : null,
        `*Player:* ${playerDisplayName(player, player.id)} (${formatMention(player.id)})`,
        '*Escopo:* personagem',
        `*Motivo:* ${parsed.action.reason}`,
        '',
        '_`─( ◆ )───── Será limpo`_',
        '',
        `*Registros de progressão:* ${preview.counts.deletedRows}`,
        `*Fila encerrada:* ${preview.counts.queueEntriesClosed}`,
        `*Reservas liberadas:* ${preview.counts.reservationsReleased}`,
        `*Cargos liberados:* ${preview.counts.leadershipRolesCleared}`,
        ...renderTableCounts(preview.counts.tables),
        '',
        '_`─( ✓ )───── Será preservado`_',
        '',
        '> player_id canônico, nome pessoal e aliases;',
        '> histórico administrativo e auditoria;',
        '> presença nos grupos do RPG;',
        '> snapshot integral para recuperação controlada.',
        '',
        '> A ficha, PH, inventário, rolls, árvores, feitiços, reservas e progresso do personagem serão zerados.',
        `> Depois de aplicado, a recuperação usa o código *${operationCode}* e só funciona antes de novos dados serem criados.`,
        '',
        `Use *.#clover aplicar codigo=${code}* para confirmar.`,
    ].filter(Boolean).join('\n');
}

function renderRestoreSimulation({ code, parsed, preview, operationCode }) {
    const player = preview.desired.player;
    return [
        '*♧┃SIMULAÇÃO CLOVER 𖥔 CLOVER MULTICOLOR*',
        '     ── recuperação de reset; nada foi aplicado ──',
        '',
        '_`─( ✓ )───── Recuperação disponível`_',
        '',
        `*Código:* ${code}`,
        `*Restauração reservada:* ${operationCode}`,
        `*Reset original:* ${preview.event.operation_code}`,
        `*Player:* ${playerDisplayName(player, player.id)} (${formatMention(player.id)})`,
        `*Motivo:* ${parsed.action.reason}`,
        '',
        `*Registros restaurados:* ${preview.counts.deletedRows}`,
        `*Fila:* ${preview.counts.queueEntriesClosed}`,
        `*Reservas:* ${preview.counts.reservationsReleased}`,
        `*Cargos:* ${preview.counts.leadershipRolesCleared}`,
        ...renderTableCounts(preview.counts.tables),
        '',
        '> O estado atual ainda corresponde exatamente ao estado deixado pelo reset.',
        '> Nenhum dado novo de personagem foi detectado.',
        '> Atividade anti-ghost posterior ao reset será preservada.',
        '',
        `Use *.#clover aplicar codigo=${code}* para confirmar.`,
    ].filter(Boolean).join('\n');
}

async function hasAppliedBatch(db, batchId) {
    if (!batchId) return null;
    return db.get(
        `SELECT id, code FROM clover_script_runs
         WHERE batch_id = ? AND status = 'applied'
         ORDER BY id DESC LIMIT 1`,
        [batchId]
    );
}

async function createResetSimulation(db, scriptText, options = {}) {
    if (!isOwner(options.actorId)) {
        throw new CloverScriptResetError('PLAYER resetar e DESFAZER_RESET são apenas para Owner.', null, 'permission_denied');
    }
    await ensurePlayerResetSchema(db);
    const parsed = parseResetScript(scriptText, options);
    const duplicate = await hasAppliedBatch(db, parsed.header.id);
    if (duplicate) {
        throw new CloverScriptResetError(`Lote já aplicado pelo código ${duplicate.code}.`, null, 'duplicate_batch');
    }

    let code = null;
    let operationCode = null;
    let plan = null;
    let text = null;

    if (parsed.kind === 'player_reset') {
        const player = await resolveTarget(db, parsed);
        const preview = await previewResetPlayer(db, player.id);
        if (!preview.ok) throw new CloverScriptResetError(preview.error, parsed.action.line, preview.code, preview);
        code = generateSimulationCode('reset');
        operationCode = generateResetCode();
        plan = {
            kind: 'player_reset',
            header: parsed.header,
            resetOperationCode: operationCode,
            blocks: [{ targets: [player], actions: [parsed.action] }],
            preview,
        };
        text = renderResetSimulation({ code, parsed, player, preview, operationCode });
    } else {
        const preview = await previewRestoreReset(db, parsed.action.sourceCode);
        if (!preview.ok) throw new CloverScriptResetError(preview.error, parsed.action.line, preview.code, preview);
        code = generateSimulationCode('restore');
        operationCode = generateRestoreCode();
        plan = {
            kind: 'player_reset_restore',
            header: parsed.header,
            restoreOperationCode: operationCode,
            blocks: [{ targets: [preview.desired.player], actions: [parsed.action] }],
            preview: {
                sourceCode: preview.event.operation_code,
                counts: preview.counts,
            },
        };
        text = renderRestoreSimulation({ code, parsed, preview, operationCode });
    }

    const insert = await db.run(
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
            serialize({ source: 'cloverscript_safe_reset', protected_action: true, operationCode }),
        ]
    );

    return { ok: true, runId: insert.lastID, code, operationCode, plan, text };
}

async function findRun(db, { code = null, actorId = null, chatId = null } = {}) {
    await ensureCloverScriptSchema(db);
    if (code) return db.get('SELECT * FROM clover_script_runs WHERE code = ?', [String(code).trim().toUpperCase()]);
    return db.get(
        `SELECT * FROM clover_script_runs
         WHERE status IN ('simulated', 'failed') AND created_by = ? AND chat_id = ?
         ORDER BY id DESC LIMIT 1`,
        [actorId || null, chatId || null]
    );
}

async function shouldHandleResetApply(db, options = {}) {
    const run = await findRun(db, options);
    if (!run) return false;
    if (/^CSR(R)?-/i.test(run.code || '')) return true;
    const plan = safeJsonParse(run.plan_json, {});
    const metadata = safeJsonParse(run.metadata_json, {});
    return ['player_reset', 'player_reset_restore'].includes(plan.kind)
        || metadata.source === 'cloverscript_safe_reset';
}

function isResetSimulationCode(code) {
    return /^CSR(R)?-/i.test(String(code || '').trim());
}

async function readExistingDomainResult(db, plan) {
    await ensurePlayerResetSchema(db);
    if (plan.kind === 'player_reset') {
        const event = await db.get(
            'SELECT * FROM clover_player_reset_events WHERE operation_code = ?',
            [plan.resetOperationCode]
        );
        if (!event) return null;
        return {
            ok: true,
            code: event.operation_code,
            playerId: event.player_id,
            before: safeJsonParse(event.before_json, null),
            after: safeJsonParse(event.after_json, null),
            result: safeJsonParse(event.result_json, {}),
            recovered: true,
        };
    }
    const restore = await db.get(
        'SELECT * FROM clover_player_reset_restores WHERE operation_code = ?',
        [plan.restoreOperationCode]
    );
    if (!restore) return null;
    return {
        ok: true,
        code: restore.operation_code,
        sourceCode: restore.source_operation_code,
        playerId: restore.player_id,
        beforeRestore: safeJsonParse(restore.before_restore_json, null),
        restored: safeJsonParse(restore.restored_json, null),
        result: safeJsonParse(restore.result_json, {}),
        recovered: true,
    };
}

async function runExternalSync({ sock, db, plan, domainResult }) {
    const warnings = [];
    if (plan.kind === 'player_reset') {
        const snapshot = await captureArchiveSnapshotForPlayer(db, domainResult.playerId).catch(() => null);
        const beforeArchiveSnapshot = domainResult.before?.player
            ? {
                playerId: domainResult.playerId,
                status: 'active',
                player: domainResult.before.player,
                roll: domainResult.before.tables?.player_rolls?.find(Boolean) || null,
                bonusSummary: null,
                phaseInfo: null,
            }
            : snapshot;
        if (beforeArchiveSnapshot) {
            await syncArchiveCardAsDeleted({ sock, db, snapshot: beforeArchiveSnapshot }).catch((error) => {
                warnings.push(`arquivo não sincronizado: ${error?.message || error}`);
            });
        }
        if (domainResult.result?.queueClosed > 0) {
            await removeSpellReviewParticipant(sock, db, domainResult.playerId).catch((error) => {
                warnings.push(`grupo de avaliação não sincronizado: ${error?.message || error}`);
            });
        }
        const previousSquad = domainResult.before?.player?.esquadrao;
        if (previousSquad && previousSquad !== '-') {
            await syncSquadGroupDescription(sock, db, previousSquad).catch((error) => {
                warnings.push(`descrição do esquadrão não sincronizada: ${error?.message || error}`);
            });
        }
    } else {
        await syncArchiveCardForPlayer({ sock, db, playerId: domainResult.playerId }).catch((error) => {
            warnings.push(`arquivo restaurado no banco, mas não sincronizado no WhatsApp: ${error?.message || error}`);
        });
        const squad = domainResult.restored?.player?.esquadrao;
        if (squad && squad !== '-') {
            await syncSquadGroupDescription(sock, db, squad).catch((error) => {
                warnings.push(`descrição do esquadrão não sincronizada: ${error?.message || error}`);
            });
        }
    }
    return warnings;
}

function renderApplied({ run, plan, domainResult, warnings }) {
    const player = plan.blocks[0].targets[0];
    const reset = plan.kind === 'player_reset';
    return [
        '*♧┃CLOVERSCRIPT APLICADO 𖥔 CLOVER MULTICOLOR*',
        reset ? '     ── reset seguro concluído ──' : '     ── recuperação de reset concluída ──',
        '',
        '_`─( ✓ )───── Resultado`_',
        '',
        `*Código:* ${run.code}`,
        `*Operação:* ${domainResult.code}`,
        !reset ? `*Reset restaurado:* ${domainResult.sourceCode}` : null,
        `*Player:* ${playerDisplayName(player, player.id)} (${formatMention(player.id)})`,
        reset ? `*Registros limpos:* ${domainResult.result?.deletedRows || 0}` : `*Registros restaurados:* ${domainResult.result?.insertedRows || 0}`,
        reset ? `*Fila encerrada:* ${domainResult.result?.queueClosed || 0}` : `*Fila restaurada:* ${domainResult.result?.queueRestored || 0}`,
        reset ? `*Reservas liberadas:* ${domainResult.result?.reservationsReleased || 0}` : `*Reservas restauradas:* ${domainResult.result?.reservationsRestored || 0}`,
        '',
        reset
            ? '> O cadastro canônico e a identidade pessoal foram preservados.'
            : '> O personagem anterior foi restaurado pelo snapshot protegido.',
        reset
            ? `> Guarde o código *${domainResult.code}* para uma possível recuperação antes de criar novos dados.`
            : '> A atividade anti-ghost posterior ao reset foi preservada.',
        warnings.length ? '' : null,
        warnings.length ? '_`─( ! )───── Sincronizações externas`_' : null,
        warnings.length ? '' : null,
        ...warnings.map((warning) => `> ${warning}`),
    ].filter(Boolean).join('\n');
}

async function applyResetSimulation(db, { code = null, actorId, chatId, sock = null } = {}) {
    if (!isOwner(actorId)) {
        throw new CloverScriptResetError('PLAYER resetar e DESFAZER_RESET são apenas para Owner.', null, 'permission_denied');
    }
    const run = await findRun(db, { code, actorId, chatId });
    if (!run) throw new CloverScriptResetError('Não encontrei simulação de reset pendente.', null, 'missing_simulation');
    const plan = safeJsonParse(run.plan_json, null);
    if (!plan || !['player_reset', 'player_reset_restore'].includes(plan.kind)) {
        throw new CloverScriptResetError('Plano de reset inválido.', null, 'invalid_plan');
    }

    const previousAction = await db.get(
        `SELECT * FROM clover_script_actions
         WHERE run_id = ? AND action_type IN ('player_reset', 'player_reset_restore') AND status = 'applied'
         ORDER BY id DESC LIMIT 1`,
        [run.id]
    );
    if (run.status === 'applied' && previousAction) {
        const after = safeJsonParse(previousAction.after_json, {});
        return {
            ok: true,
            alreadyApplied: true,
            text: `*♧┃CLOVERSCRIPT 𖥔 CLOVER MULTICOLOR*\n\n> A operação ${after.operationCode || '-'} já foi concluída.`,
        };
    }

    const player = plan.blocks?.[0]?.targets?.[0];
    const action = plan.blocks?.[0]?.actions?.[0];
    if (!player?.id || !action) throw new CloverScriptResetError('Plano de reset incompleto.', null, 'invalid_plan');

    try {
        let domainResult = await readExistingDomainResult(db, plan);
        if (!domainResult) {
            domainResult = plan.kind === 'player_reset'
                ? await resetPlayer(db, {
                    playerId: player.id,
                    reason: action.reason,
                    actorId,
                    operationCode: plan.resetOperationCode,
                })
                : await restorePlayerReset(db, {
                    sourceCode: action.sourceCode,
                    reason: action.reason,
                    actorId,
                    operationCode: plan.restoreOperationCode,
                });
        }
        if (!domainResult?.ok) {
            throw new CloverScriptResetError(
                domainResult?.error || 'A operação protegida foi recusada.',
                action.line,
                domainResult?.code || 'domain_rejected',
                domainResult
            );
        }

        const warnings = await runExternalSync({ sock, db, plan, domainResult });
        const summary = plan.kind === 'player_reset'
            ? `${playerDisplayName(player, player.id)}: personagem resetado com snapshot ${domainResult.code}`
            : `${playerDisplayName(player, player.id)}: reset ${domainResult.sourceCode} restaurado por ${domainResult.code}`;
        await db.run(
            `INSERT INTO clover_script_actions
             (run_id, player_id, action_type, summary, status, before_json, after_json, created_at)
             VALUES (?, ?, ?, ?, 'applied', ?, ?, CURRENT_TIMESTAMP)`,
            [
                run.id,
                player.id,
                plan.kind,
                summary,
                serialize(plan.kind === 'player_reset' ? domainResult.before : domainResult.beforeRestore),
                serialize({
                    operationCode: domainResult.code,
                    sourceCode: domainResult.sourceCode || null,
                    result: domainResult.result,
                    warnings,
                    recoveredAfterInterruption: Boolean(domainResult.recovered),
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
            domainResult,
            warnings,
            text: renderApplied({ run, plan, domainResult, warnings }),
        };
    } catch (error) {
        const message = error?.message || String(error);
        await db.run(
            `UPDATE clover_script_runs
             SET status = 'failed', applied_by = ?, applied_at = CURRENT_TIMESTAMP, error = ?
             WHERE id = ?`,
            [actorId || null, message, run.id]
        ).catch(() => null);
        await db.run(
            `INSERT INTO clover_script_actions
             (run_id, player_id, action_type, summary, status, error, created_at)
             VALUES (?, ?, ?, ?, 'failed', ?, CURRENT_TIMESTAMP)`,
            [run.id, player.id, plan.kind, `${plan.kind} recusado`, message]
        ).catch(() => null);
        throw error;
    }
}

module.exports = {
    CloverScriptResetError,
    applyResetSimulation,
    createResetSimulation,
    generateSimulationCode,
    isResetSimulationCode,
    looksLikeResetScript,
    parseResetScript,
    shouldHandleResetApply,
};
