const crypto = require('crypto');

const { isOwner, normalizeJid } = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const {
    formatMention,
    playerDisplayName,
    resolveTargetPlayer,
} = require('./commandTargetUtils');
const { getResolvedRewardListTargets } = require('./rewardListService');
const {
    archivePlayer,
    ensurePlayerLifecycleSchema,
    previewArchivePlayer,
    previewReactivatePlayer,
    reactivatePlayer,
} = require('./playerLifecycleService');
const {
    ensureCloverScriptSchema,
} = require('./cloverScriptService');
const {
    removeSpellReviewParticipant,
    rotateSpellReviewInviteLink,
} = require('./groupManager');
const {
    syncArchiveCardAsDeleted,
    syncArchiveCardForPlayer,
} = require('./archiveManager');
const { syncSquadGroupDescription } = require('./squadService');

const RUN_STATUS = {
    SIMULATED: 'simulated',
    APPLIED: 'applied',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
};

class CloverScriptLifecycleError extends Error {
    constructor(message, line = null, code = 'invalid_lifecycle_script', details = null) {
        super(message);
        this.name = 'CloverScriptLifecycleError';
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
    return `CSL-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
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

function looksLikeLifecycleScript(scriptText) {
    return meaningfulLines(scriptText).some((line) => (
        /^(PLAYER|JOGADOR|CICLO)\s+(arquivar|archive|reativar|reactivate)\b/i.test(line.text)
    ));
}

function parseHeader(line) {
    const kv = parseKv(line.text);
    const mode = normalizeWord(kv.modo || kv.mode || 'rigido') || 'rigido';
    if (mode !== 'rigido') {
        throw new CloverScriptLifecycleError('PLAYER arquivar/reativar aceita apenas modo=rigido.', line.line, 'invalid_mode');
    }
    return {
        id: kv.id || null,
        name: kv.nome || kv.name || null,
        mode,
        confirm: hasTrue(kv.confirmar || kv.confirm),
    };
}

function parseLifecycleAction(line, header) {
    const tokens = tokenize(line.text);
    const command = normalizeWord(tokens[0]);
    const opWord = normalizeWord(tokens[1]);
    const kv = parseKv(line.text);

    if (!['player', 'jogador', 'ciclo'].includes(command)) {
        throw new CloverScriptLifecycleError(`Ação desconhecida: ${tokens[0] || '-'}.`, line.line);
    }

    let op = null;
    if (['arquivar', 'archive'].includes(opWord)) op = 'archive';
    if (['reativar', 'reactivate'].includes(opWord)) op = 'reactivate';
    if (!op) {
        throw new CloverScriptLifecycleError('PLAYER aceita apenas arquivar ou reativar.', line.line);
    }

    const reason = String(kv.motivo || kv.reason || '').trim();
    if (reason.length < 3) {
        throw new CloverScriptLifecycleError('PLAYER arquivar/reativar precisa de motivo="...".', line.line, 'missing_reason');
    }

    const confirm = hasTrue(kv.confirmar || kv.confirm) || Boolean(header.confirm);
    if (!confirm) {
        throw new CloverScriptLifecycleError(
            'PLAYER arquivar/reativar é uma ação protegida e precisa de confirmar=true.',
            line.line,
            'missing_confirm'
        );
    }

    return {
        type: 'lifecycle',
        op,
        reason,
        confirm: true,
        dangerous: true,
        line: line.line,
    };
}

function parseTargetSpec(line, state) {
    const tokens = tokenize(line.text);
    const keyword = normalizeWord(tokens[0]);
    if (!['alvo', 'alvos'].includes(keyword)) {
        throw new CloverScriptLifecycleError('Bloco precisa começar com ALVO ou ALVOS.', line.line);
    }

    const kv = parseKv(line.text);
    if (kv.lista || kv.list) {
        return [{ kind: 'list', value: kv.lista || kv.list, raw: line.text, line: line.line }];
    }

    const name = kv.nome || kv.personagem || kv.character || null;
    const identifier = kv.id || kv.tel || kv.telefone || kv.phone || null;
    if (name || identifier) {
        return [{
            kind: 'composite',
            name,
            identifier,
            raw: line.text,
            line: line.line,
        }];
    }

    const specs = [];
    for (const token of tokens.slice(1)) {
        if (!token || token.includes('=')) continue;
        const normalized = normalizeWord(token);
        if (normalized === 'resposta') {
            specs.push({ kind: 'quote', raw: token, line: line.line });
            continue;
        }
        if (token.startsWith('@')) {
            const mentioned = state.mentions[state.mentionIndex] || null;
            state.mentionIndex += mentioned ? 1 : 0;
            specs.push({
                kind: mentioned ? 'jid' : 'identifier',
                value: mentioned ? normalizeJid(mentioned) : token.replace(/^@/, ''),
                raw: token,
                line: line.line,
            });
            continue;
        }
        specs.push({ kind: 'identifier', value: token, raw: token, line: line.line });
    }

    if (!specs.length && state.quotedParticipant) {
        specs.push({ kind: 'jid', value: normalizeJid(state.quotedParticipant), raw: 'resposta', line: line.line });
    }

    if (!specs.length) {
        throw new CloverScriptLifecycleError('ALVO sem identificação.', line.line, 'missing_target');
    }
    return specs;
}

function parseLifecycleScript(scriptText, options = {}) {
    const lines = meaningfulLines(scriptText);
    if (!lines.length) throw new CloverScriptLifecycleError('Script vazio.');

    const state = {
        mentions: options.mentions || [],
        mentionIndex: 0,
        quotedParticipant: options.quotedParticipant || null,
    };

    let index = 0;
    let header = { id: null, name: null, mode: 'rigido', confirm: false };
    if (normalizeWord(tokenize(lines[index].text)[0]) === 'lote') {
        header = { ...header, ...parseHeader(lines[index]) };
        index += 1;
    }

    const blocks = [];
    while (index < lines.length) {
        const targetLine = lines[index];
        const targetKeyword = normalizeWord(tokenize(targetLine.text)[0]);
        if (!['alvo', 'alvos'].includes(targetKeyword)) {
            throw new CloverScriptLifecycleError('Esperava ALVO ou ALVOS.', targetLine.line);
        }
        const targets = parseTargetSpec(targetLine, state);
        index += 1;

        const actions = [];
        while (index < lines.length && normalizeWord(lines[index].text) !== 'fim') {
            const nextWord = normalizeWord(tokenize(lines[index].text)[0]);
            if (['alvo', 'alvos'].includes(nextWord)) {
                throw new CloverScriptLifecycleError(
                    'ALVO encontrado dentro de um bloco aberto. Provavelmente faltou FIM antes desta linha.',
                    lines[index].line,
                    'missing_fim'
                );
            }
            actions.push(parseLifecycleAction(lines[index], header));
            index += 1;
        }

        if (index >= lines.length) {
            throw new CloverScriptLifecycleError('Bloco sem FIM.', lines[index - 1]?.line || targetLine.line, 'missing_fim');
        }
        if (!actions.length) {
            throw new CloverScriptLifecycleError('Bloco sem ação PLAYER.', targetLine.line, 'empty_block');
        }
        blocks.push({ targets, actions });
        index += 1;
    }

    return { kind: 'lifecycle', header, blocks };
}

async function resolveOneTarget(db, spec, options) {
    if (spec.kind === 'quote') {
        if (!options.quotedParticipant) {
            throw new CloverScriptLifecycleError('ALVO resposta precisa de uma resposta real.', spec.line, 'missing_reply_target');
        }
        const result = await resolveTargetPlayer(db, options.quotedParticipant, '', {
            ...options,
            quotedParticipant: options.quotedParticipant,
            mechanical: true,
        });
        if (!result.ok) throw new CloverScriptLifecycleError(result.error || 'Alvo da resposta não encontrado.', spec.line, 'target_not_found', result.details);
        return result.player;
    }

    if (spec.kind === 'composite') {
        const first = spec.identifier
            ? await resolveTargetPlayer(db, null, spec.identifier, { ...options, mechanical: true })
            : null;
        if (first?.ok && spec.name) {
            const actual = normalizeWord(first.player.personagem_nome || first.player.nome || first.player.display_name);
            const expected = normalizeWord(spec.name);
            if (actual !== expected && !actual.includes(expected) && !expected.includes(actual)) {
                throw new CloverScriptLifecycleError(
                    `Alvo composto inseguro: identificador encontrou ${playerDisplayName(first.player, first.player.id)}, mas o nome informado foi "${spec.name}".`,
                    spec.line,
                    'unsafe_composite_target'
                );
            }
        }
        if (first?.ok) return first.player;

        if (spec.name) {
            const byName = await resolveTargetPlayer(db, null, spec.name, { ...options, mechanical: true });
            if (byName.ok) return byName.player;
            throw new CloverScriptLifecycleError(byName.error || 'Player não encontrado.', spec.line, 'target_not_found', byName.details);
        }
        throw new CloverScriptLifecycleError(first?.error || 'Player não encontrado.', spec.line, 'target_not_found', first?.details);
    }

    const result = await resolveTargetPlayer(
        db,
        spec.kind === 'jid' ? spec.value : null,
        spec.kind === 'jid' ? '' : spec.value,
        { ...options, mechanical: true }
    );
    if (!result.ok) {
        throw new CloverScriptLifecycleError(result.error || `Player não encontrado: ${spec.raw}.`, spec.line, 'target_not_found', result.details);
    }
    return result.player;
}

async function resolveLifecyclePlan(db, parsed, options = {}) {
    const blocks = [];
    for (const block of parsed.blocks) {
        const targets = [];
        for (const spec of block.targets) {
            if (spec.kind === 'list') {
                const list = await getResolvedRewardListTargets(db, spec.value);
                if (!list.ok) {
                    throw new CloverScriptLifecycleError(
                        list.error || `Lista não resolvida: ${spec.value}.`,
                        spec.line,
                        'target_list_not_resolved',
                        { target: spec.value }
                    );
                }
                for (const playerId of list.playerIds) {
                    targets.push(await resolveOneTarget(db, { kind: 'jid', value: playerId, raw: playerId, line: spec.line }, options));
                }
                continue;
            }
            targets.push(await resolveOneTarget(db, spec, options));
        }
        const uniqueTargets = [...new Map(targets.map((target) => [target.id, target])).values()];
        blocks.push({ targets: uniqueTargets, actions: block.actions });
    }

    const totalTargets = blocks.reduce((total, block) => total + block.targets.length, 0);
    const totalActions = blocks.reduce((total, block) => total + (block.targets.length * block.actions.length), 0);
    if (totalTargets !== 1 || totalActions !== 1) {
        throw new CloverScriptLifecycleError(
            'Arquivar/reativar exige exatamente 1 player e 1 ação por simulação nesta versão de segurança.',
            null,
            'single_lifecycle_action_required'
        );
    }

    return { kind: 'lifecycle', header: parsed.header, blocks };
}

function flattenPlan(plan) {
    const items = [];
    for (const block of plan.blocks || []) {
        for (const target of block.targets || []) {
            for (const action of block.actions || []) items.push({ target, action });
        }
    }
    return items;
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

function previewLines(target, action, preview) {
    const label = playerDisplayName(target, target.id);
    if (action.op === 'archive') {
        return [
            `> ${label}: ciclo ${preview.changes.lifecycleStatus[0]} -> ${preview.changes.lifecycleStatus[1]}`,
            `> Jogo: ${preview.changes.gameStatus[0]} -> ${preview.changes.gameStatus[1]}`,
            `> Esquadrão: ${preview.changes.squad[0]} -> ${preview.changes.squad[1]}`,
            `> Fila fechada: ${preview.changes.queueEntriesClosed}`,
            `> Reservas liberadas: ${preview.changes.reservationsReleased}`,
            `> Lideranças limpas: ${preview.changes.leadershipRolesCleared}`,
            '> PH, inventário, grimório, personagem e histórico serão preservados.',
        ];
    }

    return [
        `> ${label}: ciclo ${preview.changes.lifecycleStatus[0]} -> ${preview.changes.lifecycleStatus[1]}`,
        `> Jogo: ${preview.changes.gameStatus[0]} -> ${preview.changes.gameStatus[1]}`,
        `> Esquadrão: ${preview.changes.squad[0]} -> ${preview.changes.squad[1]}`,
        `> Reservas restauráveis: ${preview.changes.reservationsRestored}`,
        `> Conflitos de vaga: ${preview.changes.reservationConflicts}`,
        `> Retorno à fila: ${preview.changes.queueRestoredToEnd ? 'sim, no fim' : 'não'}`,
        preview.changes.reservationConflicts
            ? '> ATENÇÃO: conflito detectado. O jogo permanecerá bloqueado e a reativação ficará pendente.'
            : '> Nenhum conflito de vaga detectado.',
    ];
}

async function buildLifecyclePreview(db, plan) {
    const { target, action } = flattenPlan(plan)[0];
    const preview = action.op === 'archive'
        ? await previewArchivePlayer(db, target.id)
        : await previewReactivatePlayer(db, target.id);
    if (!preview.ok) {
        throw new CloverScriptLifecycleError(preview.error || preview.code || 'Não foi possível simular.', action.line, preview.code);
    }
    return { target, action, preview, lines: previewLines(target, action, preview) };
}

function renderLifecycleSimulation({ code, plan, built }) {
    return [
        '*♧┃SIMULAÇÃO CLOVER 𖥔 CLOVER MULTICOLOR*',
        '     ── nada foi aplicado ainda ──',
        '',
        '_`─( ✓ )───── Resumo`_',
        '',
        `*Código:* ${code}`,
        '*Modo:* rigido',
        plan.header.id ? `*Lote:* ${plan.header.id}` : null,
        `*Ação protegida:* PLAYER ${built.action.op === 'archive' ? 'arquivar' : 'reativar'}`,
        `*Alvo:* ${playerDisplayName(built.target, built.target.id)} (${formatMention(built.target.id)})`,
        '',
        '_`─( ◆ )───── Prévia`_',
        '',
        ...built.lines,
        '',
        `Use *.#clover aplicar codigo=${code}* para confirmar.`,
    ].filter(Boolean).join('\n');
}

async function createLifecycleSimulation(db, scriptText, options = {}) {
    if (!isOwner(options.actorId)) {
        throw new CloverScriptLifecycleError('PLAYER arquivar/reativar é apenas para Owner.', null, 'permission_denied');
    }

    await ensureCloverScriptSchema(db);
    await ensurePlayerLifecycleSchema(db);
    const parsed = parseLifecycleScript(scriptText, options);
    const plan = await resolveLifecyclePlan(db, parsed, options);
    const duplicate = await hasAppliedBatch(db, plan.header.id);
    if (duplicate && !plan.header.confirm) {
        throw new CloverScriptLifecycleError(`Lote já aplicado pelo código ${duplicate.code}.`, null, 'duplicate_batch');
    }

    const built = await buildLifecyclePreview(db, plan);
    const code = generateSimulationCode();
    const result = await db.run(
        `INSERT INTO clover_script_runs
         (code, batch_id, batch_name, mode, script_hash, script_text, plan_json, status,
          created_by, chat_id, created_at, metadata_json)
         VALUES (?, ?, ?, 'rigido', ?, ?, ?, 'simulated', ?, ?, CURRENT_TIMESTAMP, ?)`,
        [
            code,
            plan.header.id,
            plan.header.name,
            crypto.createHash('sha256').update(String(scriptText), 'utf8').digest('hex'),
            scriptText,
            serialize(plan),
            options.actorId || null,
            options.chatId || null,
            serialize({ source: 'cloverscript_lifecycle', protected_action: true }),
        ]
    );

    return {
        ok: true,
        runId: result.lastID,
        code,
        plan,
        text: renderLifecycleSimulation({ code, plan, built }),
    };
}

async function findPendingRun(db, { code = null, actorId = null, chatId = null } = {}) {
    await ensureCloverScriptSchema(db);
    if (code) {
        return db.get('SELECT * FROM clover_script_runs WHERE code = ?', [String(code).trim().toUpperCase()]);
    }
    return db.get(
        `SELECT *
         FROM clover_script_runs
         WHERE status = 'simulated'
           AND created_by = ?
           AND chat_id = ?
         ORDER BY id DESC
         LIMIT 1`,
        [actorId || null, chatId || null]
    );
}

async function shouldHandleLifecycleApply(db, options = {}) {
    const run = await findPendingRun(db, options);
    if (!run) return false;
    if (String(run.code || '').toUpperCase().startsWith('CSL-')) return true;
    const metadata = safeJsonParse(run.metadata_json, {});
    const plan = safeJsonParse(run.plan_json, {});
    return metadata?.source === 'cloverscript_lifecycle' || plan?.kind === 'lifecycle';
}

async function syncArchiveSideEffects({ sock, db, applied }) {
    const warnings = [];
    if (!sock) return warnings;

    const hadCalledQueueEntry = (applied.before?.queueEntries || []).some((entry) => entry.status === 'called');
    if (hadCalledQueueEntry) {
        const removal = await removeSpellReviewParticipant(sock, db, applied.playerId).catch((error) => ({ ok: false, error }));
        if (!removal?.ok) warnings.push('não consegui confirmar a remoção do grupo de avaliação');
        await rotateSpellReviewInviteLink(sock, db).catch(() => {
            warnings.push('não consegui redefinir o link do grupo de avaliação');
        });
    }

    if (applied.archiveCardSnapshot) {
        const archiveSync = await syncArchiveCardAsDeleted({
            sock,
            db,
            snapshot: applied.archiveCardSnapshot,
        }).catch((error) => ({ ok: false, error }));
        if (!archiveSync?.ok && !archiveSync?.skipped) warnings.push('não consegui atualizar o card de arquivo');
    }

    const previousSquad = applied.before?.player?.esquadrao;
    if (previousSquad && previousSquad !== '-') {
        await syncSquadGroupDescription({ sock, db, squadKey: previousSquad }).catch(() => {
            warnings.push('não consegui sincronizar a descrição do esquadrão anterior');
        });
    }

    return warnings;
}

async function syncReactivationSideEffects({ sock, db, applied }) {
    const warnings = [];
    if (!sock) return warnings;

    const archiveSync = await syncArchiveCardForPlayer({
        sock,
        db,
        playerId: applied.playerId,
    }).catch((error) => ({ ok: false, error }));
    if (!archiveSync?.ok && !archiveSync?.skipped) warnings.push('não consegui reativar o card de arquivo');

    const squad = applied.after?.player?.esquadrao;
    if (squad && squad !== '-') {
        await syncSquadGroupDescription({ sock, db, squadKey: squad }).catch(() => {
            warnings.push('não consegui sincronizar a descrição do esquadrão');
        });
    }

    return warnings;
}

function renderLifecycleApplyResult({ run, target, action, applied, warnings }) {
    const label = playerDisplayName(target, target.id);
    const result = applied.result || {};
    const lines = action.op === 'archive'
        ? [
            `> ${label}: arquivado com segurança.`,
            `> Fila fechada: ${result.queueClosed || 0}`,
            `> Reservas liberadas: ${result.reservationsReleased || 0}`,
            `> Lideranças limpas: ${result.leadershipCleared || 0}`,
            '> PH, inventário, grimório e histórico preservados.',
        ]
        : [
            `> ${label}: reativação concluída.`,
            `> Estado: ${result.lifecycleStatus || '-'}`,
            `> Jogo: ${result.gameStatusRestored || '-'}`,
            `> Reservas restauradas: ${result.reservationsRestored || 0}`,
            `> Conflitos: ${(result.reservationConflicts || []).length}`,
            `> Fila restaurada: ${result.queue?.restored ? 'sim, no fim' : 'não'}`,
        ];

    return [
        '*♧┃CLOVERSCRIPT APLICADO 𖥔 CLOVER MULTICOLOR*',
        '     ── alteração protegida registrada ──',
        '',
        '_`─( ✓ )───── Resultado`_',
        '',
        `*Código:* ${run.code}`,
        `*Operação:* PLAYER ${action.op === 'archive' ? 'arquivar' : 'reativar'}`,
        `*Evento de ciclo:* ${applied.code}`,
        '',
        ...lines,
        warnings.length ? '' : null,
        warnings.length ? '_`─( ! )───── Avisos externos`_' : null,
        warnings.length ? '' : null,
        ...warnings.map((warning) => `> ${warning}`),
        warnings.length ? '> A alteração do banco foi concluída; os avisos acima são apenas sincronizações externas.' : null,
    ].filter(Boolean).join('\n');
}

async function applyLifecycleSimulation(db, { code = null, actorId, chatId, sock = null } = {}) {
    if (!isOwner(actorId)) {
        throw new CloverScriptLifecycleError('PLAYER arquivar/reativar é apenas para Owner.', null, 'permission_denied');
    }

    const run = await findPendingRun(db, { code, actorId, chatId });
    if (!run) throw new CloverScriptLifecycleError('Não encontrei simulação pendente.', null, 'missing_simulation');
    if (run.status !== RUN_STATUS.SIMULATED) {
        throw new CloverScriptLifecycleError('Essa simulação não está pendente.', null, 'invalid_status');
    }

    const plan = safeJsonParse(run.plan_json, null);
    if (!plan || plan.kind !== 'lifecycle') {
        throw new CloverScriptLifecycleError('Plano de ciclo de vida inválido.', null, 'invalid_plan');
    }

    const duplicate = await hasAppliedBatch(db, plan.header?.id);
    if (duplicate && duplicate.id !== run.id && !plan.header?.confirm) {
        throw new CloverScriptLifecycleError(`Lote já aplicado pelo código ${duplicate.code}.`, null, 'duplicate_batch');
    }

    const item = flattenPlan(plan)[0];
    if (!item) throw new CloverScriptLifecycleError('Plano sem ação.', null, 'invalid_plan');

    try {
        const applied = item.action.op === 'archive'
            ? await archivePlayer(db, {
                playerId: item.target.id,
                reason: item.action.reason,
                actorId,
            })
            : await reactivatePlayer(db, {
                playerId: item.target.id,
                reason: item.action.reason,
                actorId,
            });

        if (!applied.ok) {
            throw new CloverScriptLifecycleError(applied.error || applied.code || 'Operação recusada.', item.action.line, applied.code);
        }

        const warnings = item.action.op === 'archive'
            ? await syncArchiveSideEffects({ sock, db, applied })
            : await syncReactivationSideEffects({ sock, db, applied });
        const summary = `${playerDisplayName(item.target, item.target.id)}: PLAYER ${item.action.op === 'archive' ? 'arquivado' : 'reativado'} (${applied.code})`;

        await db.run(
            `INSERT INTO clover_script_actions
             (run_id, player_id, action_type, summary, status, before_json, after_json, created_at)
             VALUES (?, ?, 'lifecycle', ?, 'applied', ?, ?, CURRENT_TIMESTAMP)`,
            [
                run.id,
                item.target.id,
                summary,
                serialize(applied.before),
                serialize({ ...applied.after, lifecycleResult: applied.result, lifecycleCode: applied.code, warnings }),
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
            text: renderLifecycleApplyResult({
                run,
                target: item.target,
                action: item.action,
                applied,
                warnings,
            }),
        };
    } catch (error) {
        const message = error?.message || String(error);
        await db.run(
            `INSERT INTO clover_script_actions
             (run_id, player_id, action_type, summary, status, error, created_at)
             VALUES (?, ?, 'lifecycle', ?, 'failed', ?, CURRENT_TIMESTAMP)`,
            [run.id, item.target.id, `PLAYER ${item.action.op}`, message]
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
    CloverScriptLifecycleError,
    applyLifecycleSimulation,
    createLifecycleSimulation,
    isLifecycleSimulationCode: (code) => String(code || '').trim().toUpperCase().startsWith('CSL-'),
    looksLikeLifecycleScript,
    parseLifecycleScript,
    shouldHandleLifecycleApply,
};
