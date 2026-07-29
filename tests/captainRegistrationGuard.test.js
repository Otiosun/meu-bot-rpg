'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureCloverSquadSchema } = require('../database');
const { ensureAccessControlSchema } = require('../helpers/clover/accessControlService');
const {
    normalizeBrazilianCaptainAccount,
    registerSquadCaptainSafely,
} = require('../helpers/clover/captainRegistrationGuardService');

const ADMIN = '557999999999@s.whatsapp.net';
const EXISTING = '5511999999999@s.whatsapp.net';

async function tableExists(db, tableName) {
    const row = await db.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    );
    return Boolean(row);
}

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT '-',
            patente TEXT DEFAULT '-',
            raca TEXT DEFAULT '-',
            classe TEXT DEFAULT '-',
            reino TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            grimorio TEXT DEFAULT '-',
            personagem_idade INTEGER DEFAULT NULL,
            personagem_genero TEXT DEFAULT '-',
            personagem_aparencia TEXT DEFAULT '-',
            personagem_aparencia_image_path TEXT DEFAULT NULL,
            site_profile_image_data TEXT DEFAULT NULL,
            ficha_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado',
            estrelas INTEGER DEFAULT 0
        );
        CREATE TABLE clover_character_stats (
            player_id TEXT PRIMARY KEY,
            distribution_status TEXT DEFAULT NULL
        );
        INSERT INTO jogadores (id, nome, display_name, personagem_nome, esquadrao)
        VALUES ('${EXISTING}', 'Conta existente', 'Conta existente', 'Personagem Principal', 'Outro Esquadrão');
    `);
    await ensureCloverSquadSchema(db);
    await ensureAccessControlSchema(db);
    await db.run(
        `INSERT INTO clover_squads (squad_key, name, current_stars, historical_stars)
         VALUES ('veu_negro', 'Véu Negro', 0, 0)`
    );
    return db;
}

test('aceita telefones brasileiros com 12 ou 13 dígitos', () => {
    assert.equal(normalizeBrazilianCaptainAccount('55 82 1234-5678'), '558212345678');
    assert.equal(normalizeBrazilianCaptainAccount('55 11 91234-5678'), '5511912345678');
});

test('recusa telefone sem DDI brasileiro ou com tamanho inválido', () => {
    assert.throws(
        () => normalizeBrazilianCaptainAccount('11912345678'),
        (error) => error.code === 'invalid_brazil_phone'
    );
    assert.throws(
        () => normalizeBrazilianCaptainAccount('55119999'),
        (error) => error.code === 'invalid_brazil_phone'
    );
});

test('captain_only não pode ocultar personagem principal diferente', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await assert.rejects(
        registerSquadCaptainSafely(db, {
            phone: '5511999999999',
            squad: 'veu_negro',
            captainName: 'Sousoke Aizen',
            mode: 'captain_only',
            assignedBy: ADMIN,
            apply: false,
        }),
        (error) => error.code === 'captain_only_account_has_main_character'
    );

    const profilesExist = await tableExists(db, 'clover_captain_profiles');
    const stored = profilesExist
        ? await db.get('SELECT * FROM clover_captain_profiles LIMIT 1')
        : undefined;
    assert.equal(stored, undefined);
});

test('captain_only continua permitido quando a conta ainda não existe', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const result = await registerSquadCaptainSafely(db, {
        phone: '5582999999999',
        squad: 'veu_negro',
        captainName: 'Sousoke Aizen',
        mode: 'captain_only',
        assignedBy: ADMIN,
        apply: false,
    });

    assert.equal(result.applied, false);
    assert.equal(result.plan.willCreateCaptainOnlyAccount, true);
});
