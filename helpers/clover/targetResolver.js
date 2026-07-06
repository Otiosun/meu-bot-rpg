const fs = require('fs');
const path = require('path');
const { extractPhoneNumber, isSameUser, normalizeJid } = require('../groupAccess');
const { normalizeText } = require('../textUtils');

const EMPTY_CHARACTER_MESSAGE = 'Alvo encontrado, mas sem personagem vinculado. Use .#vincular ou .#mesclarplayer.';
const AUTH_DIR_PREFIX = 'auth_info';
let schemaReady = false;

function authInfoDirectories() {
    const rootDir = path.join(__dirname, '..', '..');
    const dirs = [];
    const current = path.join(rootDir, AUTH_DIR_PREFIX);
    if (fs.existsSync(current)) dirs.push(current);

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

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
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
                const digits = extractDigits(parsed[key]);
                if (digits) return digits;
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
        const mapped = parseMappedDigits(
            path.join(dir, `lid-mapping-${digits}_reverse.json`),
            ['phoneNumber', 'phone_number', 'pn', 'jid', 'id', 'user']
        );
        if (mapped) return mapped;
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

function normalizeCompact(value) {
    return normalizeText(value)
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeAliasValue(type, value) {
    const aliasType = String(type || '').trim().toLowerCase();
    const raw = String(value || '').trim();
    if (!raw) return '';

    if (aliasType === 'jid' || aliasType === 'lid' || aliasType === 'whatsapp_mention') {
        return normalizeJid(raw.replace(/^@/, ''));
    }
    if (aliasType === 'phone') {
        return raw.replace(/\D/g, '');
    }
    if (aliasType === 'phone_last4') {
        const digits = raw.replace(/\D/g, '');
        return digits.length >= 4 ? digits.slice(-4) : '';
    }
    return normalizeCompact(raw);
}

function normalizeTargetAliasLabel(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function aliasKeyFromJid(value) {
    const jid = normalizeJid(value);
    return jid ? `jid:${jid}` : '';
}

function aliasKeyFromPhone(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits ? `phone:${digits}` : '';
}

function aliasKeyFromName(value) {
    const name = normalizeCompact(value);
    return name ? `name:${name}` : '';
}

function normalizeTargetAliasKey(value) {
    const text = String(value || '').trim();
    if (!text) return '';

    const prefixMatch = text.match(/^(jid|phone|name):(.+)$/i);
    if (prefixMatch) {
        const prefix = String(prefixMatch[1] || '').toLowerCase();
        const rest = String(prefixMatch[2] || '').trim();
        if (prefix === 'jid') return aliasKeyFromJid(rest);
        if (prefix === 'phone') return aliasKeyFromPhone(rest);
        if (prefix === 'name') return aliasKeyFromName(rest);
    }

    if (text.includes('@')) return aliasKeyFromJid(text);

    const digits = text.replace(/\D/g, '');
    if (digits && digits.length >= 4) return aliasKeyFromPhone(digits);

    return aliasKeyFromName(text);
}

function addAliasCandidate(candidates, type, value, label = null) {
    const normalized = normalizeAliasValue(type, value);
    if (!normalized) return;
    const key = `${type}:${normalized}`;
    if (candidates.some((item) => item.key === key)) return;
    candidates.push({
        key,
        type,
        value: normalized,
        label: normalizeTargetAliasLabel(label || value || normalized),
    });
}

function aliasCandidatesFromInput(input, options = {}) {
    const raw = typeof input === 'object' && input !== null
        ? String(input.value || input.raw || input.target || '').trim()
        : String(input || '').trim();
    const explicitType = typeof input === 'object' && input !== null
        ? String(input.type || input.kind || options.type || options.kind || '').trim().toLowerCase()
        : String(options.type || options.kind || '').trim().toLowerCase();
    const label = typeof input === 'object' && input !== null
        ? input.label || raw
        : raw;
    const candidates = [];

    if (!raw) return candidates;
    if (explicitType && ['lid', 'jid', 'phone', 'phone_last4', 'character', 'manual', 'whatsapp_mention'].includes(explicitType)) {
        addAliasCandidate(candidates, explicitType, raw, label);
    }

    const withoutAt = raw.replace(/^@/, '');
    const normalizedJid = normalizeJid(withoutAt);
    const digits = raw.replace(/\D/g, '');
    const compact = normalizeCompact(raw);
    const normalizedDomain = normalizedJid && normalizedJid.includes('@')
        ? normalizedJid.split('@')[1]
        : '';
    const digitsCanBePhone = !normalizedDomain || normalizedDomain === 's.whatsapp.net';

    if (normalizedJid && normalizedJid.includes('@')) {
        const domain = normalizedJid.split('@')[1];
        const userPart = normalizedJid.split('@')[0];
        addAliasCandidate(candidates, domain === 'lid' ? 'lid' : 'jid', normalizedJid, label);
        addAliasCandidate(candidates, 'whatsapp_mention', normalizedJid, label);
        const phone = extractPhoneNumber(normalizedJid);
        if (phone && phone.length >= 8) {
            addAliasCandidate(candidates, 'phone', phone, label);
            addAliasCandidate(candidates, 'phone_last4', phone, label);
        }
        if (domain === 'lid') {
            const mappedPhone = readMappedPhoneDigits(userPart);
            if (mappedPhone && mappedPhone.length >= 8) {
                addAliasCandidate(candidates, 'phone', mappedPhone, label);
                addAliasCandidate(candidates, 'jid', `${mappedPhone}@s.whatsapp.net`, label);
                addAliasCandidate(candidates, 'phone_last4', mappedPhone, label);
            }
        } else if (domain === 's.whatsapp.net') {
            const mappedLid = readMappedLidDigits(userPart);
            if (mappedLid) {
                addAliasCandidate(candidates, 'lid', `${mappedLid}@lid`, label);
                addAliasCandidate(candidates, 'whatsapp_mention', `${mappedLid}@lid`, label);
            }
        }
    }

    if (digits && digitsCanBePhone) {
        if (digits.length >= 8) {
            addAliasCandidate(candidates, 'phone', digits, label);
            addAliasCandidate(candidates, 'jid', `${digits}@s.whatsapp.net`, label);
            const mappedLid = readMappedLidDigits(digits);
            if (mappedLid) {
                addAliasCandidate(candidates, 'lid', `${mappedLid}@lid`, label);
                addAliasCandidate(candidates, 'whatsapp_mention', `${mappedLid}@lid`, label);
            }
        }
        if (digits.length >= 4) addAliasCandidate(candidates, 'phone_last4', digits, label);
    }

    const structuredIdentifier = Boolean(normalizedJid && normalizedJid.includes('@'));
    const numericOnly = Boolean(digits && compact && compact.replace(/\s+/g, '') === digits);
    if (compact && !structuredIdentifier && !numericOnly) {
        addAliasCandidate(candidates, 'character', compact, label);
        addAliasCandidate(candidates, 'manual', compact, label);
    }

    return candidates;
}

function buildAliasKeysFromInput(raw) {
    const candidates = aliasCandidatesFromInput(raw);
    const keys = new Set();
    for (const item of candidates) {
        if (item.type === 'jid' || item.type === 'lid' || item.type === 'whatsapp_mention') {
            keys.add(aliasKeyFromJid(item.value));
        } else if (item.type === 'phone') {
            keys.add(aliasKeyFromPhone(item.value));
        } else if (item.type === 'character' || item.type === 'manual') {
            keys.add(aliasKeyFromName(item.value));
        }
    }
    return [...keys].filter(Boolean);
}

function buildSearchText(player = {}) {
    return [
        player?.id,
        player?.nome,
        player?.display_name,
        player?.personagem_nome,
    ]
        .map((value) => normalizeCompact(value))
        .filter(Boolean)
        .join(' | ');
}

function buildPlayerVariants(player = {}) {
    const variants = new Set();
    const rawId = String(player?.id || '').trim();
    const normalizedId = normalizeJid(rawId);
    const digits = extractPhoneNumber(rawId) || rawId.replace(/\D/g, '');

    if (rawId) variants.add(rawId);
    if (normalizedId) variants.add(normalizedId);
    if (digits) variants.add(digits);
    if (digits) variants.add(`${digits}@s.whatsapp.net`);

    return [...variants].filter(Boolean);
}

async function addColumnIfMissing(db, table, column, definition) {
    const columns = await db.all(`PRAGMA table_info(${table})`);
    if (columns.some((item) => item.name === column)) return false;
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
}

async function ensureTargetResolverSchema(db) {
    if (schemaReady) return;
    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_player_target_aliases (
            alias_key TEXT PRIMARY KEY,
            alias_label TEXT NOT NULL,
            player_id TEXT NOT NULL,
            alias_kind TEXT NOT NULL DEFAULT 'manual',
            created_by TEXT DEFAULT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            metadata_json TEXT DEFAULT NULL
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_player_target_aliases_player
        ON clover_player_target_aliases (player_id, updated_at DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_player_target_aliases_kind
        ON clover_player_target_aliases (alias_kind)
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS clover_player_aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id_destino TEXT NOT NULL,
            alias_type TEXT NOT NULL,
            alias_value TEXT NOT NULL,
            source TEXT DEFAULT 'manual',
            confidence INTEGER DEFAULT 100,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(alias_type, alias_value)
        )
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_player_aliases_player
        ON clover_player_aliases (player_id_destino, active, updated_at DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clover_player_aliases_lookup
        ON clover_player_aliases (alias_type, alias_value, active)
    `);

    await addColumnIfMissing(db, 'jogadores', 'canonical_player_id', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'jogadores', 'merged_into', 'TEXT DEFAULT NULL');
    await addColumnIfMissing(db, 'jogadores', 'is_shadow', 'INTEGER DEFAULT 0');
    await addColumnIfMissing(db, 'jogadores', 'identity_status', "TEXT DEFAULT 'active'");

    await migrateLegacyAliases(db);
    schemaReady = true;
}

async function migrateLegacyAliases(db) {
    const legacyRows = await db.all(`
        SELECT alias_key, alias_label, player_id, alias_kind, created_by, created_at, updated_at
        FROM clover_player_target_aliases
        WHERE alias_key IS NOT NULL AND alias_key <> ''
    `);

    for (const row of legacyRows) {
        const match = String(row.alias_key || '').match(/^(jid|phone|name):(.+)$/);
        if (!match) continue;
        const aliasType = match[1] === 'name' ? 'character' : match[1];
        const aliasValue = normalizeAliasValue(aliasType, match[2]);
        if (!aliasValue) continue;
        await db.run(
            `INSERT INTO clover_player_aliases
             (player_id_destino, alias_type, alias_value, source, confidence, active, created_at, updated_at)
             VALUES (?, ?, ?, ?, 90, 1, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
             ON CONFLICT(alias_type, alias_value) DO NOTHING`,
            [
                row.player_id,
                aliasType,
                aliasValue,
                row.alias_kind || 'legacy',
                row.created_at || null,
                row.updated_at || null,
            ]
        );
    }
}

async function getRawPlayerById(db, playerId) {
    const raw = String(playerId || '').trim();
    if (!raw) return null;

    const normalized = normalizeJid(raw);
    const digits = raw.replace(/\D/g, '');

    const exactIds = [...new Set([raw, normalized].filter(Boolean))];
    for (const id of exactIds) {
        const exact = await db.get('SELECT * FROM jogadores WHERE id = ?', [id]);
        if (exact) return exact;
    }

    const rows = await db.all('SELECT * FROM jogadores WHERE id IS NOT NULL');

    const exact = rows.find((player) => {
        const variants = buildPlayerVariants(player);
        return variants.some((variant) => (
            variant === raw
            || variant === normalized
            || variant === digits
        ));
    });
    if (exact) return exact;

    return rows.find((player) => {
        const variants = buildPlayerVariants(player);
        return variants.some((variant) => (
            isSameUser(variant, raw)
            || isSameUser(variant, normalized)
        ));
    }) || null;
}

async function resolveCanonicalChain(db, playerOrId, options = {}) {
    await ensureTargetResolverSchema(db);
    const original = typeof playerOrId === 'object' && playerOrId !== null
        ? playerOrId
        : await getRawPlayerById(db, playerOrId);
    if (!original) {
        return {
            original: null,
            canonical: null,
            chain: [],
            redirectedFrom: null,
            redirectReason: null,
        };
    }

    const seen = new Set();
    const chain = [];
    let current = original;

    for (let depth = 0; depth < 12; depth += 1) {
        const currentId = String(current?.id || '').trim();
        if (!currentId || seen.has(currentId)) break;
        seen.add(currentId);
        chain.push({
            id: currentId,
            personagem_nome: current.personagem_nome || null,
            merged_into: current.merged_into || null,
            canonical_player_id: current.canonical_player_id || null,
            is_shadow: current.is_shadow || 0,
        });

        const mergedInto = String(current.merged_into || '').trim();
        const canonicalId = String(current.canonical_player_id || '').trim();
        const shadowCanonical = Number(current.is_shadow || 0) === 1 && canonicalId && canonicalId !== currentId;
        const explicitCanonical = canonicalId && canonicalId !== currentId;
        const nextId = mergedInto || (shadowCanonical ? canonicalId : '') || (explicitCanonical ? canonicalId : '');
        if (!nextId || nextId === currentId) break;

        const next = await getRawPlayerById(db, nextId);
        if (!next) break;
        current = next;
    }

    const redirected = String(original.id || '') !== String(current.id || '');
    return {
        original,
        canonical: current,
        chain,
        redirectedFrom: redirected ? original.id : null,
        redirectReason: redirected ? 'merged_shadow' : null,
    };
}

async function getCanonicalPlayer(db, playerOrId, options = {}) {
    const resolved = await resolveCanonicalChain(db, playerOrId);
    let current = resolved.canonical;
    if (!current) return null;

    if (!options.skipSelfHydrate && current?.id && !current.canonical_player_id && !current.merged_into) {
        await db.run(
            `UPDATE jogadores
             SET canonical_player_id = COALESCE(canonical_player_id, ?),
                 is_shadow = COALESCE(is_shadow, 0),
                 identity_status = COALESCE(identity_status, 'active')
             WHERE id = ?`,
            [current.id, current.id]
        ).catch(() => {});
        current = await getRawPlayerById(db, current.id) || current;
    }

    return current;
}

async function getPlayerById(db, playerId) {
    const raw = await getRawPlayerById(db, playerId);
    return getCanonicalPlayer(db, raw);
}

function isEmptyCharacterPlayer(player = {}) {
    const raw = player?.personagem_nome;
    const text = String(raw ?? '').trim();
    const normalized = normalizeCompact(text);
    return !text || !normalized || ['-', '.', 'cacador'].includes(normalized);
}

function assertMechanicalTarget(player, context = {}) {
    if (!player) {
        return {
            ok: false,
            error: 'Player nao encontrado no banco.',
            details: {
                rawTarget: context.rawTarget || context.target || '',
                source: context.source || 'indefinido',
                originalSource: context.originalSource || context.source || 'indefinido',
                redirectedFrom: context.redirectedFrom || null,
                redirectReason: context.redirectReason || null,
                foundPlayer: null,
                canonicalPlayer: null,
                reason: 'target_not_found',
                suggestion: 'Use mencao real, .#quem, .#vincular ou .#mesclarplayer.',
            },
        };
    }
    if (isEmptyCharacterPlayer(player)) {
        return {
            ok: false,
            error: EMPTY_CHARACTER_MESSAGE,
            details: {
                rawTarget: context.rawTarget || context.target || player.id,
                source: context.source || 'indefinido',
                originalSource: context.originalSource || context.source || 'indefinido',
                redirectedFrom: context.redirectedFrom || null,
                redirectReason: context.redirectReason || null,
                foundPlayer: {
                    id: player.id,
                    personagem_nome: player.personagem_nome || null,
                    nome: player.nome || player.display_name || null,
                    is_shadow: player.is_shadow || 0,
                    merged_into: player.merged_into || null,
                },
                canonicalPlayer: {
                    id: player.id,
                    personagem_nome: player.personagem_nome || null,
                    nome: player.nome || player.display_name || null,
                    is_shadow: player.is_shadow || 0,
                    merged_into: player.merged_into || null,
                },
                reason: 'empty_character',
                suggestion: 'Use .#vincular para associar o alvo a um personagem real ou .#mesclarplayer para unir cadastro espelho.',
            },
        };
    }
    return { ok: true };
}

async function listPlayerTargetAliases(db, playerId) {
    await ensureTargetResolverSchema(db);
    const raw = String(playerId || '').trim();
    const canonical = await getCanonicalPlayer(db, raw);
    const ids = [...new Set([raw, normalizeJid(raw), canonical?.id].filter(Boolean))];
    if (!ids.length) return [];

    const placeholders = ids.map(() => '?').join(',');
    const oldRows = await db.all(
        `SELECT alias_key, alias_label, player_id, alias_kind, created_by, created_at, updated_at, metadata_json
         FROM clover_player_target_aliases
         WHERE player_id IN (${placeholders})
         ORDER BY updated_at DESC, alias_label ASC`,
        ids
    );

    const newRows = await db.all(
        `SELECT id, alias_type, alias_value, player_id_destino, source, confidence, active, created_at, updated_at
         FROM clover_player_aliases
         WHERE player_id_destino IN (${placeholders}) AND active = 1
         ORDER BY updated_at DESC, alias_type ASC, alias_value ASC`,
        ids
    );

    const converted = newRows.map((row) => ({
        alias_key: `${row.alias_type}:${row.alias_value}`,
        alias_label: row.alias_value,
        player_id: row.player_id_destino,
        alias_kind: row.source || 'manual',
        created_by: null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        metadata_json: JSON.stringify({ confidence: row.confidence, table: 'clover_player_aliases' }),
    }));

    const seen = new Set();
    return [...converted, ...oldRows].filter((row) => {
        const key = String(row.alias_key || '').trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function upsertAlias(db, { playerId, type, value, source = 'manual', confidence = 100, createdBy = null }) {
    await ensureTargetResolverSchema(db);
    const canonical = await getCanonicalPlayer(db, playerId);
    const canonicalPlayerId = String(canonical?.id || playerId || '').trim();
    const aliasType = String(type || '').trim().toLowerCase();
    const aliasValue = normalizeAliasValue(aliasType, value);
    if (!canonicalPlayerId) throw new Error('Player alvo nao informado.');
    if (!aliasType || !aliasValue) throw new Error('Alias de vinculo vazio.');

    const existing = await db.get(
        `SELECT * FROM clover_player_aliases
         WHERE alias_type = ? AND alias_value = ?`,
        [aliasType, aliasValue]
    );

    await db.run(
        `INSERT INTO clover_player_aliases
         (player_id_destino, alias_type, alias_value, source, confidence, active, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(alias_type, alias_value) DO UPDATE SET
             player_id_destino = excluded.player_id_destino,
             source = excluded.source,
             confidence = MAX(clover_player_aliases.confidence, excluded.confidence),
             active = 1,
             updated_at = CURRENT_TIMESTAMP`,
        [canonicalPlayerId, aliasType, aliasValue, source, Number(confidence) || 100]
    );

    const oldKey = aliasType === 'phone'
        ? aliasKeyFromPhone(aliasValue)
        : (['jid', 'lid', 'whatsapp_mention'].includes(aliasType) ? aliasKeyFromJid(aliasValue) : aliasKeyFromName(aliasValue));
    if (oldKey) {
        await db.run(
            `INSERT INTO clover_player_target_aliases
             (alias_key, alias_label, player_id, alias_kind, created_by, updated_at, metadata_json)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
             ON CONFLICT(alias_key) DO UPDATE SET
                 alias_label = excluded.alias_label,
                 player_id = excluded.player_id,
                 alias_kind = excluded.alias_kind,
                 created_by = excluded.created_by,
                 updated_at = CURRENT_TIMESTAMP,
                 metadata_json = excluded.metadata_json`,
            [
                oldKey,
                value,
                canonicalPlayerId,
                source,
                createdBy,
                JSON.stringify({ alias_type: aliasType, alias_value: aliasValue, linked_by: createdBy || null }),
            ]
        );
    }

    return {
        alias_type: aliasType,
        alias_value: aliasValue,
        previous_player_id: existing?.player_id_destino || null,
        replaced: existing?.player_id_destino && !isSameUser(existing.player_id_destino, canonicalPlayerId),
    };
}

async function linkPlayerTarget(db, aliasInput, playerId, options = {}) {
    await ensureTargetResolverSchema(db);
    const canonical = await getCanonicalPlayer(db, playerId);
    const canonicalPlayerId = String(canonical?.id || playerId || '').trim();
    if (!canonicalPlayerId) throw new Error('Player alvo nao informado.');

    const candidates = aliasCandidatesFromInput(aliasInput, options);
    if (!candidates.length) throw new Error('Nao consegui normalizar o alias informado.');

    const previousOwners = [];
    const aliasKeys = [];
    for (const candidate of candidates) {
        const row = await upsertAlias(db, {
            playerId: canonicalPlayerId,
            type: candidate.type,
            value: candidate.value,
            source: options.source || options.kind || 'manual',
            confidence: options.confidence || 100,
            createdBy: options.createdBy || null,
        });
        aliasKeys.push(`${row.alias_type}:${row.alias_value}`);
        if (row.replaced) {
            previousOwners.push({
                alias_key: `${row.alias_type}:${row.alias_value}`,
                alias_label: candidate.label,
                player_id: row.previous_player_id,
                alias_kind: options.source || options.kind || 'manual',
            });
        }
    }

    return {
        ok: true,
        aliasKeys,
        aliasLabel: normalizeTargetAliasLabel(typeof aliasInput === 'object' && aliasInput !== null ? aliasInput.label || aliasInput.value : aliasInput),
        playerId: canonicalPlayerId,
        replaced: previousOwners,
    };
}

function describeTargetSource(source) {
    const labels = {
        direct: 'id direto',
        id: 'id principal',
        alias: 'alias vinculado',
        phone: 'telefone',
        phone_suffix: 'ultimos digitos',
        phone_last4: 'ultimos 4 digitos',
        character: 'personagem',
        manual: 'alias manual',
        lid: '@lid',
        jid: 'jid',
        whatsapp_mention: 'mencao real',
        mention: 'mencao',
        quote: 'resposta',
        body: 'texto',
        fallback: 'fallback',
    };

    return labels[source] || source || 'indefinido';
}

function scoreForAlias(type, confidence = 100) {
    const base = {
        whatsapp_mention: 145,
        lid: 140,
        jid: 135,
        phone: 120,
        phone_last4: 75,
        character: 90,
        manual: 85,
    }[type] || 70;
    return base + Math.min(20, Math.max(0, Number(confidence || 0) - 80));
}

function scorePlayerAgainstIdentifier(player, identifier, options = {}) {
    if (!player) return null;
    if (options.playerFilter && !options.playerFilter(player)) return null;

    const rawIdentifier = String(identifier || '').trim();
    const normalizedIdentifier = normalizeJid(rawIdentifier.replace(/^@/, ''));
    const digits = rawIdentifier.replace(/\D/g, '');
    const name = normalizeCompact(rawIdentifier);
    const playerId = String(player.id || '').trim();
    const playerDigits = extractPhoneNumber(playerId) || playerId.replace(/\D/g, '');
    const searchText = buildSearchText(player);
    const playerVariants = buildPlayerVariants(player);

    let score = 0;
    const sources = [];

    if (rawIdentifier && playerId === rawIdentifier) {
        score += 150;
        sources.push('direct');
    }

    if (normalizedIdentifier && playerVariants.some((value) => value === normalizedIdentifier || isSameUser(value, normalizedIdentifier))) {
        score += 135;
        sources.push('id');
    }

    if (digits) {
        if (digits.length >= 8 && playerDigits && playerDigits === digits) {
            score += 115;
            sources.push('phone');
        } else if (digits.length >= 4 && playerDigits && playerDigits.endsWith(digits)) {
            score += 70;
            sources.push('phone_last4');
        }
    }

    if (name && name.length >= 3 && searchText) {
        const parts = searchText.split(' | ');
        if (parts.some((part) => part === name)) {
            score += 90;
            sources.push('character');
        } else if (searchText.includes(name)) {
            score += 55;
            sources.push('name_partial');
        }
    }

    if (!score) return null;
    return { player, rawPlayer: player, score, source: sources[0] || 'fallback', sources, aliasHits: [] };
}

async function findPlayersByIdentifier(db, identifier, options = {}) {
    const raw = String(identifier || '').trim();
    if (!raw) return [];
    await ensureTargetResolverSchema(db);

    const candidates = aliasCandidatesFromInput(raw);
    const aliasMatches = [];
    if (candidates.length) {
        const clauses = candidates.map(() => '(alias_type = ? AND alias_value = ?)');
        const params = [];
        for (const candidate of candidates) params.push(candidate.type, candidate.value);
        const rows = await db.all(
            `SELECT *
             FROM clover_player_aliases
             WHERE active = 1 AND (${clauses.join(' OR ')})`,
            params
        );
        for (const row of rows) {
            const rawPlayer = await getRawPlayerById(db, row.player_id_destino);
            const resolved = await resolveCanonicalChain(db, rawPlayer || row.player_id_destino);
            const canonical = resolved.canonical;
            if (!canonical) continue;
            if (options.playerFilter && !options.playerFilter(canonical)) continue;
            aliasMatches.push({
                player: canonical,
                rawPlayer: resolved.original || rawPlayer || canonical,
                score: scoreForAlias(row.alias_type, row.confidence),
                source: row.alias_type,
                sources: [row.alias_type],
                aliasHits: [row],
                redirectedFrom: resolved.redirectedFrom,
                redirectReason: resolved.redirectReason,
                originalSource: row.alias_type,
                redirectChain: resolved.chain,
            });
        }
    }

    const legacyKeys = buildAliasKeysFromInput(raw);
    if (legacyKeys.length) {
        const rows = await db.all(
            `SELECT alias_key, alias_label, player_id, alias_kind
             FROM clover_player_target_aliases
             WHERE alias_key IN (${legacyKeys.map(() => '?').join(',')})`,
            legacyKeys
        );
        for (const row of rows) {
            const rawPlayer = await getRawPlayerById(db, row.player_id);
            const resolved = await resolveCanonicalChain(db, rawPlayer || row.player_id);
            const canonical = resolved.canonical;
            if (!canonical) continue;
            if (options.playerFilter && !options.playerFilter(canonical)) continue;
            aliasMatches.push({
                player: canonical,
                rawPlayer: resolved.original || rawPlayer || canonical,
                score: 105,
                source: 'alias',
                sources: ['alias'],
                aliasHits: [row],
                redirectedFrom: resolved.redirectedFrom,
                redirectReason: resolved.redirectReason,
                originalSource: 'alias',
                redirectChain: resolved.chain,
            });
        }
    }

    const players = await db.all('SELECT * FROM jogadores WHERE id IS NOT NULL');
    const fallbackIdentifiers = [
        raw,
        ...candidates
            .filter((candidate) => ['jid', 'lid', 'whatsapp_mention', 'phone', 'phone_last4', 'character', 'manual'].includes(candidate.type))
            .map((candidate) => candidate.value),
    ].filter(Boolean);
    const fallbackMatches = [];
    const fallbackSeen = new Set();
    for (const fallbackIdentifier of fallbackIdentifiers) {
        for (const player of players) {
            const match = scorePlayerAgainstIdentifier(player, fallbackIdentifier, options);
            if (!match) continue;
            const key = `${player.id}:${match.source}:${fallbackIdentifier}`;
            if (fallbackSeen.has(key)) continue;
            fallbackSeen.add(key);
            fallbackMatches.push(match);
        }
    }

    const best = new Map();
    for (const match of [...aliasMatches, ...fallbackMatches]) {
        const resolved = await resolveCanonicalChain(db, match.rawPlayer || match.player);
        const canonical = resolved.canonical;
        if (!canonical) continue;
        const key = canonical.id;
        const next = {
            ...match,
            player: canonical,
            rawPlayer: resolved.original || match.rawPlayer || match.player,
            redirectedFrom: resolved.redirectedFrom || match.redirectedFrom || null,
            redirectReason: resolved.redirectReason || match.redirectReason || null,
            originalSource: match.originalSource || match.source,
            redirectChain: resolved.chain || match.redirectChain || [],
        };
        const existing = best.get(key);
        if (!existing || next.score > existing.score) {
            best.set(key, next);
        } else if (existing) {
            existing.sources = [...new Set([...(existing.sources || []), ...(next.sources || [])])];
            existing.aliasHits = [...(existing.aliasHits || []), ...(next.aliasHits || [])];
            if (
                !existing.redirectedFrom
                && next.redirectedFrom
                && next.score >= existing.score
            ) {
                existing.rawPlayer = next.rawPlayer;
                existing.redirectedFrom = next.redirectedFrom;
                existing.redirectReason = next.redirectReason;
                existing.originalSource = next.originalSource;
                existing.redirectChain = next.redirectChain;
            }
        }
    }

    return [...best.values()]
        .sort((left, right) => right.score - left.score || String(left.player.id).localeCompare(String(right.player.id)));
}

function normalizeResolveArgs(targetIdOrOptions, targetText, options) {
    if (targetIdOrOptions && typeof targetIdOrOptions === 'object' && !Array.isArray(targetIdOrOptions)) {
        return {
            targetId: targetIdOrOptions.targetId || targetIdOrOptions.id || null,
            targetText: targetIdOrOptions.targetText || targetIdOrOptions.text || targetIdOrOptions.name || '',
            options: {
                ...targetIdOrOptions,
                ...(options || {}),
            },
        };
    }
    return {
        targetId: targetIdOrOptions,
        targetText,
        options: options || {},
    };
}

function buildTargetDetails({
    rawTarget,
    source,
    foundPlayer,
    canonicalPlayer,
    redirectedFrom,
    redirectReason,
    originalSource,
    reason,
    suggestion,
}) {
    return {
        rawTarget: rawTarget || '',
        source: source || 'indefinido',
        originalSource: originalSource || source || 'indefinido',
        redirectedFrom: redirectedFrom || null,
        redirectReason: redirectReason || null,
        foundPlayer: foundPlayer ? {
            id: foundPlayer.id,
            personagem_nome: foundPlayer.personagem_nome || null,
            nome: foundPlayer.nome || foundPlayer.display_name || null,
            merged_into: foundPlayer.merged_into || null,
            is_shadow: foundPlayer.is_shadow || 0,
        } : null,
        canonicalPlayer: canonicalPlayer ? {
            id: canonicalPlayer.id,
            personagem_nome: canonicalPlayer.personagem_nome || null,
            nome: canonicalPlayer.nome || canonicalPlayer.display_name || null,
            merged_into: canonicalPlayer.merged_into || null,
            is_shadow: canonicalPlayer.is_shadow || 0,
        } : null,
        reason: reason || 'target_error',
        suggestion: suggestion || 'Use .#quem para diagnosticar, .#vincular para corrigir alias ou .#mesclarplayer para unir espelho.',
    };
}

function hasAnySource(match = {}, sources = []) {
    const all = [match.source, ...(match.sources || [])].filter(Boolean);
    return all.some((source) => sources.includes(source));
}

function preferNonEmptyAliasOverEmptyDirect(matches = []) {
    const directEmpty = matches.find((match) => (
        isEmptyCharacterPlayer(match.player)
        && hasAnySource(match, ['direct', 'id'])
    ));
    if (!directEmpty) return null;

    return matches.find((match) => (
        !isEmptyCharacterPlayer(match.player)
        && hasAnySource(match, ['whatsapp_mention', 'lid', 'jid', 'alias', 'phone', 'character', 'manual'])
    )) || null;
}

async function resolveTargetDetails(db, targetIdOrOptions, targetText = '', options = {}) {
    const normalizedArgs = normalizeResolveArgs(targetIdOrOptions, targetText, options);
    const targetId = normalizedArgs.targetId;
    const targetLabel = normalizedArgs.targetText;
    const opts = normalizedArgs.options;
    const quotedParticipant = opts.quotedParticipant ? normalizeJid(opts.quotedParticipant) : '';
    const identifier = String(targetId || targetLabel || quotedParticipant || '').trim();
    const label = String(targetLabel || targetId || quotedParticipant || '').trim();
    const rawTarget = label || identifier;

    if (!identifier) {
        return {
            ok: false,
            error: 'Player nao encontrado no banco.',
            details: buildTargetDetails({ rawTarget, source: opts.source || 'none', reason: 'empty_target' }),
        };
    }

    const matches = await findPlayersByIdentifier(db, identifier, opts);
    let selected = null;
    const preferredAlias = preferNonEmptyAliasOverEmptyDirect(matches);
    if (preferredAlias) {
        selected = preferredAlias;
    } else if (matches.length === 1) {
        selected = matches[0];
    } else if (matches.length > 1) {
        const first = matches[0];
        const second = matches[1];
        if (first.score > second.score + 10) {
            selected = first;
        } else {
            return {
                ok: false,
                error: `Encontrei mais de um personagem para "${label}". Use mencao real, resposta, .#vincular ou player_id canonico.`,
                matches,
                details: buildTargetDetails({
                    rawTarget,
                    source: 'ambiguous',
                    foundPlayer: first.player,
                    reason: 'ambiguous_target',
                    suggestion: 'Use .#quem no alvo e depois .#vincular ou .#mesclarplayer para fixar a identidade.',
                }),
            };
        }
    }

    if (!selected && targetId) {
        const direct = await getRawPlayerById(db, targetId);
        const resolved = await resolveCanonicalChain(db, direct || targetId);
        const canonical = resolved.canonical;
        if (canonical && (!opts.playerFilter || opts.playerFilter(canonical))) {
            selected = {
                player: canonical,
                rawPlayer: resolved.original || direct || canonical,
                score: 150,
                source: 'direct',
                sources: ['direct'],
                aliasHits: [],
                redirectedFrom: resolved.redirectedFrom,
                redirectReason: resolved.redirectReason,
                originalSource: 'direct',
                redirectChain: resolved.chain,
            };
        }
    }

    if (!selected && quotedParticipant) {
        const quoted = await getRawPlayerById(db, quotedParticipant);
        const resolved = await resolveCanonicalChain(db, quoted || quotedParticipant);
        const canonical = resolved.canonical;
        if (canonical && (!opts.playerFilter || opts.playerFilter(canonical))) {
            selected = {
                player: canonical,
                rawPlayer: resolved.original || quoted || canonical,
                score: 130,
                source: 'quote',
                sources: ['quote'],
                aliasHits: [],
                redirectedFrom: resolved.redirectedFrom,
                redirectReason: resolved.redirectReason,
                originalSource: 'quote',
                redirectChain: resolved.chain,
            };
        }
    }

    if (!selected) {
        return {
            ok: false,
            error: `Player nao encontrado no banco: ${label || identifier}.`,
            details: buildTargetDetails({
                rawTarget,
                source: opts.source || 'not_found',
                reason: 'target_not_found',
                suggestion: 'Use mencao real, telefone completo, .#quem, .#vincular ou .#mesclarplayer.',
            }),
        };
    }

    const resolvedChain = await resolveCanonicalChain(db, selected.rawPlayer || selected.player);
    const canonical = resolvedChain.canonical || selected.player;
    const rawPlayer = resolvedChain.original || selected.rawPlayer || selected.player;
    const redirectedFrom = resolvedChain.redirectedFrom || selected.redirectedFrom || (
        rawPlayer?.id && canonical?.id && rawPlayer.id !== canonical.id ? rawPlayer.id : null
    );
    const redirectReason = redirectedFrom ? (resolvedChain.redirectReason || selected.redirectReason || 'merged_shadow') : null;
    const originalSource = selected.originalSource || selected.source || opts.source || 'resolved';
    const mechanical = opts.mechanical || opts.requireCharacter || opts.rejectEmptyCharacter;
    if (mechanical) {
        const guard = assertMechanicalTarget(canonical, {
            rawTarget,
            source: selected.source,
            originalSource,
            redirectedFrom,
            redirectReason,
        });
        if (!guard.ok) {
            return { ok: false, error: guard.error, matches, details: guard.details };
        }
    }

    return {
        ok: true,
        player: canonical,
        rawPlayer,
        canonicalPlayerId: canonical.id,
        redirectedFrom,
        redirectReason,
        originalSource,
        redirectChain: resolvedChain.chain || selected.redirectChain || [],
        source: selected.source,
        sources: selected.sources || [selected.source],
        matches,
        details: buildTargetDetails({
            rawTarget,
            source: selected.source,
            foundPlayer: rawPlayer,
            canonicalPlayer: canonical,
            redirectedFrom,
            redirectReason,
            originalSource,
            reason: redirectedFrom ? 'merged_shadow' : 'resolved',
            suggestion: redirectedFrom ? `Cadastro redirecionado para ${canonical.id}.` : 'Identidade resolvida.',
        }),
    };
}

async function resolveTargetPlayer(db, targetId, targetText, options = {}) {
    return resolveTargetDetails(db, targetId, targetText, options);
}

async function mergePlayerIdentity(db, { origin, destination, reason = '', actorId = null } = {}) {
    await ensureTargetResolverSchema(db);
    const rawOriginDirect = await getRawPlayerById(db, origin);
    const originResolved = rawOriginDirect
        ? {
            ok: true,
            player: await getCanonicalPlayer(db, rawOriginDirect, { skipSelfHydrate: true }) || rawOriginDirect,
            rawPlayer: rawOriginDirect,
            source: 'direct',
        }
        : await resolveTargetDetails(db, null, origin, { allowShadow: true });
    const destinationResolved = await resolveTargetDetails(db, null, destination, { allowShadow: true });
    if (!originResolved.ok) throw new Error(`Origem nao encontrada: ${originResolved.error}`);
    if (!destinationResolved.ok) throw new Error(`Destino nao encontrado: ${destinationResolved.error}`);

    const rawOrigin = originResolved.rawPlayer || originResolved.player;
    const canonicalDestination = await getCanonicalPlayer(db, destinationResolved.player);
    if (!rawOrigin?.id || !canonicalDestination?.id) throw new Error('Origem ou destino invalido.');
    const destinationGuard = assertMechanicalTarget(canonicalDestination, {
        rawTarget: destination,
        source: destinationResolved.source || 'merge_destination',
    });
    if (!destinationGuard.ok) {
        throw new Error(destinationGuard.error);
    }
    if (rawOrigin.id === canonicalDestination.id) {
        return { ok: true, origin: rawOrigin, destination: canonicalDestination, movedAliases: 0, same: true };
    }

    const originAliases = aliasCandidatesFromInput(rawOrigin.id);
    const originPhone = extractPhoneNumber(rawOrigin.id);
    if (originPhone) {
        originAliases.push(...aliasCandidatesFromInput(originPhone));
    }
    if (!isEmptyCharacterPlayer(rawOrigin)) {
        originAliases.push(...aliasCandidatesFromInput({ type: 'character', value: rawOrigin.personagem_nome, label: rawOrigin.personagem_nome }));
    }

    await db.exec('BEGIN');
    try {
        await db.run(
            `UPDATE clover_player_aliases
             SET player_id_destino = ?, source = 'merge', updated_at = CURRENT_TIMESTAMP
             WHERE player_id_destino = ?`,
            [canonicalDestination.id, rawOrigin.id]
        );
        await db.run(
            `UPDATE clover_player_target_aliases
             SET player_id = ?, alias_kind = 'merge', updated_at = CURRENT_TIMESTAMP
             WHERE player_id = ?`,
            [canonicalDestination.id, rawOrigin.id]
        );
        await db.run(
            `UPDATE jogadores
             SET merged_into = ?,
                 canonical_player_id = ?,
                 is_shadow = 1,
                 identity_status = 'merged'
             WHERE id = ?`,
            [canonicalDestination.id, canonicalDestination.id, rawOrigin.id]
        );
        await db.run(
            `UPDATE jogadores
             SET canonical_player_id = COALESCE(canonical_player_id, ?),
                 is_shadow = 0,
                 identity_status = COALESCE(identity_status, 'active')
             WHERE id = ?`,
            [canonicalDestination.id, canonicalDestination.id]
        );
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }

    const unique = new Map();
    for (const candidate of originAliases) unique.set(candidate.key, candidate);
    for (const candidate of unique.values()) {
        await upsertAlias(db, {
            playerId: canonicalDestination.id,
            type: candidate.type,
            value: candidate.value,
            source: 'merge',
            confidence: 100,
            createdBy: actorId,
        });
    }

    return {
        ok: true,
        origin: rawOrigin,
        destination: canonicalDestination,
        reason,
        movedAliases: unique.size,
        safeHistory: 'aliases_moved_economic_history_preserved',
    };
}

function formatTargetErrorDetailsLegacy(details = {}) {
    const found = details.foundPlayer
        ? `${details.foundPlayer.personagem_nome || details.foundPlayer.nome || '-'} (${details.foundPlayer.id || '-'})`
        : '-';
    return [
        details.rawTarget ? `*Alvo bruto:* ${details.rawTarget}` : null,
        details.source ? `*Fonte:* ${describeTargetSource(details.source)}` : null,
        `*Cadastro encontrado:* ${found}`,
        details.reason ? `*Motivo:* ${details.reason}` : null,
        details.suggestion ? `*Correção:* ${details.suggestion}` : null,
    ].filter(Boolean);
}

function formatTargetErrorDetails(details = {}) {
    const found = details.foundPlayer
        ? `${details.foundPlayer.personagem_nome || details.foundPlayer.nome || '-'} (${details.foundPlayer.id || '-'})`
        : '-';
    const canonical = details.canonicalPlayer
        ? `${details.canonicalPlayer.personagem_nome || details.canonicalPlayer.nome || '-'} (${details.canonicalPlayer.id || '-'})`
        : null;
    return [
        details.rawTarget ? `*Alvo bruto:* ${details.rawTarget}` : null,
        details.source ? `*Fonte:* ${describeTargetSource(details.source)}` : null,
        details.originalSource && details.originalSource !== details.source ? `*Fonte original:* ${describeTargetSource(details.originalSource)}` : null,
        `*Cadastro encontrado:* ${found}`,
        details.redirectedFrom ? `*Redirecionado:* ${details.redirectedFrom} -> ${details.canonicalPlayer?.id || '-'}` : null,
        details.redirectReason ? `*Motivo do redirecionamento:* ${details.redirectReason}` : null,
        canonical ? `*Canonico final:* ${canonical}` : null,
        details.reason ? `*Motivo:* ${details.reason}` : null,
        details.suggestion ? `*Correção:* ${details.suggestion}` : null,
    ].filter(Boolean);
}

module.exports = {
    EMPTY_CHARACTER_MESSAGE,
    aliasCandidatesFromInput,
    assertMechanicalTarget,
    buildAliasKeysFromInput,
    describeTargetSource,
    ensureTargetResolverSchema,
    findPlayersByIdentifier,
    formatTargetErrorDetails,
    getCanonicalPlayer,
    resolveCanonicalChain,
    getPlayerById,
    getRawPlayerById,
    isEmptyCharacterPlayer,
    linkPlayerTarget,
    listPlayerTargetAliases,
    mergePlayerIdentity,
    normalizeAliasValue,
    normalizeTargetAliasKey,
    normalizeTargetAliasLabel,
    resolveTargetDetails,
    resolveTargetPlayer,
    upsertAlias,
};
