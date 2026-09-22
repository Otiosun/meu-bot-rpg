'use strict';

const {
    listPlayerTargetAliases,
    resolveCanonicalChain,
} = require('./targetResolver');
const { maskPhoneFromPlayerId } = require('./adminPlayerSearchService');
const { getAdminPlayerTraitOverview } = require('./adminPlayerTraitOverviewService');
const { getPlayerPossessions } = require('./possessionsService');
const { readResourceState } = require('./adminResourceAdjustmentService');
const { readPlayerProgression } = require('./adminProgressionService');

class AdminPlayerDetailError extends Error {
    constructor(code, message, status = 400, details = null) {
        super(message || code);
        this.name = 'AdminPlayerDetailError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function firstValue(source, keys) {
    for (const key of keys) {
        const value = source?.[key];
        if (
            value !== undefined
            && value !== null
            && String(value).trim() !== ''
        ) {
            return value;
        }
    }
    return null;
}

function maskIdentity(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    const [user = '', domain = ''] = text.split('@');
    if (!domain) {
        if (/^\d+$/.test(user) && user.length >= 8) {
            return `${user.slice(0, 4)}••••${user.slice(-4)}`;
        }
        return user.length > 8
            ? `${user.slice(0, 3)}•••${user.slice(-3)}`
            : user;
    }
    if (user.length <= 7) return text;
    if (domain === 's.whatsapp.net') {
        return maskPhoneFromPlayerId(text)
            || `${user.slice(0, 3)}•••${user.slice(-3)}@${domain}`;
    }
    return `${user.slice(0, 3)}•••${user.slice(-3)}@${domain}`;
}

function aliasTypeFromRow(row = {}) {
    if (row.alias_type) return String(row.alias_type).trim().toLowerCase();
    const match = String(row.alias_key || '').match(/^([^:]+):/);
    return String(match?.[1] || row.alias_kind || 'manual')
        .trim()
        .toLowerCase();
}

function aliasValueFromRow(row = {}) {
    if (row.alias_value) return String(row.alias_value).trim();
    const key = String(row.alias_key || '');
    const separator = key.indexOf(':');
    if (separator >= 0) return key.slice(separator + 1).trim();
    return String(row.alias_label || '').trim();
}

function sanitizeAlias(row = {}) {
    const kind = aliasTypeFromRow(row);
    const rawValue = aliasValueFromRow(row)
        || String(row.alias_label || '').trim();
    const sensitive = [
        'phone',
        'phone_last4',
        'jid',
        'lid',
        'whatsapp_mention',
    ].includes(kind);
    const metadata = (() => {
        try {
            return row.metadata_json ? JSON.parse(row.metadata_json) : {};
        } catch {
            return {};
        }
    })();

    return {
        kind,
        label: sensitive ? maskIdentity(rawValue) : rawValue,
        source: row.source || row.alias_kind || 'manual',
        confidence: Number(row.confidence ?? metadata.confidence ?? 0) || null,
        updatedAt: row.updated_at || null,
    };
}

function buildProfile(player = {}) {
    return {
        playerId: String(player.id || ''),
        characterName: String(
            firstValue(
                player,
                ['personagem_nome', 'display_name', 'nome']
            ) || '-'
        ),
        displayName: firstValue(player, ['display_name', 'nome']),
        phoneMasked: maskPhoneFromPlayerId(player.id),
        squad: firstValue(player, ['esquadrao', 'esquadrao_nome', 'squad']),
        gameStatus: firstValue(player, ['jogo_status', 'game_status']),
        lifecycleStatus: firstValue(player, ['lifecycle_status']),
        identityStatus: firstValue(player, ['identity_status']),
        approvalStatus: firstValue(
            player,
            ['ficha_status', 'status_ficha', 'aprovacao_status']
        ),
        magic: firstValue(player, ['magia', 'magia_nome', 'magic']),
        magicKey: firstValue(player, ['magia_key']),
        grimoire: firstValue(
            player,
            ['grimorio', 'grimorio_nome', 'grimoire']
        ),
        race: firstValue(player, ['raca', 'race']),
        className: firstValue(
            player,
            ['classe', 'classe_social', 'class_name']
        ),
        rank: firstValue(player, ['patente', 'rank']),
        level: firstValue(player, ['nivel', 'level']),
        createdAt: firstValue(player, ['created_at', 'data_criacao']),
        updatedAt: firstValue(player, ['updated_at', 'data_atualizacao']),
        canonicalPlayerId:
            firstValue(player, ['canonical_player_id'])
            || String(player.id || ''),
        mergedInto: firstValue(player, ['merged_into']),
        isShadow: Number(player.is_shadow || 0) === 1,
    };
}

async function resolveTraitOverview(db, playerId, options = {}) {
    if (typeof options.getTraitOverview === 'function') {
        return options.getTraitOverview(db, playerId);
    }
    if (!db || typeof db.get !== 'function' || typeof db.exec !== 'function') {
        return {
            available: false,
            status: 'unavailable',
            slots: [],
        };
    }
    return getAdminPlayerTraitOverview(db, playerId);
}

async function resolvePossessions(db, playerId, options = {}) {
    if (typeof options.getPossessions === 'function') {
        return options.getPossessions(db, playerId);
    }
    if (
        !db
        || typeof db.get !== 'function'
        || typeof db.all !== 'function'
        || typeof db.exec !== 'function'
    ) {
        return {
            available: false,
            status: 'unavailable',
        };
    }
    try {
        return await getPlayerPossessions(db, playerId, {
            inventoryLimit: 200,
            historyLimit: 30,
        });
    } catch (error) {
        return {
            available: false,
            status: 'unavailable',
            error: error?.code || 'possessions_unavailable',
        };
    }
}

async function resolveResources(db, playerId, options = {}) {
    if (typeof options.getResources === 'function') {
        return options.getResources(db, playerId);
    }
    if (
        !db
        || typeof db.get !== 'function'
        || typeof db.run !== 'function'
        || typeof db.exec !== 'function'
    ) {
        return { available: false, status: 'unavailable' };
    }
    try {
        // Leitura sequencial: os serviços podem inicializar schemas idempotentes
        // na primeira abertura e não devem disputar DDL na mesma conexão SQLite.
        const yulls = await readResourceState(db, playerId, 'yulls');
        const ph = await readResourceState(db, playerId, 'ph');
        const pa = await readResourceState(db, playerId, 'pa');
        const pm = await readResourceState(db, playerId, 'pm');
        return {
            available: true,
            status: 'ready',
            yulls,
            ph,
            pa,
            pm,
        };
    } catch (error) {
        return {
            available: false,
            status: 'unavailable',
            error: error?.code || 'resources_unavailable',
        };
    }
}

async function resolveProgression(db, playerId, options = {}) {
    if (typeof options.getProgression === 'function') {
        return options.getProgression(db, playerId);
    }
    if (
        !db
        || typeof db.get !== 'function'
        || typeof db.run !== 'function'
        || typeof db.all !== 'function'
        || typeof db.exec !== 'function'
    ) {
        return { available: false, status: 'unavailable' };
    }
    try {
        const result = await readPlayerProgression(db, playerId, {
            includeTrees: options.includeProgressionTrees !== false,
        });
        return {
            available: true,
            status: 'ready',
            ...result,
        };
    } catch (error) {
        return {
            available: false,
            status: 'unavailable',
            error: error?.code || 'progression_unavailable',
        };
    }
}

async function getAdminPlayerDetail(db, playerId, options = {}) {
    const rawId = String(playerId || '').trim();
    if (!rawId) {
        throw new AdminPlayerDetailError(
            'missing_player_id',
            'Informe o player_id do jogador.',
            400
        );
    }

    const resolveCanonical =
        options.resolveCanonical
        || resolveCanonicalChain;
    const listAliases = options.listAliases || listPlayerTargetAliases;
    const resolved = await resolveCanonical(
        db,
        rawId,
        { skipSelfHydrate: true }
    );
    const canonical = resolved?.canonical;
    if (!canonical?.id) {
        throw new AdminPlayerDetailError(
            'player_not_found',
            'Jogador não encontrado.',
            404,
            { playerId: rawId }
        );
    }

    // Cada módulo pode inicializar schema idempotente. A ordem explícita evita
    // disputas de DDL na primeira abertura da ficha administrativa.
    const aliases = await listAliases(db, canonical.id);
    const traits = await resolveTraitOverview(db, canonical.id, options);
    const possessions = await resolvePossessions(db, canonical.id, options);
    const resources = await resolveResources(db, canonical.id, options);
    const progression = await resolveProgression(db, canonical.id, options);
    const profile = buildProfile(canonical);

    return {
        ok: true,
        player: profile,
        identity: {
            canonical: !profile.isShadow && !profile.mergedInto,
            requestedIdMasked: maskIdentity(rawId),
            canonicalIdMasked: maskIdentity(canonical.id),
            redirectedFromMasked: resolved.redirectedFrom
                ? maskIdentity(resolved.redirectedFrom)
                : null,
            redirectReason: resolved.redirectReason || null,
            chain: (resolved.chain || []).map((entry) => ({
                idMasked: maskIdentity(entry.id),
                characterName: entry.personagem_nome || null,
                isShadow: Number(entry.is_shadow || 0) === 1,
                mergedIntoMasked: entry.merged_into
                    ? maskIdentity(entry.merged_into)
                    : null,
                canonicalIdMasked: entry.canonical_player_id
                    ? maskIdentity(entry.canonical_player_id)
                    : null,
            })),
            aliases: (aliases || []).map(sanitizeAlias),
        },
        resources,
        progression,
        profileOptions: {
            magics: getAllMagics().map((magic) => ({
                key: magic.key,
                label: magic.label || magic.name || magic.key,
                rarity: magic.rarity || null,
                capacity: magic.capacity ?? null,
            })),
        },
        modules: {
            traits,
            possessions,
            items: possessions,
            progression,
            rewards: possessions?.available ? {
                available: true,
                status: possessions.status,
                boxes: possessions.boxes,
                titles: possessions.titles,
                redemptions: possessions.redemptions,
            } : {
                available: false,
                status: possessions?.status || 'unavailable',
            },
            hooks: { available: false, status: 'planned' },
        },
    };
}

module.exports = {
    AdminPlayerDetailError,
    buildProfile,
    getAdminPlayerDetail,
    maskIdentity,
    resolvePossessions,
    resolveProgression,
    resolveResources,
    sanitizeAlias,
};
