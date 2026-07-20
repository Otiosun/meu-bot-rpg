'use strict';

const fs = require('fs');
const path = require('path');

const OPTIONAL_REVIEW_CODES = new Set(['hook_missing']);

const LEGACY_NODE_MAP = Object.freeze({
    fisico_root: 'fisico',
    vigor_base: 'vigor',
    controle_corporal_base: 'controle_corporal',
});

const SAFE_TEXT_SUGGESTIONS = Object.freeze({
    'Elizabeth:aptidao_comum:Olhar Anal?tico': 'Olhar Analítico',
    'Noctos Sun:gancho_narrativo:A Praga N?o Levou Tudo': 'A Praga Não Levou Tudo',
    'Noctos Sun:marca_rara:D?vida de Vida': 'Dívida de Vida',
    'Zahir Al-Nur:gancho_narrativo:B?ssola do Rei N?o-Nascido': 'Bússola do Rei Não-Nascido',
    'Zahir Al-Nur:marca_rara:D?vida de Vida': 'Dívida de Vida',
});

function issueKey(issue) {
    return `${issue.characterName || ''}:${issue.field || ''}:${typeof issue.current === 'string' ? issue.current : ''}`;
}

function classifyIssue(issue) {
    if (OPTIONAL_REVIEW_CODES.has(issue.code)) {
        return {
            bucket: 'optional_review',
            action: 'Não corrigir automaticamente. Gancho narrativo não é obrigatório para todo personagem.',
            automatic: false,
        };
    }

    if (issue.code === 'legacy_node_unknown') {
        const mapped = LEGACY_NODE_MAP[issue.current] || null;
        return {
            bucket: mapped ? 'legacy_mapping_candidate' : 'legacy_manual_review',
            action: mapped
                ? `Comparar com clover_skill_nodes; candidato conhecido: ${issue.current} → ${mapped}.`
                : 'Comparar registro legado, compras canônicas e histórico antes de mapear.',
            automatic: false,
            suggestedValue: mapped,
        };
    }

    if (issue.code === 'trait_label_key_mismatch') {
        return {
            bucket: 'catalog_lookup',
            action: 'Resolver a chave exata no catálogo de traços e preencher somente o lado ausente.',
            automatic: false,
        };
    }

    if (issue.code.endsWith('_encoding')) {
        const suggestion = SAFE_TEXT_SUGGESTIONS[issueKey(issue)] || null;
        return {
            bucket: suggestion ? 'text_candidate_high_confidence' : 'backup_required',
            action: suggestion
                ? 'Confirmar no backup/ficha original antes de aplicar a substituição sugerida.'
                : 'Recuperar o texto integral em backup ou ficha canônica; o relatório pode conter valor truncado.',
            automatic: false,
            suggestedValue: suggestion,
        };
    }

    if (issue.code === 'profile_required_missing') {
        return {
            bucket: 'profile_source_required',
            action: 'Comparar ficha aprovada, cadastro antigo e backups. Não inventar classe ausente.',
            automatic: false,
        };
    }

    return {
        bucket: 'manual_review',
        action: issue.suggestedAction || 'Revisar manualmente antes de alterar o banco.',
        automatic: false,
    };
}

function buildRepairPlan(report) {
    if (!report || !Array.isArray(report.issues)) {
        throw new Error('Relatório de auditoria inválido.');
    }

    const entries = report.issues.map((issue, index) => ({
        id: index + 1,
        ...issue,
        classification: classifyIssue(issue),
    }));

    const actionable = entries.filter((entry) => entry.classification.bucket !== 'optional_review');
    const optional = entries.filter((entry) => entry.classification.bucket === 'optional_review');
    const byPlayer = new Map();

    for (const entry of actionable) {
        const key = entry.playerId || `global:${entry.entity || entry.id}`;
        if (!byPlayer.has(key)) {
            byPlayer.set(key, {
                playerId: entry.playerId,
                characterName: entry.characterName || 'Registro global',
                entries: [],
            });
        }
        byPlayer.get(key).entries.push(entry);
    }

    const bucketCounts = {};
    for (const entry of entries) {
        const bucket = entry.classification.bucket;
        bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
    }

    return {
        ok: true,
        readOnly: true,
        generatedAt: new Date().toISOString(),
        source: {
            generatedAt: report.generatedAt || null,
            database: report.database || null,
            originalSummary: report.summary || null,
        },
        summary: {
            originalIssues: entries.length,
            optionalReviewsExcluded: optional.length,
            actionableIssues: actionable.length,
            actionablePlayers: byPlayer.size,
            bucketCounts,
            automaticRepairs: 0,
        },
        players: [...byPlayer.values()].sort((a, b) => a.characterName.localeCompare(b.characterName, 'pt-BR')),
        optionalReviews: optional,
    };
}

function escapeMarkdown(value) {
    return String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderMarkdown(plan) {
    const lines = [
        '# Plano de reparo dos dados dos jogadores',
        '',
        `Gerado em: ${plan.generatedAt}`,
        '',
        '## Resumo',
        '',
        `- Apontamentos originais: ${plan.summary.originalIssues}`,
        `- Revisões opcionais excluídas da fila de correção: ${plan.summary.optionalReviewsExcluded}`,
        `- Apontamentos acionáveis: ${plan.summary.actionableIssues}`,
        `- Jogadores acionáveis: ${plan.summary.actionablePlayers}`,
        `- Correções automáticas autorizadas: ${plan.summary.automaticRepairs}`,
        '',
        '> Este plano não altera o SQLite. Toda sugestão exige comparação com backup, ficha aprovada, catálogo ou histórico.',
        '',
        '## Jogadores',
        '',
    ];

    for (const player of plan.players) {
        lines.push(`### ${player.characterName}`);
        lines.push('');
        lines.push('| Campo | Código | Classificação | Valor atual | Sugestão | Próxima ação |');
        lines.push('|---|---|---|---|---|---|');
        for (const entry of player.entries) {
            lines.push(`| ${escapeMarkdown(entry.field)} | ${escapeMarkdown(entry.code)} | ${escapeMarkdown(entry.classification.bucket)} | ${escapeMarkdown(typeof entry.current === 'object' ? JSON.stringify(entry.current) : entry.current)} | ${escapeMarkdown(entry.classification.suggestedValue)} | ${escapeMarkdown(entry.classification.action)} |`);
        }
        lines.push('');
    }

    lines.push('## Revisões opcionais fora da fila');
    lines.push('');
    lines.push(`Foram encontrados ${plan.summary.optionalReviewsExcluded} personagens liberados sem gancho narrativo. Isso não será tratado como corrupção por padrão, porque o campo é opcional e pode nunca ter sido concedido.`);
    lines.push('');
    return `${lines.join('\n')}\n`;
}

function loadReport(reportPath) {
    const absolute = path.resolve(reportPath);
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

module.exports = {
    LEGACY_NODE_MAP,
    OPTIONAL_REVIEW_CODES,
    SAFE_TEXT_SUGGESTIONS,
    buildRepairPlan,
    classifyIssue,
    loadReport,
    renderMarkdown,
};
