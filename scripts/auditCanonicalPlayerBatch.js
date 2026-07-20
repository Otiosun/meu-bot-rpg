'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { auditCanonicalPlayerBatch } = require('../helpers/clover/playerCanonicalAuditService');

const args = process.argv.slice(2);
const databaseFile = path.resolve(args.find((arg) => arg.startsWith('--db='))?.slice('--db='.length) || 'banco.sqlite');
const manifestFile = path.resolve(args.find((arg) => arg.startsWith('--manifest='))?.slice('--manifest='.length) || 'data/player-canonical-batch-1.json');
const outputDir = path.resolve(args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) || 'backups');

function escapeCell(value) {
    return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function listTitles(entries = []) {
    return entries.map((item) => item.title || item).filter(Boolean).join(', ') || '—';
}

function renderMarkdown(report) {
    const lines = [];
    lines.push('# Auditoria canônica — lote inicial');
    lines.push('');
    lines.push(`Gerado em: ${report.generatedAt}`);
    lines.push('');
    lines.push('> Modo somente leitura. Nenhum dado foi alterado.');
    lines.push('');
    lines.push('## Resumo');
    lines.push('');
    lines.push(`- Personagens solicitados: ${report.summary.requestedPlayers}`);
    lines.push(`- Resolvidos: ${report.summary.resolved}`);
    lines.push(`- Ambíguos: ${report.summary.ambiguous}`);
    lines.push(`- Não encontrados: ${report.summary.unresolved}`);
    lines.push(`- Resolvidos e ativos: ${report.summary.activeResolved}`);
    lines.push(`- Recomendações: ${report.summary.recommendations}`);
    lines.push(`- Bloqueios de identidade: ${report.summary.blockers}`);
    lines.push('');
    lines.push('## Visão geral');
    lines.push('');
    lines.push('| Referência | Resolução | Cadastro | Ativo | Traço do sistema | Traços pessoais | Ganchos | Itens narrativos |');
    lines.push('|---|---|---|---:|---|---|---|---|');
    for (const player of report.players) {
        lines.push(`| ${escapeCell(player.referenceName)} | ${escapeCell(player.resolution.status)} | ${escapeCell(player.snapshot?.name || '—')} | ${player.snapshot?.active ? 'sim' : 'não'} | ${escapeCell(player.intended?.systemTrait?.matched || player.intended?.systemTraits?.join(' / ') || '—')} | ${escapeCell(listTitles(player.intended?.customTraits))} | ${escapeCell(listTitles(player.intended?.narrativeHooks))} | ${escapeCell(listTitles(player.intended?.narrativeItems))} |`);
    }
    lines.push('');

    for (const player of report.players) {
        lines.push(`## ${player.referenceName}`);
        lines.push('');
        lines.push(`**Resolução:** ${player.resolution.status}${player.resolution.confidence ? ` (${player.resolution.confidence})` : ''}`);
        if (player.resolution.reasons?.length) lines.push(`**Motivos:** ${player.resolution.reasons.join('; ')}`);
        if (!player.snapshot) {
            lines.push('');
            lines.push('### Candidatos');
            lines.push('');
            if (!player.resolution.candidates?.length) lines.push('- Nenhum candidato encontrado.');
            for (const candidate of player.resolution.candidates || []) {
                lines.push(`- ${candidate.name} — ${candidate.playerId} — score ${candidate.score} — ${candidate.jogoStatus || 'sem status'}`);
            }
        } else {
            lines.push(`**Cadastro:** ${player.snapshot.name} — ${player.snapshot.playerId}`);
            lines.push(`**Estado:** ficha ${player.snapshot.fichaStatus || '—'}; jogo ${player.snapshot.jogoStatus || '—'}; história ${player.snapshot.historiaStatus || '—'}`);
            lines.push(`**Esquadrão:** ${player.snapshot.squad || '—'}`);
            lines.push('');
            lines.push('### Estado atual');
            lines.push('');
            lines.push(`- Traços registrados: ${player.snapshot.traits.map((item) => item.label || item.key).filter(Boolean).join(', ') || 'nenhum'}`);
            lines.push(`- Gancho atual: ${player.snapshot.profile.narrativeHook || 'nenhum'}`);
            lines.push(`- Itens no inventário: ${player.snapshot.inventory.length}`);
            lines.push(`- Compras de capacidade: ${player.snapshot.skills.length}`);
            lines.push('');
            lines.push('### Organização proposta');
            lines.push('');
            lines.push(`- Traço do sistema: ${player.intended.systemTrait.acceptableLabels.join(' / ') || 'nenhum'} — ${player.intended.systemTrait.status}`);
            for (const item of player.intended.customTraits) lines.push(`- Traço pessoal: **${item.title}** — ${item.presence}`);
            for (const item of player.intended.narrativeHooks) lines.push(`- Gancho narrativo: **${item.title}** — ${item.presence}`);
            for (const item of player.intended.narrativeItems) lines.push(`- Item narrativo: **${item.title}** — ${item.presence}`);
            for (const note of player.intended.notes || []) lines.push(`- Nota: ${note}`);
        }
        lines.push('');
        lines.push('### Próximas ações');
        lines.push('');
        if (!player.recommendations.length) lines.push('- Nenhuma ação necessária neste estágio.');
        for (const action of player.recommendations) {
            lines.push(`- **${action.priority} · ${action.action}:** ${action.detail}`);
        }
        lines.push('');
    }

    return `${lines.join('\n')}\n`;
}

(async () => {
    if (!fs.existsSync(databaseFile)) throw new Error(`Banco não encontrado: ${databaseFile}`);
    if (!fs.existsSync(manifestFile)) throw new Error(`Manifesto não encontrado: ${manifestFile}`);

    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const db = await open({ filename: databaseFile, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
    let report;
    try {
        await db.exec('PRAGMA query_only = ON');
        report = await auditCanonicalPlayerBatch(db, manifest);
    } finally {
        await db.close();
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonFile = path.join(outputDir, `canonical-player-batch-1-${stamp}.json`);
    const markdownFile = path.join(outputDir, `canonical-player-batch-1-${stamp}.md`);
    fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(markdownFile, renderMarkdown(report), 'utf8');

    console.log('\n=== AUDITORIA CANÔNICA — LOTE INICIAL ===');
    console.log('Modo: SOMENTE LEITURA');
    console.log(`Banco: ${databaseFile}`);
    console.log(`Manifesto: ${manifestFile}`);
    console.log(`Personagens solicitados: ${report.summary.requestedPlayers}`);
    console.log(`Resolvidos: ${report.summary.resolved}`);
    console.log(`Ambíguos: ${report.summary.ambiguous}`);
    console.log(`Não encontrados: ${report.summary.unresolved}`);
    console.log(`Resolvidos e ativos: ${report.summary.activeResolved}`);
    console.log(`Recomendações: ${report.summary.recommendations}`);
    console.log(`Bloqueios: ${report.summary.blockers}`);

    console.log('\n=== RESOLUÇÃO POR PERSONAGEM ===');
    for (const player of report.players) {
        const id = player.snapshot?.playerId || '—';
        const active = player.snapshot?.active ? 'ativo' : player.snapshot ? 'não ativo' : 'sem cadastro';
        console.log(`- ${player.referenceName}: ${player.resolution.status} · ${active} · ${id}`);
        for (const action of player.recommendations.filter((item) => item.priority === 'blocker')) {
            console.log(`  BLOQUEIO: ${action.detail}`);
        }
    }

    console.log('\nRelatórios salvos em:');
    console.log(jsonFile);
    console.log(markdownFile);
    console.log('\nNenhum dado foi alterado.');
})().catch((error) => {
    console.error('\nFALHA NA AUDITORIA CANÔNICA:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
