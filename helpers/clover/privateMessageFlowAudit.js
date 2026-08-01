'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
    '.git',
    'node_modules',
    'coverage',
    'dist',
    'build',
    'auth_info',
    'artifacts',
]);

const CALL_PATTERNS = [
    { api: 'sendPrivateText', regex: /\bsendPrivateText\s*\(/g, certainty: 'private' },
    { api: 'sendPrivateMessage', regex: /\bsendPrivateMessage\s*\(/g, certainty: 'private' },
    { api: 'enqueuePrivateText', regex: /\benqueuePrivateText\s*\(/g, certainty: 'private' },
    { api: 'enqueuePrivateMessage', regex: /\benqueuePrivateMessage\s*\(/g, certainty: 'private' },
    { api: 'enqueueSpellReviewInvite', regex: /\benqueueSpellReviewInvite\s*\(/g, certainty: 'private' },
    { api: 'sendReply', regex: /\bsendReply\s*\(/g, certainty: 'contextual' },
    { api: 'sock.sendMessage', regex: /\bsock\.sendMessage\s*\(/g, certainty: 'contextual' },
    { api: 'sock.relayMessage', regex: /\bsock\.relayMessage\s*\(/g, certainty: 'contextual' },
];

const PROACTIVE_TERMS = [
    'antighost',
    'anti_ghost',
    'anti-ghost',
    'weekly',
    'checklist',
    'resetdispatch',
    'returnbonus',
    'return_bonus',
    'incentivo',
    'reminder',
    'lembrete',
    'notice',
    'sweep',
    'timer',
    'setinterval',
    'broadcast',
];

const TRANSACTIONAL_TERMS = [
    'appearance_approved',
    'aparencia_aprovada',
    'appearanceapproved',
    'game_liberated',
    'jogo_liberado',
    'gameliberated',
    'spell_review',
    'spellreview',
    'offgroup',
    'grupo_off',
    'group_request',
    'communityexit',
    'exitconfirmation',
    'invite',
    'convite',
    'approved',
    'approval',
    'aprovacao',
    'aprovada',
    'liberado',
];

const REACTIVE_TERMS = [
    'messages.upsert',
    'command',
    'comando',
    'reply',
    'resposta',
    'confirmationreply',
    'handleprivate',
    'quoted',
    'cooldown',
    'unknowncommand',
    'gameblocked',
];

function normalizePath(value) {
    return String(value || '').split(path.sep).join('/');
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function isExcludedDirectory(name) {
    const normalized = String(name || '').toLowerCase();
    return DEFAULT_EXCLUDED_DIRECTORIES.has(normalized)
        || normalized.startsWith('backup-')
        || normalized.startsWith('backup_')
        || normalized.startsWith('auth_info_');
}

function listSourceFiles(rootDir, options = {}) {
    const includeTests = Boolean(options.includeTests);
    const files = [];

    function walk(currentDir) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const absolute = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                if (isExcludedDirectory(entry.name)) continue;
                if (!includeTests && entry.name === 'tests') continue;
                walk(absolute);
                continue;
            }
            if (!entry.isFile()) continue;
            if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
            files.push(absolute);
        }
    }

    walk(rootDir);
    return files.sort((left, right) => left.localeCompare(right));
}

function lineNumberAt(content, index) {
    let line = 1;
    for (let cursor = 0; cursor < index; cursor += 1) {
        if (content.charCodeAt(cursor) === 10) line += 1;
    }
    return line;
}

function snippetAround(lines, lineNumber, radius = 5) {
    const start = Math.max(0, lineNumber - radius - 1);
    const end = Math.min(lines.length, lineNumber + radius);
    return lines.slice(start, end).join('\n');
}

function findEnclosingFunction(lines, lineNumber) {
    const startIndex = Math.max(0, lineNumber - 1);
    const patterns = [
        /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/,
        /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
        /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*async\s+function/,
    ];

    for (let index = startIndex; index >= Math.max(0, startIndex - 120); index -= 1) {
        const line = lines[index];
        for (const pattern of patterns) {
            const match = line.match(pattern);
            if (match) return match[1];
        }
    }
    return null;
}

function containsAny(haystack, terms) {
    return terms.some((term) => haystack.includes(term));
}

function classifyFlow({ api, relativePath, functionName, snippet }) {
    const haystack = [api, relativePath, functionName, snippet]
        .filter(Boolean)
        .join('\n')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, '');

    if (containsAny(haystack, PROACTIVE_TERMS)) return 'proactive';
    if (containsAny(haystack, TRANSACTIONAL_TERMS)) return 'transactional';
    if (containsAny(haystack, REACTIVE_TERMS)) return 'reactive';
    if (api === 'enqueueSpellReviewInvite') return 'transactional';
    return 'unknown';
}

function inferTrigger({ category, api, relativePath, functionName, snippet }) {
    const haystack = [relativePath, functionName, snippet]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();

    if (/setinterval|settimeout|timer|sweep|dispatch|weekly/.test(haystack)) return 'scheduled';
    if (/participants\.update|participantadd|participantremove|approval|approved|liberated|exit/.test(haystack)) {
        return 'state_event';
    }
    if (/messages\.upsert|command|reply|confirmation|quoted/.test(haystack)) return 'user_initiated';
    if (api.startsWith('enqueue')) return 'queued';
    if (category === 'proactive') return 'automatic';
    return 'unknown';
}

function detectRiskFlags({ api, category, relativePath, functionName, snippet }) {
    const haystack = [relativePath, functionName, snippet]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
    const flags = new Set();

    if (api === 'sock.sendMessage' || api === 'sock.relayMessage') {
        flags.add('direct_socket_send');
    }
    if (api.startsWith('enqueue') || /maxattempts|retry|fallback|recovery/.test(haystack)) {
        flags.add('retry_or_queue');
    }
    if (/fanout|getusyncdevices|device-list|fallbacktargets|relaymessage/.test(haystack)) {
        flags.add('multi_target_or_device_fallback');
    }
    if (/setinterval|settimeout|timer|sweep|dispatch/.test(haystack)) {
        flags.add('automatic_schedule');
    }
    if (category === 'proactive') flags.add('unsolicited_outreach');
    if (category === 'unknown') flags.add('classification_required');
    if (/maxattempts\s*:\s*[4-9]/.test(haystack)) flags.add('more_than_three_attempts');

    return [...flags].sort();
}

function scanFile(rootDir, filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const relativePath = normalizePath(path.relative(rootDir, filePath));
    const findings = [];

    for (const pattern of CALL_PATTERNS) {
        pattern.regex.lastIndex = 0;
        let match;
        while ((match = pattern.regex.exec(content)) !== null) {
            const line = lineNumberAt(content, match.index);
            const snippet = snippetAround(lines, line);
            const functionName = findEnclosingFunction(lines, line);
            const category = classifyFlow({
                api: pattern.api,
                relativePath,
                functionName,
                snippet,
            });
            const trigger = inferTrigger({
                category,
                api: pattern.api,
                relativePath,
                functionName,
                snippet,
            });
            const riskFlags = detectRiskFlags({
                api: pattern.api,
                category,
                relativePath,
                functionName,
                snippet,
            });

            findings.push({
                id: sha256(`${relativePath}:${line}:${pattern.api}`).slice(0, 16),
                path: relativePath,
                line,
                api: pattern.api,
                certainty: pattern.certainty,
                functionName,
                category,
                trigger,
                riskFlags,
                snippet: snippet.trim(),
            });
        }
    }

    return findings.sort((left, right) => left.line - right.line || left.api.localeCompare(right.api));
}

function countBy(items, selector) {
    const result = {};
    for (const item of items) {
        const key = selector(item) || 'unknown';
        result[key] = (result[key] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function scanPrivateMessageFlows(rootDir, options = {}) {
    const absoluteRoot = path.resolve(rootDir);
    const sourceFiles = listSourceFiles(absoluteRoot, options);
    const findings = sourceFiles.flatMap((filePath) => scanFile(absoluteRoot, filePath));
    const directSocketCount = findings.filter((item) => item.riskFlags.includes('direct_socket_send')).length;
    const proactiveCount = findings.filter((item) => item.category === 'proactive').length;
    const unknownCount = findings.filter((item) => item.category === 'unknown').length;

    return {
        version: 'clover.private-message-flow-audit.v1',
        generatedAt: new Date().toISOString(),
        write: false,
        repositoryRoot: absoluteRoot,
        options: {
            includeTests: Boolean(options.includeTests),
        },
        summary: {
            scannedFileCount: sourceFiles.length,
            findingCount: findings.length,
            directSocketCount,
            proactiveCount,
            unknownCount,
            reviewRequired: directSocketCount > 0 || proactiveCount > 0 || unknownCount > 0,
            byCategory: countBy(findings, (item) => item.category),
            byApi: countBy(findings, (item) => item.api),
            byTrigger: countBy(findings, (item) => item.trigger),
            byRiskFlag: countBy(
                findings.flatMap((item) => item.riskFlags.map((riskFlag) => ({ riskFlag }))),
                (item) => item.riskFlag
            ),
        },
        findings,
    };
}

function writeAuditReport(report, outputPath) {
    const absoluteOutput = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
    fs.writeFileSync(absoluteOutput, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
    });
    return absoluteOutput;
}

module.exports = {
    CALL_PATTERNS,
    classifyFlow,
    detectRiskFlags,
    inferTrigger,
    listSourceFiles,
    scanPrivateMessageFlows,
    writeAuditReport,
};
