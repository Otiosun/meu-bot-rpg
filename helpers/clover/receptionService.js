'use strict';

const { getPublicSiteUrl } = require('./sitePublicUrl');

const OFF_GROUP_INVITE_KEY = 'clover_off_group_invite_link';

function normalizeWhatsAppInviteUrl(value) {
    const text = String(value || '').trim();
    if (!/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]{8,}$/i.test(text)) return null;
    return text;
}

async function readStoredReceptionInvite(db) {
    if (!db) return null;
    try {
        const row = await db.get(
            'SELECT value FROM clover_settings WHERE key = ?',
            [OFF_GROUP_INVITE_KEY]
        );
        return normalizeWhatsAppInviteUrl(row?.value);
    } catch {
        return null;
    }
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
    OFF_GROUP_INVITE_KEY,
    getPublicReceptionState,
    normalizeWhatsAppInviteUrl,
    readStoredReceptionInvite,
};
