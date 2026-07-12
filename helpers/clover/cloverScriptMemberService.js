const crypto = require('crypto');

const { isOwner, isSameUser, normalizeJid } = require('../groupAccess');
const { normalizeText } = require('../textUtils');
const {
    formatMention,
    playerDisplayName,
    resolveTargetPlayer,
} = require('./commandTargetUtils');
const {
    ensureCloverScriptSchema,
} = require('./cloverScriptService');
const {
    advanceSpellReviewQueueAfterRemoval,
    getCloverGroup,
    getParticipantCandidates,
    removeSpellReviewParticipant,
} = require('./groupManager');
const { markCommunityStatus } = require('./antiGhostService');

const GROUP_ALIASES = {
    comunidade: 'community',
    community: 'community',
    avisos: 'community',
    off: 'off',
    on: 'on',
    arquivo: 'archive',
    arquivos: 'archive',
    archive: 'archive',
    avaliacao: 'spell_review',
    avaliacao_feiticos: 'spell_review',
    avaliacao_de_feiticos: 'spell_review',
    spell_review: 'spell_review',
    feiticos: 'spell_review',
};

const GROUP_LABELS = {
    community: 'Comunidade/Avisos',
    off: 'Grupo OFF',
    on: 'Grupo ON',
    archive: 'Arquivos',
    spell_review: 'Avaliação de Feitiços',
};

class CloverScriptMemberError extends Error {
    constructor(message, line = null, code = 'invalid_member_script', details = null) {
        super(message);
        this.name = 'CloverScriptMemberError';
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

function tokenize(line) {
    return [...String(line || '').matchAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g)]
        .map((match) => stripQuotes(match[0]));
}

function truthy(value) {
    return ['true', 'sim', 'yes', '1', 'confirmar'].includes(normalizeWord(value));
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

function meaningfulLines(scriptText) {
    return String(scriptText || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((raw, index) => ({ raw, text: raw.trim(), line: index + 1 }))
        .filter((item) => item.text && !item.text.startsWith('//'));
}

function generateSimulationCode() {
    return `CSM-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function generateOperationCode() {
    return `MO-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function looksLikeMemberScript(scriptText) {
    return meaningfulLines(scriptText).some((line) => /^MEMBRO\s+REMOVER\b/i.test(line.text));
}

function parseHeader(line) {
    const kv = parseKv(line.text);
    const mode = normalizeWord(kv.modo || kv.mode || 'rigido') || 'rigido';
    if (mode !== 'rigido') {
        throw new CloverScriptMemberError('MEMBRO remover aceita apenas modo=rigido.', line.line, 'invalid_mode');
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
    const mention = options.mentions?.[0] || null;
    const quoted = options.quotedParticipant || null;
    const id = kv.id || kv.jid || kv.tel || kv.telefone || kv.phone || null;
    const name = kv.nome || kv.personagem || kv.character || null;
    const loose = tokens.slice(1).filter((token) => !token.includes('=')).join(' ').trim();
    const explicitMention = tokens.some((token) => token.startsWith('@')) ? mention : null;
    const response = tokens.some((token) => normalizeWord(token) === 'resposta') ? quoted : null;

    const targetId = explicitMention || response || id || null;
    const targetText = name || (!targetId ? loose : '');
    if (!targetId && !targetText) {
        throw new CloverScriptMemberError('ALVO sem identificação.', line.line, 'missing_target');
    }
    return { targetId, targetText, line: line.line, raw: line.text };
}

function parseMemberAction(line, header) {
    const tokens = tokenize(line.text);
    const first = normalizeWord(tokens[0]);
    const second = normalizeWord(tokens[1]);
    if (first !== 'membro' || second !== 'remover') {
        throw new CloverScriptMemberError(`Ação desconhecida: ${tokens[0] || '-'}.`, line.line);
    }

    const kv = parseKv(line.text);
    const rawGroup = normalizeWord(kv.grupo || kv.group || '');
    const groupKey = GROUP_ALIASES[rawGroup] || null;
    if (!groupKey) {
        throw new CloverScriptMemberError(
            'MEMBRO remover precisa de grupo=comunidade|off|on|arquivo|avaliacao.',
            line.line,
            'invalid_group'
        );
    }
    const reason = String(kv.motivo || kv.reason || '').trim();
    if (reason.length < 3) {
        throw new CloverScriptMemberError('MEMBRO remover precisa de motivo="...".', line.line, 'missing_reason');
    }
    const confirm = truthy(kv.confirmar || kv.confirm) || header.confirm;
    if (!confirm) {
        throw new CloverScriptMemberError(
            'MEMBRO remover é protegido e precisa de confirmar=true.',
            line.line,
            'missing_confirm'
        );
    }
    const syncValue = normalizeWord(kv.sincronizar || kv.sync || 'auto');
    if (!['auto', 'nenhum', 'none'].includes(syncValue)) {
        throw new CloverScriptMemberError(
            'sincronizar aceita apenas auto ou nenhum.',
            line.line,
            'invalid_sync_mode'
        );
    }

    return {
        type: 'member_remove',
        groupKey,
        groupLabel: GROUP_LABELS[groupKey],
        reason,
        sync: syncValue === 'auto' ? 'auto' : 'none',
        confirm: true,
        dangerous: true,
        line: line.line,
    };
}

function parseMemberScript(scriptText, options = {}) {
    const lines = meaningfulLines(scriptText);
    if (!lines.length) throw new CloverScriptMemberError('Script vazio.');

    let index = 0;
    let header = { id: null, name: null, mode: 'rigido', confirm: false };
    if (/^LOTE\b/i.test(lines[index].text)) {
        header = { ...header, ...parseHeader(lines[index]) };
        index += 1;
    }

    const targetLine = lines[index];
    if (!targetLine || !/^ALVO\b/i.test(targetLine.text)) {
        throw new CloverScriptMemberError('MEMBRO remover exige exatamente um bloco ALVO.', targetLine?.line || null, 'missing_target_block');
    }
    const target = parseTarget(targetLine, options);
    index += 1;

    const actionLine = lines[index];
    if (!actionLine) throw new CloverScriptMemberError('Bloco sem ação MEMBRO remover.', targetLine.line, 'empty_block');
    const action = parseMemberAction(actionLine, header);
    index += 1;

    if (!lines[index] || normalizeWord(lines[index].text) !== 'fim') {
        throw new CloverScriptMemberError('Bloco sem FIM.', actionLine.line, 'missing_fim');
    }
    index += 1;
    if (index < lines.length) {
        throw new CloverScriptMemberError(
            'MEMBRO remover aceita apenas um player e uma ação por simulação.',
            lines[index].line,
            'single_member_action_required'
        );
    }

    return { kind: 'member_remove', header, target, action };
}

async function ensureMemberOperationSchema(db) {
    await ensureCloverScriptSchema(db);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_member_operations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operation_code TEXT NOT NULL UNIQUE,
            run_id INTEGER NOT NULL UNIQUE,
            simulation_code TEXT NOT NULL,
            player_id TEXT NOT NULL,
            group_key TEXT NOT NULL,
            group_id TEXT DEFAULT NULL,
            reason TEXT NOT NULL,
            sync_mode TEXT NOT NULL DEFAULT 'auto',
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'applied', 'failed')),
            was_member INTEGER DEFAULT NULL,
            removed_id TEXT DEFAULT NULL,
            external_result_json TEXT DEFAULT NULL,
            sync_result_json TEXT DEFAULT NULL,
            error TEXT DEFAULT NULL,
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            applied_at TEXT DEFAULT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_clover_member_operations_player
        ON clover_member_operations (player_id, created_at DESC, id DESC);
    `);
}

async function resolveTarget(db, parsed, options = {}) {
    const resolved = await resolveTargetPlayer(
        db,
        parsed.target.targetId,
        parsed.target.targetText,
        { mechanical: true }
    );
    if (!resolved.ok) {
        throw new CloverScriptMemberError(
            resolved.error || 'Player não encontrado.',
            parsed.target.line,
            'target_not_found',
            resolved.details
        );
    }
    if (Number(resolved.player.is_shadow || 0) === 1) {
        throw new CloverScriptMemberError(
            'Cadastro sombra não pode ser alvo mecânico. Use o cadastro canônico.',
            parsed.target.line,
            'shadow_target'
        );
    }
    return resolved.player;
}

function participantId(participant) {
    return normalizeJid(participant?.id || participant?.jid || participant?.participant || '');
}

async function inspectMembership(sock, groupId, playerId) {
    if (!sock?.groupMetadata || !groupId) {
        return { known: false, member: null, groupName: null, matchedId: null };
    }
    try {
        const metadata = await sock.groupMetadata(groupId);
        const candidates = getParticipantCandidates(playerId);
        const participant = (metadata?.participants || []).find((item) => {
            const id = participantId(item);
            return candidates.some((candidate) => isSameUser(id, candidate));
        }) || null;
        return {
            known: true,
            member: Boolean(participant),
            groupName: metadata?.subject || null,
            matchedId: participant ? participantId(participant) : null,
            participants: Array.isArray(metadata?.participants) ? metadata.participants.length : null,
        };
    } catch (error) {
        return {
            known: false,
            member: null,
            groupName: null,
            matchedId: null,
            error: error?.message || String(error),
        };
    }
}

async function buildPreview(db, parsed, options = {}) {
    const player = await resolveTarget(db, parsed, options);
    const groupId = await getCloverGroup(db, parsed.action.groupKey);
    if (!groupId) {
        throw new CloverScriptMemberError(
            `Grupo ${parsed.action.groupLabel} não está configurado.`,
            parsed.action.line,
            'missing_group'
        );
    }
    const membership = await inspectMembership(options.sock, groupId, player.id);
    return { player, groupId, membership, action: parsed.action };
}

function renderSimulation({ code, parsed, preview }) {
    const membershipText = preview.membership.known
        ? (preview.membership.member ? 'presente' : 'já ausente')
        : 'não confirmado nesta simulação';
    const syncText = parsed.action.sync === 'none'
        ? 'nenhuma sincronização de banco'
        : parsed.action.groupKey === 'community'
            ? 'marcar comunidade como fora'
            : parsed.action.groupKey === 'spell_review'
                ? 'fechar/avançar a fila quando houver chamado ativo'
                : 'sem ajuste adicional de banco';

    return [
        '*♧┃SIMULAÇÃO CLOVER 𖥔 CLOVER MULTICOLOR*',
        '     ── remoção de grupo; nada foi aplicado ──',
        '',
        '_`─( ✓ )───── Resumo`_',
        '',
        `*Código:* ${code}`,
        '*Modo:* rigido',
        parsed.header.id ? `*Lote:* ${parsed.header.id}` : null,
        '*Ação protegida:* MEMBRO remover',
        `*Player:* ${playerDisplayName(preview.player, preview.player.id)} (${formatMention(preview.player.id)})`,
        `*Grupo:* ${preview.action.groupLabel}`,
        `*Grupo ID:* ${preview.groupId}`,
        `*Presença:* ${membershipText}`,
        `*Sincronização:* ${syncText}`,
        `*Motivo:* ${preview.action.reason}`,
        '',
        '> O cadastro, personagem, PH, inventário, grimório e histórico não serão apagados.',
        '> A remoção afeta somente o grupo indicado e a sincronização explicitada acima.',
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

async function createMemberSimulation(db, scriptText, options = {}) {
    if (!isOwner(options.actorId)) {
        throw new CloverScriptMemberError('MEMBRO remover é apenas para Owner.', null, 'permission_denied');
    }
    await ensureMemberOperationSchema(db);
    const parsed = parseMemberScript(scriptText, options);
    const duplicate = await hasAppliedBatch(db, parsed.header.id);
    if (duplicate && !parsed.header.confirm) {
        throw new CloverScriptMemberError(`Lote já aplicado pelo código ${duplicate.code}.`, null, 'duplicate_batch');
    }
    const preview = await buildPreview(db, parsed, options);
    const code = generateSimulationCode();
    const plan = {
        kind: 'member_remove',
        header: parsed.header,
        blocks: [{ targets: [preview.player], actions: [parsed.action] }],
        member: {
            groupId: preview.groupId,
            membership: preview.membership,
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
            serialize({ source: 'cloverscript_member_remove', protected_action: true }),
        ]
    );
    return {
        ok: true,
        runId: result.lastID,
        code,
        plan,
        preview,
        text: renderSimulation({ code, parsed, preview }),
    };
}

async function findPendingRun(db, { code = null, actorId = null, chatId = null } = {}) {
    await ensureMemberOperationSchema(db);
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

async function shouldHandleMemberApply(db, options = {}) {
    const run = await findPendingRun(db, options);
    if (!run) return false;
    if (String(run.code || '').toUpperCase().startsWith('CSM-')) return true;
    const metadata = safeJsonParse(run.metadata_json, {});
    const plan = safeJsonParse(run.plan_json, {});
    return metadata?.source === 'cloverscript_member_remove' || plan?.kind === 'member_remove';
}

async function removeFromConfiguredGroup({ sock, db, groupKey, groupId, playerId }) {
    if (!sock?.groupParticipantsUpdate) {
        return { ok: false, reason: 'missing_socket', error: 'Conexão do WhatsApp indisponível.' };
    }
    if (groupKey === 'spell_review') {
        return removeSpellReviewParticipant(sock, db, playerId);
    }

    const errors = [];
    for (const candidate of getParticipantCandidates(playerId)) {
        try {
            const response = await sock.groupParticipantsUpdate(groupId, [candidate], 'remove');
            return { ok: true, groupId, removedId: candidate, response };
        } catch (error) {
            errors.push({ candidate, error: error?.message || String(error) });
        }
    }
    return { ok: false, reason: 'remove_failed', groupId, errors };
}

async function synchronizeAfterRemoval({ sock, db, action, playerId }) {
    if (action.sync === 'none') return { ok: true, skipped: true, mode: 'none' };
    if (action.groupKey === 'community') {
        await markCommunityStatus(db, playerId, false);
        return { ok: true, type: 'community_out' };
    }
    if (action.groupKey === 'spell_review') {
        const result = await advanceSpellReviewQueueAfterRemoval({
            sock,
            db,
            participantId: playerId,
            closedBy: 'cloverscript',
        });
        return { ok: true, type: 'spell_review_queue', result };
    }
    return { ok: true, skipped: true, mode: 'not_applicable' };
}

async function claimOperation(db, { run, player, action, groupId, actorId }) {
    const existing = await db.get('SELECT * FROM clover_member_operations WHERE run_id = ?', [run.id]);
    if (existing) return existing;
    const operationCode = generateOperationCode();
    try {
        const insert = await db.run(
            `INSERT INTO clover_member_operations
             (operation_code, run_id, simulation_code, player_id, group_key, group_id,
              reason, sync_mode, status, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
                operationCode,
                run.id,
                run.code,
                player.id,
                action.groupKey,
                groupId,
                action.reason,
                action.sync,
                actorId || null,
            ]
        );
        return db.get('SELECT * FROM clover_member_operations WHERE id = ?', [insert.lastID]);
    } catch (error) {
        const concurrent = await db.get('SELECT * FROM clover_member_operations WHERE run_id = ?', [run.id]);
        if (concurrent) return concurrent;
        throw error;
    }
}

function renderApplyResult({ run, operation, player, action, membership, external, syncResult, warnings }) {
    return [
        '*♧┃CLOVERSCRIPT APLICADO 𖥔 CLOVER MULTICOLOR*',
        '     ── remoção de grupo registrada ──',
        '',
        '_`─( ✓ )───── Resultado`_',
        '',
        `*Código:* ${run.code}`,
        `*Operação:* ${operation.operation_code}`,
        `*Player:* ${playerDisplayName(player, player.id)} (${formatMention(player.id)})`,
        `*Grupo:* ${action.groupLabel}`,
        `*Resultado:* ${membership.known && !membership.member ? 'já estava ausente' : 'removido'}`,
        `*ID usado:* ${external?.removedId || membership.matchedId || '-'}`,
        `*Sincronização:* ${syncResult?.type || syncResult?.mode || 'nenhuma'}`,
        '',
        '> O cadastro e todos os dados do personagem foram preservados.',
        warnings.length ? '' : null,
        warnings.length ? '_`─( ! )───── Avisos`_' : null,
        warnings.length ? '' : null,
        ...warnings.map((warning) => `> ${warning}`),
    ].filter(Boolean).join('\n');
}

async function applyMemberSimulation(db, { code = null, actorId, chatId, sock = null } = {}) {
    if (!isOwner(actorId)) {
        throw new CloverScriptMemberError('MEMBRO remover é apenas para Owner.', null, 'permission_denied');
    }
    const run = await findPendingRun(db, { code, actorId, chatId });
    if (!run) throw new CloverScriptMemberError('Não encontrei simulação de remoção pendente.', null, 'missing_simulation');

    const plan = safeJsonParse(run.plan_json, null);
    if (!plan || plan.kind !== 'member_remove') {
        throw new CloverScriptMemberError('Plano de remoção inválido.', null, 'invalid_plan');
    }
    const player = plan.blocks?.[0]?.targets?.[0];
    const action = plan.blocks?.[0]?.actions?.[0];
    if (!player?.id || !action?.groupKey) {
        throw new CloverScriptMemberError('Plano de remoção incompleto.', null, 'invalid_plan');
    }

    const existingOperation = await db.get('SELECT * FROM clover_member_operations WHERE run_id = ?', [run.id]);
    if (run.status === 'applied' && existingOperation?.status === 'applied') {
        return {
            ok: true,
            alreadyApplied: true,
            run,
            operation: existingOperation,
            text: `*♧┃CLOVERSCRIPT 𖥔 CLOVER MULTICOLOR*\n\n> A remoção ${existingOperation.operation_code} já foi concluída.`,
        };
    }
    if (!['simulated', 'failed'].includes(run.status) && !existingOperation) {
        throw new CloverScriptMemberError('Essa simulação não está pendente.', null, 'invalid_status');
    }

    const groupId = await getCloverGroup(db, action.groupKey);
    if (!groupId) throw new CloverScriptMemberError(`Grupo ${action.groupLabel} não está configurado.`, action.line, 'missing_group');
    if (plan.member?.groupId && !isSameUser(plan.member.groupId, groupId)) {
        throw new CloverScriptMemberError(
            'O grupo configurado mudou depois da simulação. Simule novamente.',
            action.line,
            'group_changed'
        );
    }

    const operation = await claimOperation(db, { run, player, action, groupId, actorId });
    if (operation.status === 'applied') {
        return {
            ok: true,
            alreadyApplied: true,
            run,
            operation,
            text: `*♧┃CLOVERSCRIPT 𖥔 CLOVER MULTICOLOR*\n\n> A remoção ${operation.operation_code} já foi concluída.`,
        };
    }

    const warnings = [];
    try {
        const membership = await inspectMembership(sock, groupId, player.id);
        let external = { ok: true, alreadyAbsent: true, removedId: membership.matchedId || null };
        if (!(membership.known && !membership.member)) {
            external = await removeFromConfiguredGroup({ sock, db, groupKey: action.groupKey, groupId, playerId: player.id });
            if (!external.ok) {
                throw new CloverScriptMemberError(
                    external.error || `Não consegui remover o membro do grupo ${action.groupLabel}.`,
                    action.line,
                    external.reason || 'remove_failed',
                    { errors: external.errors || null }
                );
            }
        }

        let syncResult = null;
        try {
            syncResult = await synchronizeAfterRemoval({ sock, db, action, playerId: player.id });
        } catch (error) {
            syncResult = { ok: false, error: error?.message || String(error) };
            warnings.push(`membro removido, mas a sincronização interna falhou: ${syncResult.error}`);
        }

        await db.run(
            `UPDATE clover_member_operations
             SET status = 'applied',
                 was_member = ?,
                 removed_id = ?,
                 external_result_json = ?,
                 sync_result_json = ?,
                 error = NULL,
                 applied_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                membership.known ? (membership.member ? 1 : 0) : null,
                external.removedId || membership.matchedId || null,
                serialize(external),
                serialize(syncResult),
                operation.id,
            ]
        );

        const summary = `${playerDisplayName(player, player.id)}: removido de ${action.groupLabel}`;
        await db.run(
            `INSERT INTO clover_script_actions
             (run_id, player_id, action_type, summary, status, before_json, after_json, created_at)
             VALUES (?, ?, 'member_remove', ?, 'applied', ?, ?, CURRENT_TIMESTAMP)`,
            [
                run.id,
                player.id,
                summary,
                serialize({ groupId, membership }),
                serialize({ external, syncResult, operationCode: operation.operation_code, warnings }),
            ]
        );
        await db.run(
            `UPDATE clover_script_runs
             SET status = 'applied', applied_by = ?, applied_at = CURRENT_TIMESTAMP, error = NULL
             WHERE id = ?`,
            [actorId || null, run.id]
        );

        const freshOperation = await db.get('SELECT * FROM clover_member_operations WHERE id = ?', [operation.id]);
        return {
            ok: true,
            run,
            operation: freshOperation,
            player,
            action,
            membership,
            external,
            syncResult,
            warnings,
            text: renderApplyResult({
                run,
                operation: freshOperation,
                player,
                action,
                membership,
                external,
                syncResult,
                warnings,
            }),
        };
    } catch (error) {
        const message = error?.message || String(error);
        await db.run(
            `UPDATE clover_member_operations
             SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [message, operation.id]
        ).catch(() => null);
        await db.run(
            `UPDATE clover_script_runs
             SET status = 'failed', applied_by = ?, applied_at = CURRENT_TIMESTAMP, error = ?
             WHERE id = ?`,
            [actorId || null, message, run.id]
        ).catch(() => null);
        await db.run(
            `INSERT INTO clover_script_actions
             (run_id, player_id, action_type, summary, status, error, created_at)
             VALUES (?, ?, 'member_remove', ?, 'failed', ?, CURRENT_TIMESTAMP)`,
            [run.id, player.id, `MEMBRO remover ${action.groupKey}`, message]
        ).catch(() => null);
        throw error;
    }
}

module.exports = {
    CloverScriptMemberError,
    GROUP_ALIASES,
    applyMemberSimulation,
    createMemberSimulation,
    ensureMemberOperationSchema,
    inspectMembership,
    isMemberSimulationCode: (code) => String(code || '').trim().toUpperCase().startsWith('CSM-'),
    looksLikeMemberScript,
    parseMemberScript,
    shouldHandleMemberApply,
};
