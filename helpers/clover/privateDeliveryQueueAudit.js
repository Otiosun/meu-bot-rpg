'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_EXCLUDED_DIRS = new Set([
    '.git',
    'node_modules',
    'auth_info',
    'assets',
    'backups',
    'coverage',
    'dist',
]);

const SIGNALS = Object.freeze({
    schema: /\bclover_delivery_jobs\b/g,
    enqueue: /\benqueue(?:DeliveryJob|PrivateMessage|PrivateText|SpellReviewInvite|SpellReviewRemove|ApprovalSweep)\s*\(/g,
    list: /\b(?:listRecentDeliveryJobs|getDeliveryStats)\s*\(/g,
    retry: /\bretryDeliveryJob\s*\(/g,
    cancel: /\bcancelDeliveryJob\s*\(/g,
    pendingRead: /(?:FROM\s+clover_delivery_jobs[\s\S]{0,500}status\s*(?:=|IN)\s*\(?['"]pending|status\s*(?:=|IN)\s*\(?['"]pending[\s\S]{0,500}FROM\s+clover_delivery_jobs)/gi,
    processingWrite: /UPDATE\s+clover_delivery_jobs[\s\S]{0,500}SET[\s\S]{0,250}status\s*=\s*['"]processing['"]/gi,
    sentWrite: /UPDATE\s+clover_delivery_jobs[\s\S]{0,500}SET[\s\S]{0,250}status\s*=\s*['"]sent['"]/gi,
    failedWrite: /UPDATE\s+clover_delivery_jobs[\s\S]{0,500}SET[\s\S]{0,250}status\s*=\s*['"]failed['"]/gi,
    privateTransport: /\b(?:sendPrivateText|sendPrivateMessage|sendReply|sock\.sendMessage)\s*\(/g,
    policyMetadata: /\bpolicy\s*:\s*\{|\bdedupeKey\s*:|\bsource\s*:/g,
    payloadRead: /\bpayload_json\b|JSON\.parse\s*\(/g,
    scheduling: /\b(?:setInterval|setTimeout|cron|schedule|run_after|locked_at|locked_by)\b/g,
});

function normalizeRelative(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function shouldExcludeDirectory(name) {
    if (DEFAULT_EXCLUDED_DIRS.has(name)) return true;
    return /^auth_info_backup_/i.test(name)
        || /^clover-phase0-/i.test(name)
        || /^\.?cache$/i.test(name);
}

function listJavaScriptFiles(rootDir) {
    const files = [];
    const visit = (currentDir) => {
        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!shouldExcludeDirectory(entry.name)) visit(path.join(currentDir, entry.name));
                continue;
            }
            if (!entry.isFile() || !/\.(?:c?js|mjs)$/i.test(entry.name)) continue;
            files.push(path.join(currentDir, entry.name));
        }
    };
    visit(rootDir);
    return files.sort();
}

function lineNumberAt(content, index) {
    return content.slice(0, Math.max(0, index)).split('\n').length;
}

function collectMatches(content, regex) {
    const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
    const matcher = new RegExp(regex.source, flags);
    const matches = [];
    let match;
    while ((match = matcher.exec(content)) !== null) {
        matches.push({
            line: lineNumberAt(content, match.index),
            text: String(match[0] || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        });
        if (match[0] === '') matcher.lastIndex += 1;
    }
    return matches;
}

function classifyFile(relativePath, signals) {
    const production = !relativePath.startsWith('tests/')
        && !relativePath.startsWith('scripts/')
        && !relativePath.includes('/fixtures/');
    const queueSchema = signals.schema.length > 0;
    const producer = signals.enqueue.length > 0;
    const management = signals.list.length > 0 || signals.retry.length > 0 || signals.cancel.length > 0;
    const lifecycle = signals.pendingRead.length > 0
        && signals.processingWrite.length > 0
        && (signals.sentWrite.length > 0 || signals.failedWrite.length > 0);
    const dispatch = lifecycle && signals.privateTransport.length > 0 && signals.payloadRead.length > 0;
    const policyPropagation = dispatch && signals.policyMetadata.length > 0;

    return {
        production,
        queueSchema,
        producer,
        management,
        lifecycleCandidate: lifecycle,
        confirmedConsumer: dispatch,
        policyPropagation,
    };
}

function auditFile(rootDir, absolutePath) {
    const content = fs.readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n');
    const relativePath = normalizeRelative(path.relative(rootDir, absolutePath));
    const signals = {};
    for (const [name, regex] of Object.entries(SIGNALS)) {
        signals[name] = collectMatches(content, regex);
    }
    const classification = classifyFile(relativePath, signals);
    const relevant = Object.values(signals).some((items) => items.length > 0);
    return relevant ? { path: relativePath, classification, signals } : null;
}

function auditPrivateDeliveryQueue(rootDir) {
    const resolvedRoot = path.resolve(rootDir || process.cwd());
    const findings = listJavaScriptFiles(resolvedRoot)
        .map((filePath) => auditFile(resolvedRoot, filePath))
        .filter(Boolean);
    const production = findings.filter((finding) => finding.classification.production);
    const confirmedConsumers = production.filter((finding) => finding.classification.confirmedConsumer);
    const lifecycleCandidates = production.filter((finding) => finding.classification.lifecycleCandidate);
    const producers = production.filter((finding) => finding.classification.producer);
    const management = production.filter((finding) => finding.classification.management);
    const policyConsumers = confirmedConsumers.filter((finding) => finding.classification.policyPropagation);

    return {
        version: 'clover.private-delivery-queue-audit.v1',
        generatedAt: new Date().toISOString(),
        write: false,
        repositoryRoot: resolvedRoot,
        summary: {
            scannedFileCount: listJavaScriptFiles(resolvedRoot).length,
            relevantFileCount: findings.length,
            productionRelevantFileCount: production.length,
            producerFileCount: producers.length,
            managementFileCount: management.length,
            lifecycleCandidateCount: lifecycleCandidates.length,
            confirmedConsumerCount: confirmedConsumers.length,
            policyPropagationConsumerCount: policyConsumers.length,
            consumerMissing: confirmedConsumers.length === 0,
            policyPropagationMissing: confirmedConsumers.length > 0 && policyConsumers.length === 0,
        },
        producers: producers.map((item) => item.path),
        management: management.map((item) => item.path),
        lifecycleCandidates: lifecycleCandidates.map((item) => item.path),
        confirmedConsumers: confirmedConsumers.map((item) => item.path),
        policyPropagationConsumers: policyConsumers.map((item) => item.path),
        findings,
    };
}

module.exports = {
    auditPrivateDeliveryQueue,
    classifyFile,
    collectMatches,
    listJavaScriptFiles,
};
