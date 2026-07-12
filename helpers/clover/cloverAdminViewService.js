const { normalizeText } = require('../textUtils');
const {
    formatMention,
    playerDisplayName,
    resolveTargetPlayer,
} = require('./commandTargetUtils');
const {
    ensureTargetResolverSchema,
    getCanonicalPlayer,
    listPlayerTargetAliases,
} = require('./targetResolver');
const { ensureTargetResolverTables } = require('./targetResolverSchemaGuard');
const { diagnoseSpellReviewQueue } = require('./spellQueueAdminService');
const { diagnoseDatabaseIntegrity } = require('./databaseIntegrityService');
const { getPlayerLifecycleState } = require('./playerLifecycleService');

const VIEW_ALIASES = {
    player: 'player',
    jogador: 'player',
    personagem: 'player',
    cadastro: 'player',
    fila: 'queue',
    queue: 'queue',
    lote: 'batch',
    batch: 'batch',
    codigo: 'batch',
    code: 'batch',
    simulacao: 'batch',
    simulation: 'batch',
    esquadrao: 'squad',
    squad: 'squad',
    integridade: 'integrity',
    banco: 'integrity',
    database: 'integrity',
};

function normalizeCompact(value) {
    return normalizeText(String(value || ''))
        .replace(/[^a-z0-9_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeKey(value) {
    return normalizeCompact(value).replace(/\s+/g, '_');
}

function stripQuotes(value) {
    const text = String(value || '').trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
        return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
    return text;
}

function parseKv(text) {
    const kv = {};
    const regex = /([A-Za-zÀ-ÿ0-9_]+)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g;
    let match = null;
    while ((match = regex.exec(String(text || '')))) {
        kv[normalizeKey(match[1])] = stripQuotes(match[2]);
    }
    return kv;
}

function splitView(rest) {
    const text = String(rest || '').trim();
    const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const rawType = normalizeKey(match?.[1] || '');
    return {
        type: VIEW_ALIASES[rawType] || null,
        rawType,
        rest: String(match?.[2] || '').trim(),
        full: text,
    };
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT 1 AS found FROM sqlite_master
         WHERE type = 'table' AND name = ? LIMIT 1`,
        [tableName]
    );
    return Boolean(row?.found);
}

async function tableColumns(db, tableName) {
    const rows = await db.all(`PRAGMA table_info(${tableName})`).catch(() => []);
    return new Set((rows || []).map((row) => row.name));
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

function compactText(text, limit = 3900) {
    const value = String(text || '');
    if (value.length <= limit) return value;
    return `${value.slice(0, limit - 90)}\n\n> Relatório cortado por tamanho. Use uma consulta mais específica.`;
}

function lifecycleLabel(value) {
    const labels = {
        active: 'ativo',
        archived: 'arquivado',
        reactivation_pending: 'reativação pendente',
    };
    return labels[value] || value || 'ativo';
}

function queueLabel(value) {
    const labels = {
        waiting: 'aguardando',
        called: 'chamado',
        concluded: 'concluído',
        removed: 'removido',
        cancelled: 'cancelado',
    };
    return labels[value] || value || '-';
}

async function readLegacyAliases(db, playerId) {
    if (!await tableExists(db, 'clover_player_aliases')) return [];
    const columns = await tableColumns(db, 'clover_player_aliases');
    if (!columns.has('player_id_destino')) return [];
    return db.all(
        `SELECT alias_type, alias_value, source, confidence, active
         FROM clover_player_aliases
         WHERE player_id_destino = ?
         ORDER BY active DESC, updated_at DESC, id DESC
         LIMIT 20`,
        [playerId]
    );
}

async function readStats(db, playerId) {
    if (!await tableExists(db, 'clover_character_stats')) return null;
    return db.get(
        `SELECT stage_key, pb_total, pb_spent, ph_accumulated, ph_available,
                forca, velocidade, agilidade, resistencia, poder_magico,
                distribution_status, updated_at
         FROM clover_character_stats
         WHERE player_id = ?`,
        [playerId]
    );
}

async function readCommunity(db, playerId) {
    if (!await tableExists(db, 'clover_antighost_activity')) return null;
    return db.get(
        `SELECT community_status, last_activity_at, last_activity_kind,
                candidate_at, last_notice_level, exempt_until, exempt_reason
         FROM clover_antighost_activity
         WHERE player_id = ?`,
        [playerId]
    );
}

async function readRecentScriptActions(db, playerId) {
    if (!await tableExists(db, 'clover_script_actions') || !await tableExists(db, 'clover_script_runs')) return [];
    return db.all(
        `SELECT a.id, a.action_type, a.summary, a.status, a.error, a.created_at,
                r.code, r.batch_id
         FROM clover_script_actions a
         JOIN clover_script_runs r ON r.id = a.run_id
         WHERE a.player_id = ?
         ORDER BY a.id DESC
         LIMIT 5`,
        [playerId]
    );
}

async function readPlayerIssues(db, playerId) {
    const report = await diagnoseDatabaseIntegrity(db, { sampleLimit: 3 });
    return report.issues.filter((issue) => (
        issue.playerId === playerId
        || issue.data?.playerIds?.includes?.(playerId)
        || issue.data?.samples?.some?.((sample) => sample.playerId === playerId)
    )).slice(0, 8);
}

async function resolvePlayerViewTarget(db, query, options = {}) {
    await ensureTargetResolverTables(db);
    await ensureTargetResolverSchema(db);
    const kv = parseKv(query);
    const mention = options.mentions?.[0] || null;
    const quoted = options.quotedParticipant || null;
    const explicitId = kv.id || kv.player_id || kv.jid || null;
    const name = kv.nome || kv.name || kv.personagem || kv.character || null;
    const cleaned = String(query || '')
        .replace(/(?:id|player_id|jid|nome|name|personagem|character)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/gi, '')
        .trim();
    const targetId = mention || quoted || explicitId;
    const targetText = name || cleaned;
    if (!targetId && !targetText) {
        return { ok: false, error: 'Informe marcação, resposta, nome, telefone ou player_id.' };
    }
    return resolveTargetPlayer(db, targetId, targetText, { allowShadow: true });
}

async function buildPlayerView(db, query, options = {}) {
    const resolved = await resolvePlayerViewTarget(db, query, options);
    if (!resolved.ok) return { ok: false, error: resolved.error || 'Player não encontrado.', details: resolved.details };
    const player = resolved.player;
    const canonical = await getCanonicalPlayer(db, player.id).catch(() => ({ player, redirected: false }));
    const canonicalPlayer = canonical.player || player;
    const [aliases, legacyAliases, lifecycle, stats, community, actions, issues] = await Promise.all([
        listPlayerTargetAliases(db, canonicalPlayer.id).catch(() => []),
        readLegacyAliases(db, canonicalPlayer.id),
        getPlayerLifecycleState(db, canonicalPlayer.id).catch(() => null),
        readStats(db, canonicalPlayer.id),
        readCommunity(db, canonicalPlayer.id),
        readRecentScriptActions(db, canonicalPlayer.id),
        readPlayerIssues(db, canonicalPlayer.id),
    ]);

    const queue = lifecycle?.queueEntries || [];
    const reservations = lifecycle?.reservations || [];
    const leadership = lifecycle?.leadership || [];
    const aliasLines = [
        ...(aliases || []).map((alias) => `${alias.alias_label || alias.alias_key} [${alias.alias_kind || 'alias'}]`),
        ...(legacyAliases || []).filter((alias) => Number(alias.active || 0) === 1)
            .map((alias) => `${alias.alias_value} [${alias.alias_type}]`),
    ];
    const uniqueAliases = [...new Set(aliasLines)].slice(0, 8);

    const lines = [
        '*♧┃VISÃO ADMINISTRATIVA 𖥔 CLOVER MULTICOLOR*',
        '     ── consulta somente leitura ──',
        '',
        '_`─( ✓ )───── Identidade`_',
        '',
        `*Player:* ${playerDisplayName(canonicalPlayer, canonicalPlayer.id)} (${formatMention(canonicalPlayer.id)})`,
        `*Player ID:* ${canonicalPlayer.id}`,
        canonical.redirected ? `*Redirecionado de:* ${player.id}` : null,
        `*Personagem:* ${canonicalPlayer.personagem_nome || '-'}`,
        `*Nome real:* ${canonicalPlayer.nome_real || canonicalPlayer.display_name || canonicalPlayer.nome || '-'}`,
        `*Sombra:* ${Number(canonicalPlayer.is_shadow || 0) === 1 ? 'sim' : 'não'}`,
        `*Estado de identidade:* ${canonicalPlayer.identity_status || 'active'}`,
        '',
        '_`─( ◆ )───── Estado`_',
        '',
        `*Ciclo de vida:* ${lifecycleLabel(canonicalPlayer.lifecycle_status)}`,
        `*Jogo:* ${canonicalPlayer.jogo_status || '-'}`,
        `*Ficha:* ${canonicalPlayer.ficha_status || '-'}`,
        `*História:* ${canonicalPlayer.historia_status || '-'}`,
        `*Aparência:* ${canonicalPlayer.personagem_aparencia_status || '-'}`,
        `*Comunidade:* ${community?.community_status || 'sem registro'}`,
        `*Esquadrão:* ${canonicalPlayer.esquadrao || '-'}`,
        `*Patente:* ${canonicalPlayer.patente || '-'}`,
        `*Estrelas pessoais:* ${Number(canonicalPlayer.estrelas || 0)}`,
        '',
        '_`─( ✦ )───── Progressão e vínculos`_',
        '',
        stats ? `*PH disponível:* ${Number(stats.ph_available || 0)}` : '*PH disponível:* sem stats',
        stats ? `*PH acumulado:* ${Number(stats.ph_accumulated || 0)}` : '*PH acumulado:* sem stats',
        stats ? `*Estágio:* ${stats.stage_key || '-'}` : '*Estágio:* -',
        stats ? `*PB:* ${Number(stats.pb_spent || 0)}/${Number(stats.pb_total || 0)}` : '*PB:* -',
        `*Fila de feitiços:* ${queue.length ? queue.map((entry) => `${queueLabel(entry.status)} #${entry.id}`).join(', ') : 'fora'}`,
        `*Reservas ativas:* ${reservations.length}`,
        `*Cargos de liderança:* ${leadership.length}`,
        `*Última atividade:* ${community?.last_activity_at || '-'}`,
        '',
        '_`─( ◇ )───── Aliases`_',
        '',
        ...(uniqueAliases.length ? uniqueAliases.map((alias) => `> ${alias}`) : ['> Nenhum alias ativo encontrado.']),
        '',
        '_`─( ■ )───── Integridade`_',
        '',
        ...(issues.length ? issues.map((issue) => `> ${issue.severity === 'critical' ? '!' : '△'} ${issue.message}`) : ['> Nenhuma inconsistência encontrada para este player.']),
        '',
        '_`─( ⧖ )───── Últimas ações CloverScript`_',
        '',
        ...(actions.length ? actions.map((action) => `> ${action.code} · ${action.status} · ${action.summary || action.action_type}`) : ['> Nenhuma ação encontrada.']),
    ];

    return {
        ok: true,
        type: 'player',
        player: canonicalPlayer,
        mentions: [canonicalPlayer.id],
        text: compactText(lines.filter(Boolean).join('\n')),
    };
}

async function buildQueueView(db) {
    const diagnosis = await diagnoseSpellReviewQueue(db);
    const lines = diagnosis.entries.slice(0, 20).map((entry) => {
        const problems = [
            ...entry.integrity.blocking.map((item) => item.message),
            ...entry.integrity.warnings.map((item) => item.message),
        ];
        return [
            `*${entry.position}. ${playerDisplayName(entry, entry.player_id)}*`,
            `> ${queueLabel(entry.status)} · ${entry.player_id}`,
            problems.length ? `> ${entry.integrity.ok ? 'Aviso' : 'Bloqueante'}: ${problems.join(' ')}` : '> Integridade: ok',
        ].join('\n');
    });
    return {
        ok: true,
        type: 'queue',
        mentions: diagnosis.entries.slice(0, 20).map((entry) => entry.player_id),
        text: compactText([
            '*♧┃FILA ADMINISTRATIVA 𖥔 CLOVER MULTICOLOR*',
            '     ── consulta somente leitura ──',
            '',
            `*Ativas:* ${diagnosis.total}`,
            `*Chamados:* ${diagnosis.called}`,
            `*Aguardando:* ${diagnosis.waiting}`,
            `*Bloqueantes:* ${diagnosis.blocking.length}`,
            `*Avisos:* ${diagnosis.warnings.length}`,
            '',
            ...(lines.length ? lines : ['> A fila está vazia.']),
            diagnosis.entries.length > 20 ? `\n> ...e mais ${diagnosis.entries.length - 20} entrada(s).` : null,
        ].filter(Boolean).join('\n')),
    };
}

async function findRun(db, query) {
    if (!await tableExists(db, 'clover_script_runs')) return null;
    const kv = parseKv(query);
    const raw = kv.codigo || kv.code || kv.id || kv.lote || kv.batch || String(query || '').trim();
    const value = String(raw || '').trim();
    if (!value) return null;
    const upper = value.toUpperCase();
    if (/^(CS|CSL|CSU)-/.test(upper)) {
        return db.get('SELECT * FROM clover_script_runs WHERE code = ?', [upper]);
    }
    return db.get(
        `SELECT * FROM clover_script_runs
         WHERE batch_id = ?
         ORDER BY id DESC LIMIT 1`,
        [value]
    );
}

async function buildBatchView(db, query) {
    const run = await findRun(db, query);
    if (!run) return { ok: false, error: 'Lote/simulação não encontrado.' };
    const actions = await db.all(
        `SELECT action_type, status, COUNT(*) AS total
         FROM clover_script_actions
         WHERE run_id = ?
         GROUP BY action_type, status
         ORDER BY status, action_type`,
        [run.id]
    ).catch(() => []);
    const recent = await db.all(
        `SELECT player_id, action_type, summary, status, error
         FROM clover_script_actions
         WHERE run_id = ?
         ORDER BY id DESC LIMIT 10`,
        [run.id]
    ).catch(() => []);
    const job = await tableExists(db, 'clover_script_jobs')
        ? db.get('SELECT * FROM clover_script_jobs WHERE run_id = ?', [run.id])
        : null;
    const plan = safeJsonParse(run.plan_json, {});
    const planned = (plan.blocks || []).reduce((total, block) => (
        total + ((block.targets || []).length * (block.actions || []).length)
    ), 0);

    return {
        ok: true,
        type: 'batch',
        mentions: recent.map((item) => item.player_id).filter(Boolean),
        text: compactText([
            '*♧┃LOTE CLOVERSCRIPT 𖥔 CLOVER MULTICOLOR*',
            '     ── consulta somente leitura ──',
            '',
            `*Código:* ${run.code}`,
            `*Lote:* ${run.batch_id || '-'}`,
            `*Nome:* ${run.batch_name || '-'}`,
            `*Modo:* ${run.mode || '-'}`,
            `*Status:* ${run.status}`,
            `*Ações planejadas:* ${planned}`,
            `*Criado por:* ${run.created_by || '-'}`,
            `*Criado em:* ${run.created_at || '-'}`,
            `*Aplicado por:* ${run.applied_by || '-'}`,
            `*Aplicado em:* ${run.applied_at || '-'}`,
            run.error ? `*Erro:* ${run.error}` : null,
            job ? '' : null,
            job ? '_`─( ⧖ )───── Tarefa`_' : null,
            job ? '' : null,
            job ? `*JOB:* ${job.code}` : null,
            job ? `*Estado:* ${job.status}` : null,
            job ? `*Progresso:* ${job.completed_actions}/${job.total_actions}` : null,
            '',
            '_`─( ◆ )───── Contagem registrada`_',
            '',
            ...(actions.length ? actions.map((item) => `> ${item.status} · ${item.action_type}: ${item.total}`) : ['> Nenhuma ação registrada ainda.']),
            '',
            '_`─( ◇ )───── Últimas ações`_',
            '',
            ...(recent.length ? recent.map((item) => `> ${item.status} · ${item.player_id || '-'} · ${item.summary || item.action_type}${item.error ? ` · ${item.error}` : ''}`) : ['> Nenhuma ação registrada.']),
        ].filter(Boolean).join('\n')),
    };
}

async function buildSquadView(db, query) {
    if (!await tableExists(db, 'clover_squads')) return { ok: false, error: 'Tabela de esquadrões não existe.' };
    const kv = parseKv(query);
    const requested = kv.esquadrao || kv.squad || kv.nome || kv.name || String(query || '').trim();
    const expected = normalizeCompact(requested);
    if (!expected) return { ok: false, error: 'Informe o nome do esquadrão.' };
    const squads = await db.all('SELECT * FROM clover_squads');
    const matches = squads.filter((squad) => (
        normalizeCompact(squad.squad_key) === expected
        || normalizeCompact(squad.name) === expected
        || normalizeCompact(squad.name).includes(expected)
    ));
    if (matches.length !== 1) {
        return {
            ok: false,
            error: matches.length ? `Esquadrão ambíguo: ${matches.map((item) => item.name).join(', ')}.` : 'Esquadrão não encontrado.',
        };
    }
    const squad = matches[0];
    const players = await db.all(
        `SELECT id, personagem_nome, display_name, nome, jogo_status, ficha_status, lifecycle_status, patente, estrelas
         FROM jogadores
         WHERE LOWER(COALESCE(esquadrao, '')) = LOWER(?)
         ORDER BY personagem_nome COLLATE NOCASE, id`,
        [squad.name]
    ).catch(async () => db.all(
        `SELECT id, personagem_nome, display_name, nome, jogo_status, ficha_status, patente, estrelas
         FROM jogadores
         WHERE LOWER(COALESCE(esquadrao, '')) = LOWER(?)
         ORDER BY personagem_nome COLLATE NOCASE, id`,
        [squad.name]
    ));

    return {
        ok: true,
        type: 'squad',
        mentions: players.map((player) => player.id),
        text: compactText([
            '*♧┃VISÃO DO ESQUADRÃO 𖥔 CLOVER MULTICOLOR*',
            '     ── consulta somente leitura ──',
            '',
            `*Esquadrão:* ${squad.name}`,
            `*Chave:* ${squad.squad_key}`,
            `*Estrelas atuais:* ${Number(squad.current_stars || 0)}`,
            `*Estrelas históricas:* ${Number(squad.historical_stars || 0)}`,
            `*Estrelas negras:* ${Number(squad.black_stars || 0)}`,
            `*Capitão:* ${squad.captain_player_id || squad.captain_name || '-'}`,
            `*Vice:* ${squad.vice_captain_player_id || '-'}`,
            `*Grupo:* ${squad.group_id || '-'}`,
            `*Membros:* ${players.length}`,
            '',
            ...(players.length ? players.slice(0, 25).map((player, index) => (
                `> ${index + 1}. ${playerDisplayName(player, player.id)} · ${player.jogo_status || '-'} · ${player.lifecycle_status || 'active'} · ${player.patente || '-'}`
            )) : ['> Nenhum membro vinculado.']),
            players.length > 25 ? `> ...e mais ${players.length - 25} membro(s).` : null,
        ].filter(Boolean).join('\n')),
    };
}

async function buildIntegrityView(db) {
    const report = await diagnoseDatabaseIntegrity(db, { sampleLimit: 3 });
    const sections = Object.entries(report.summary.bySection)
        .filter(([, summary]) => summary.total > 0)
        .sort((a, b) => b[1].critical - a[1].critical || b[1].total - a[1].total);
    return {
        ok: true,
        type: 'integrity',
        mentions: [],
        text: compactText([
            '*♧┃INTEGRIDADE CLOVER 𖥔 CLOVER MULTICOLOR*',
            '     ── resumo somente leitura ──',
            '',
            `*Players:* ${report.players}`,
            `*Tabelas:* ${report.tables}`,
            `*Problemas:* ${report.summary.total}`,
            `*Críticos:* ${report.summary.critical}`,
            `*Avisos:* ${report.summary.warning}`,
            '',
            ...(sections.length ? sections.map(([section, summary]) => (
                `> ${section}: ${summary.total} · críticos ${summary.critical} · avisos ${summary.warning}`
            )) : ['> Nenhuma inconsistência encontrada.']),
            '',
            '> Use .#diagnosticarbanco completo para o relatório detalhado.',
        ].join('\n')),
    };
}

function renderViewHelp() {
    return [
        '*♧┃CONSULTAS CLOVER 𖥔 CLOVER MULTICOLOR*',
        '     ── visão administrativa somente leitura ──',
        '',
        '> .#clover ver player nome="Arthur Pendragon"',
        '> .#clover ver player @player',
        '> .#clover ver fila',
        '> .#clover ver lote codigo=CS-XXXXXX',
        '> .#clover ver lote id="evento-x"',
        '> .#clover ver esquadrao nome="Touros Negros"',
        '> .#clover ver integridade',
    ].join('\n');
}

async function createCloverAdminView(db, rest, options = {}) {
    const parsed = splitView(rest);
    if (!parsed.type) return { ok: false, help: true, error: renderViewHelp() };
    if (parsed.type === 'player') return buildPlayerView(db, parsed.rest, options);
    if (parsed.type === 'queue') return buildQueueView(db);
    if (parsed.type === 'batch') return buildBatchView(db, parsed.rest);
    if (parsed.type === 'squad') return buildSquadView(db, parsed.rest);
    if (parsed.type === 'integrity') return buildIntegrityView(db);
    return { ok: false, help: true, error: renderViewHelp() };
}

module.exports = {
    buildBatchView,
    buildIntegrityView,
    buildPlayerView,
    buildQueueView,
    buildSquadView,
    createCloverAdminView,
    renderViewHelp,
    splitView,
};
