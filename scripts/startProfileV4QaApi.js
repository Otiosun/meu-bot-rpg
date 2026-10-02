'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { criarBanco } = require('../database');
const { startSiteApiServer, stopSiteApiServer } = require('../helpers/clover/siteApiServer');
const { createSiteLoginCode } = require('../helpers/clover/siteAuthService');

const PORT = Number(process.env.PORT || process.env.CLOVER_SITE_API_PORT || 8787);
const DB_FILE = process.env.CLOVER_QA_DB_FILE || '/tmp/clover-profile-v4-qa.sqlite';
const MEDIA_DIR = process.env.CLOVER_PROFILE_MEDIA_DIR || '/tmp/clover-profile-v4-media';
const PHONE = String(process.env.CLOVER_QA_PHONE || '5579999000000').replace(/\D/g, '');
const FIXED_LOGIN_CODE = String(process.env.CLOVER_QA_LOGIN_CODE || '').trim();
const PLAYER_ID = `${PHONE}@s.whatsapp.net`;

process.env.CLOVER_SITE_API_ENABLED = '1';
process.env.CLOVER_SITE_API_PORT = String(PORT);
process.env.CLOVER_SITE_API_HOST = '0.0.0.0';
process.env.CLOVER_PROFILE_MEDIA_DIR = MEDIA_DIR;
process.env.CLOVER_WEEKLY_CHECKLIST_AUTO_PV = '0';

function existingColumnSet(columns) {
    return new Set((columns || []).map((row) => String(row.name || '')));
}

async function upsertQaPlayer(db) {
    await db.run(
        `INSERT INTO jogadores (id, nome)
         VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET nome = excluded.nome`,
        [PLAYER_ID, 'Lysandra Vael']
    );

    const columns = existingColumnSet(await db.all('PRAGMA table_info(jogadores)'));
    const desired = {
        personagem_nome: 'Lysandra Vael',
        idade: '24',
        reino: 'Clover',
        classe: 'Nobreza',
        familia: 'Casa Vael',
        raca: 'Humana',
        grimorio: 'Grimório de 4 folhas',
        magia: 'Magia de Cartografia Astral',
        historia: 'Cartógrafa de mana ligada a uma estrela que não deveria existir.',
        aparencia: 'Cabelos escuros, olhar atento e mapas astrais presos ao uniforme.',
        esquadrao: 'Cervo Turquesa',
        estrelas: 37,
        jogo_status: 'liberado',
        ficha_status: 'aprovada',
        historia_status: 'aprovada',
        personagem_aparencia_status: 'approved',
        identity_status: 'active',
        lifecycle_status: 'active',
        is_shadow: 0,
        merged_into: null,
        is_test_user: 1,
        character_kind: 'ghost',
        is_canonical: 0,
        site_profile_image_data: null,
    };

    const pairs = Object.entries(desired).filter(([column]) => columns.has(column));
    if (pairs.length) {
        const assignments = pairs.map(([column]) => `${column} = ?`).join(', ');
        await db.run(
            `UPDATE jogadores SET ${assignments} WHERE id = ?`,
            [...pairs.map(([, value]) => value), PLAYER_ID]
        );
    }

    const statsColumns = existingColumnSet(await db.all('PRAGMA table_info(clover_character_stats)'));
    if (statsColumns.has('player_id')) {
        const payload = {
            player_id: PLAYER_ID,
            stage_key: '5',
            pb_total: 24,
            pb_spent: 8,
            ph_accumulated: 83,
            ph_available: 12,
            forca: 12,
            velocidade: 15,
            agilidade: 17,
            resistencia: 13,
            poder_magico: 28,
            distribution_status: 'confirmed',
        };
        const entries = Object.entries(payload).filter(([column]) => statsColumns.has(column));
        const cols = entries.map(([column]) => column);
        const values = entries.map(([, value]) => value);
        const updates = cols.filter((column) => column !== 'player_id')
            .map((column) => `${column} = excluded.${column}`);
        await db.run(
            `INSERT INTO clover_character_stats (${cols.join(', ')})
             VALUES (${cols.map(() => '?').join(', ')})
             ON CONFLICT(player_id) DO UPDATE SET ${updates.join(', ')}`,
            values
        );
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function seedFixedLoginCode(db, code) {
    if (!/^\d{6}$/.test(code)) throw new Error('CLOVER_QA_LOGIN_CODE precisa ter 6 dígitos.');
    const salt = crypto.randomBytes(16).toString('hex');
    const codeHash = sha256(`${salt}:${PLAYER_ID}:${code}`);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await db.run(
        `INSERT INTO clover_site_login_codes
         (player_id, phone_digits, code_hash, code_salt, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, NULL)
         ON CONFLICT(player_id) DO UPDATE SET
             phone_digits = excluded.phone_digits,
             code_hash = excluded.code_hash,
             code_salt = excluded.code_salt,
             created_at = CURRENT_TIMESTAMP,
             expires_at = excluded.expires_at,
             used_at = NULL`,
        [PLAYER_ID, PHONE, codeHash, salt, expiresAt]
    );

    return {
        ok: true,
        code,
        expiresAt,
        phoneDigits: PHONE,
    };
}

async function main() {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.mkdirSync(MEDIA_DIR, { recursive: true });

    const db = await criarBanco({ filename: DB_FILE });
    await upsertQaPlayer(db);

    const login = FIXED_LOGIN_CODE
        ? await seedFixedLoginCode(db, FIXED_LOGIN_CODE)
        : await createSiteLoginCode(db, PLAYER_ID, {
            phoneDigits: PHONE,
            ttlMs: 24 * 60 * 60 * 1000,
        });
    if (!login.ok) {
        throw new Error(`Não foi possível criar login QA: ${login.reason || 'unknown'}`);
    }

    const server = startSiteApiServer({ getDb: () => db });
    if (!server) throw new Error('Site API staging não iniciou.');

    console.log('[profile-v4-qa] READY', JSON.stringify({
        port: PORT,
        playerId: PLAYER_ID,
        phone: PHONE,
        loginCode: login.code,
        expiresAt: login.expiresAt,
        dbFile: DB_FILE,
        mediaDir: MEDIA_DIR,
        whatsapp: false,
    }));

    const shutdown = async (signal) => {
        console.log(`[profile-v4-qa] shutdown ${signal}`);
        await stopSiteApiServer().catch(() => {});
        await db.close().catch(() => {});
        process.exit(0);
    };
    process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
    process.once('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch((error) => {
    console.error('[profile-v4-qa] fatal', error?.stack || error?.message || String(error));
    process.exit(1);
});
