'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const PLAN_ARG = args.find((arg) => arg.startsWith('--plan='))?.slice('--plan='.length) || null;
const OUTPUT_DIR = path.resolve(args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length) || 'backups');

const TARGETS = new Map([
    ['5511959362194', { kind: 'manual', canonicalId: '206545145098459@lid', dataOwnerId: '206545145098459@lid' }],
    ['554799685887', { kind: 'manual', canonicalId: '86663984324791@lid', dataOwnerId: '554799685887@s.whatsapp.net' }],
    ['559985412280', { kind: 'manual', canonicalId: '149701705904226@lid', dataOwnerId: '149701705904226@lid' }],
    ['244947382093', { kind: 'migration', canonicalId: '65683454992605@lid', dataOwnerId: '244947382093@s.whatsapp.net' }],
    ['5521982456465', { kind: 'migration', canonicalId: '42297542578405@lid', dataOwnerId: '5521982456465@s.whatsapp.net', label: 'Maksim' }],
    ['557999178806', { kind: 'migration', canonicalId: '19533913923724@lid', dataOwnerId: '557999178806@s.whatsapp.net' }],
    ['559888768701', { kind: 'migration', canonicalId: '76738801471621@lid', dataOwnerId: '559888768701@s.whatsapp.net' }],
]);

function latestPlan(directory) {
    if (!fs.existsSync(directory)) return null;
    return fs.readdirSync(directory)
        .filter((name) => /^identity-repair-plan-.*\.json$/i.test(name))
        .map((name) => ({
            file: path.join(directory, name),
            modifiedAt: fs.statSync(path.join(directory, name)).mtimeMs,
        }))
        .sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.file || null;
}

function loadPlan() {
    const filename = PLAN_ARG ? path.resolve(PLAN_ARG) : latestPlan(OUTPUT_DIR);
    if (!filename || !fs.existsSync(filename)) {
        throw new Error('Plano-base não encontrado. Rode npm run audit:identity e npm run plan:identity primeiro.');
    }
    const plan = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(plan.groups) || plan.readOnly !== true) {
        throw new Error('Plano-base inválido ou sem marcação readOnly.');
    }
    return { filename, plan };
}

function fallbackStrategy(table, column) {
    const key = `${table}.${column}`;
    if (key === 'jogadores.id') return 'source_record';
    if (key === 'clover_player_aliases.alias_value') return 'preserve_alias_value';
    if (key === 'clover_player_target_aliases.alias_label') return 'preserve_alias_value';
    if (key === 'player_onboarding.player_id') return 'merge_or_delete_auxiliary';
    if (key === 'clover_character_stats.player_id') return 'merge_singleton';
    if (key === 'clover_mana_hexagon.player_id') return 'merge_singleton';
    if (key === 'clover_archive_cards.player_id') return 'merge_singleton';
    if (key === 'jogadores.canonical_player_id' || key === 'jogadores.merged_into') {
        return 'repoint_to_canonical';
    }
    if (/(?:^|_)(?:created|updated|approved|evaluated|purchased|released)_by$/i.test(column)
        || /^(?:evaluator_id|actor_id|admin_id)$/i.test(column)) {
        return 'repoint_actor';
    }
    if (/^(?:target_jid|recipient_jid)$/i.test(column)) return 'repoint_target';
    return 'repoint_owned_data';
}

function normalizeSource(source) {
    const references = (source.references || []).map((reference) => ({
        ...reference,
        strategy: reference.strategy === 'unknown'
            ? fallbackStrategy(reference.table, reference.column)
            : reference.strategy,
    }));

    const unknownReferences = references.filter((reference) => reference.strategy === 'unknown');
    return {
        ...source,
        references,
        unknownReferences,
        activeMigrationReferences: references.filter((reference) => !['source_record', 'preserve_alias_value', 'merge_or_delete_auxiliary'].includes(reference.strategy)),
    };
}

function buildTargetGroup(group, target) {
    if (group.canonicalId !== target.canonicalId) {
        throw new Error(`ID canônico inesperado para ${group.phone}: ${group.canonicalId}`);
    }
    if (group.dataOwnerId !== target.dataOwnerId) {
        throw new Error(`Dono dos dados inesperado para ${group.phone}: ${group.dataOwnerId}`);
    }

    const sources = (group.sources || []).map(normalizeSource);
    const unknown = sources.flatMap((source) => source.unknownReferences || []);
    if (unknown.length) {
        throw new Error(`Ainda existem referências sem estratégia para ${group.phone}.`);
    }

    return {
        ...group,
        label: target.label || null,
        sources,
        action: target.kind === 'manual'
            ? 'transactional_manual_merge'
            : 'transactional_canonical_migration',
        readyForExecutor: true,
        targetedIdentityRepair: true,
        conflictPolicy: 'data_owner_wins_archive',
        manualMergePolicy: target.kind === 'manual'
            ? 'data_owner_wins_fill_missing'
            : null,
        reason: target.kind === 'manual'
            ? 'Fusão individual autorizada: o dono dos dados vence conflitos e campos vazios são preenchidos pelo cadastro secundário.'
            : 'Migração canônica autorizada: todas as referências conhecidas serão reatribuídas ao LID correto.',
    };
}

(function main() {
    const { filename: sourcePlan, plan } = loadPlan();
    const byPhone = new Map(plan.groups.map((group) => [String(group.phone), group]));
    const missing = [...TARGETS.keys()].filter((phone) => !byPhone.has(phone));
    if (missing.length) {
        throw new Error(`Casos especiais ausentes no plano-base: ${missing.join(', ')}`);
    }

    const groups = [...TARGETS.entries()].map(([phone, target]) => (
        buildTargetGroup(byPhone.get(phone), target)
    ));

    const output = {
        generatedAt: new Date().toISOString(),
        database: plan.database,
        sourcePlan,
        readOnly: true,
        targetedRepair: 'seven_special_identity_cases',
        groupsAnalyzed: groups.length,
        readyForExecutor: groups.length,
        blockedOrUnknown: 0,
        groups,
    };

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = path.join(OUTPUT_DIR, `identity-seven-repair-plan-${stamp}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf8');

    console.log('\n=== PLANO DOS SETE CASOS ESPECIAIS ===');
    console.log(`Plano-base: ${sourcePlan}`);
    console.log(`Casos preparados: ${groups.length}`);
    console.log('Fusões manuais: 3');
    console.log('Migrações canônicas: 4');
    console.log(`Maksim: ${TARGETS.get('5521982456465').canonicalId}`);
    console.log(`Plano salvo em: ${outputFile}`);
    console.log('\nNenhum dado foi alterado.');
})().catch((error) => {
    console.error('\nFALHA NO PLANO DOS SETE CASOS:');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
