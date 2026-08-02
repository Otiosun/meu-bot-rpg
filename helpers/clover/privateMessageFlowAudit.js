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

const PRIVATE_APIS = new Set([
    'sendPrivateText',
    'sendPrivateMessage',
    'enqueuePrivateText',
    'enqueuePrivateMessage',
    'enqueueSpellReviewInvite',
]);

const SOCKET_APIS = new Set(['sock.sendMessage', 'sock.relayMessage']);

const PROACTIVE_TERMS = [
    'runantighostsweep',
    'activateantighost',
    'maybecreateautoreturnbonus',
    'queueweeklynoticeforplayer',
    'runweeklychecklistresetdispatch',
    'weekly_checklist_reset',
    'weeklyreset',
    'return_bonus',
    'returnbonusoffer',
    'incentivo',
    'reminder',
    'lembrete',
    'notice_sent',
    'broadcast',
];

const TRANSACTIONAL_TERMS = [
    'appearance_approved',
    'appearance_rejected',
    'aparencia_aprovada',
    'aparencia_negada',
    'notifyplayerappearanceresult',
    'game_liberated',
    'jogo_liberado',
    'spell_review',
    'spellreviewinvite',
    'offgroup',
    'grupo_off',
    'group_request',
    'communityexit',
    'exitconfirmation',
    'createorrefreshexitconfirmation',
    'cancelpendingexitforreturn',
    'post_ficha',
    'postficha',
    'invite',
    'convite',
];

const REACTIVE_TERMS = [
    'messages.upsert',
    'handlecommand',
    'executecommand',
    'commandreply',
    'confirmationreply',
    'handleexitconfirmationreply',
    'handleantighostprivatereply',
    'sendantighostprivatereply',
    'tryattachappearanceimage',
    'notifyjobresult',
    'sendreactiontokey',
    'sendtreemap',
    'cooldown',
    'unknowncommand',
    'gameblocked',
];

const GROUP_TARGET_TERMS = [
    'groupid',
    'archivegroupid',
    'registrationgroup',
    'receptiongroupid',
    'fallbackgroupid',
    'sourcegroupid',
];

const PRIVATE_TARGET_TERMS = [
    'playerid',
    'participantid',
    'targetjid',
    'player.id',
    'record.targetjid',
    'target.jid',
    'review.player_id',
    'entry.player_id',
];

function normalizePath(value) {
    return String(value || '').split(path.sep).join('/');
}

function normalizeToken(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, '');
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

function maskNonCode(content) {
    const output = [...content];
    let state = 'code';
    let quote = null;
    let escaped = false;

    for (let index = 0; index < content.length; index += 1) {
        const char = content[index];
        const next = content[index + 1];

        if (state === 'line_comment') {
            if (char === '\n') state = 'code';
            else output[index] = ' ';
            continue;
        }

        if (state === 'block_comment') {
            if (char === '*' && next === '/') {
                output[index] = ' ';
                output[index + 1] = ' ';
                index += 1;
                state = 'code';
            } else if (char !== '\n') {
                output[index] = ' ';
            }
            continue;
        }

        if (state === 'string') {
            if (char !== '\n') output[index] = ' ';
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === quote) {
                state = 'code';
                quote = null;
            }
            continue;
        }

        if (char === '/' && next === '/') {
            output[index] = ' ';
            output[index + 1] = ' ';
            index += 1;
            state = 'line_comment';
            continue;
        }

        if (char === '/' && next === '*') {
            output[index] = ' ';
            output[index + 1] = ' ';
            index += 1;
            state = 'block_comment';
            continue;
        }

        if (char === '\'' || char === '"' || char === '`') {
            output[index] = ' ';
            state = 'string';
            quote = char;
        }
    }

    return output.join('');
}

function lineNumberAt(content, index) {
    let line = 1;
    for (let cursor = 0; cursor < index; cursor += 1) {
        if (content.charCodeAt(cursor) === 10) line += 1;
    }
    return line;
}

function snippetAround(lines, lineNumber, radius = 7) {
    const start = Math.max(0, lineNumber - radius - 1);
    const end = Math.min(lines.length, lineNumber + radius);
    return lines.slice(start, end).join('\n');
}

function findClosingDelimiter(masked, openIndex, openChar, closeChar) {
    let depth = 0;
    for (let index = openIndex; index < masked.length; index += 1) {
        const char = masked[index];
        if (char === openChar) depth += 1;
        else if (char === closeChar) {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return -1;
}

function buildFunctionRanges(content, masked) {
    const patterns = [
        /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/g,
        /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
        /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*async\s+function\s*\([^)]*\)\s*\{/g,
    ];
    const ranges = [];

    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(masked)) !== null) {
            const openIndex = masked.indexOf('{', match.index + match[0].lastIndexOf('{'));
            const closeIndex = findClosingDelimiter(masked, openIndex, '{', '}');
            if (openIndex < 0 || closeIndex < 0) continue;
            ranges.push({
                name: match[1],
                start: match.index,
                bodyStart: openIndex,
                end: closeIndex,
            });
        }
    }

    return ranges.sort((left, right) => left.start - right.start || right.end - left.end);
}

function findEnclosingFunction(functionRanges, index) {
    const candidates = functionRanges.filter((range) => range.bodyStart < index && range.end >= index);
    if (!candidates.length) return null;
    candidates.sort((left, right) => (left.end - left.start) - (right.end - right.start));
    return candidates[0].name;
}

function isFunctionDeclaration(masked, matchIndex) {
    const lineStart = masked.lastIndexOf('\n', matchIndex - 1) + 1;
    const prefix = masked.slice(lineStart, matchIndex);
    return /(?:^|\s)(?:async\s+)?function\s*$/.test(prefix);
}

function extractCallExpression(content, masked, matchIndex) {
    const openIndex = masked.indexOf('(', matchIndex);
    if (openIndex < 0) return '';
    const closeIndex = findClosingDelimiter(masked, openIndex, '(', ')');
    if (closeIndex < 0) return content.slice(matchIndex, Math.min(content.length, matchIndex + 1200));
    return content.slice(matchIndex, closeIndex + 1);
}

function extractFirstArgument(callExpression) {
    const openIndex = callExpression.indexOf('(');
    if (openIndex < 0) return '';
    const inner = callExpression.slice(openIndex + 1, -1);
    const masked = maskNonCode(inner);
    let paren = 0;
    let brace = 0;
    let bracket = 0;

    for (let index = 0; index < masked.length; index += 1) {
        const char = masked[index];
        if (char === '(') paren += 1;
        else if (char === ')') paren -= 1;
        else if (char === '{') brace += 1;
        else if (char === '}') brace -= 1;
        else if (char === '[') bracket += 1;
        else if (char === ']') bracket -= 1;
        else if (char === ',' && paren === 0 && brace === 0 && bracket === 0) {
            return inner.slice(0, index).trim();
        }
    }
    return inner.trim();
}

function extractObjectProperty(callExpression, propertyName) {
    const pattern = new RegExp(`\\b${propertyName}\\s*:\\s*([^,}\\n]+)`, 'i');
    const match = callExpression.match(pattern);
    return match ? match[1].trim() : '';
}

function extractLiteralProperty(callExpression, propertyName) {
    const pattern = new RegExp(`\\b${propertyName}\\s*:\\s*(['\"])(.*?)\\1`, 'i');
    return callExpression.match(pattern)?.[2] || '';
}

function containsAny(haystack, terms) {
    return terms.some((term) => haystack.includes(term));
}

function isTransportCore(relativePath, functionName) {
    if (relativePath !== 'helpers/chatReply.js') return false;
    return [
        'sendMessageWithFallback',
        'handlePrivateSendUpdate',
        'sendReaction',
        'withHumanTyping',
    ].includes(functionName);
}

function inferChannel({ api, relativePath, functionName, snippet, callExpression }) {
    if (PRIVATE_APIS.has(api)) return 'private';

    const targetExpression = api === 'sendReply'
        ? extractObjectProperty(callExpression, 'idChat')
        : extractFirstArgument(callExpression);
    const target = normalizeToken(targetExpression);
    const context = normalizeToken([relativePath, functionName, snippet, callExpression].filter(Boolean).join('\n'));

    if (containsAny(target, GROUP_TARGET_TERMS)) return 'group_likely';
    if (target === 'id' && /groupparticipants|isspellreviewgroup|isoffgroup|groupreception/.test(context)) {
        return 'group_likely';
    }
    if (target === 'idchat' && /isgroup&&|endswith@?g.us|spell_review|groupreception/.test(context)) {
        return 'group_likely';
    }
    if (containsAny(target, PRIVATE_TARGET_TERMS)) return 'private';
    if (target === 'idchat' || target === 'job.chat_id') return 'contextual';
    if (api === 'sendReply') return 'contextual';
    return 'unknown';
}

function classifyFlow({ api, relativePath, functionName, snippet, callExpression, channel }) {
    if (channel === 'group_likely') return 'non_private';
    if (isTransportCore(relativePath, functionName)) return 'infrastructure';

    const source = extractLiteralProperty(callExpression, 'source');
    const reason = extractLiteralProperty(callExpression, 'reason');
    const functionToken = normalizeToken(functionName);
    const context = normalizeToken([
        source,
        reason,
        functionName,
        callExpression,
        snippet,
    ].filter(Boolean).join('\n'));

    if (api === 'sendReply') {
        if (channel === 'private' && containsAny(context, TRANSACTIONAL_TERMS)) return 'transactional';
        return 'reactive';
    }

    if (SOCKET_APIS.has(api)) {
        if (functionToken === 'sendreactiontokey' || functionToken === 'sendtreemap'
            || functionToken === 'tryattachappearanceimage' || functionToken === 'notifyjobresult') {
            return 'reactive';
        }
        if (containsAny(context, REACTIVE_TERMS)) return 'reactive';
        if (channel === 'private' && containsAny(context, TRANSACTIONAL_TERMS)) return 'transactional';
        if (channel === 'private' && containsAny(context, PROACTIVE_TERMS)) return 'proactive';
        return 'unknown';
    }

    if (api === 'enqueueSpellReviewInvite') return 'transactional';
    if (containsAny(context, REACTIVE_TERMS)) return 'reactive';
    if (containsAny(context, TRANSACTIONAL_TERMS)) return 'transactional';
    if (containsAny(context, PROACTIVE_TERMS)) return 'proactive';

    if (relativePath === 'comandos/incentivo.js' || relativePath === 'comandos/testePv.js') {
        return 'proactive';
    }

    return 'unknown';
}

function inferTrigger({ category, api, relativePath, functionName, snippet, callExpression }) {
    if (category === 'non_private') return 'group_event';
    if (category === 'infrastructure') return 'transport';

    const context = normalizeToken([relativePath, functionName, snippet, callExpression].filter(Boolean).join('\n'));
    if (/setinterval|settimeout|runantighostsweep|weekly|sweep|dispatch/.test(context)) return 'scheduled';
    if (relativePath.startsWith('comandos/') && category === 'proactive') return 'admin_initiated';
    if (/participants.update|participantadd|participantremove|approval|approved|liberated|exit|appearance/.test(context)) {
        return 'state_event';
    }
    if (category === 'reactive') return 'user_initiated';
    if (api.startsWith('enqueue')) return 'queued';
    if (category === 'proactive') return 'automatic';
    return 'unknown';
}

function detectRiskFlags({ api, category, channel, relativePath, functionName, snippet, callExpression, trigger }) {
    const context = normalizeToken([relativePath, functionName, snippet, callExpression].filter(Boolean).join('\n'));
    const flags = new Set();

    if (SOCKET_APIS.has(api)) {
        if (category === 'infrastructure') flags.add('transport_core');
        else if (channel === 'private') flags.add('direct_private_socket_bypass');
        else if (channel === 'contextual' || channel === 'unknown') flags.add('direct_contextual_socket_send');
        else if (channel === 'group_likely') flags.add('direct_group_socket_send');
    }
    if (api.startsWith('enqueue') || /maxattempts|retry|fallback|recovery/.test(context)) {
        flags.add('retry_or_queue');
    }
    if (/fanout|getusyncdevices|devicelist|fallbacktargets|relaymessage/.test(context)) {
        flags.add('multi_target_or_device_fallback');
    }
    if (trigger === 'scheduled' && category === 'proactive') flags.add('automatic_schedule');
    if (category === 'proactive') flags.add('unsolicited_outreach');
    if (category === 'unknown') flags.add('classification_required');
    if (/maxattempts\s*:\s*[4-9]/.test(callExpression.toLowerCase())) flags.add('more_than_three_attempts');

    return [...flags].sort();
}

function scanFile(rootDir, filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const masked = maskNonCode(content);
    const lines = content.split(/\r?\n/);
    const relativePath = normalizePath(path.relative(rootDir, filePath));
    const functionRanges = buildFunctionRanges(content, masked);
    const findings = [];

    for (const pattern of CALL_PATTERNS) {
        pattern.regex.lastIndex = 0;
        let match;
        while ((match = pattern.regex.exec(masked)) !== null) {
            if (isFunctionDeclaration(masked, match.index)) continue;

            const line = lineNumberAt(content, match.index);
            const snippet = snippetAround(lines, line);
            const functionName = findEnclosingFunction(functionRanges, match.index);
            const callExpression = extractCallExpression(content, masked, match.index);
            const channel = inferChannel({
                api: pattern.api,
                relativePath,
                functionName,
                snippet,
                callExpression,
            });
            const category = classifyFlow({
                api: pattern.api,
                relativePath,
                functionName,
                snippet,
                callExpression,
                channel,
            });
            const trigger = inferTrigger({
                category,
                api: pattern.api,
                relativePath,
                functionName,
                snippet,
                callExpression,
            });
            const riskFlags = detectRiskFlags({
                api: pattern.api,
                category,
                channel,
                relativePath,
                functionName,
                snippet,
                callExpression,
                trigger,
            });

            findings.push({
                id: sha256(`${relativePath}:${line}:${pattern.api}`).slice(0, 16),
                path: relativePath,
                line,
                api: pattern.api,
                certainty: pattern.certainty,
                channel,
                functionName,
                category,
                trigger,
                riskFlags,
                targetExpression: pattern.api === 'sendReply'
                    ? extractObjectProperty(callExpression, 'idChat')
                    : extractFirstArgument(callExpression),
                source: extractLiteralProperty(callExpression, 'source') || null,
                reason: extractLiteralProperty(callExpression, 'reason') || null,
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
    const pvRelevant = findings.filter((item) => !['non_private', 'infrastructure'].includes(item.category));
    const directPrivateSocketCount = findings.filter((item) => item.riskFlags.includes('direct_private_socket_bypass')).length;
    const directContextualSocketCount = findings.filter((item) => item.riskFlags.includes('direct_contextual_socket_send')).length;
    const proactiveCount = findings.filter((item) => item.category === 'proactive').length;
    const unknownCount = pvRelevant.filter((item) => item.category === 'unknown').length;

    return {
        version: 'clover.private-message-flow-audit.v2',
        generatedAt: new Date().toISOString(),
        write: false,
        repositoryRoot: absoluteRoot,
        options: {
            includeTests: Boolean(options.includeTests),
        },
        summary: {
            scannedFileCount: sourceFiles.length,
            findingCount: findings.length,
            pvRelevantCount: pvRelevant.length,
            nonPrivateCount: findings.filter((item) => item.category === 'non_private').length,
            infrastructureCount: findings.filter((item) => item.category === 'infrastructure').length,
            directSocketCount: directPrivateSocketCount + directContextualSocketCount,
            directPrivateSocketCount,
            directContextualSocketCount,
            proactiveCount,
            unknownCount,
            reviewRequired: directPrivateSocketCount > 0 || proactiveCount > 0 || unknownCount > 0,
            byCategory: countBy(findings, (item) => item.category),
            byChannel: countBy(findings, (item) => item.channel),
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
    buildFunctionRanges,
    classifyFlow,
    detectRiskFlags,
    extractCallExpression,
    inferChannel,
    inferTrigger,
    isFunctionDeclaration,
    listSourceFiles,
    maskNonCode,
    scanPrivateMessageFlows,
    writeAuditReport,
};