'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    ensureCloverInventorySchema,
    ensureCloverRaidSchema,
    ensureCloverSquadSchema,
} = require('../database');
const {
    assignAccessRole,
    ensureAccessControlSchema,
} = require('../helpers/clover/accessControlService');
const { ensureRaidV2Schema } = require('../helpers/clover/raidV2Schema');
const { prepareCanonicalRaidSchema } = require('./helpers/canonicalRaidSchemaFixture');
const { getSquadMemberDirectory } = require('../helpers/clover/siteSquadMemberService');
const { getSquadOperations } = require('../helpers/clover/siteSquadOperationsService');

const IDS = {
    captain: '5511111111111@s.whatsapp.net',
    member: '5522222222222@s.whatsapp.net',
    outsider: '5533333333333@s.whatsapp.net',
    admin: '5544444444444@s.whatsapp.net',
};

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            personagem_idade INTEGER DEFAULT NULL,
            personagem_genero TEXT DEFAULT '-',
            personagem_aparencia TEXT DEFAULT '-',
            personagem_aparencia_status TEXT DEFAULT 'approved',
            personagem_aparencia_image_path TEXT DEFAULT NULL,
            site_profile_image_data TEXT DEFAULT NULL,
            reino TEXT DEFAULT 'Clover',
            classe TEXT DEFAULT '-',
            familia TEXT DEFAULT '-',
            raca TEXT DEFAULT 'Humano',
            grimorio TEXT DEFAULT '-',
            magia TEXT DEFAULT '-',
            formas TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            patente TEXT DEFAULT '-',
            aptidao_comum TEXT DEFAULT '-',
            aptidao_rara TEXT DEFAULT '-',
            marca_comum TEXT DEFAULT '-',
            marca_rara TEXT DEFAULT '-',
            anomalia TEXT DEFAULT '-',
            gancho_narrativo TEXT DEFAULT '-',
            ficha_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado',
            dinheiro INTEGER DEFAULT 0
        );
        INSERT INTO jogadores
            (id, personagem_nome, esquadrao, estrelas, patente, magia, grimorio, site_profile_image_data)
        VALUES
            ('${IDS.captain}', 'Capitã Rubra', 'Coringas Magenta', 8, 'Cavaleiro Sênior', 'Magia de Fogo', 'Grimório de Trevo', 'data:image/jpeg;base64,abc'),
            ('${IDS.member}', 'Membro Um', 'Coringas Magenta', 3, 'Cavaleiro Júnior', 'Magia de Vento', 'Grimório de Trevo', NULL),
            ('${IDS.outsider}', 'Forasteiro', 'Asas Verdes', 2, 'Cavaleiro Júnior', 'Magia de Água', 'Grimório de Trevo', NULL),
            ('${IDS.admin}', 'Administrador', '-', 0, '-', 'Registro', 'Comum', NULL);
    `);

    await prepareCanonicalRaidSchema(db);
    await ensureAccessControlSchema(db);

    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, phrase, captain_name, captain_player_id,
          historical_stars, current_stars, black_stars)
         VALUES ('coringas_magenta', 'Coringas Magenta', 'Rir diante do impossível',
                 'Capitã Rubra', ?, 31, 14, 1)`,
        [IDS.captain]
    );
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, historical_stars, current_stars, black_stars)
         VALUES ('asas_verdes', 'Asas Verdes', 10, 4, 0)`
    );

    await assignAccessRole(db, {
        subjectId: IDS.admin,
        role: 'admin',
        assignedBy: IDS.admin,
        reason: 'teste do painel operacional',
    });

    await db.run(
        `INSERT INTO clover_raids
         (raid_key, name, category, category_key, category_label, description,
          location, status, owner_player_id, max_players, salary_eligible,
          scope_type, scope_squad_key, month_key, counts_monthly, monthly_limit,
          created_at, updated_at)
         VALUES
         ('RAID-SQUAD-1', 'Operação Magenta', 'missao_esquadrao', 'missao_esquadrao',
          'Missão de esquadrão', 'Operação oficial', 'Capital de Clover', 'completed',
          ?, 12, 1, 'squad', 'coringas_magenta', '2026-07', 1, 2,
          '2026-07-05 12:00:00', '2026-07-05 12:00:00')`,
        [IDS.admin]
    );
    const raid = await db.get(`SELECT id FROM clover_raids WHERE raid_key = 'RAID-SQUAD-1'`);
    await db.run(
        `INSERT INTO clover_raid_participants
         (raid_id, player_id, status, joined_at, joined_via)
         VALUES (?, ?, 'completed', '2026-07-05 12:10:00', 'site')`,
        [raid.id, IDS.member]
    );
    await db.run(
        `INSERT INTO clover_raid_monthly_ledger
         (entry_key, raid_id, category_key, month_key, scope_type, scope_key,
          amount, kind, reason, created_by, created_at)
         VALUES ('raid-completion:test:squad', ?, 'missao_esquadrao', '2026-07',
                 'squad', 'coringas_magenta', 1, 'completion',
                 'Operação concluída', ?, '2026-07-05 15:00:00')`,
        [raid.id, IDS.admin]
    );
    await db.run(
        `INSERT INTO clover_squad_star_ledger
         (squad_key, player_id, amount, kind, source, reason, created_by, created_at)
         VALUES ('coringas_magenta', ?, 2, 'ganho', 'missao_esquadrao',
                 'Operação concluída', ?, '2026-07-05 15:00:00')`,
        [IDS.member, IDS.admin]
    );

    return db;
}

test('membro consulta contador compartilhado, histórico e participação', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const result = await getSquadOperations(db, {
        actorId: IDS.member,
        squadInput: 'Coringas Magenta',
        referenceDate: new Date('2026-07-20T12:00:00-03:00'),
    });

    assert.equal(result.ok, true);
    assert.equal(result.access, 'own_squad');
    assert.equal(result.actor.role, 'member');
    assert.equal(result.squad.name, 'Coringas Magenta');
    assert.equal(result.state.memberCount, 2);
    assert.equal(result.monthKey, '2026-07');
    const mission = result.monthly.find((item) => item.key === 'missao_esquadrao');
    assert.equal(mission.completed, 1);
    assert.equal(mission.reserved, 0);
    assert.equal(mission.used, 1);
    assert.equal(mission.limit, 2);
    assert.equal(mission.remaining, 1);
    assert.equal(mission.exhausted, false);
    assert.equal(result.monthly.find((item) => item.key === 'treino_esquadrao').used, 0);
    assert.equal(result.recentRaids[0].name, 'Operação Magenta');
    assert.equal(result.starHistory[0].playerName, 'Membro Um');
    assert.equal(result.participation.total, 1);
    assert.equal(result.participation.completed, 1);
    assert.equal(result.participation.thisMonth, 1);
});

test('capitão recebe visão de liderança e gerenciamento de benfeitorias', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const result = await getSquadOperations(db, {
        actorId: IDS.captain,
        squadInput: 'coringas_magenta',
        referenceDate: new Date('2026-07-20T12:00:00-03:00'),
    });

    assert.equal(result.actor.role, 'captain');
    assert.equal(result.actor.roleLabel, 'Capitão');
    assert.equal(result.actor.isLeadership, true);
    assert.equal(result.actor.canManageUpgrades, true);
    assert.equal(result.squad.leadership.captain.name, 'Capitã Rubra');
    assert.equal(result.squad.leadership.captain.image, 'data:image/jpeg;base64,abc');
});

test('membro não consulta outro esquadrão, mas administração global consulta', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const denied = await getSquadOperations(db, {
        actorId: IDS.member,
        squadInput: 'Asas Verdes',
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'forbidden');

    const allowed = await getSquadOperations(db, {
        actorId: IDS.admin,
        squadInput: 'Asas Verdes',
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.actor.role, 'administrator');
    assert.equal(allowed.actor.canCreateRaid, true);
});

test('diretório seguro é visível ao próprio membro e preserva imagem compartilhada', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const directory = await getSquadMemberDirectory(db, {
        actorId: IDS.member,
        squadInput: 'Coringas Magenta',
    });

    assert.equal(directory.ok, true);
    assert.equal(directory.access, 'own_squad');
    assert.equal(directory.memberCount, 2);
    assert.equal(directory.members[0].leadership, 'Capitão');
    assert.equal(directory.members[0].image, 'data:image/jpeg;base64,abc');
    assert.equal(Object.hasOwn(directory.members[0], 'id'), false);
});
