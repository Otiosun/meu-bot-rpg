'use strict';

const GHOST_KIND = 'ghost';

const GHOST_PROFILE = {
    personagem_nome: 'Whatever',
    personagem_idade: 21,
    personagem_genero: 'Livre',
    personagem_aparencia: 'Personagem temporario de teste do Clover.',
    personagem_aparencia_status: 'approved',
    ficha_status: 'aprovada',
    historia_status: 'aprovada',
    jogo_status: 'liberado',
    reino: 'Clover',
    classe: 'Nobre',
    familia: 'Vermillion',
    raca: 'Humano',
    grimorio: 'Trevo de 4 folhas',
    magia: 'Luz',
    formas: 'Lamina, disparo e escudo de luz.',
    historia: 'Whatever foi criado apenas para teste de bot, site e comandos.',
    aparencia: 'Personagem temporario de teste do Clover.',
    gancho_narrativo: 'Nao canonico. Pode testar missoes, perfil, atributos e comandos sem afetar a historia oficial.',
    numero_roll_escolhido: 1,
    dinheiro: 500,
    esquadrao: 'Touros Negros',
    estrelas: 3,
    atributos_max: 1280,
    forca: 256,
    velocidade: 256,
    resistencia: 256,
    reflexos: 256,
    poder_magico: 256,
    mana: 256,
    pontos: 0,
    agilidade: 256,
};

const GHOST_STATS = {
    stage_key: '2',
    pb_total: 1280,
    pb_spent: 1280,
    ph_accumulated: 4000,
    ph_available: 800,
    forca: 256,
    velocidade: 256,
    agilidade: 256,
    resistencia: 256,
    poder_magico: 256,
    distribution_status: 'confirmed',
};

const GHOST_ROLL = {
    roll_number: 1,
    kingdom: 'Clover',
    social_class: 'Nobre',
    family: 'Vermillion',
    race: 'Humano',
    grimoire: 'Trevo de 4 folhas',
    grimoire_rank: '4 folhas',
    grimoire_symbol: 'trevo_4_folhas',
    magic_rarity: 'Rara',
    magic_scope: 'Luz',
    summary: 'Clover - Nobre - Humano - Trevo de 4 folhas - Magia Rara',
    roll_version: 'ghost-test-v1',
    kingdom_key: 'clover',
    social_class_key: 'nobre',
    race_key: 'humano',
    grimoire_key: 'trevo_4_folhas',
    magic_rarity_key: 'rara',
};

const GHOST_CLEANUP_TABLES = [
    'pending_profile_confirmations',
    'pending_magic_confirmations',
    'clover_pending_skill_purchases',
    'clover_pending_hexagon_upgrades',
    'clover_trait_attempts',
    'clover_appearance_reviews',
    'clover_skill_nodes',
    'clover_inventory_items',
    'clover_quick_evaluations',
    'clover_ph_ledger',
    'clover_mana_hexagon_ledger',
    'clover_mana_hexagon',
    'clover_character_stats',
    'player_rolls',
    'player_skill_trees',
    'player_progress',
    'player_onboarding',
    'clover_spellbook_spells',
    'clover_character_bonuses',
    'clover_return_bonuses',
    'clover_prereset_character_operations',
    'clover_prereset_characters',
    'clover_prereset_future_rolls',
    'clover_site_login_codes',
    'clover_site_sessions',
    'clover_exit_confirmations',
    'clover_antighost_activity',
];

const GHOST_PLAYER_ID_COLUMNS = [
    'player_id',
    'id_jogador',
    'jogador_id',
    'target_player_id',
    'subject_id',
    'actor_id',
    'owner_id',
    'jid',
    'user_jid',
    'whatsapp_id',
];

const GHOST_PHONE_COLUMNS = [
    'phone',
    'telefone',
    'phone_digits',
    'whatsapp_number',
    'numero',
];

function extractDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeJid(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.includes('@')) return raw;
    const digits = extractDigits(raw);
    return digits ? `${digits}@s.whatsapp.net` : raw;
}

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

async function tableExists(db, table) {
    const row = await db.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [table]
    ).catch(() => null);
    return Boolean(row?.found);
}

async function tableColumns(db, table) {
    const rows = await db.all(`PRAGMA table_info(${quoteIdentifier(table)})`);
    return new Set((rows || []).map((row) => row.name));
}

async function ensureColumn(db, table, column, definition) {
    const columns = await tableColumns(db, table);
    if (!columns.has(column)) {
        await db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`);
    }
}

async function clearGhostBlockingRows(db, playerIds) {
    const ids = [...new Set((playerIds || []).map(normalizeJid).filter(Boolean))];
    const phoneDigits = [...new Set(ids.map(extractDigits).filter(Boolean))];
    let deletedRows = 0;

    for (const table of GHOST_CLEANUP_TABLES) {
        if (!await tableExists(db, table)) continue;
        const columns = await tableColumns(db, table);

        for (const column of GHOST_PLAYER_ID_COLUMNS) {
            if (!columns.has(column) || !ids.length) continue;
            const placeholders = ids.map(() => '?').join(', ');
            const result = await db.run(
                `DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IN (${placeholders})`,
                ids
            ).catch(() => null);
            deletedRows += Number(result?.changes || 0);
        }

        for (const column of GHOST_PHONE_COLUMNS) {
            if (!columns.has(column) || !phoneDigits.length) continue;
            const placeholders = phoneDigits.map(() => '?').join(', ');
            const result = await db.run(
                `DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IN (${placeholders})`,
                phoneDigits
            ).catch(() => null);
            deletedRows += Number(result?.changes || 0);
        }
    }

    return deletedRows;
}

async function readPlayers(db, playerIds) {
    const ids = [...new Set((playerIds || []).map(normalizeJid).filter(Boolean))];
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return db.all(
        `SELECT * FROM jogadores WHERE id IN (${placeholders})`,
        ids
    ).catch(() => []);
}

async function ensureGhostTestSchema(db) {
    await ensureColumn(db, 'jogadores', 'is_test_user', 'INTEGER DEFAULT 0');
    await ensureColumn(db, 'jogadores', 'character_kind', "TEXT DEFAULT 'player'");
    await ensureColumn(db, 'jogadores', 'is_canonical', 'INTEGER DEFAULT 1');
}

function isMarkedGhost(player) {
    return Number(player?.is_test_user || 0) === 1
        && String(player?.character_kind || '') === GHOST_KIND
        && Number(player?.is_canonical ?? 1) === 0;
}

function hasRealPlayerData(player) {
    if (!player) return false;
    if (isMarkedGhost(player)) return false;
    const characterName = String(player.personagem_nome || '').trim();
    const hasCharacterName = characterName && characterName !== '-';
    const fichaStatus = String(player.ficha_status || '').trim().toLowerCase();
    const gameStatus = String(player.jogo_status || '').trim().toLowerCase();
    const hasSelectedRoll = Number(player.numero_roll_escolhido || 0) > 0;

    return hasCharacterName
        || ['confirmada', 'aprovada'].includes(fichaStatus)
        || ['liberado', 'historia_aprovada', 'aguardando_historia'].includes(gameStatus)
        || hasSelectedRoll;
}

function buildInsertStatement(table, values, availableColumns) {
    const entries = Object.entries(values).filter(([column]) => availableColumns.has(column));
    const columns = entries.map(([column]) => column);
    const placeholders = columns.map(() => '?');
    const params = entries.map(([, value]) => value);
    return {
        sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
        params,
    };
}

function buildUpdateStatement(table, values, availableColumns, whereClause) {
    const entries = Object.entries(values).filter(([column]) => availableColumns.has(column));
    const assignments = entries.map(([column]) => `${column} = ?`);
    const params = entries.map(([, value]) => value);
    return {
        sql: `UPDATE ${table} SET ${assignments.join(', ')} ${whereClause}`,
        params,
    };
}

async function upsertPlayer(db, playerId, displayName) {
    const columns = await tableColumns(db, 'jogadores');
    const safeName = String(displayName || 'Tester').trim() || 'Tester';
    const values = {
        id: playerId,
        nome: safeName,
        display_name: safeName,
        ...GHOST_PROFILE,
        is_test_user: 1,
        character_kind: GHOST_KIND,
        is_canonical: 0,
    };
    const existing = await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]);
    if (!existing) {
        const statement = buildInsertStatement('jogadores', values, columns);
        await db.run(statement.sql, statement.params);
    } else {
        const statement = buildUpdateStatement('jogadores', values, columns, 'WHERE id = ?');
        await db.run(statement.sql, [...statement.params, playerId]);
    }
}

async function upsertOnboarding(db, playerId) {
    await db.run(
        `INSERT INTO player_onboarding
         (player_id, current_step, step_payload, started_at, welcome_sent_at, last_seen_at)
         VALUES (?, 'ghost_test_ready', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(player_id) DO UPDATE SET
             current_step = 'ghost_test_ready',
             step_payload = excluded.step_payload,
             last_seen_at = CURRENT_TIMESTAMP`,
        [playerId, JSON.stringify({ sandbox: true, character_kind: GHOST_KIND })]
    );
}

async function upsertRoll(db, playerId) {
    const columns = await tableColumns(db, 'player_rolls');
    await db.run('DELETE FROM player_rolls WHERE player_id = ?', [playerId]);
    const values = {
        player_id: playerId,
        ...GHOST_ROLL,
        roll_payload: JSON.stringify({
            sandbox: true,
            canonical: false,
            source: 'ghost_test',
        }),
    };
    const statement = buildInsertStatement('player_rolls', values, columns);
    await db.run(statement.sql, statement.params);
}

async function upsertProgress(db, playerId) {
    await db.run(
        `INSERT INTO player_progress (player_id, ph_total, ph_bonus, updated_at)
         VALUES (?, 300, 0, CURRENT_TIMESTAMP)
         ON CONFLICT(player_id) DO UPDATE SET
             ph_total = excluded.ph_total,
             ph_bonus = excluded.ph_bonus,
             updated_at = CURRENT_TIMESTAMP`,
        [playerId]
    );
}

async function upsertStats(db, playerId) {
    const columns = await tableColumns(db, 'clover_character_stats');
    const existing = await db.get('SELECT * FROM clover_character_stats WHERE player_id = ?', [playerId]);
    const values = {
        player_id: playerId,
        ...GHOST_STATS,
        confirmed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    if (!existing) {
        const statement = buildInsertStatement('clover_character_stats', values, columns);
        await db.run(statement.sql, statement.params);
    } else {
        const statement = buildUpdateStatement('clover_character_stats', values, columns, 'WHERE player_id = ?');
        await db.run(statement.sql, [...statement.params, playerId]);
    }
}

async function createOrResetGhostTestPlayer(db, input = {}) {
    const playerId = normalizeJid(input.playerId);
    if (!playerId) {
        return { ok: false, code: 'missing_player_id', error: 'Identidade do jogador ausente.' };
    }

    await ensureGhostTestSchema(db);
    const alternateIds = (input.alternateIds || []).map(normalizeJid).filter(Boolean);
    const allIds = [...new Set([playerId, ...alternateIds])];
    const existingPlayers = await readPlayers(db, allIds);
    const realPlayer = existingPlayers.find(hasRealPlayerData);
    if (realPlayer) {
        return {
            ok: false,
            code: 'real_player_exists',
            error: 'Esse numero ja possui um personagem real. Nao vou converter ficha canonica em teste.',
            player: realPlayer,
        };
    }

    const existing = existingPlayers.find((player) => player.id === playerId) || null;
    const mode = existing ? (isMarkedGhost(existing) ? 'reset' : 'converted') : 'created';
    await db.exec('BEGIN');
    try {
        await clearGhostBlockingRows(db, allIds);
        for (const stalePlayer of existingPlayers) {
            if (stalePlayer.id !== playerId && !hasRealPlayerData(stalePlayer)) {
                await db.run('DELETE FROM jogadores WHERE id = ?', [stalePlayer.id]);
            }
        }
        await upsertPlayer(db, playerId, input.displayName);
        await upsertOnboarding(db, playerId);
        await upsertRoll(db, playerId);
        await upsertProgress(db, playerId);
        await upsertStats(db, playerId);
        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
    }

    return {
        ok: true,
        mode,
        cleanupIds: allIds,
        player: await db.get('SELECT * FROM jogadores WHERE id = ?', [playerId]),
    };
}

async function isGhostTestPlayer(db, playerId) {
    await ensureGhostTestSchema(db);
    const player = await db.get('SELECT is_test_user, character_kind, is_canonical FROM jogadores WHERE id = ?', [playerId]);
    return isMarkedGhost(player);
}

module.exports = {
    GHOST_KIND,
    GHOST_PROFILE,
    GHOST_STATS,
    clearGhostBlockingRows,
    createOrResetGhostTestPlayer,
    ensureGhostTestSchema,
    isGhostTestPlayer,
};
