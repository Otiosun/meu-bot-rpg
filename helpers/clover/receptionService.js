'use strict';

const { getPublicSiteUrl } = require('./sitePublicUrl');

const RECEPTION_GROUP_INVITE_KEY = 'clover_reception_group_invite_link';
const LEGACY_OFF_GROUP_INVITE_KEY = 'clover_off_group_invite_link';
const DEFAULT_RECEPTION_INVITE_URL = 'https://chat.whatsapp.com/GsCifa4uwLP8h4z5tVnCFE';

function normalizeWhatsAppInviteUrl(value) {
    const text = String(value || '').trim();
    if (!/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]{8,}$/i.test(text)) return null;
    return text;
}

async function readSetting(db, key) {
    try {
        return await db.get(
            'SELECT value FROM clover_settings WHERE key = ?',
            [key]
        );
    } catch {
        return null;
    }
}

async function readStoredReceptionInvite(db) {
    if (!db) return DEFAULT_RECEPTION_INVITE_URL;

    const dedicated = await readSetting(db, RECEPTION_GROUP_INVITE_KEY);
    const dedicatedUrl = normalizeWhatsAppInviteUrl(dedicated?.value);
    if (dedicatedUrl) return dedicatedUrl;

    const legacy = await readSetting(db, LEGACY_OFF_GROUP_INVITE_KEY);
    const legacyUrl = normalizeWhatsAppInviteUrl(legacy?.value);

    // O valor legado só é aceito quando já aponta para a recepção correta.
    if (legacyUrl === DEFAULT_RECEPTION_INVITE_URL) return legacyUrl;

    return DEFAULT_RECEPTION_INVITE_URL;
}

async function getPublicReceptionState(db, options = {}) {
    const siteUrl = getPublicSiteUrl(options.env || process.env);
    const receptionInviteUrl = await readStoredReceptionInvite(db);
    return {
        public: true,
        siteUrl,
        entryUrl: new URL('/', siteUrl).toString(),
        loginUrl: new URL('/personagem', siteUrl).toString(),
        receptionInviteUrl,
        canJoinReception: Boolean(receptionInviteUrl),
        paths: {
            existingPlayer: '/personagem',
            newcomer: receptionInviteUrl,
        },
    };
}

module.exports = {
    DEFAULT_RECEPTION_INVITE_URL,
    LEGACY_OFF_GROUP_INVITE_KEY,
    RECEPTION_GROUP_INVITE_KEY,
    getPublicReceptionState,
    normalizeWhatsAppInviteUrl,
    readStoredReceptionInvite,
};