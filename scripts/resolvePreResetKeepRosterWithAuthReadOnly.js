'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const {
    classifyResolved,
    exactIdentityCandidates,
    loadIdentitySnapshot,
    parseRosterText,
    resolveCanonicalPlayer,
} = require('./resolvePreResetKeepRosterReadOnly');

function digits(value) {
    return String(value || '').replace(/\D/g, '');
}

function sha256File(filename) {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function uniqueDirectories(values) {
    return [...new Set(values.map((value) => path.resolve(value)).filter((value) => fs.existsSync(value)))];
}

function authInfoDirectories(authRoot) {
    const root = path.resolve(String(authRoot || process.cwd()));
    const dirs = [];
    const baseName = path.basename(root).toLowerCase();
    if (baseName === 'auth_info' || baseName.startsWith('auth_info_backup_')) dirs.push(root);
    const current = path.join(root, 'auth_info');
    if (fs.existsSync(current)) dirs.push(current);
    try {
        for (const entry of fs.readdirSync(root, { withFileTypes:true })) {
            if (entry.isDirectory() && entry.name.startsWith('auth_info_backup_')) dirs.push(path.join(root, entry.name));
        }
    } catch {
        // Ausencia/permissao em backups nao deve transformar resolucao em mutacao ou chute.
    }
    return uniqueDirectories(dirs);
}

function mappedPhoneDigits(parsed) {
    if (typeof parsed === 'string' || typeof parsed === 'number') return digits(parsed);
    if (!parsed || typeof parsed !== 'object') return '';
    for (const key of ['phoneNumber','pn','jid','id','user','phone']) {
        const value = digits(parsed[key]);
        if (value) return value;
    }
    return '';
}

function loadReverseLidMappings(authRoot) {
    const phoneToLids = new Map();
    let filesRead = 0;
    for (const dir of authInfoDirectories(authRoot)) {
        let files = [];
        try {
            files = fs.readdirSync(dir);
        } catch {
            continue;
        }
        for (const filename of files) {
            const match = filename.match(/^lid-mapping-(\d+)_reverse\.json$/i);
            if (!match) continue;
            try {
                const parsed = JSON.parse(fs.readFileSync(path.join(dir, filename), 'utf8'));
                const phone = mappedPhoneDigits(parsed);
                const lid = digits(match[1]);
                if (!phone || !lid) continue;
                if (!phoneToLids.has(phone)) phoneToLids.set(phone, new Set());
                phoneToLids.get(phone).add(lid);
                filesRead += 1;
            } catch {
                continue;
            }
        }
    }
    return { phoneToLids, filesRead };
}

function playerLidDigits(playerId) {
    const text = String(playerId || '').trim().toLowerCase();
    if (!text.endsWith('@lid')) return '';
    return digits(text.split('@')[0]);
}

function authIdentityCandidates(snapshot, phone, authMappings) {
    const wanted = digits(phone);
    const lids = authMappings?.phoneToLids?.get(wanted) || new Set();
    const canonical = new Map();
    for (const lid of lids) {
        for (const player of snapshot.players) {
            if (playerLidDigits(player.id) !== lid) continue;
            const resolved = resolveCanonicalPlayer(snapshot.playersById, player);
            if (resolved?.id) canonical.set(String(resolved.id), resolved);
        }
    }
    return [...canonical.values()];
}

function mergeCandidates(snapshot, groups) {
    const canonical = new Map();
    for (const group of groups) {
        for (const player of group || []) {
            const resolved = resolveCanonicalPlayer(snapshot.playersById, player);
            if (resolved?.id) canonical.set(String(resolved.id), resolved);
        }
    }
    return [...canonical.values()];
}

function candidateEligibility(snapshot, player) {
    const playerId = String(player?.id || '').trim();
    const approved = String(player?.ficha_status || '').trim().toLowerCase() === 'aprovada';
    const shadow = Number(player?.is_shadow || 0) === 1;
    const purged = snapshot.purged.has(playerId);
    return {
        approved,
        shadow,
        purged,
        eligible:approved && !shadow && !purged,
    };
}

function describeCandidate(snapshot, player) {
    const eligibility = candidateEligibility(snapshot, player);
    return {
        playerId:String(player?.id || ''),
        displayName:player?.display_name || player?.nome || null,
        characterName:player?.personagem_nome || null,
        fichaStatus:player?.ficha_status || null,
        gameStatus:player?.jogo_status || null,
        lifecycleStatus:player?.lifecycle_status || null,
        mergedInto:player?.merged_into || null,
        canonicalPlayerId:player?.canonical_player_id || null,
        eligibility,
    };
}

function resolveOnlyEligibleCandidate(snapshot, candidates) {
    if (!Array.isArray(candidates) || candidates.length <= 1) return null;
    const eligible = candidates.filter((player) => candidateEligibility(snapshot, player).eligible);
    return eligible.length === 1 ? eligible[0] : null;
}

async function resolveRosterWithAuthAgainstDatabase({ dbPath, authRoot, entries }) {
    const filename = path.resolve(String(dbPath || ''));
    if (!filename || !fs.existsSync(filename)) throw new Error('Arquivo SQLite nao encontrado.');
    const before = sha256File(filename);
    const mappings = loadReverseLidMappings(authRoot);
    const db = await open({ filename, driver:sqlite3.Database, mode:sqlite3.OPEN_READONLY });
    try {
        await db.exec('PRAGMA query_only=ON');
        const snapshot = await loadIdentitySnapshot(db);
        const results = entries.map((entry) => {
            const dbCandidates = exactIdentityCandidates(snapshot, entry.phone);
            const authCandidates = authIdentityCandidates(snapshot, entry.phone, mappings);
            const candidates = mergeCandidates(snapshot, [dbCandidates, authCandidates]);
            const soleEligible = resolveOnlyEligibleCandidate(snapshot, candidates);
            const effectiveCandidates = soleEligible ? [soleEligible] : candidates;
            const result = classifyResolved(snapshot, entry, effectiveCandidates);
            return {
                ...result,
                identityResolution:soleEligible ? 'sole_eligible_candidate' : undefined,
                candidateDetails:candidates.length > 1
                    ? candidates.map((player) => describeCandidate(snapshot, player)).sort((a,b) => a.playerId.localeCompare(b.playerId))
                    : undefined,
                identityEvidence:{
                    databaseCandidates:dbCandidates.map((player) => String(player.id)).sort(),
                    authReverseLidCandidates:authCandidates.map((player) => String(player.id)).sort(),
                },
            };
        });
        const counts = results.reduce((acc, item) => {
            acc[item.status] = (acc[item.status] || 0) + 1;
            return acc;
        }, {});
        return {
            results,
            counts,
            allResolved:results.every((item) => item.status === 'RESOLVED'),
            auth:{ directories:authInfoDirectories(authRoot).length, reverseMappingsRead:mappings.filesRead },
        };
    } finally {
        await db.close();
        const after = sha256File(filename);
        if (before !== after) throw new Error('Falha de seguranca: arquivo SQLite mudou durante auditoria read-only.');
    }
}

function parseArgs(argv) {
    const values = {};
    for (const arg of argv) {
        const match = String(arg).match(/^--([^=]+)=(.*)$/);
        if (match) values[match[1]] = match[2];
    }
    return values;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.db || !args.input) {
        console.error('Uso: node scripts/resolvePreResetKeepRosterWithAuthReadOnly.js --db=C:\\copia.sqlite --input=C:\\roster.txt --auth-root=C:\\repo');
        process.exitCode = 2;
        return;
    }
    const entries = parseRosterText(fs.readFileSync(path.resolve(args.input), 'utf8'));
    if (!entries.length) throw new Error('Roster vazio ou invalido.');
    const report = await resolveRosterWithAuthAgainstDatabase({
        dbPath:args.db,
        authRoot:args['auth-root'] || process.cwd(),
        entries,
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.allResolved) process.exitCode = 2;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[prereset-roster-auth-readonly] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    authIdentityCandidates,
    authInfoDirectories,
    candidateEligibility,
    describeCandidate,
    loadReverseLidMappings,
    mappedPhoneDigits,
    mergeCandidates,
    resolveOnlyEligibleCandidate,
    resolveRosterWithAuthAgainstDatabase,
};
