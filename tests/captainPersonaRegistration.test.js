'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureCloverSquadSchema } = require('../database');
const { ensureAccessControlSchema } = require('../helpers/clover/accessControlService');
const {
    ensureCaptainPersonaSchema,
    listAccountPersonas,
    readCaptainProfile,
    registerSquadCaptain,
} = require('../helpers/clover/captainPersonaService');
const { readLeader } = require('../helpers/clover/siteSquadOperationsService');

const ADMIN = '557999999999@s.whatsapp.net';
const EXISTING = '557988888888@s.whatsapp.net';
const AIZEN_PHONE = '557977777777';

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
            ficha_status TEXT DEFAULT 'incompleta',
            jogo_status TEXT DEFAULT 'bloqueado',
            estrelas INTEGER DEFAULT 0
        );
        CREATE TABLE clover_character_stats (
            player_id TEXT PRIMARY KEY,
            distribution_status TEXT DEFAULT NULL
        );
        INSERT INTO jogadores
        (id, nome, display_name, personagem_nome, esquadrao, patente, magia, grimorio,
         ficha_status, jogo_status)
        VALUES
        ('${EXISTING}', 'Conta Outis', 'Conta Outis', 'Personagem Principal', 'Outro Esquadrao',
         'Cavaleiro', 'Água', 'Trevo de 3 folhas', 'aprovada', 'liberado');
    `);
    await ensureCloverSquadSchema(db);
    await ensureAccessControlSchema(db);
    await ensureCaptainPersonaSchema(db);
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, current_stars, historical_stars)
         VALUES ('trevos_da_esperanca', 'Trevos da Esperança', 0, 0)`
    );
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, current_stars, historical_stars)
         VALUES ('veu_negro', 'Véu Negro', 0, 0)`
    );
    return db;
}

test('main_plus_captain preserva personagem principal e cria persona separada', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const result = await registerSquadCaptain(db, {
        phone: '557988888888',
        squad: 'trevos_da_esperanca',
        captainName: 'Outis Vermilion',
        mode: 'main_plus_captain',
        assignedBy: ADMIN,
        profile: {
            magic: 'Magia Feral',
            grimoire: 'Trevo de 3 folhas',
            race: 'Humana',
            className: 'Bruxa',
        },
        apply: true,
    });

    assert.equal(result.applied, true);
    assert.equal(result.account.created, false);
    assert.equal(result.account.mainCharacterPreserved, true);
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [EXISTING]);
    assert.equal(player.personagem_nome, 'Personagem Principal');
    assert.equal(player.esquadrao, 'Outro Esquadrao');

    const profile = await readCaptainProfile(db, {
        accountPlayerId: EXISTING,
        squadKey: 'trevos_da_esperanca',
    });
    assert.equal(profile.characterName, 'Outis Vermilion');
    assert.equal(profile.magic, 'Magia Feral');

    const personas = await listAccountPersonas(db, EXISTING);
    assert.deepEqual(personas.map((persona) => persona.kind), ['main', 'captain']);
    assert.equal(personas[0].characterName, 'Personagem Principal');
    assert.equal(personas[1].characterName, 'Outis Vermilion');

    const leader = await readLeader(db, EXISTING, null, { squadKey: 'trevos_da_esperanca' });
    assert.equal(leader.name, 'Outis Vermilion');
    assert.equal(leader.magic, 'Magia Feral');

    const role = await db.get(
        `SELECT * FROM clover_access_roles
         WHERE subject_id = ? AND role_key = 'captain' AND scope_key = 'trevos_da_esperanca'`,
        [EXISTING]
    );
    assert.equal(role.status, 'active');
});

test('captain_only cria conta-base de Aizen e expõe somente a persona de Capitão', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const result = await registerSquadCaptain(db, {
        phone: AIZEN_PHONE,
        squad: 'veu_negro',
        captainName: 'Sousoke Aizen',
        mode: 'captain_only',
        assignedBy: ADMIN,
        profile: {
            magic: 'Magia da Escuridão',
            grimoire: 'Trevo de 3 folhas',
            race: 'Humano',
            className: 'Nobre',
            kingdom: 'Clover',
            age: 27,
        },
        apply: true,
    });

    assert.equal(result.account.created, true);
    const player = await db.get('SELECT * FROM jogadores WHERE id = ?', [result.account.playerId]);
    assert.equal(player.personagem_nome, 'Sousoke Aizen');
    assert.equal(player.esquadrao, 'Véu Negro');
    assert.equal(player.patente, 'Capitão');

    const personas = await listAccountPersonas(db, result.account.playerId);
    assert.equal(personas.length, 1);
    assert.equal(personas[0].kind, 'captain');
    assert.equal(personas[0].characterName, 'Sousoke Aizen');
    assert.equal(personas[0].isDefault, true);
});

test('cadastro é dry-run por padrão e não altera cargo ou esquadrão', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const preview = await registerSquadCaptain(db, {
        phone: '557988888888',
        squad: 'trevos_da_esperanca',
        captainName: 'Outis Vermilion',
        mode: 'main_plus_captain',
        assignedBy: ADMIN,
    });
    assert.equal(preview.applied, false);
    assert.equal(preview.plan.preserveMainCharacter, true);
    assert.equal(await db.get('SELECT * FROM clover_captain_profiles LIMIT 1'), undefined);
    const squad = await db.get("SELECT captain_player_id FROM clover_squads WHERE squad_key = 'trevos_da_esperanca'");
    assert.equal(squad.captain_player_id, null);
});
