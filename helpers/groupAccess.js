const fs = require('fs');
const path = require('path');

const OWNER_NUMBERS = new Set(['557998868223']);
const OWNER_STATE_PATH = path.join(__dirname, '..', 'config', 'owner-access.json');

let cachedOwnerState = null;

function normalizeJid(jid) {
    return String(jid || '')
        .trim()
        .toLowerCase()
        .replace(/:\d+(?=@)/g, '');
}

function loadOwnerState() {
    if (cachedOwnerState) return cachedOwnerState;

    try {
        if (fs.existsSync(OWNER_STATE_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(OWNER_STATE_PATH, 'utf8'));
            cachedOwnerState = {
                registeredJid: normalizeJid(parsed?.registeredJid),
                registeredPhone: String(parsed?.registeredPhone || '').replace(/\D/g, ''),
                registeredAt: parsed?.registeredAt || null,
            };
            return cachedOwnerState;
        }
    } catch (error) {
        console.log('Erro ao carregar owner-access.json:', error);
    }

    cachedOwnerState = {
        registeredJid: '',
        registeredPhone: '',
        registeredAt: null,
    };

    return cachedOwnerState;
}

function saveOwnerState(nextState) {
    cachedOwnerState = {
        registeredJid: normalizeJid(nextState?.registeredJid),
        registeredPhone: String(nextState?.registeredPhone || '').replace(/\D/g, ''),
        registeredAt: nextState?.registeredAt || null,
    };

    fs.mkdirSync(path.dirname(OWNER_STATE_PATH), { recursive: true });
    fs.writeFileSync(OWNER_STATE_PATH, JSON.stringify(cachedOwnerState, null, 2));

    return cachedOwnerState;
}

function extractPhoneNumber(jid) {
    const normalized = normalizeJid(jid);
    if (!normalized) return '';

    if (!normalized.includes('@')) {
        return normalized.replace(/\D/g, '');
    }

    const [userPart, domain] = normalized.split('@');
    if (domain === 'lid') return '';

    return String(userPart || '').replace(/\D/g, '');
}

function registerOwnerIdentity(jid) {
    const normalizedJid = normalizeJid(jid);
    const registeredPhone = extractPhoneNumber(normalizedJid);

    const state = saveOwnerState({
        registeredJid: normalizedJid,
        registeredPhone,
        registeredAt: new Date().toISOString(),
    });

    console.log(`[owner] Dona registrada em ${state.registeredJid || '(vazio)'}`);
    return state;
}

function getRegisteredOwner() {
    return { ...loadOwnerState() };
}

function isOwner(jid) {
    const normalized = normalizeJid(jid);
    if (!normalized) return false;

    const phoneNumber = extractPhoneNumber(normalized);
    if (phoneNumber && OWNER_NUMBERS.has(phoneNumber)) {
        return true;
    }

    const ownerState = loadOwnerState();
    if (ownerState.registeredJid && normalized === ownerState.registeredJid) {
        return true;
    }

    return Boolean(ownerState.registeredPhone)
        && Boolean(phoneNumber)
        && phoneNumber === ownerState.registeredPhone;
}

function isSameUser(left, right) {
    const leftJid = normalizeJid(left);
    const rightJid = normalizeJid(right);
    if (!leftJid || !rightJid) return false;
    if (leftJid === rightJid) return true;

    const leftNumber = extractPhoneNumber(leftJid);
    const rightNumber = extractPhoneNumber(rightJid);
    return Boolean(leftNumber) && leftNumber === rightNumber;
}

async function isGroupEnabled(db, groupId) {
    const row = await db.get('SELECT enabled FROM group_settings WHERE group_id = ?', [groupId]);
    return Boolean(row?.enabled);
}

async function setGroupEnabled(db, groupId, enabled) {
    await db.run(
        `INSERT INTO group_settings (group_id, enabled, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(group_id) DO UPDATE SET
             enabled = excluded.enabled,
             updated_at = CURRENT_TIMESTAMP`,
        [groupId, enabled ? 1 : 0]
    );
}

module.exports = {
    OWNER_NUMBERS,
    extractPhoneNumber,
    getRegisteredOwner,
    isGroupEnabled,
    isOwner,
    isSameUser,
    normalizeJid,
    registerOwnerIdentity,
    setGroupEnabled,
};
