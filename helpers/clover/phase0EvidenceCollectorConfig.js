'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const AUDITORS = Object.freeze({
    phase0: [
        'scripts/createCloverPhase0Snapshot.js',
        'scripts/auditCloverPhase0.js',
        'scripts/auditLegacySquadReconcileCallsites.js',
    ],
    roleShadow: ['scripts/auditCanonicalRoleShadow.js'],
    membershipIntegrity: ['scripts/auditSquadMembershipIntegrity.js'],
    membershipReadShadow: ['scripts/auditSquadMembershipReadShadow.js'],
    eligibilityStatus: ['scripts/auditSquadMembershipEligibilityStatuses.js'],
});

class EvidenceError extends Error {
    constructor(message, code, details = null) {
        super(message);
        this.name = 'EvidenceError';
        this.code = code || 'phase0_evidence_error';
        this.details = details;
    }
}

const clean = (value) => String(value ?? '').trim();
const sameSha = (a, b) => {
    a = clean(a); b = clean(b);
    return a && b ? a.startsWith(b) || b.startsWith(a) : null;
};
const inside = (root, file) => {
    const relative = path.relative(root, file);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const shaText = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const defaultCollectorCwd = () => path.resolve(__dirname, '..', '..');
const shaFile = (file) => new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
});

function parseArgs(argv) {
    const out = {
        config: null,
        expectedCollectorSha: process.env.CLOVER_COLLECTOR_SHA || null,
        dryRun: false,
        jsonOnly: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--config') out.config = argv[++i];
        else if (arg.startsWith('--config=')) out.config = arg.slice(9);
        else if (arg === '--expected-collector-sha') out.expectedCollectorSha = argv[++i];
        else if (arg.startsWith('--expected-collector-sha=')) out.expectedCollectorSha = arg.slice(25);
        else if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--json-only') out.jsonOnly = true;
        else throw new EvidenceError(`Argumento desconhecido: ${arg}`, 'unknown_argument');
    }
    if (!out.config) throw new EvidenceError('Informe --config.', 'missing_config');
    return out;
}

function loadConfig(filename) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) {
        throw new EvidenceError('Configuração JSON inválida.', 'invalid_config_json', { cause: error.message });
    }
    const root = path.dirname(path.resolve(filename));
    const runtimeCwd = path.resolve(root, clean(raw?.runtime?.cwd));
    const db = clean(raw?.runtime?.db) || './banco.sqlite';
    const config = {
        outputDir: path.resolve(root, clean(raw?.outputDir)),
        referenceDate: clean(raw?.referenceDate) || new Date().toISOString(),
        runtime: {
            processName: clean(raw?.runtime?.processName) || 'clover-rpg',
            cwd: runtimeCwd,
            sourceDb: path.resolve(runtimeCwd, db),
            expectedSha: clean(raw?.runtime?.expectedSha),
            allowExternalDb: raw?.runtime?.allowExternalDb === true,
        },
        auditors: {},
        eligibilityPolicy: {
            approvedSheetStatuses: Array.isArray(raw?.eligibilityPolicy?.approvedSheetStatuses)
                ? raw.eligibilityPolicy.approvedSheetStatuses.map(clean).filter(Boolean) : [],
            releasedGameStatuses: Array.isArray(raw?.eligibilityPolicy?.releasedGameStatuses)
                ? raw.eligibilityPolicy.releasedGameStatuses.map(clean).filter(Boolean) : [],
        },
    };
    for (const key of Object.keys(AUDITORS)) {
        config.auditors[key] = {
            cwd: path.resolve(root, clean(raw?.auditors?.[key]?.cwd)),
            expectedSha: clean(raw?.auditors?.[key]?.expectedSha),
        };
    }
    return validateConfig(config);
}

function validateConfig(config) {
    if (!config.outputDir || config.outputDir === path.parse(config.outputDir).root) {
        throw new EvidenceError('outputDir inválido.', 'invalid_output_dir');
    }
    if (!config.runtime.cwd || !config.runtime.expectedSha || !config.runtime.processName) {
        throw new EvidenceError('Configuração do runtime incompleta.', 'invalid_runtime_config');
    }
    if (!config.runtime.allowExternalDb && !inside(config.runtime.cwd, config.runtime.sourceDb)) {
        throw new EvidenceError('Banco externo não autorizado.', 'external_database_not_allowed');
    }
    for (const key of Object.keys(AUDITORS)) {
        if (!config.auditors[key]?.cwd || !config.auditors[key]?.expectedSha) {
            throw new EvidenceError(`Auditor ${key} incompleto.`, 'invalid_auditor_config', { auditor: key });
        }
    }
    const policy = config.eligibilityPolicy;
    if ((policy.approvedSheetStatuses.length > 0) !== (policy.releasedGameStatuses.length > 0)) {
        throw new EvidenceError('Allowlists devem ser fornecidas juntas.', 'incomplete_eligibility_policy');
    }
    const date = new Date(config.referenceDate);
    if (Number.isNaN(date.getTime())) throw new EvidenceError('referenceDate inválida.', 'invalid_reference_date');
    config.referenceDate = date.toISOString();
    return config;
}

function command(file, args, cwd) {
    const result = spawnSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function git(cwd, args, deps) {
    const result = deps?.git ? deps.git(cwd, args) : command('git', args, cwd);
    if (typeof result === 'string') return clean(result);
    if (result.status !== 0) throw new EvidenceError('Falha ao consultar Git.', 'git_query_failed', { cwd, args });
    return clean(result.stdout);
}

function checkout(cwd, expectedSha, allowUntracked, deps) {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new EvidenceError(`Checkout ausente: ${cwd}`, 'checkout_not_found');
    }
    const head = git(cwd, ['rev-parse', 'HEAD'], deps);
    if (sameSha(head, expectedSha) !== true) {
        throw new EvidenceError('SHA de checkout inesperado.', 'checkout_sha_mismatch', { cwd, head, expectedSha });
    }
    const status = git(cwd, [
        'status', '--porcelain', allowUntracked ? '--untracked-files=no' : '--untracked-files=normal',
    ], deps);
    if (status) throw new EvidenceError('Checkout não está limpo.', 'checkout_not_clean', { cwd, status });
    return { cwd, head, expectedSha, clean: true };
}

function pm2(runtime, deps) {
    let list;
    if (deps?.pm2List) list = deps.pm2List();
    else {
        const result = command('pm2', ['jlist']);
        if (result.status !== 0) throw new EvidenceError('Falha ao consultar PM2.', 'pm2_query_failed');
        try { list = JSON.parse(result.stdout || '[]'); }
        catch { throw new EvidenceError('JSON inválido do PM2.', 'pm2_invalid_json'); }
    }
    const matches = (Array.isArray(list) ? list : []).filter((item) => clean(item?.name) === runtime.processName);
    if (matches.length !== 1) {
        throw new EvidenceError('Processo PM2 ausente ou ambíguo.', 'pm2_process_ambiguous', { count: matches.length });
    }
    const item = matches[0];
    const status = clean(item?.pm2_env?.status);
    const pmCwd = path.resolve(clean(item?.pm2_env?.pm_cwd));
    if (status !== 'online') throw new EvidenceError('Processo PM2 não está online.', 'pm2_process_not_online');
    if (pmCwd !== path.resolve(runtime.cwd)) {
        throw new EvidenceError('pm_cwd diverge do runtime.cwd.', 'pm2_cwd_mismatch', { pmCwd, runtimeCwd: runtime.cwd });
    }
    return {
        name: runtime.processName,
        status,
        pmCwd,
        execPath: clean(item?.pm2_env?.pm_exec_path) || null,
        pid: Number.isInteger(item?.pid) ? item.pid : null,
        pmId: Number.isInteger(item?.pm_id) ? item.pm_id : null,
    };
}

function preflight(config, expectedCollectorSha, deps = {}) {
    if (!clean(expectedCollectorSha)) throw new EvidenceError('SHA do coletor é obrigatório.', 'missing_expected_collector_sha');
    if (fs.existsSync(config.outputDir)) throw new EvidenceError('Diretório de saída já existe.', 'output_dir_exists');
    if (!fs.existsSync(config.runtime.sourceDb)) throw new EvidenceError('Banco de origem ausente.', 'source_database_not_found');
    const collectorCwd = deps.collectorCwd || defaultCollectorCwd();
    const collector = checkout(collectorCwd, expectedCollectorSha, false, deps);
    const runtime = { ...checkout(config.runtime.cwd, config.runtime.expectedSha, true, deps), pm2: pm2(config.runtime, deps) };
    const auditors = {};
    for (const [key, scripts] of Object.entries(AUDITORS)) {
        auditors[key] = checkout(config.auditors[key].cwd, config.auditors[key].expectedSha, false, deps);
        for (const script of scripts) {
            if (!fs.existsSync(path.join(config.auditors[key].cwd, script))) {
                throw new EvidenceError('Script auditor ausente.', 'auditor_script_missing', { auditor: key, script });
            }
        }
    }
    return { collector, runtime, auditors };
}

module.exports = {
    AUDITORS, EvidenceError, command, defaultCollectorCwd, loadConfig, parseArgs, preflight, sameSha, shaFile, shaText, validateConfig,
};
