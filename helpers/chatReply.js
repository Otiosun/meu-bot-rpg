const fs = require('fs');
const path = require('path');

const AUTH_DIR_PREFIX = 'auth_info';
const AUTH_INFO_DIR = path.join(__dirname, '..', AUTH_DIR_PREFIX);
const OWNER_ACCESS_FILE = path.join(__dirname, '..', 'config', 'owner-access.json');
const PRIVATE_SEND_TTL_MS = 5 * 60 * 1000;
const PRIVATE_SEND_MAX_RECORDS = 300;
const ERROR_STATUS = 0;
const DELIVERED_OR_ACK_STATUS = 2;
const TRUSTED_CONTACT_ERROR_CODE = '463';
const HUMAN_TYPING_MIN_MS = 900;
const HUMAN_TYPING_MAX_MS = 6000;
const PRIVATE_COMMAND_GLOBAL_GAP_MS = 1200;
const PRIVATE_COMMAND_TARGET_GAP_MS = 3000;
const PRIVATE_AUTO_GLOBAL_GAP_MS = 2500;
const PRIVATE_AUTO_TARGET_GAP_MS = 15000;

const pendingPrivateSends = new Map();
const privateSendClock = {
    lastAnyAt: 0,
    byTarget: new Map(),
};

function getCloverDeliveryDb() {
    return global.__cloverDeliveryDb || global.runtimeClover?.db || null;
}

async function enqueuePrivateDeliveryFallback({ idChat, message, reason, source = 'chatReply' }) {
    if (process.env.CLOVER_DELIVERY_QUEUE_ENABLED !== '1') return null;
    const db = getCloverDeliveryDb();
    if (!db) return null;

    try {
        const { enqueuePrivateMessage } = require('./clover/deliveryService');
        const queued = await enqueuePrivateMessage(db, {
            targetJid: normalizeJid(idChat),
            message,
            source,
            reason,
            metadata: { queued_by: 'chatReply' },
            priority: reason === 'pv_reachout_locked' ? 5 : 0,
        });
        if (queued?.ok) {
            console.log('[sendReply] PV encaminhado para fila auxiliar:', {
                idChat,
                reason,
                jobId: queued.jobId || null,
            });
        }
        return queued;
    } catch (error) {
        console.log('[sendReply] falha ao colocar PV na fila auxiliar:', {
            idChat,
            reason,
            error: error?.message || error,
        });
        return null;
    }
}

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeJid(jid) {
    return String(jid || '')
        .trim()
        .toLowerCase()
        .replace(/:\d+(?=@)/g, '');
}

function getIncomingText(message) {
    return message?.message?.conversation
        || message?.message?.extendedTextMessage?.text
        || message?.message?.imageMessage?.caption
        || message?.message?.videoMessage?.caption
        || '';
}

function looksLikeCloverCommand(text) {
    return /^\.#/i.test(String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f\u0323\u200b-\u200f\ufeff]/g, '')
        .trim());
}

function isPrivateCommandReply(idChat, m) {
    const target = normalizeJid(idChat);
    if (!isPrivateJid(target)) return false;
    return looksLikeCloverCommand(getIncomingText(m));
}

function cleanSendJid(jid) {
    return String(jid || '').trim().toLowerCase();
}

function hasDeviceSuffix(jid) {
    return /:\d+(?=@)/.test(String(jid || ''));
}

function isPrivateJid(jid) {
    const clean = cleanSendJid(jid);
    return Boolean(clean)
        && clean.includes('@')
        && !clean.endsWith('@g.us')
        && !clean.endsWith('@newsletter')
        && clean !== 'status@broadcast';
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function messageTextLength(message = {}) {
    if (!message || typeof message !== 'object') return 0;
    return String(message.text || message.caption || message.groupInvite?.body || '').length;
}

function humanTypingDelayMs(message = {}) {
    const length = messageTextLength(message);
    const base = 650 + Math.min(4300, length * 22);
    const jitter = Math.floor(Math.random() * 700);
    return clamp(base + jitter, HUMAN_TYPING_MIN_MS, HUMAN_TYPING_MAX_MS);
}

async function withHumanTyping(sock, jid, message, enabled, sendFn) {
    if (!enabled || process.env.CLOVER_HUMAN_TYPING_ENABLED === '0' || !sock?.sendPresenceUpdate) {
        return sendFn();
    }

    try {
        await sock.sendPresenceUpdate('composing', jid);
        await sleep(humanTypingDelayMs(message));
    } catch (error) {
        console.log('[sendReply] falha ao sinalizar digitando:', {
            target: jid,
            error: error?.message || error,
        });
    }

    try {
        return await sendFn();
    } finally {
        await sock.sendPresenceUpdate('paused', jid).catch(() => null);
    }
}

async function waitPrivateSendSlot(jid, { commandReply = false } = {}) {
    if (process.env.CLOVER_PRIVATE_SEND_THROTTLE === '0') return;
    if (!isPrivateJid(jid)) return;
    const now = Date.now();
    const normalized = normalizeJid(jid);
    const globalGap = commandReply ? PRIVATE_COMMAND_GLOBAL_GAP_MS : PRIVATE_AUTO_GLOBAL_GAP_MS;
    const targetGap = commandReply ? PRIVATE_COMMAND_TARGET_GAP_MS : PRIVATE_AUTO_TARGET_GAP_MS;
    const lastTargetAt = privateSendClock.byTarget.get(normalized) || 0;
    const waitMs = Math.max(
        privateSendClock.lastAnyAt + globalGap - now,
        lastTargetAt + targetGap - now,
        0
    );

    if (waitMs > 0) {
        await sleep(waitMs);
    }

    const reservedAt = Date.now();
    privateSendClock.lastAnyAt = reservedAt;
    if (normalized) {
        privateSendClock.byTarget.set(normalized, reservedAt);
    }

    if (privateSendClock.byTarget.size > 500) {
        const cutoff = reservedAt - 30 * 60 * 1000;
        for (const [target, at] of privateSendClock.byTarget.entries()) {
            if (at < cutoff) privateSendClock.byTarget.delete(target);
        }
    }
}

function getActivePrivateReachoutLock() {
    const lock = global.runtimeClover?.pvReachoutLock || null;
    if (!lock?.isActive) return null;

    const rawEnd = lock.timeEnforcementEnds;
    if (!rawEnd) return lock;

    const end = rawEnd instanceof Date ? rawEnd : new Date(rawEnd);
    if (Number.isNaN(end.getTime())) return lock;
    if (end.getTime() <= Date.now()) return null;

    return {
        ...lock,
        timeEnforcementEnds: end,
    };
}

function getSocketAuthState(sock) {
    return sock?._cloverAuthState || sock?.authState || null;
}

function getNodeChildren(node) {
    return Array.isArray(node?.content) ? node.content : [];
}

function collectTrustedContactTokenEntries(node, fallbackJid, inheritedFrom = '') {
    if (!node || typeof node !== 'object' || Buffer.isBuffer(node)) return [];

    const attrs = node.attrs || {};
    const currentFrom = normalizeJid(attrs.from || inheritedFrom);
    const entries = [];

    if (node.tag === 'token' && attrs.type === 'trusted_contact') {
        const token = Buffer.isBuffer(node.content)
            ? node.content
            : (node.content instanceof Uint8Array ? Buffer.from(node.content) : null);
        const jid = cleanSendJid(attrs.jid || attrs.from || currentFrom || fallbackJid);
        if (token && jid) {
            entries.push({
                jid,
                token,
                timestamp: Number(attrs.t) || Math.floor(Date.now() / 1000),
            });
        }
    }

    for (const child of getNodeChildren(node)) {
        entries.push(...collectTrustedContactTokenEntries(child, fallbackJid, currentFrom));
    }

    return entries;
}

function summarizeBinaryNode(node, depth = 0) {
    if (!node || typeof node !== 'object') {
        return typeof node;
    }

    if (Buffer.isBuffer(node) || node instanceof Uint8Array) {
        return `buffer:${node.length}`;
    }

    if (depth >= 4) {
        return {
            tag: node.tag || null,
            attrs: node.attrs ? Object.keys(node.attrs) : [],
            content: Array.isArray(node.content) ? `children:${node.content.length}` : typeof node.content,
        };
    }

    return {
        tag: node.tag || null,
        attrs: node.attrs || {},
        content: Array.isArray(node.content)
            ? node.content.slice(0, 8).map((child) => summarizeBinaryNode(child, depth + 1))
            : summarizeBinaryNode(node.content, depth + 1),
    };
}

async function readTrustedContactToken(authState, jid) {
    const clean = cleanSendJid(jid);
    if (!authState?.keys?.get || !clean) return null;

    try {
        const found = await authState.keys.get('tctoken', [clean]);
        return found?.[clean] || null;
    } catch {
        return null;
    }
}

async function storeTrustedContactToken(authState, jids, tokenData) {
    if (!authState?.keys?.set || !tokenData?.token) return false;

    const data = {};
    for (const jid of jids) {
        const clean = cleanSendJid(jid);
        if (!clean || !isPrivateJid(clean)) continue;
        data[clean] = {
            token: tokenData.token,
            timestamp: tokenData.timestamp || Math.floor(Date.now() / 1000),
        };
    }

    if (!Object.keys(data).length) return false;
    await authState.keys.set({ tctoken: data });
    return true;
}

async function clearTrustedContactTokens(sock, jids) {
    const authState = getSocketAuthState(sock);
    if (!authState?.keys?.set) return false;

    const data = {};
    for (const jid of jids) {
        const clean = cleanSendJid(jid);
        const bare = normalizeJid(clean);
        if (clean && isPrivateJid(clean)) data[clean] = null;
        if (bare && isPrivateJid(bare)) data[bare] = null;
    }

    if (!Object.keys(data).length) return false;
    await authState.keys.set({ tctoken: data });
    return true;
}

async function ensureTrustedContactToken(sock, jid, options = {}) {
    const targetJid = cleanSendJid(jid);
    const bareJid = normalizeJid(targetJid);
    if (!isPrivateJid(targetJid) || !sock?.getPrivacyTokens) return false;

    const authState = getSocketAuthState(sock);
    if (!authState?.keys?.get || !authState?.keys?.set) return false;

    const force = Boolean(options.force);
    if (!force) {
        const targetToken = await readTrustedContactToken(authState, targetJid);
        if (targetToken?.token) return true;

        if (bareJid && bareJid !== targetJid) {
            const bareToken = await readTrustedContactToken(authState, bareJid);
            if (bareToken?.token) {
                await storeTrustedContactToken(authState, [targetJid], bareToken);
                return true;
            }
        }
    }

    try {
        const response = await sock.getPrivacyTokens([bareJid || targetJid]);
        const entries = collectTrustedContactTokenEntries(response, bareJid || targetJid);
        const preferred = entries.find((entry) => normalizeJid(entry.jid) === bareJid)
            || entries.find((entry) => extractDigits(entry.jid) === extractDigits(bareJid || targetJid))
            || entries[0];

        if (!preferred?.token) {
            console.log('[sendReply] tctoken PV indisponivel:', {
                target: targetJid,
                response: summarizeBinaryNode(response),
            });
            return false;
        }

        await storeTrustedContactToken(authState, [preferred.jid, bareJid, targetJid], preferred);
        console.log('[sendReply] tctoken PV atualizado:', {
            target: targetJid,
            tokenJid: preferred.jid,
        });
        return true;
    } catch (error) {
        console.log('[sendReply] falha ao atualizar tctoken PV:', {
            target: targetJid,
            error: error?.message || error,
        });
        return false;
    }
}

function prunePendingPrivateSends() {
    const now = Date.now();
    for (const [messageId, record] of pendingPrivateSends) {
        if (now - record.createdAt > PRIVATE_SEND_TTL_MS) {
            pendingPrivateSends.delete(messageId);
        }
    }

    while (pendingPrivateSends.size > PRIVATE_SEND_MAX_RECORDS) {
        const oldest = pendingPrivateSends.keys().next().value;
        if (!oldest) break;
        pendingPrivateSends.delete(oldest);
    }
}

function authInfoDirectories() {
    const rootDir = path.join(__dirname, '..');
    const dirs = [];

    if (fs.existsSync(AUTH_INFO_DIR)) dirs.push(AUTH_INFO_DIR);

    try {
        const backups = fs.readdirSync(rootDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${AUTH_DIR_PREFIX}_backup_`))
            .map((entry) => path.join(rootDir, entry.name))
            .sort()
            .reverse();
        dirs.push(...backups);
    } catch {
        return dirs;
    }

    return dirs;
}

function readDeviceIdsForUserDigits(userDigits, options = {}) {
    const digits = extractDigits(userDigits);
    if (!digits) return [];

    const includeBackups = Boolean(options.includeBackups);
    const dirs = includeBackups
        ? authInfoDirectories()
        : (fs.existsSync(AUTH_INFO_DIR) ? [AUTH_INFO_DIR] : []);
    const ids = new Set();
    for (const dir of dirs) {
        const filePath = path.join(dir, `device-list-${digits}.json`);
        try {
            if (!fs.existsSync(filePath)) continue;
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!Array.isArray(parsed)) continue;

            for (const item of parsed) {
                const value = Number(item);
                if (Number.isInteger(value) && value > 0) {
                    ids.add(value);
                }
            }
        } catch {
            continue;
        }
    }

    return [...ids].sort((a, b) => a - b);
}

function parseMappedDigits(filePath, keys) {
    try {
        if (!fs.existsSync(filePath)) return '';

        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (typeof parsed === 'string' || typeof parsed === 'number') {
            return extractDigits(parsed);
        }

        if (parsed && typeof parsed === 'object') {
            for (const key of keys) {
                const value = extractDigits(parsed[key]);
                if (value) return value;
            }
        }
    } catch {
        return '';
    }

    return '';
}

function readMappedPhoneDigits(lidDigits) {
    const digits = extractDigits(lidDigits);
    if (!digits) return '';

    for (const dir of authInfoDirectories()) {
        const direct = parseMappedDigits(
            path.join(dir, `lid-mapping-${digits}_reverse.json`),
            ['phoneNumber', 'phone_number', 'pn', 'jid', 'id', 'user']
        );
        if (direct) return direct;
    }

    for (const dir of authInfoDirectories()) {
        try {
            const match = fs.readdirSync(dir)
                .filter((name) => /^lid-mapping-\d+\.json$/i.test(name))
                .find((name) => {
                    const mappedLid = parseMappedDigits(
                        path.join(dir, name),
                        ['lid', 'lidJid', 'lid_jid', 'jid', 'id', 'user']
                    );
                    return mappedLid === digits;
                });

            if (match) return extractDigits(match.replace(/^lid-mapping-/, '').replace(/\.json$/i, ''));
        } catch {
            continue;
        }
    }

    return '';
}

function readMappedLidDigits(phoneDigits) {
    const digits = extractDigits(phoneDigits);
    if (!digits) return '';

    for (const dir of authInfoDirectories()) {
        const mapped = parseMappedDigits(
            path.join(dir, `lid-mapping-${digits}.json`),
            ['lid', 'lidJid', 'lid_jid', 'jid', 'id', 'user']
        );
        if (mapped) return mapped;
    }

    return '';
}

function readOwnerAccess() {
    try {
        if (!fs.existsSync(OWNER_ACCESS_FILE)) return {};
        return JSON.parse(fs.readFileSync(OWNER_ACCESS_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function isOwnerReplyTarget(idChat, targets = []) {
    const owner = readOwnerAccess();
    const ownerLid = normalizeJid(owner.registeredJid);
    const ownerPhone = extractDigits(owner.registeredPhone);
    const normalized = normalizeJid(idChat);
    const targetJids = [normalized, ...targets.map((item) => normalizeJid(item.jid))];
    if (ownerLid && targetJids.includes(ownerLid)) return true;
    if (ownerPhone && targetJids.some((jid) => extractDigits(jid) === ownerPhone)) return true;
    return false;
}

function buildReplyTargets(idChat) {
    const original = cleanSendJid(idChat);
    const normalized = normalizeJid(idChat);
    if (!normalized || normalized.endsWith('@g.us')) {
        return [{ jid: idChat, quoted: true }];
    }

    const [userPart, domain] = normalized.split('@');
    const targets = [];
    const seen = new Set();

    const add = (jid, quoted) => {
        const clean = cleanSendJid(jid);
        if (!clean || seen.has(`${clean}:${quoted ? 'q' : 'nq'}`)) return;
        seen.add(`${clean}:${quoted ? 'q' : 'nq'}`);
        targets.push({ jid: clean, quoted });
    };

    const originalDeviceJid = original && hasDeviceSuffix(original) ? original : '';

    if (domain === 'lid') {
        add(normalized, true);
        add(normalized, false);
        if (originalDeviceJid) add(originalDeviceJid, false);
        for (const deviceId of readDeviceIdsForUserDigits(userPart)) {
            add(`${userPart}:${deviceId}@lid`, false);
        }
        for (const deviceId of readDeviceIdsForUserDigits(userPart, { includeBackups: true })) {
            add(`${userPart}:${deviceId}@lid`, false);
        }
        const phone = readMappedPhoneDigits(userPart);
        if (phone) add(`${phone}@s.whatsapp.net`, false);
        return targets;
    }

    add(normalized, true);
    add(normalized, false);
    if (originalDeviceJid) add(originalDeviceJid, false);
    for (const deviceId of readDeviceIdsForUserDigits(userPart)) {
        add(`${userPart}:${deviceId}@${domain}`, false);
    }

    const lid = readMappedLidDigits(userPart);
    if (lid) {
        add(`${lid}@lid`, false);
        for (const deviceId of readDeviceIdsForUserDigits(lid)) {
            add(`${lid}:${deviceId}@lid`, false);
        }
    }

    for (const deviceId of readDeviceIdsForUserDigits(userPart, { includeBackups: true })) {
        add(`${userPart}:${deviceId}@${domain}`, false);
    }

    if (lid) {
        for (const deviceId of readDeviceIdsForUserDigits(lid, { includeBackups: true })) {
            add(`${lid}:${deviceId}@lid`, false);
        }
    }
    add(normalized, true);

    return targets;
}

async function expandTargetsWithSocketDevices(sock, targets) {
    if (!sock?.getUSyncDevices) return targets;

    const expanded = [];
    const seen = new Set();
    const add = (target) => {
        const jid = cleanSendJid(target?.jid);
        if (!jid) return;
        const key = `${jid}:${target.quoted ? 'q' : 'nq'}`;
        if (seen.has(key)) return;
        seen.add(key);
        expanded.push({ jid, quoted: Boolean(target.quoted) });
    };

    for (const target of targets) {
        add(target);

        const bare = normalizeJid(target.jid);
        if (bare && !bare.endsWith('@g.us') && !hasDeviceSuffix(target.jid)) {
            try {
                const devices = await sock.getUSyncDevices([bare], false, false);
                for (const device of devices || []) {
                    const jid = cleanSendJid(device?.jid);
                    if (jid && hasDeviceSuffix(jid)) {
                        add({ jid, quoted: false });
                    }
                }
            } catch (error) {
                console.log('[sendReply] nao consegui consultar devices do PV:', {
                    target: target.jid,
                    error: error?.message || error,
                });
            }
        }
    }

    return expanded;
}

function rememberPrivateSend(sent, meta) {
    const messageId = sent?.key?.id;
    const remoteJid = cleanSendJid(sent?.key?.remoteJid || meta?.targetJid);
    if (!messageId || !isPrivateJid(remoteJid) || !sent?.message) return;

    prunePendingPrivateSends();
    pendingPrivateSends.set(messageId, {
        messageId,
        targetJid: remoteJid,
        content: meta.content,
        protoMessage: sent.message,
        fallbackTargets: meta.fallbackTargets || [],
        createdAt: Date.now(),
        recoveryStarted: false,
    });
}

function forgetPrivateSend(messageId) {
    if (messageId) pendingPrivateSends.delete(messageId);
}

function uniqueRecoveryTargets(record) {
    const seen = new Set();
    const targets = [];

    const add = (jid, reason) => {
        const clean = cleanSendJid(jid);
        if (!isPrivateJid(clean) || seen.has(clean)) return;
        seen.add(clean);
        targets.push({ jid: clean, reason });
    };

    add(record.targetJid, 'retry');
    for (const target of record.fallbackTargets || []) {
        if (target.quoted) continue;
        add(target.jid, 'fallback');
    }

    return targets;
}

async function handlePrivateSendUpdate({ sock, item }) {
    const messageId = item?.key?.id;
    const jid = item?.key?.remoteJid || '';
    const update = item?.update || {};
    const status = update.status;

    if (!item?.key?.fromMe || !isPrivateJid(jid) || !messageId) return false;

    if (Number(status) >= DELIVERED_OR_ACK_STATUS) {
        forgetPrivateSend(messageId);
        return false;
    }

    if (Number(status) !== ERROR_STATUS) return false;

    const record = pendingPrivateSends.get(messageId);
    if (!record || record.recoveryStarted) return false;
    record.recoveryStarted = true;

    const errorCode = update.messageStubParameters?.[0] || null;
    const recoveryTargets = uniqueRecoveryTargets(record);
    if (String(errorCode) === TRUSTED_CONTACT_ERROR_CODE) {
        await clearTrustedContactTokens(sock, [
            record.targetJid,
            ...recoveryTargets.map((target) => target.jid),
        ]);
        console.log('[sendReply] PV bloqueado por reachout/privacidade; recuperacao normal pulada:', {
            idChat: jid,
            messageId,
            errorCode,
            recoveryTargets: recoveryTargets.map((target) => `${target.jid}:${target.reason}`),
        });
        forgetPrivateSend(messageId);
        return false;
    }
    console.log('[sendReply] PV retornou erro; tentando recuperacao:', {
        idChat: jid,
        messageId,
        errorCode,
        recoveryTargets: recoveryTargets.map((target) => `${target.jid}:${target.reason}`),
    });

    let recovered = false;

    if (sock?.relayMessage && record.protoMessage) {
        try {
            if (String(errorCode) === TRUSTED_CONTACT_ERROR_CODE) {
                await ensureTrustedContactToken(sock, record.targetJid, { force: true });
            }
            await sock.relayMessage(record.targetJid, record.protoMessage, {
                messageId: record.messageId,
                useUserDevicesCache: false,
                additionalAttributes: {
                    device_fanout: 'false',
                },
            });
            recovered = true;
            console.log('[sendReply] recuperacao PV via relay enviada:', {
                target: record.targetJid,
                messageId: record.messageId,
                errorCode,
            });
        } catch (error) {
            console.log('[sendReply] recuperacao PV via relay falhou:', {
                target: record.targetJid,
                messageId: record.messageId,
                errorCode,
                error: error?.message || error,
            });
        }
    }

    for (const target of recoveryTargets.filter((candidate) => candidate.jid !== record.targetJid)) {
        try {
            if (String(errorCode) === TRUSTED_CONTACT_ERROR_CODE) {
                await ensureTrustedContactToken(sock, target.jid, { force: true });
            }
            const sent = await sock.sendMessage(target.jid, record.content, {
                useUserDevicesCache: false,
            });
            recovered = true;
            console.log('[sendReply] recuperacao PV via fallback enviada:', {
                target: target.jid,
                originalMessageId: record.messageId,
                newMessageId: sent?.key?.id || null,
                errorCode,
            });
        } catch (error) {
            console.log('[sendReply] recuperacao PV via fallback falhou:', {
                target: target.jid,
                originalMessageId: record.messageId,
                errorCode,
                error: error?.message || error,
            });
        }
    }

    if (recovered) {
        forgetPrivateSend(messageId);
    }

    return recovered;
}

async function sendMessageWithFallback(sock, idChat, message, m) {
    const original = normalizeJid(idChat);
    const privateTarget = original && !original.endsWith('@g.us');
    const privateCommandReply = privateTarget && isPrivateCommandReply(original, m);
    const reachoutLock = privateTarget ? getActivePrivateReachoutLock() : null;
    if (reachoutLock) {
        console.log('[sendReply] PV pulado por trava do WhatsApp:', {
            idChat,
            tipo: reachoutLock.enforcementType || null,
            fim: reachoutLock.timeEnforcementEnds || null,
            privateCommandReply,
        });
        if (privateCommandReply) {
            return {
                skipped: true,
                reason: 'pv_command_reply_not_queued',
                lock: {
                    isActive: true,
                    enforcementType: reachoutLock.enforcementType || null,
                    timeEnforcementEnds: reachoutLock.timeEnforcementEnds || null,
                },
            };
        }
        const queued = await enqueuePrivateDeliveryFallback({
            idChat: original,
            message,
            reason: 'pv_reachout_locked',
        });
        return {
            skipped: true,
            reason: 'pv_reachout_locked',
            queue: queued?.ok ? { id: queued.jobId || null } : null,
            lock: {
                isActive: true,
                enforcementType: reachoutLock.enforcementType || null,
                timeEnforcementEnds: reachoutLock.timeEnforcementEnds || null,
            },
        };
    }

    const baseTargets = buildReplyTargets(idChat);
    const targets = privateCommandReply
        ? baseTargets.slice(0, 1)
        : await expandTargetsWithSocketDevices(sock, baseTargets);
    const fanoutPrivate = process.env.CLOVER_PRIVATE_REPLY_FANOUT === '1'
        && !privateCommandReply
        && !original.endsWith('@g.us')
        && targets.length > 1
        && isOwnerReplyTarget(idChat, targets);
    let lastError = null;
    let firstSent = null;
    const sentTargets = [];

    if (!original.endsWith('@g.us') && targets.length > 1) {
        console.log('[sendReply] alvos PV:', {
            idChat,
            fanoutPrivate,
            targets: targets.map((item) => `${item.jid}${item.quoted ? ':quoted' : ''}`),
        });
    }

    for (const target of targets) {
        try {
            if (isPrivateJid(target.jid)) {
                await ensureTrustedContactToken(sock, target.jid);
            }
            const options = {
                ...(fanoutPrivate ? { useUserDevicesCache: false } : {}),
                ...(target.quoted && m ? { quoted: m } : {}),
            };
            await waitPrivateSendSlot(target.jid, { commandReply: privateCommandReply });
            const sent = await withHumanTyping(
                sock,
                target.jid,
                message,
                privateCommandReply,
                () => sock.sendMessage(
                    target.jid,
                    message,
                    Object.keys(options).length ? options : undefined
                )
            );
            rememberPrivateSend(sent, {
                content: message,
                targetJid: target.jid,
                fallbackTargets: targets.filter((item) => item.jid !== target.jid || item.quoted !== target.quoted),
            });
            if (!normalizeJid(idChat).endsWith('@g.us')) {
                console.log('[sendReply] resposta PV enviada:', {
                    idChat,
                    target: target.jid,
                    quoted: Boolean(target.quoted && m),
                    noCache: fanoutPrivate,
                    messageId: sent?.key?.id || null,
                });
            }
            sentTargets.push(`${target.jid}${target.quoted ? ':quoted' : ''}`);
            if (!firstSent) firstSent = sent;
            if (fanoutPrivate) continue;
            return sent;
        } catch (error) {
            lastError = error;
            if (fanoutPrivate) {
                console.log('[sendReply] falha parcial no fanout PV:', {
                    idChat,
                    target: target.jid,
                    quoted: Boolean(target.quoted && m),
                    error: error?.message || error,
                });
            }
        }
    }

    if (firstSent) {
        if (fanoutPrivate) {
            console.log('[sendReply] fanout PV concluido:', {
                idChat,
                sentTargets,
            });
        }
        return firstSent;
    }

    if (privateTarget) {
        if (privateCommandReply) {
            return {
                skipped: true,
                reason: 'pv_command_reply_not_queued',
                originalError: lastError?.message || String(lastError || 'send_failed'),
            };
        }
        const queued = await enqueuePrivateDeliveryFallback({
            idChat: original,
            message,
            reason: lastError?.message || 'send_failed',
        });
        if (queued?.ok) {
            return {
                skipped: true,
                reason: 'queued_delivery',
                queue: { id: queued.jobId || null },
                originalError: lastError?.message || String(lastError || 'send_failed'),
            };
        }
    }

    console.log('[sendReply] falha ao enviar resposta:', {
        idChat,
        targets: targets.map((item) => `${item.jid}${item.quoted ? ':quoted' : ''}`),
        error: lastError?.message || lastError,
    });
    throw lastError;
}

async function sendReply({ sock, idChat, m, text, mentions, imagePath }) {
    const safeMentions = mentions || [];
    const message = imagePath && fs.existsSync(imagePath)
        ? { image: fs.readFileSync(imagePath), caption: text, mentions: safeMentions }
        : { text, mentions: safeMentions };

    return sendMessageWithFallback(sock, idChat, message, m);
}

async function sendPrivateText({ sock, playerId, text, mentions }) {
    const safeMentions = mentions || [];
    return sendMessageWithFallback(sock, playerId, { text, mentions: safeMentions }, null);
}

async function sendPrivateMessage({ sock, playerId, message }) {
    return sendMessageWithFallback(sock, playerId, message, null);
}

async function sendReaction({ sock, idChat, m, emoji }) {
    if (!m?.key) return null;

    return sock.sendMessage(idChat, {
        react: {
            text: emoji,
            key: m.key,
        },
    });
}

module.exports = {
    handlePrivateSendUpdate,
    sendPrivateMessage,
    sendPrivateText,
    sendReaction,
    sendReply,
};
