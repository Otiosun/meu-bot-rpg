const fs = require('fs');
const path = require('path');

const OWNER_NUMBERS = new Set(['557998868223']);
const OWNER_STATE_PATH = path.join(__dirname, '..', 'config', 'owner-access.json');
const AUTH_INFO_DIR = path.join(__dirname, '..', 'auth_info');

let cachedOwnerState = null;

function normalizeJid(jid) {
    return String(jid || '')
        .trim()
        .toLowerCase()
        .replace(/:\d+(?=@)/g, '');
}

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function readMappedPhoneDigits(lidDigits) {
    const digits = extractDigits(lidDigits);
    if (!digits) return '';

    const mappingPath = path.join(AUTH_INFO_DIR, `lid-mapping-${digits}_reverse.json`);
    try {
        if (!fs.existsSync(mappingPath)) return '';

        const parsed = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        if (typeof parsed === 'string' || typeof parsed === 'number') {
            return extractDigits(parsed);
        }

        if (parsed && typeof parsed === 'object') {
            return extractDigits(parsed.phoneNumber || parsed.pn || parsed.jid || parsed.id || parsed.user);
        }
    } catch {
        return '';
    }

    return '';
}

function loadOwnerState() {
    if (cachedOwnerState) return cachedOwnerState;

    try {
        if (fs.existsSync(OWNER_STATE_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(OWNER_STATE_PATH, 'utf8'));
            cachedOwnerState = {
                registeredJid: normalizeJid(parsed?.registeredJid),
                registeredPhone: extractDigits(parsed?.registeredPhone),
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
        registeredPhone: extractDigits(nextState?.registeredPhone),
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
    if (domain === 'lid') return readMappedPhoneDigits(userPart);

    return extractDigits(userPart);
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

function normalizeGroupReceptionType(type) {
    const normalized = String(type || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '');

    if (['recepcao', 'reception', 'welcome', 'boasvindas'].includes(normalized)) return 'reception';
    if (['off', 'grupooff', 'recepcaooff', 'offgroup'].includes(normalized)) return 'off';
    return null;
}

async function getGroupReceptionConfig(db, groupId) {
    const row = await db.get(
        `SELECT reception_enabled, reception_type
         FROM group_settings
         WHERE group_id = ?`,
        [groupId]
    );

    return {
        enabled: Boolean(row?.reception_enabled),
        type: normalizeGroupReceptionType(row?.reception_type),
    };
}

async function isGroupReceptionEnabled(db, groupId, type = null) {
    const config = await getGroupReceptionConfig(db, groupId);
    if (!config.enabled) return false;
    if (!type) return true;
    return config.type === normalizeGroupReceptionType(type);
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

async function setGroupReception(db, groupId, type, enabled) {
    const normalizedType = normalizeGroupReceptionType(type);
    if (enabled && !normalizedType) {
        throw new Error(`Tipo de recepcao invalido: ${type}`);
    }

    const existing = await db.get(
        'SELECT enabled FROM group_settings WHERE group_id = ?',
        [groupId]
    );

    await db.run(
        `INSERT INTO group_settings (group_id, enabled, reception_enabled, reception_type, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(group_id) DO UPDATE SET
             reception_enabled = excluded.reception_enabled,
             reception_type = excluded.reception_type,
             updated_at = CURRENT_TIMESTAMP`,
        [
            groupId,
            existing?.enabled ? 1 : 0,
            enabled ? 1 : 0,
            enabled ? normalizedType : null,
        ]
    );
}

module.exports = {
    OWNER_NUMBERS,
    extractPhoneNumber,
    getRegisteredOwner,
    getGroupReceptionConfig,
    isGroupEnabled,
    isGroupReceptionEnabled,
    isOwner,
    isSameUser,
    normalizeGroupReceptionType,
    normalizeJid,
    registerOwnerIdentity,
    setGroupEnabled,
    setGroupReception,
};
