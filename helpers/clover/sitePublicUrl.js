'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CLOVER_SITE_URL = 'https://clover-multicolor.vercel.app/';
const LEGACY_SITE_PATTERNS = Object.freeze([
    /https?:\/\/(?:www\.)?black-clover-multicolor\.lovable\.app\/?/gi,
    /https?:\/\/(?:www\.)?clover-multicolor\.lovable\.app\/?/gi,
    /https?:\/\/(?:www\.)?[a-z0-9-]+\.lovable\.app(?:\/[^\s"'<>]*)?/gi,
    /https?:\/\/clover-multicolor-git-main-[^\s/]+\.vercel\.app\/?/gi,
]);

function normalizePublicSiteUrl(value = '') {
    const raw = String(value || '').trim() || DEFAULT_CLOVER_SITE_URL;
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return `${withProtocol.replace(/\/+$/, '')}/`;
}

function getPublicSiteUrl(env = process.env) {
    return normalizePublicSiteUrl(env.CLOVER_SITE_PUBLIC_URL || DEFAULT_CLOVER_SITE_URL);
}

function replaceLegacySiteUrls(text, publicUrl = getPublicSiteUrl()) {
    const replacement = normalizePublicSiteUrl(publicUrl);
    return LEGACY_SITE_PATTERNS.reduce(
        (current, pattern) => current.replace(pattern, replacement),
        String(text ?? '')
    );
}

function migrateValue(value, publicUrl) {
    if (typeof value === 'string') {
        const next = replaceLegacySiteUrls(value, publicUrl);
        return { value: next, changed: next !== value };
    }
    if (Array.isArray(value)) {
        let changed = false;
        const next = value.map((item) => {
            const migrated = migrateValue(item, publicUrl);
            changed = changed || migrated.changed;
            return migrated.value;
        });
        return { value: next, changed };
    }
    if (value && typeof value === 'object') {
        let changed = false;
        const next = {};
        for (const [key, item] of Object.entries(value)) {
            const migrated = migrateValue(item, publicUrl);
            changed = changed || migrated.changed;
            next[key] = migrated.value;
        }
        return { value: next, changed };
    }
    return { value, changed: false };
}

function migrateCustomMessageSiteUrls(options = {}) {
    const filePath = options.filePath || path.join(process.cwd(), 'config', 'custom-messages.json');
    const publicUrl = normalizePublicSiteUrl(options.publicUrl || getPublicSiteUrl(options.env));
    if (!fs.existsSync(filePath)) return { ok: true, changed: false, reason: 'missing_file', filePath, publicUrl };

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const migrated = migrateValue(parsed, publicUrl);
        if (migrated.changed) {
            fs.writeFileSync(filePath, `${JSON.stringify(migrated.value, null, 2)}\n`, 'utf8');
        }
        return { ok: true, changed: migrated.changed, filePath, publicUrl };
    } catch (error) {
        return { ok: false, changed: false, filePath, publicUrl, error };
    }
}

module.exports = {
    DEFAULT_CLOVER_SITE_URL,
    LEGACY_SITE_PATTERNS,
    getPublicSiteUrl,
    migrateCustomMessageSiteUrls,
    normalizePublicSiteUrl,
    replaceLegacySiteUrls,
};