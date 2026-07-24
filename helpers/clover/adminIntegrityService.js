'use strict';

const { auditPlayerDataIntegrity } = require('./playerDataIntegrityAudit');

const REPORT_CACHE = new WeakMap();
const DEFAULT_CACHE_MS = 60_000;
const MAX_LIMIT = 100;

class AdminIntegrityError extends Error {
    constructor(message, code = 'admin_integrity_error', status = 500, details = null) {
        super(message);
        this.name = 'AdminIntegrityError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function text(value) {
    return String(value || '').trim();
}

function normalized(value) {
    return text(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function maskIdentity(value) {
    const raw = text(value);
    if (!raw) return null;
    const [user = '', domain = ''] = raw.split('@');
    if (!user) return null;
    const visible = user.length <= 6 ? user.slice(0, 2) : `${user.slice(0, 3)}…${user.slice(-3)}`;
    return domain ? `${visible}@${domain}` : visible;
}

function safeScalar(value, maximum = 600) {
    if (value === null || value === undefined) return value;
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (raw.length <= maximum) return value;
    return `${raw.slice(0, maximum)}…`;
}

function presentIssue(item, index) {
    return {
        id: `${item.category || 'global'}:${item.code || 'issue'}:${index + 1}`,
        severity: item.severity || 'review',
        category: item.category || 'global',
        code: item.code || 'unknown_issue',
        playerId: item.playerId || null,
        playerIdMasked: maskIdentity(item.playerId),
        characterName: item.characterName || null,
        field: item.field || null,
        entity: item.entity || null,
        current: safeScalar(item.current),
        detail: text(item.detail) || 'Apontamento sem descrição.',
        suggestedAction: text(item.suggestedAction) || 'Revisar manualmente antes de qualquer alteração.',
    };
}

async function loadReport(db, options = {}) {
    const now = Number(options.now || Date.now());
    const ttlMs = boundedInteger(options.cacheMs, DEFAULT_CACHE_MS, 0, 10 * 60_000);
    const cached = REPORT_CACHE.get(db);
    if (!options.force && cached && now - cached.createdAt <= ttlMs) {
        return { report: cached.report, cached: true };
    }

    const audit = options.audit || auditPlayerDataIntegrity;
    let report;
    try {
        report = await audit(db, {
            includeArchived: Boolean(options.includeArchived),
            databaseLabel: 'central_admin_read_only',
        });
    } catch (error) {
        throw new AdminIntegrityError(
            'A auditoria de integridade não pôde ser concluída.',
            'integrity_audit_failed',
            500,
            { message: error?.message || String(error) }
        );
    }

    if (!report?.readOnly || !Array.isArray(report.issues)) {
        throw new AdminIntegrityError(
            'O serviço de auditoria retornou um contrato inválido.',
            'invalid_integrity_report',
            500
        );
    }

    REPORT_CACHE.set(db, { report, createdAt: now });
    return { report, cached: false };
}

function matchesIssue(item, filters) {
    if (filters.severity && item.severity !== filters.severity) return false;
    if (filters.category && item.category !== filters.category) return false;
    if (!filters.query) return true;
    const haystack = normalized([
        item.code,
        item.category,
        item.characterName,
        item.field,
        item.entity,
        item.detail,
        item.suggestedAction,
    ].filter(Boolean).join(' '));
    return haystack.includes(filters.query);
}

async function getAdminIntegrityOverview(db, options = {}) {
    if (!db || typeof db.get !== 'function' || typeof db.all !== 'function') {
        throw new AdminIntegrityError('Banco indisponível para auditoria.', 'database_unavailable', 503);
    }

    const { report, cached } = await loadReport(db, options);
    const filters = {
        severity: normalized(options.severity),
        category: normalized(options.category),
        query: normalized(options.query),
    };
    const limit = boundedInteger(options.limit, 50, 1, MAX_LIMIT);
    const offset = boundedInteger(options.offset, 0, 0, 100_000);
    const presented = report.issues.map(presentIssue);
    const filtered = presented.filter((item) => matchesIssue(item, filters));
    const categories = Object.keys(report.summary?.byCategory || {}).sort((a, b) => a.localeCompare(b, 'pt-BR'));

    return {
        ok: true,
        readOnly: true,
        cached,
        generatedAt: report.generatedAt,
        summary: report.summary,
        filters: {
            severity: filters.severity || null,
            category: filters.category || null,
            query: text(options.query) || null,
            severities: ['critical', 'warning', 'review'],
            categories,
        },
        result: {
            total: filtered.length,
            offset,
            limit,
            hasMore: offset + limit < filtered.length,
        },
        issues: filtered.slice(offset, offset + limit),
    };
}

function clearAdminIntegrityCache(db) {
    if (db) REPORT_CACHE.delete(db);
}

module.exports = {
    AdminIntegrityError,
    clearAdminIntegrityCache,
    getAdminIntegrityOverview,
    maskIdentity,
    presentIssue,
};
