'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const EXPECTED_TABLES = Object.freeze([
    'jogadores',
    'clover_admin_roles',
    'clover_access_roles',
    'clover_squads',
    'clover_squad_memberships',
    'clover_captain_profiles',
    'clover_squad_star_ledger',
    'clover_admin_operations',
    'clover_admin_operation_units',
]);

function parseArgs(argv) {
    const options = {
        db: './banco.sqlite',
        output: null,
        expectedSha: process.env.CLOVER_DEPLOY_SHA || null,
        failOnCritical: false,
        jsonOnly: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--fail-on-critical') options.failOnCritical = true;
        else if (arg === '--json-only') options.jsonOnly = true;
        else if (arg === '--db') options.db = argv[++index];
        else if (arg.startsWith('--db=')) options.db = arg.slice(5);
        else if (arg === '--output') options.output = argv[++index];
        else if (arg.startsWith('--output=')) options.output = arg.slice(9);
        else if (arg === '--expected-sha') options.expectedSha = argv[++index];
        else if (arg.startsWith('--expected-sha=')) options.expectedSha = arg.slice(15);
        else throw new Error(`Argumento desconhecido: ${arg}`);
    }
    return options;
}

function quote(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function normalize(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

function squadKey(value) {
    return normalize(value)
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function issue(severity, category, code, message, details = null) {
    return { severity, category, code, message, details };
}

function addIssue(report, finding) {
    report.issues.push(finding);
    report.summary.total += 1;
    report.summary[finding.severity] = (report.summary[finding.severity] || 0) + 1;
    report.summary.bySeverity[finding.severity] = (report.summary.bySeverity[finding.severity] || 0) + 1;
    report.summary.byCategory[finding.category] = (report.summary.byCategory[finding.category] || 0) + 1;
}

function git(args) {
    try {
        return execFileSync('git', args, {
            cwd: path.resolve(__dirname, '..'),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null;
    } catch {
        return null;
    }
}

function digest(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function readSchema(db) {
    const rows = await db.all(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name ASC
    `);
    const schema = new Map();
    for (const row of rows) {
        const columns = await db.all(`PRAGMA table_info(${quote(row.name)})`);
        schema.set(row.name, new Set(columns.map((column) => column.name)));
    }
    return schema;
}

function has(schema, table, columns = []) {
    const available = schema.get(table);
    return Boolean(available) && columns.every((column) => available.has(column));
}

function column(schema, table, name, fallback = 'NULL') {
    return has(schema, table, [name]) ? quote(name) : `${fallback} AS ${quote(name)}`;
}

async function grouped(db, schema, table, name) {
    if (!has(schema, table, [name])) return [];
    return db.all(`
        SELECT ${quote(name)} AS value, COUNT(*) AS count
        FROM ${quote(table)}
        GROUP BY ${quote(name)}
        ORDER BY count DESC, value ASC
    `);
}

async function auditRoles(db, schema, report) {
    const adminRows = has(schema, 'clover_admin_roles', ['player_id', 'role', 'active'])
        ? await db.all(`SELECT player_id, role, active FROM clover_admin_roles ORDER BY player_id`)
        : [];
    const accessRows = has(schema, 'clover_access_roles', ['id', 'subject_id', 'role_key', 'scope_type', 'scope_key', 'status'])
        ? await db.all(`
            SELECT id, subject_id, role_key, scope_type, scope_key, status
            FROM clover_access_roles
            ORDER BY subject_id, role_key, scope_key, id
        `)
        : [];

    const activeAdmin = adminRows.filter((row) => number(row.active) === 1);
    const activeAccess = accessRows.filter((row) => row.status === 'active');
    const globalAccess = new Set(activeAccess
        .filter((row) => row.scope_type === 'global' && row.scope_key === '*')
        .map((row) => `${row.subject_id}::${row.role_key}`));
    const central = new Set(activeAdmin.map((row) => `${row.player_id}::${row.role}`));

    for (const row of activeAdmin) {
        if (row.role === 'assistant') {
            addIssue(report, issue(
                'warning', 'roles', 'assistant_without_operational_equivalent',
                'Auxiliar ativo na Central não possui papel operacional equivalente.',
                { subjectId: row.player_id }
            ));
            continue;
        }
        if (!globalAccess.has(`${row.player_id}::${row.role}`)) {
            addIssue(report, issue(
                ['admin', 'evaluator'].includes(row.role) ? 'critical' : 'warning',
                'roles', 'admin_role_missing_in_access_control',
                'Cargo ativo na Central não possui concessão operacional global equivalente.',
                { subjectId: row.player_id, role: row.role }
            ));
        }
    }

    for (const row of activeAccess.filter((item) => (
        item.scope_type === 'global'
        && item.scope_key === '*'
        && ['admin', 'evaluator', 'narrator'].includes(item.role_key)
    ))) {
        if (!central.has(`${row.subject_id}::${row.role_key}`)) {
            addIssue(report, issue(
                ['admin', 'evaluator'].includes(row.role_key) ? 'critical' : 'warning',
                'roles', 'access_role_missing_in_admin_team',
                'Concessão operacional ativa não possui cargo equivalente ativo na Central.',
                { subjectId: row.subject_id, role: row.role_key, assignmentId: row.id }
            ));
        }
    }

    report.evidence.roles = {
        adminRows,
        accessRows,
        activeAdminCount: activeAdmin.length,
        activeAccessCount: activeAccess.length,
    };
}

async function auditMemberships(db, schema, report) {
    const players = has(schema, 'jogadores', ['id'])
        ? await db.all(`
            SELECT id,
                   ${column(schema, 'jogadores', 'personagem_nome')},
                   ${column(schema, 'jogadores', 'esquadrao')},
                   ${column(schema, 'jogadores', 'ficha_status')},
                   ${column(schema, 'jogadores', 'jogo_status')}
            FROM jogadores ORDER BY id
        `)
        : [];
    const memberships = has(schema, 'clover_squad_memberships', ['id', 'squad_key', 'player_id', 'status'])
        ? await db.all(`
            SELECT id, squad_key, player_id, status,
                   ${column(schema, 'clover_squad_memberships', 'joined_at')},
                   ${column(schema, 'clover_squad_memberships', 'ended_at')}
            FROM clover_squad_memberships ORDER BY player_id, id
        `)
        : [];
    const squads = has(schema, 'clover_squads', ['squad_key'])
        ? await db.all(`
            SELECT squad_key,
                   ${column(schema, 'clover_squads', 'name')},
                   ${column(schema, 'clover_squads', 'captain_player_id')},
                   ${column(schema, 'clover_squads', 'current_stars', '0')},
                   ${column(schema, 'clover_squads', 'historical_stars', '0')},
                   ${column(schema, 'clover_squads', 'black_stars', '0')}
            FROM clover_squads ORDER BY squad_key
        `)
        : [];

    const playerById = new Map(players.map((row) => [row.id, row]));
    const squadKeys = new Set(squads.map((row) => squadKey(row.squad_key)));
    const active = memberships.filter((row) => row.status === 'active');
    const activeByPlayer = new Map();
    for (const membership of active) {
        if (!activeByPlayer.has(membership.player_id)) activeByPlayer.set(membership.player_id, []);
        activeByPlayer.get(membership.player_id).push(membership);
    }

    for (const [playerId, rows] of activeByPlayer.entries()) {
        if (rows.length > 1) {
            addIssue(report, issue(
                'critical', 'memberships', 'multiple_active_memberships',
                'Um personagem possui mais de um vínculo ativo.',
                { playerId, membershipIds: rows.map((row) => row.id), squadKeys: rows.map((row) => row.squad_key) }
            ));
        }
    }

    for (const membership of active) {
        const player = playerById.get(membership.player_id);
        if (!player) {
            addIssue(report, issue(
                'critical', 'memberships', 'active_membership_without_player',
                'Vínculo ativo aponta para personagem inexistente.',
                { membershipId: membership.id, playerId: membership.player_id, squadKey: membership.squad_key }
            ));
            continue;
        }
        if (!squadKeys.has(squadKey(membership.squad_key))) {
            addIssue(report, issue(
                'critical', 'memberships', 'active_membership_without_squad',
                'Vínculo ativo aponta para esquadrão inexistente.',
                { membershipId: membership.id, playerId: membership.player_id, squadKey: membership.squad_key }
            ));
        }
        const legacy = squadKey(player.esquadrao);
        const canonical = squadKey(membership.squad_key);
        if (legacy && legacy !== canonical) {
            addIssue(report, issue(
                'critical', 'memberships', 'membership_legacy_disagreement',
                'Vínculo ativo e jogadores.esquadrao discordam.',
                { membershipId: membership.id, playerId: membership.player_id, canonical, legacy, legacyValue: player.esquadrao }
            ));
        }
        const ficha = normalize(player.ficha_status);
        const jogo = normalize(player.jogo_status);
        if ((ficha && !['aprovada', 'confirmada'].includes(ficha)) || (jogo && jogo !== 'liberado')) {
            addIssue(report, issue(
                'warning', 'memberships', 'active_member_outside_current_eligibility',
                'Membro ativo não satisfaz a política atual de ficha/jogo.',
                { membershipId: membership.id, playerId: membership.player_id, fichaStatus: player.ficha_status, jogoStatus: player.jogo_status }
            ));
        }
    }

    for (const player of players) {
        const legacy = squadKey(player.esquadrao);
        if (legacy && !activeByPlayer.has(player.id)) {
            addIssue(report, issue(
                'warning', 'memberships', 'legacy_squad_without_active_membership',
                'jogadores.esquadrao possui valor, mas não existe vínculo ativo correspondente.',
                { playerId: player.id, legacySquad: player.esquadrao, legacySquadKey: legacy }
            ));
        }
    }

    const captainRoles = report.evidence.roles.accessRows.filter((row) => (
        row.status === 'active' && row.role_key === 'captain' && row.scope_type === 'squad'
    ));
    const captainRoleKeys = new Set(captainRoles.map((row) => `${row.subject_id}::${squadKey(row.scope_key)}`));
    for (const squad of squads) {
        if (!squad.captain_player_id) continue;
        if (!playerById.has(squad.captain_player_id)) {
            addIssue(report, issue(
                'critical', 'captains', 'squad_captain_without_player',
                'Esquadrão aponta para Capitão inexistente em jogadores.',
                { squadKey: squad.squad_key, captainPlayerId: squad.captain_player_id }
            ));
        }
        if (!captainRoleKeys.has(`${squad.captain_player_id}::${squadKey(squad.squad_key)}`)) {
            addIssue(report, issue(
                'critical', 'captains', 'squad_captain_without_scoped_role',
                'Capitão registrado não possui concessão ativa escopada ao mesmo esquadrão.',
                { squadKey: squad.squad_key, captainPlayerId: squad.captain_player_id }
            ));
        }
    }

    report.evidence.memberships = {
        playerCount: players.length,
        squadCount: squads.length,
        membershipCount: memberships.length,
        activeCount: active.length,
    };
    return { players, squads, memberships, active };
}

async function auditStars(db, schema, report, membershipEvidence) {
    const rows = has(schema, 'clover_squad_star_ledger', ['squad_key', 'amount'])
        ? await db.all(`
            SELECT rowid AS row_id, squad_key,
                   ${column(schema, 'clover_squad_star_ledger', 'player_id')},
                   amount,
                   ${column(schema, 'clover_squad_star_ledger', 'kind')},
                   ${column(schema, 'clover_squad_star_ledger', 'source')},
                   ${column(schema, 'clover_squad_star_ledger', 'reason')}
            FROM clover_squad_star_ledger ORDER BY rowid
        `)
        : [];
    const synthetic = rows.filter((row) => row.source === 'squad_reconcile');
    const negative = rows.filter((row) => number(row.amount) < 0);

    if (synthetic.length) {
        addIssue(report, issue(
            'critical', 'stars', 'legacy_squad_reconcile_entries_present',
            'Existem lançamentos sintéticos criados pelo reconciliador legado.',
            {
                count: synthetic.length,
                totalAmount: synthetic.reduce((total, row) => total + number(row.amount), 0),
                squads: [...new Set(synthetic.map((row) => row.squad_key))],
            }
        ));
    }
    if (negative.length) {
        addIssue(report, issue(
            'warning', 'stars', 'negative_star_ledger_entries_require_semantic_classification',
            'Lançamentos negativos precisam ser classificados por efeito econômico antes da migração.',
            { count: negative.length, totalAmount: negative.reduce((total, row) => total + number(row.amount), 0) }
        ));
    }

    for (const squad of membershipEvidence.squads) {
        const current = number(squad.current_stars);
        const historical = number(squad.historical_stars);
        const black = number(squad.black_stars);
        if (current < 0 || historical < 0 || black < 0) {
            addIssue(report, issue(
                'critical', 'stars', 'negative_squad_aggregate',
                'Esquadrão possui agregado negativo de Estrelas.',
                { squadKey: squad.squad_key, current, historical, black }
            ));
        }
        if (historical < current) {
            addIssue(report, issue(
                'critical', 'stars', 'historical_stars_below_current',
                'Histórico vitalício está abaixo do saldo atual.',
                { squadKey: squad.squad_key, current, historical }
            ));
        }
    }

    report.evidence.stars = {
        ledgerCount: rows.length,
        syntheticCount: synthetic.length,
        negativeCount: negative.length,
        relatedTables: [...schema.entries()]
            .filter(([name]) => /(star|estrela|season|temporad)/i.test(name))
            .map(([name, columns]) => ({ name, columns: [...columns].sort() })),
    };
}

async function auditOperations(db, schema, report) {
    const operations = has(schema, 'clover_admin_operations', ['id', 'code', 'status'])
        ? await db.all(`SELECT id, code, status FROM clover_admin_operations ORDER BY id`)
        : [];
    const units = has(schema, 'clover_admin_operation_units', ['id', 'operation_id', 'status'])
        ? await db.all(`
            SELECT id, operation_id, status,
                   ${column(schema, 'clover_admin_operation_units', 'applied_at')},
                   ${column(schema, 'clover_admin_operation_units', 'undone_at')}
            FROM clover_admin_operation_units ORDER BY operation_id, id
        `)
        : [];
    const partial = operations.filter((row) => row.status === 'partially_applied');
    if (partial.length) {
        addIssue(report, issue(
            'critical', 'operations', 'partially_applied_operations_present',
            'Existem operações administrativas parcialmente aplicadas sem garantia de recuperação.',
            { count: partial.length, codes: partial.map((row) => row.code) }
        ));
    }

    const operationById = new Map(operations.map((row) => [row.id, row]));
    for (const unit of units) {
        const parent = operationById.get(unit.operation_id);
        if (!parent) {
            addIssue(report, issue(
                'critical', 'operations', 'operation_unit_without_parent',
                'Unidade administrativa aponta para operação inexistente.',
                { unitId: unit.id, operationId: unit.operation_id }
            ));
            continue;
        }
        const mutated = Boolean(unit.applied_at) || ['applied', 'undone'].includes(unit.status);
        if (mutated && !['applied', 'undone', 'partially_applied'].includes(parent.status)) {
            addIssue(report, issue(
                'critical', 'operations', 'mutated_unit_outside_parent_state',
                'Unidade mutada pertence a operação-pai em estado incompatível.',
                { unitId: unit.id, operationId: parent.id, operationCode: parent.code, operationStatus: parent.status, unitStatus: unit.status }
            ));
        }
    }

    report.evidence.operations = {
        operationCount: operations.length,
        unitCount: units.length,
        statusCounts: Object.fromEntries([...new Set(operations.map((row) => row.status))]
            .map((status) => [status, operations.filter((row) => row.status === status).length])),
        unitStatusCounts: Object.fromEntries([...new Set(units.map((row) => row.status))]
            .map((status) => [status, units.filter((row) => row.status === status).length])),
    };
}

async function inventoryWorkflowTables(db, schema) {
    const output = [];
    for (const [name, columns] of schema.entries()) {
        if (!/(reward|recompens|proposal|proposta|raid)/i.test(name)) continue;
        const countRow = await db.get(`SELECT COUNT(*) AS count FROM ${quote(name)}`);
        output.push({
            name,
            count: number(countRow?.count),
            columns: [...columns].sort(),
            statusCounts: await grouped(db, schema, name, 'status'),
            hashColumns: [...columns].filter((item) => /(hash|fingerprint|digest)/i.test(item)).sort(),
            versionColumns: [...columns].filter((item) => /version/i.test(item)).sort(),
        });
    }
    return output;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const databasePath = path.resolve(options.db);
    const reportPath = path.resolve(options.output || path.join(
        'backups',
        `clover-phase0-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    ));
    if (!fs.existsSync(databasePath)) throw new Error(`Banco não encontrado: ${databasePath}`);

    const db = await open({
        filename: databasePath,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });
    const report = {
        reportVersion: 'clover-phase0-audit-v1',
        generatedAt: new Date().toISOString(),
        mode: 'read_only',
        summary: { total: 0, critical: 0, warning: 0, review: 0, bySeverity: {}, byCategory: {} },
        issues: [],
        evidence: {},
    };

    try {
        await db.exec('PRAGMA query_only = ON');
        const queryOnly = await db.get('PRAGMA query_only');
        const integrityRow = await db.get('PRAGMA integrity_check');
        const integrity = integrityRow?.integrity_check || Object.values(integrityRow || {})[0] || null;
        const stat = fs.statSync(databasePath);
        const head = git(['rev-parse', 'HEAD']);
        const originMain = git(['rev-parse', 'origin/main']);
        const dirty = git(['status', '--short']);
        const expectedSha = String(options.expectedSha || '').trim() || null;

        report.evidence.source = {
            repository: {
                head,
                originMain,
                branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
                dirty: Boolean(dirty),
                dirtySummary: dirty ? dirty.split(/\r?\n/).slice(0, 50) : [],
                expectedDeployedSha: expectedSha,
                expectedShaMatchesHead: expectedSha && head
                    ? head.startsWith(expectedSha) || expectedSha.startsWith(head)
                    : null,
            },
            database: {
                path: databasePath,
                bytes: stat.size,
                modifiedAt: stat.mtime.toISOString(),
                queryOnly: number(queryOnly?.query_only ?? Object.values(queryOnly || {})[0]) === 1,
                integrity,
            },
            runtime: { node: process.version, platform: process.platform, pid: process.pid },
        };

        if (!report.evidence.source.database.queryOnly) {
            addIssue(report, issue('critical', 'execution', 'query_only_not_confirmed', 'SQLite não confirmou PRAGMA query_only = ON.'));
        }
        if (integrity !== 'ok') {
            addIssue(report, issue('critical', 'database', 'sqlite_integrity_check_failed', 'PRAGMA integrity_check não retornou ok.', { integrity }));
        }
        if (report.evidence.source.repository.expectedShaMatchesHead === false) {
            addIssue(report, issue(
                'critical', 'deployment', 'expected_deployed_sha_mismatch',
                'O SHA informado como implantado não corresponde ao HEAD auditado.',
                { expected: expectedSha, head }
            ));
        }

        const schema = await readSchema(db);
        report.evidence.schema = [...schema.entries()]
            .map(([name, columns]) => ({ name, columns: [...columns].sort() }))
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const table of EXPECTED_TABLES) {
            if (!schema.has(table)) {
                addIssue(report, issue(
                    ['jogadores', 'clover_access_roles', 'clover_squad_memberships'].includes(table) ? 'critical' : 'warning',
                    'schema', 'expected_table_missing', `Tabela esperada ausente: ${table}.`, { table }
                ));
            }
        }

        report.evidence.statuses = {
            fichaStatus: await grouped(db, schema, 'jogadores', 'ficha_status'),
            jogoStatus: await grouped(db, schema, 'jogadores', 'jogo_status'),
        };
        await auditRoles(db, schema, report);
        const memberships = await auditMemberships(db, schema, report);
        await auditStars(db, schema, report, memberships);
        await auditOperations(db, schema, report);
        report.evidence.rewardAndProposalTables = await inventoryWorkflowTables(db, schema);
    } finally {
        await db.close();
    }

    report.evidenceDigest = digest({
        reportVersion: report.reportVersion,
        generatedAt: report.generatedAt,
        issues: report.issues,
        evidence: report.evidence,
    });
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    if (options.jsonOnly) process.stdout.write(`${JSON.stringify(report)}\n`);
    else {
        console.log('\n=== CLOVER · FASE 0 · EVIDÊNCIA E CONTENÇÃO ===');
        console.log('Modo: SOMENTE LEITURA');
        console.log(`Banco: ${databasePath}`);
        console.log(`Integridade SQLite: ${report.evidence.source.database.integrity}`);
        console.log(`HEAD: ${report.evidence.source.repository.head || 'indisponível'}`);
        console.log(`origin/main: ${report.evidence.source.repository.originMain || 'indisponível'}`);
        console.log(`Críticos: ${report.summary.critical}`);
        console.log(`Avisos: ${report.summary.warning}`);
        console.log(`Digest: ${report.evidenceDigest}`);
        const critical = report.issues.filter((item) => item.severity === 'critical').slice(0, 30);
        if (critical.length) {
            console.log('\nBloqueios críticos:');
            for (const item of critical) console.log(`- [${item.category}/${item.code}] ${item.message}`);
        }
        console.log(`\nRelatório: ${reportPath}`);
        console.log('Nenhum dado foi alterado.');
    }
    if (options.failOnCritical && report.summary.critical > 0) process.exitCode = 2;
}

main().catch((error) => {
    console.error('\nFalha na auditoria P0:', error?.stack || error?.message || error);
    process.exitCode = 1;
});
