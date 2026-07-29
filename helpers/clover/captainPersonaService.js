'use strict';

const { ensureCloverSquadSchema } = require('../../database');
const { normalizeJid } = require('../groupAccess');
const { assignAccessRole } = require('./accessControlService');
const { normalizeSquadKey } = require('./cavalierService');
const {
    extractDigits,
    getJidCandidatesForPhone,
    resolveBestPlayerByPhone,
} = require('./siteAuthService');
const { resolveSquad } = require('./squadStateService');

const CAPTAIN_ACCOUNT_MODES = Object.freeze(['main_plus_captain', 'captain_only']);

class CaptainPersonaError extends Error {
    constructor(message, code = 'captain_persona_error', details = null) {
        super(message);
        this.name = 'CaptainPersonaError';
        this.code = code;
        this.details = details;
    }
}

function filled(value) {
    const text = String(value || '').trim();
    return text && text !== '-' ? text : null;
}

function safeJsonParse(value, fallback = {}) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function normalizeMode(value) {
    const mode = String(value || 'main_plus_captain').trim().toLowerCase().replace(/-/g, '_');
    if (!CAPTAIN_ACCOUNT_MODES.includes(mode)) {
        throw new CaptainPersonaError(
            'Use main_plus_captain ou captain_only.',
            'invalid_account_mode',
            { mode }
        );
    }
    return mode;
}

function normalizeProfile(input = {}) {
    return {
        characterName: filled(input.characterName || input.character_name || input.name),
        rank: filled(input.rank || input.patente) || 'Capitão',
        magic: filled(input.magic || input.magia),
        grimoire: filled(input.grimoire || input.grimorio),
        race: filled(input.race || input.raca),
        className: filled(input.className || input.class_name || input.classe),
        kingdom: filled(input.kingdom || input.reino),
        age: Number.isFinite(Number(input.age || input.idade)) ? Number(input.age || input.idade) : null,
        gender: filled(input.gender || input.genero),
        appearance: filled(input.appearance || input.aparencia),
        image: filled(input.image || input.imageData || input.site_profile_image_data),
        biography: filled(input.biography || input.history || input.historia),
        personality: filled(input.personality || input.personalidade),
        extra: input.extra && typeof input.extra === 'object' ? input.extra : {},
    };
}

async function ensureCaptainPersonaSchema(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_captain_profiles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_player_id TEXT NOT NULL,
            squad_key TEXT NOT NULL,
            persona_key TEXT NOT NULL,
            account_mode TEXT NOT NULL DEFAULT 'main_plus_captain'
                CHECK (account_mode IN ('main_plus_captain', 'captain_only')),
            character_name TEXT NOT NULL,
            rank TEXT DEFAULT 'Capitão',
            magic TEXT DEFAULT NULL,
            grimoire TEXT DEFAULT NULL,
            race TEXT DEFAULT NULL,
            class_name TEXT DEFAULT NULL,
            kingdom TEXT DEFAULT NULL,
            age INTEGER DEFAULT NULL,
            gender TEXT DEFAULT NULL,
            appearance TEXT DEFAULT NULL,
            image TEXT DEFAULT NULL,
            profile_json TEXT DEFAULT NULL,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'archived')),
            is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
            created_by TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            archived_at TEXT DEFAULT NULL,
            archived_by TEXT DEFAULT NULL
        )
    `);
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_captain_profiles_active_squad
        ON clover_captain_profiles (squad_key)
        WHERE status = 'active'
    `);
    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_clover_captain_profiles_active_account_squad
        ON clover_captain_profiles (account_player_id, squad_key)
        WHERE status = 'active'
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_captain_profiles_account
        ON clover_captain_profiles (account_player_id, status, updated_at DESC, id DESC)
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_captain_profile_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id INTEGER DEFAULT NULL,
            account_player_id TEXT NOT NULL,
            squad_key TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'archived', 'registered')),
            performed_by TEXT NOT NULL,
            before_json TEXT DEFAULT NULL,
            after_json TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);
}

function serializeProfile(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        accountPlayerId: row.account_player_id,
        squadKey: row.squad_key,
        personaKey: row.persona_key,
        accountMode: row.account_mode,
        characterName: row.character_name,
        rank: row.rank || null,
        magic: row.magic || null,
        grimoire: row.grimoire || null,
        race: row.race || null,
        className: row.class_name || null,
        kingdom: row.kingdom || null,
        age: row.age === null || row.age === undefined ? null : Number(row.age),
        gender: row.gender || null,
        appearance: row.appearance || null,
        image: row.image || null,
        profile: safeJsonParse(row.profile_json, {}),
        status: row.status,
        isDefault: Boolean(row.is_default),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
    };
}

async function readCaptainProfile(db, { accountPlayerId = null, squadKey = null } = {}) {
    await ensureCaptainPersonaSchema(db);
    const clauses = ["status = 'active'"];
    const params = [];
    if (accountPlayerId) {
        clauses.push('account_player_id = ?');
        params.push(normalizeJid(accountPlayerId));
    }
    if (squadKey) {
        clauses.push('squad_key = ?');
        params.push(normalizeSquadKey(squadKey));
    }
    const row = await db.get(
        `SELECT * FROM clover_captain_profiles
         WHERE ${clauses.join(' AND ')}
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
        params
    );
    return serializeProfile(row);
}

async function listAccountPersonas(db, accountPlayerId) {
    await ensureCaptainPersonaSchema(db);
    const accountId = normalizeJid(accountPlayerId);
    if (!accountId) return [];
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [accountId]);
    if (!player) return [];
    const rows = await db.all(
        `SELECT profile.*, squad.name AS squad_name
         FROM clover_captain_profiles profile
         LEFT JOIN clover_squads squad ON squad.squad_key = profile.squad_key
         WHERE profile.account_player_id = ? AND profile.status = 'active'
         ORDER BY profile.is_default DESC, profile.created_at ASC, profile.id ASC`,
        [accountId]
    );
    const profiles = rows.map((row) => ({ ...serializeProfile(row), squadName: row.squad_name || row.squad_key }));
    const captainOnly = profiles.some((profile) => profile.accountMode === 'captain_only');
    const personas = [];
    if (!captainOnly) {
        const mainName = filled(player.personagem_nome) || filled(player.display_name) || filled(player.nome);
        if (mainName) {
            personas.push({
                key: 'main',
                kind: 'main',
                label: 'Personagem principal',
                characterName: mainName,
                squadKey: normalizeSquadKey(player.esquadrao) || null,
                squadName: filled(player.esquadrao),
                image: filled(player.site_profile_image_data) || filled(player.personagem_aparencia_image_path),
                isDefault: !profiles.some((profile) => profile.isDefault),
            });
        }
    }
    for (const profile of profiles) {
        personas.push({
            key: profile.personaKey,
            kind: 'captain',
            label: `Capitão · ${profile.squadName}`,
            characterName: profile.characterName,
            squadKey: profile.squadKey,
            squadName: profile.squadName,
            image: profile.image,
            isDefault: captainOnly || profile.isDefault,
        });
    }
    if (personas.length && !personas.some((persona) => persona.isDefault)) personas[0].isDefault = true;
    return personas;
}

async function resolveAccount(db, phoneOrId, mode) {
    const raw = String(phoneOrId || '').trim();
    if (!raw) throw new CaptainPersonaError('Informe o número ou JID da conta.', 'missing_account');
    if (raw.includes('@')) {
        const id = normalizeJid(raw);
        const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [id]);
        return { accountId: id, player, phoneDigits: extractDigits(raw), candidates: [id] };
    }
    const phoneDigits = extractDigits(raw);
    if (phoneDigits.length < 10) {
        throw new CaptainPersonaError('Número inválido. Use DDI + DDD + número.', 'invalid_phone');
    }
    const player = await resolveBestPlayerByPhone(db, phoneDigits);
    const candidates = getJidCandidatesForPhone(phoneDigits);
    if (player) return { accountId: player.id, player, phoneDigits, candidates };
    const accountId = normalizeJid(`${phoneDigits}@s.whatsapp.net`);
    if (mode !== 'captain_only') {
        throw new CaptainPersonaError(
            'Não encontrei a conta principal deste número. Cadastre o personagem principal antes ou use captain_only.',
            'main_account_not_found',
            { phoneDigits, candidates }
        );
    }
    return { accountId, player: null, phoneDigits, candidates };
}

async function writeProfileEvent(db, row, action, actorId, { before = null, reason = null, metadata = {} } = {}) {
    await db.run(
        `INSERT INTO clover_captain_profile_events
         (profile_id, account_player_id, squad_key, action, performed_by,
          before_json, after_json, reason, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row?.id || null,
            row.account_player_id,
            row.squad_key,
            action,
            normalizeJid(actorId) || String(actorId || 'system'),
            before ? JSON.stringify(before) : null,
            JSON.stringify(serializeProfile(row)),
            filled(reason),
            JSON.stringify(metadata || {}),
        ]
    );
}

async function upsertCaptainProfileInTransaction(db, {
    accountPlayerId,
    squadKey,
    captainName,
    accountMode,
    profile = {},
    createdBy,
    reason = null,
}) {
    const normalizedProfile = normalizeProfile({ ...profile, characterName: captainName });
    if (!normalizedProfile.characterName) {
        throw new CaptainPersonaError('Informe o nome do Capitão.', 'missing_captain_name');
    }
    const existing = await db.get(
        `SELECT * FROM clover_captain_profiles
         WHERE squad_key = ? AND status = 'active'
         ORDER BY id DESC LIMIT 1`,
        [squadKey]
    );
    if (existing && normalizeJid(existing.account_player_id) !== normalizeJid(accountPlayerId)) {
        throw new CaptainPersonaError(
            'Este esquadrão já possui outro perfil de Capitão ativo.',
            'captain_profile_conflict',
            { existingAccountPlayerId: existing.account_player_id }
        );
    }
    const profileJson = JSON.stringify({
        biography: normalizedProfile.biography,
        personality: normalizedProfile.personality,
        extra: normalizedProfile.extra,
    });
    let row;
    if (existing) {
        const before = serializeProfile(existing);
        await db.run(
            `UPDATE clover_captain_profiles
             SET account_player_id = ?, persona_key = ?, account_mode = ?, character_name = ?,
                 rank = ?, magic = ?, grimoire = ?, race = ?, class_name = ?, kingdom = ?,
                 age = ?, gender = ?, appearance = ?, image = ?, profile_json = ?,
                 is_default = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                accountPlayerId,
                `captain:${squadKey}`,
                accountMode,
                normalizedProfile.characterName,
                normalizedProfile.rank,
                normalizedProfile.magic,
                normalizedProfile.grimoire,
                normalizedProfile.race,
                normalizedProfile.className,
                normalizedProfile.kingdom,
                normalizedProfile.age,
                normalizedProfile.gender,
                normalizedProfile.appearance,
                normalizedProfile.image,
                profileJson,
                accountMode === 'captain_only' ? 1 : 0,
                existing.id,
            ]
        );
        row = await db.get('SELECT * FROM clover_captain_profiles WHERE id = ?', [existing.id]);
        await writeProfileEvent(db, row, 'updated', createdBy, { before, reason });
    } else {
        const inserted = await db.run(
            `INSERT INTO clover_captain_profiles
             (account_player_id, squad_key, persona_key, account_mode, character_name,
              rank, magic, grimoire, race, class_name, kingdom, age, gender,
              appearance, image, profile_json, is_default, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                accountPlayerId,
                squadKey,
                `captain:${squadKey}`,
                accountMode,
                normalizedProfile.characterName,
                normalizedProfile.rank,
                normalizedProfile.magic,
                normalizedProfile.grimoire,
                normalizedProfile.race,
                normalizedProfile.className,
                normalizedProfile.kingdom,
                normalizedProfile.age,
                normalizedProfile.gender,
                normalizedProfile.appearance,
                normalizedProfile.image,
                profileJson,
                accountMode === 'captain_only' ? 1 : 0,
                normalizeJid(createdBy) || String(createdBy || 'system'),
            ]
        );
        row = await db.get('SELECT * FROM clover_captain_profiles WHERE id = ?', [inserted.lastID]);
        await writeProfileEvent(db, row, 'created', createdBy, { reason });
    }
    return serializeProfile(row);
}

async function registerSquadCaptain(db, input = {}) {
    await ensureCloverSquadSchema(db);
    await ensureCaptainPersonaSchema(db);
    const mode = normalizeMode(input.mode || input.accountMode);
    const captainName = filled(input.captainName || input.characterName || input.name);
    if (!captainName) throw new CaptainPersonaError('Informe o nome do Capitão.', 'missing_captain_name');
    const squadKey = normalizeSquadKey(input.squadKey || input.squad);
    if (!squadKey) throw new CaptainPersonaError('Informe o esquadrão.', 'missing_squad');
    const squad = await resolveSquad(db, { squadName: squadKey });
    if (!squad) throw new CaptainPersonaError('Esquadrão não encontrado.', 'squad_not_found', { squadKey });
    const account = await resolveAccount(db, input.phoneOrId || input.phone || input.number || input.subjectId, mode);
    const actor = normalizeJid(input.assignedBy) || String(input.assignedBy || '').trim();
    if (!actor) throw new CaptainPersonaError('Informe quem está realizando o cadastro.', 'missing_actor');
    const plan = {
        mode,
        phoneDigits: account.phoneDigits,
        accountPlayerId: account.accountId,
        accountExists: Boolean(account.player),
        willCreateCaptainOnlyAccount: !account.player && mode === 'captain_only',
        preserveMainCharacter: mode === 'main_plus_captain',
        squad: { key: squad.squad_key, name: squad.name },
        captainName,
    };
    if (input.apply !== true) return { ok: true, applied: false, plan };

    await db.exec('BEGIN IMMEDIATE');
    try {
        let player = await db.get('SELECT * FROM jogadores WHERE id = ?', [account.accountId]);
        if (!player) {
            if (mode !== 'captain_only') {
                throw new CaptainPersonaError('A conta principal deixou de existir antes da aplicação.', 'main_account_not_found');
            }
            const profile = normalizeProfile({ ...(input.profile || {}), characterName: captainName });
            await db.run(
                `INSERT INTO jogadores
                 (id, nome, display_name, personagem_nome, esquadrao, patente, raca, classe,
                  reino, magia, grimorio, personagem_idade, personagem_genero,
                  personagem_aparencia, site_profile_image_data, ficha_status, jogo_status)
                 VALUES (?, ?, ?, ?, ?, 'Capitão', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aprovada', 'liberado')`,
                [
                    account.accountId,
                    captainName,
                    captainName,
                    captainName,
                    squad.name,
                    profile.race || '-',
                    profile.className || '-',
                    profile.kingdom || '-',
                    profile.magic || '-',
                    profile.grimoire || '-',
                    profile.age,
                    profile.gender || '-',
                    profile.appearance || '-',
                    profile.image,
                ]
            );
            player = await db.get('SELECT * FROM jogadores WHERE id = ?', [account.accountId]);
        }

        const captainProfile = await upsertCaptainProfileInTransaction(db, {
            accountPlayerId: account.accountId,
            squadKey: squad.squad_key,
            captainName,
            accountMode: mode,
            profile: input.profile || {},
            createdBy: actor,
            reason: input.reason || 'Cadastro de Capitão',
        });
        const role = await assignAccessRole(db, {
            subjectId: account.accountId,
            role: 'captain',
            scopeKey: squad.squad_key,
            assignedBy: actor,
            reason: input.reason || 'Cadastro de Capitão',
            metadata: {
                source: 'captain_registration',
                persona_key: captainProfile.personaKey,
                account_mode: mode,
            },
        });
        if (!role.ok) {
            throw new CaptainPersonaError('Não foi possível atribuir o cargo de Capitão.', role.code || 'role_assignment_failed');
        }
        await db.run(
            `UPDATE clover_squads
             SET captain_player_id = ?, captain_name = ?, updated_at = CURRENT_TIMESTAMP
             WHERE squad_key = ?`,
            [account.accountId, captainName, squad.squad_key]
        );
        const stored = await db.get('SELECT * FROM clover_captain_profiles WHERE id = ?', [captainProfile.id]);
        await writeProfileEvent(db, stored, 'registered', actor, {
            reason: input.reason || 'Cadastro de Capitão',
            metadata: { role_code: role.code, account_created: !account.player },
        });
        await db.exec('COMMIT');
        return {
            ok: true,
            applied: true,
            plan,
            account: {
                playerId: account.accountId,
                created: !account.player,
                mainCharacterPreserved: mode === 'main_plus_captain',
            },
            captainProfile,
            role: { code: role.code, inserted: role.inserted },
        };
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => null);
        throw error;
    }
}

module.exports = {
    CAPTAIN_ACCOUNT_MODES,
    CaptainPersonaError,
    ensureCaptainPersonaSchema,
    listAccountPersonas,
    normalizeMode,
    readCaptainProfile,
    registerSquadCaptain,
    serializeProfile,
    upsertCaptainProfileInTransaction,
};
