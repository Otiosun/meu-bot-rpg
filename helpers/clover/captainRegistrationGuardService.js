'use strict';

const { normalizeJid } = require('../groupAccess');
const {
    CaptainPersonaError,
    normalizeMode,
    registerSquadCaptain,
} = require('./captainPersonaService');
const {
    extractDigits,
    resolveBestPlayerByPhone,
} = require('./siteAuthService');

function normalizedText(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function filledCharacterName(player) {
    return [player?.personagem_nome, player?.display_name, player?.nome]
        .map((value) => String(value || '').trim())
        .find((value) => value && value !== '-')
        || null;
}

function normalizeBrazilianCaptainAccount(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        throw new CaptainPersonaError('Informe o número ou JID da conta.', 'missing_account');
    }
    if (raw.includes('@')) {
        const jid = normalizeJid(raw);
        if (!jid) throw new CaptainPersonaError('JID inválido.', 'invalid_account_jid');
        return jid;
    }

    const digits = extractDigits(raw);
    if (!/^55\d{10,11}$/.test(digits)) {
        throw new CaptainPersonaError(
            'Número inválido. Use 55 + DDD + telefone, com 12 ou 13 dígitos no total.',
            'invalid_brazil_phone',
            { receivedLength: digits.length }
        );
    }
    return digits;
}

async function guardCaptainOnlyAccount(db, account, captainName, mode) {
    if (normalizeMode(mode) !== 'captain_only') return null;
    const normalizedAccount = normalizeBrazilianCaptainAccount(account);
    const existing = normalizedAccount.includes('@')
        ? await db.get('SELECT * FROM jogadores WHERE id = ?', [normalizedAccount])
        : await resolveBestPlayerByPhone(db, normalizedAccount);
    if (!existing) return null;

    const existingName = filledCharacterName(existing);
    if (!existingName || normalizedText(existingName) === normalizedText(captainName)) {
        return existing;
    }

    throw new CaptainPersonaError(
        `O número já possui o personagem principal "${existingName}". Use main_plus_captain ou corrija o número do Capitão.`,
        'captain_only_account_has_main_character',
        {
            existingPlayerId: existing.id,
            existingCharacterName: existingName,
        }
    );
}

async function registerSquadCaptainSafely(db, input = {}) {
    const account = normalizeBrazilianCaptainAccount(
        input.phoneOrId || input.phone || input.number || input.subjectId
    );
    const captainName = String(input.captainName || input.characterName || input.name || '').trim();
    if (!captainName) {
        throw new CaptainPersonaError('Informe o nome do Capitão.', 'missing_captain_name');
    }
    const mode = normalizeMode(input.mode || input.accountMode);
    await guardCaptainOnlyAccount(db, account, captainName, mode);

    return registerSquadCaptain(db, {
        ...input,
        phoneOrId: account,
        phone: undefined,
        number: undefined,
        subjectId: undefined,
        mode,
        captainName,
    });
}

module.exports = {
    filledCharacterName,
    guardCaptainOnlyAccount,
    normalizeBrazilianCaptainAccount,
    normalizedText,
    registerSquadCaptainSafely,
};
