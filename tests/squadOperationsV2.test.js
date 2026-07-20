'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    ensureCloverInventorySchema,
    ensureCloverRaidSchema,
    ensureCloverSquadSchema,
    ensureCloverYullsLedgerSchema,
} = require('../database');
const {
    assignAccessRole,
    ensureAccessControlSchema,
} = require('../helpers/clover/accessControlService');
const {
    createRaid,
    joinRaid,
} = require('../helpers/clover/raidService');
const {
    getSquadMemberDirectory,
} = require('../helpers/clover/siteSquadMemberService');
const {
    getSquadOperations,
} = require('../helpers/clover/siteSquadOperationsService');

const IDS = Object.freeze({
    narrator: '5511111111111@s.whatsapp.net',
    captain: '5522222222222@s.whatsapp.net',
    vice: '5533333333333@s.whatsapp.net',
    member: '5544444444444@s.whatsapp.net',
    outsider: '5555555555555@s.whatsapp.net',
});

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-', display_name TEXT DEFAULT '-', personagem_nome TEXT DEFAULT '-',
            personagem_idade INTEGER DEFAULT NULL, personagem_genero TEXT DEFAULT '-',
            personagem_aparencia TEXT DEFAULT '-', personagem_aparencia_status TEXT DEFAULT 'approved',
            personagem_aparencia_image_path TEXT DEFAULT NULL,
            site_profile_image_data TEXT DEFAULT NULL,
            reino TEXT DEFAULT 'Clover', classe TEXT DEFAULT '-', familia TEXT DEFAULT '-', raca TEXT DEFAULT 'Humano',
            grimorio TEXT DEFAULT '-', magia TEXT DEFAULT '-', formas TEXT DEFAULT '-', esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0, patente TEXT DEFAULT '-', aptidao_comum TEXT DEFAULT '-',
            aptidao_rara TEXT DEFAULT '-', marca_comum TEXT DEFAULT '-', marca_rara TEXT DEFAULT '-',
            anomalia TEXT DEFAULT '-', gancho_narrativo TEXT DEFAULT '-', jogo_status TEXT DEFAULT 'liberado',
            ficha_status TEXT DEFAULT 'aprovada', dinheiro INTEGER DEFAULT 0
        );
        INSERT INTO jogadores
            (id, personagem_nome, esquadrao, magia, grimorio, patente, estrelas, site_profile_image_data)
        VALUES
            ('${IDS.narrator}', 'Narrador', '-', 'Registro', 'Comum', 'Narrador', 0, NULL),
            ('${IDS.captain}', 'Capitã Magenta', 'Coringas Magenta', 'Vetor', 'Trevo', 'Capitã', 8, 'data:image/png;base64,AAA'),
            ('${IDS.vice}', 'Vice Magenta', 'Coringas Magenta', 'Vidro', 'Trevo', 'Vice-Capitão', 5, NULL),
            ('${IDS.member}', 'Membro Magenta', 'Coringas Magenta', 'Fogo', 'Trevo', 'Cavaleiro', 3, NULL),
            ('${IDS.outsider}', 'Membro Verde', 'Asas Verdes', 'Água', 'Trevo', 'Cavaleiro', 2, NULL);
    `);
    await ensureCloverInventorySchema(db);
    await ensureCloverRaidSchema(db);
    await ensureCloverYullsLedgerSchema(db);
    await ensureCloverSquadSchema(db);
    await ensureAccessControlSchema(db);
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, phrase, captain_player_id, vice_captain_player_id,
          historical_stars, current_stars, black_stars)
         VALUES
         ('coringas_magenta', 'Coringas Magenta', 'O jogo nunca termina.', ?, ?, 20, 15, 2),
         ('asas_verdes', 'Asas Verdes', NULL, NULL, NULL, 4, 4, 0)`,
        [IDS.captain, IDS.vice]
    );
    await assignAccessRole(db, {
        subjectId: IDS.narrator,
        role: 'narrator',
        assignedBy: IDS.narrator,
        reason: 'teste do painel de esquadrão',
    });
    return db;
}

async function seedOperations(db) {
    const mission = await createRaid(db, IDS.narrator, {
        name: 'Operação Magenta',
        category: 'missao_esquadrao',
        scopeSquadKey: 'Coringas Magenta',
        maxPlayers: 6,
    });
    const training = await createRaid(db, IDS.narrator, {
        name: 'Treino do Coringa',
        category: 'treino_esquadrao',
        scopeSquadKey: 'coringas_magenta',
        maxPlayers: 8,
    });
    await joinRaid(db, mission.raid.key, IDS.member);
    await db.run(
        `UPDATE clover_raid_participants SET status = 'completed'
         WHERE player_id = ? AND raid_id = ?`,
        [IDS.member, mission.raid.id]
    );
    await db.run(
        `INSERT INTO clover_squad_star_ledger
         (squad_key, player_id, amount, kind, source, reason, created_by)
         VALUES ('coringas_magenta', ?, 2, 'ganho', 'missao_esquadrao',
                 'Missão concluída', ?)`,
        [IDS.member, IDS.narrator]
    );
    return { mission, training };
}

test('membro consulta o estado operacional do próprio esquadrão', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await seedOperations(db);

    const operations = await getSquadOperations(db, {
        actorId: IDS.member,
        squadInput: 'Coringas Magenta',
    });

    assert.equal(operations.ok, true);
    assert.equal(operations.actor.role, 'member');
    assert.equal(operations.actor.roleLabel, 'Membro');
    assert.equal(operations.actor.canOrganize, false);
    assert.equal(operations.squad.stars.current, 15);
    assert.equal(operations.squad.stars.historical, 20);
    assert.equal(operations.squad.leadership.captain.name, 'Capitã Magenta');
    assert.equal(operations.squad.leadership.vice.name, 'Vice Magenta');
    assert.equal(operations.monthly.length, 2);
    assert.equal(operations.monthly.find((entry) => entry.key === 'missao_esquadrao').used, 1);
    assert.equal(operations.monthly.find((entry) => entry.key === 'treino_esquadrao').used, 1);
    assert.equal(operations.recentRaids.length, 2);
    assert.equal(operations.starHistory[0].reason, 'Missão concluída');
    assert.equal(operations.participation.total, 1);
    assert.equal(operations.participation.completed, 1);
    assert.equal(operations.participation.thisMonth, 1);
});

test('capitão recebe leitura de liderança e organização', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const operations = await getSquadOperations(db, {
        actorId: IDS.captain,
        squadInput: 'coringas_magenta',
    });

    assert.equal(operations.ok, true);
    assert.equal(operations.actor.role, 'captain');
    assert.equal(operations.actor.roleLabel, 'Capitão');
    assert.equal(operations.actor.isLeadership, true);
    assert.equal(operations.actor.canOrganize, true);
});

test('membro comum não consulta outro esquadrão', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const operations = await getSquadOperations(db, {
        actorId: IDS.outsider,
        squadInput: 'Coringas Magenta',
    });
    assert.equal(operations.ok, false);
    assert.equal(operations.code, 'forbidden');
});

test('diretório do próprio esquadrão é visível e ordena a liderança', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const directory = await getSquadMemberDirectory(db, {
        actorId: IDS.member,
        squadInput: 'Coringas Magenta',
    });

    assert.equal(directory.ok, true);
    assert.equal(directory.memberCount, 3);
    assert.deepEqual(
        directory.members.map((member) => member.leadership),
        ['Capitão', 'Vice-Capitão', null]
    );
    assert.equal(directory.members[0].playerId, IDS.captain);
    assert.equal(directory.members[0].image, 'data:image/png;base64,AAA');
});
