const DEFAULT_WHATSAPP_DOMAIN = 's.whatsapp.net';
const PHONE_JID_DOMAINS = new Set([DEFAULT_WHATSAPP_DOMAIN, 'c.us']);

function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
}

function splitJid(value) {
    const normalized = normalizeText(value);
    const atIndex = normalized.indexOf('@');
    if (atIndex <= 0) return null;

    const user = normalized.slice(0, atIndex).replace(/:\d+$/, '');
    const domain = normalized.slice(atIndex + 1);
    if (!user || !domain) return null;

    return {
        user,
        domain,
        jid: `${user}@${domain}`,
    };
}

function getDigitsFromRawPhone(value) {
    const normalized = normalizeText(value);
    if (!normalized || normalized.includes('@')) return '';

    const withoutSeparators = normalized.replace(/[\s().+-]/g, '');
    if (!/^\d+$/.test(withoutSeparators)) return '';

    return normalized.replace(/\D/g, '');
}

function getWhatsAppPhoneNumber(value) {
    const jid = splitJid(value);
    if (jid) {
        if (!PHONE_JID_DOMAINS.has(jid.domain)) return '';
        return /^\d+$/.test(jid.user) ? jid.user : '';
    }

    return getDigitsFromRawPhone(value);
}

function toWhatsAppJid(value) {
    const normalized = normalizeText(value);
    if (!normalized) return '';

    const phone = getWhatsAppPhoneNumber(normalized);
    if (phone) return `${phone}@${DEFAULT_WHATSAPP_DOMAIN}`;

    const jid = splitJid(normalized);
    return jid ? jid.jid : normalized;
}

function normalizeWhatsAppUserId(value) {
    return toWhatsAppJid(value);
}

function getWhatsAppIdentityVariants(value) {
    const normalized = normalizeText(value);
    const variants = new Set();

    const canonical = normalizeWhatsAppUserId(normalized);
    if (canonical) variants.add(canonical);

    const jid = splitJid(normalized);
    if (jid?.jid) variants.add(jid.jid);

    const phone = getWhatsAppPhoneNumber(normalized);
    if (phone) {
        variants.add(`${phone}@${DEFAULT_WHATSAPP_DOMAIN}`);
        variants.add(`${phone}@c.us`);
        variants.add(phone);
    }

    if (normalized) variants.add(normalized);

    return Array.from(variants).filter(Boolean);
}

function isSameWhatsAppUser(left, right) {
    const leftVariants = getWhatsAppIdentityVariants(left);
    const rightVariants = new Set(getWhatsAppIdentityVariants(right));

    return leftVariants.some((variant) => rightVariants.has(variant));
}

module.exports = {
    getWhatsAppIdentityVariants,
    getWhatsAppPhoneNumber,
    isSameWhatsAppUser,
    normalizeWhatsAppUserId,
    toWhatsAppJid,
};
