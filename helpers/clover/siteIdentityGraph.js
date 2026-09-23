'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { normalizeJid } = require('../groupAccess');

const graphCache = new Map();

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeIdentity(value, authInfoDir) {
    return normalizeJid(value, { authInfoDir });
}

function addIdentityEdge(graph, left, right, authInfoDir) {
    const a = normalizeIdentity(left, authInfoDir);
    const b = normalizeIdentity(right, authInfoDir);
    if (!a || !b || a === b) return;
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a).add(b);
    graph.get(b).add(a);
}

function inferIdentityDomain(keyHint, fallbackDomain) {
    const key = String(keyHint || '').toLowerCase();
    if (key.includes('phone') || key === 'pn' || key.includes('phone_number')) return 's.whatsapp.net';
    if (key.includes('lid')) return 'lid';
    return fallbackDomain;
}

function collectIdentityCandidates(value, fallbackDomain, output, keyHint = '') {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' || typeof value === 'number') {
        const raw = String(value || '').trim();
        const explicit = raw.match(/(\d{8,})(?::\d+)?@(lid|s\.whatsapp\.net)/i);
        if (explicit) {
            output.add(`${explicit[1]}@${explicit[2].toLowerCase()}`);
            return;
        }
        const digits = extractDigits(raw);
        if (digits.length < 8) return;
        const domain = inferIdentityDomain(keyHint, fallbackDomain);
        if (domain) output.add(`${digits}@${domain}`);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectIdentityCandidates(item, fallbackDomain, output, keyHint);
        return;
    }
    if (typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            collectIdentityCandidates(item, inferIdentityDomain(key, fallbackDomain), output, key);
        }
    }
}

function readMappingFiles(authInfoDir) {
    const resolvedDir = path.resolve(authInfoDir);
    if (!fs.existsSync(resolvedDir)) return [];
    return fs.readdirSync(resolvedDir)
        .filter((name) => /^lid-mapping-\d+(?:_reverse)?\.json$/i.test(name))
        .map((name) => {
            const filePath = path.join(resolvedDir, name);
            let mtimeMs = 0;
            let size = 0;
            try {
                const stat = fs.statSync(filePath);
                mtimeMs = stat.mtimeMs;
                size = stat.size;
            } catch {}
            return { name, filePath, mtimeMs, size };
        })
        .sort((left, right) => left.name.localeCompare(right.name));
}

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function buildIdentityGraph(authInfoDir) {
    const resolvedDir = path.resolve(authInfoDir);
    const graph = new Map();
    const files = readMappingFiles(resolvedDir);
    for (const file of files) {
        const match = file.name.match(/^lid-mapping-(\d+)(_reverse)?\.json$/i);
        if (!match) continue;
        const reverse = Boolean(match[2]);
        const root = `${match[1]}@${reverse ? 'lid' : 's.whatsapp.net'}`;
        const fallbackDomain = reverse ? 's.whatsapp.net' : 'lid';
        const parsed = readJson(file.filePath);
        if (parsed === null || parsed === undefined) continue;
        const candidates = new Set();
        collectIdentityCandidates(parsed, fallbackDomain, candidates);
        for (const candidate of candidates) addIdentityEdge(graph, root, candidate, resolvedDir);
    }
    return { authInfoDir: resolvedDir, files, graph };
}

function getIdentityGraph(authInfoDir, options = {}) {
    const resolvedDir = path.resolve(authInfoDir);
    const files = readMappingFiles(resolvedDir);
    const signature = files.map((file) => `${file.name}:${file.mtimeMs}:${file.size}`).join('|');
    const now = Date.now();
    const ttlMs = Number(options.cacheTtlMs ?? 60_000);
    const cached = graphCache.get(resolvedDir);
    if (cached && cached.signature === signature && now - cached.at < ttlMs) return cached.value;
    const value = buildIdentityGraph(resolvedDir);
    graphCache.set(resolvedDir, { at: now, signature, value });
    return value;
}

function connectedIdentities(identityGraph, seeds) {
    const graph = identityGraph?.graph || new Map();
    const authInfoDir = identityGraph?.authInfoDir;
    const queue = [...new Set((seeds || []).map((seed) => normalizeIdentity(seed, authInfoDir)).filter(Boolean))];
    const visited = new Set(queue);
    while (queue.length) {
        const current = queue.shift();
        for (const next of graph.get(current) || []) {
            if (visited.has(next)) continue;
            visited.add(next);
            queue.push(next);
        }
    }
    return [...visited];
}

function canonicalIdentityFor(identityGraph, seeds) {
    const identities = connectedIdentities(identityGraph, seeds).sort((left, right) => left.localeCompare(right));
    const lids = identities.filter((identity) => identity.endsWith('@lid'));
    return (lids[0] || identities[0] || '');
}

function clearIdentityGraphCache() {
    graphCache.clear();
}

module.exports = {
    addIdentityEdge,
    buildIdentityGraph,
    canonicalIdentityFor,
    clearIdentityGraphCache,
    collectIdentityCandidates,
    connectedIdentities,
    getIdentityGraph,
    inferIdentityDomain,
    normalizeIdentity,
    readMappingFiles,
};
