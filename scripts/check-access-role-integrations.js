'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { ensureCloverSquadSchema } = require('../database');
const {
    assignAccessRole,
    revokeAccessRole,
} = require('../helpers/clover/accessRoleAssignmentService');
const {
    ACCESS_PERMISSIONS,
    authorizeCharacterCommandAccess,
    authorizeSquadAccess,
} = require('../helpers/clover/accessIntegrationService');
const { listActiveAccessRoles } = require('../helpers/clover/accessControlService');
const {
    canManageSquadUpgrade,
    purchaseSquadUpgrade,
} = require('../helpers/clover/squadUpgradeService');
const { getIntegratedSquadState } = require('../helpers/clover/squadStateIntegrationService');
const profileCommand = require('../comandos/perfil');
const capacityCommand = require('../comandos/capacidade');
const grimoireCommand = require('../comandos/grimorio');
const spellCommand = require('../comandos/feitico');

const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'access-role-integrations');
const OWNER = '557998868223@s.whatsapp.net';
const NARRATOR = '5511000000001@s.whatsapp.net';
const EVALUATOR = '5511000000002@s.whatsapp.net';
const CAPTAIN_OLD = '5511000000003@s.whatsapp.net';
const CAPTAIN_NEW = '5511000000004@s.whatsapp.net';
const VICE = '5511000000005@s.whatsapp.net';
const MEMBER_A = '5511000000010@s.whatsapp.net';
const MEMBER_B = '5511000000011@s.whatsapp.net';
const OUTSIDER = '5511000000012@s.whatsapp.net';

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0,
            patente TEXT DEFAULT '-',
            jogo_status TEXT DEFAULT 'liberado',
            ficha_status TEXT DEFAULT 'aprovada'
        )
    `);
    await ensureCloverSquadSchema(db);
    await db.run(`
        INSERT INTO clover_squads
        (squad_key, name, historical_stars, current_stars, black_stars)
        VALUES ('touros_negros', 'Touros Negros', 37, 30, 0)
    `);
    await db.run(`
        INSERT INTO clover_squads
        (squad_key, name, historical_stars, current_stars, black_stars)
        VALUES ('aguias_prateadas', 'Águias Prateadas', 60, 20, 1)
    `);

    const players = [
        [NARRATOR, 'Narrador', '-'],
        [EVALUATOR, 'Avaliador', '-'],
        [CAPTAIN_OLD, 'Capitão Antigo', 'Touros Negros'],
        [CAPTAIN_NEW, 'Capitão Novo', 'Touros Negros'],
        [VICE, 'Vice', 'Touros Negros'],
        [MEMBER_A, 'Membro A', 'Touros Negros'],
        [MEMBER_B, 'Membro B', 'Águias Prateadas'],
        [OUTSIDER, 'Sem Cargo', '-'],
    ];
    for (const [id, name, squad] of players) {
        await db.run(
            `INSERT INTO jogadores
             (id, nome, display_name, personagem_nome, esquadrao, estrelas, patente)
             VALUES (?, ?, ?, ?, ?, 0, 'Cavaleiro Mágico')`,
            [id, name, name, name, squad]
        );
    }
    return db;
}

function player(id, squad) {
    return { id, personagem_nome: id, esquadrao: squad };
}

function assertClean(text, label) {
    assert.strictEqual(typeof text, 'string', `${label} não retornou texto.`);
    assert(!text.includes('undefined'), `${label} contém undefined.`);
    assert(!text.includes('[object Object]'), `${label} contém objeto cru.`);
    assert(text.length < 4096, `${label} ultrapassou 4096 caracteres.`);
}

async function main() {
    const db = await createDb();
    try {
        await assignAccessRole(db, {
            subjectId: NARRATOR,
            role: 'narrador',
            assignedBy: OWNER,
        });
        await assignAccessRole(db, {
            subjectId: EVALUATOR,
            role: 'avaliador',
            assignedBy: OWNER,
        });
        await assignAccessRole(db, {
            subjectId: CAPTAIN_OLD,
            role: 'capitao',
            scopeKey: 'Touros Negros',
            assignedBy: OWNER,
            metadata: { scope_label: 'Touros Negros' },
        });
        await assignAccessRole(db, {
            subjectId: VICE,
            role: 'vice',
            scopeKey: 'Touros Negros',
            assignedBy: OWNER,
            metadata: { scope_label: 'Touros Negros' },
        });

        let squad = await db.get("SELECT * FROM clover_squads WHERE squad_key = 'touros_negros'");
        assert.strictEqual(squad.captain_player_id, CAPTAIN_OLD);
        assert.strictEqual(squad.captain_name, 'Capitão Antigo');
        assert.strictEqual(squad.vice_captain_player_id, VICE);
        assert.strictEqual((await canManageSquadUpgrade({ actorId: CAPTAIN_OLD, squad })).ok, true);
        assert.strictEqual((await canManageSquadUpgrade({ actorId: VICE, squad })).ok, true);

        const replacement = await assignAccessRole(db, {
            subjectId: CAPTAIN_NEW,
            role: 'capitao',
            scopeKey: 'Touros Negros',
            assignedBy: OWNER,
            metadata: { scope_label: 'Touros Negros' },
        });
        assert.strictEqual(replacement.ok, true);
        assert.strictEqual(replacement.replaced.length, 1);
        squad = await db.get("SELECT * FROM clover_squads WHERE squad_key = 'touros_negros'");
        assert.strictEqual(squad.captain_player_id, CAPTAIN_NEW);
        assert.strictEqual(squad.captain_name, 'Capitão Novo');
        assert.strictEqual((await canManageSquadUpgrade({ actorId: CAPTAIN_NEW, squad })).code, 'captain');
        assert.strictEqual((await canManageSquadUpgrade({ actorId: CAPTAIN_OLD, squad })).ok, false);

        const oldCaptainRoles = await listActiveAccessRoles(db, { subjectId: CAPTAIN_OLD });
        assert.strictEqual(oldCaptainRoles.length, 0);

        const narratorProfile = await authorizeCharacterCommandAccess({
            db,
            actorId: NARRATOR,
            targetPlayer: player(MEMBER_B, 'Águias Prateadas'),
            permission: ACCESS_PERMISSIONS.PROFILE_READ,
            allowLegacyAdmin: false,
        });
        const narratorGrimoire = await authorizeCharacterCommandAccess({
            db,
            actorId: NARRATOR,
            targetPlayer: player(MEMBER_B, 'Águias Prateadas'),
            permission: ACCESS_PERMISSIONS.GRIMOIRE_READ,
            allowLegacyAdmin: false,
        });
        const narratorTechnical = await authorizeCharacterCommandAccess({
            db,
            actorId: NARRATOR,
            targetPlayer: player(MEMBER_B, 'Águias Prateadas'),
            permission: ACCESS_PERMISSIONS.GRIMOIRE_TECHNICAL,
            allowLegacyAdmin: false,
        });
        assert.strictEqual(narratorProfile.ok, true);
        assert.strictEqual(narratorGrimoire.ok, true);
        assert.strictEqual(narratorTechnical.ok, false);

        const evaluatorCapacity = await authorizeCharacterCommandAccess({
            db,
            actorId: EVALUATOR,
            targetPlayer: player(MEMBER_B, 'Águias Prateadas'),
            permission: ACCESS_PERMISSIONS.CAPACITY_TECHNICAL,
            allowLegacyAdmin: false,
        });
        const evaluatorSpell = await authorizeCharacterCommandAccess({
            db,
            actorId: EVALUATOR,
            targetPlayer: player(MEMBER_A, 'Touros Negros'),
            permission: ACCESS_PERMISSIONS.GRIMOIRE_TECHNICAL,
            allowLegacyAdmin: false,
        });
        assert.strictEqual(evaluatorCapacity.ok, true);
        assert.strictEqual(evaluatorSpell.ok, true);

        const captainOwnMember = await authorizeCharacterCommandAccess({
            db,
            actorId: CAPTAIN_NEW,
            targetPlayer: player(MEMBER_A, 'Touros Negros'),
            permission: ACCESS_PERMISSIONS.CAPACITY_READ,
            allowLegacyAdmin: false,
        });
        const captainOtherMember = await authorizeCharacterCommandAccess({
            db,
            actorId: CAPTAIN_NEW,
            targetPlayer: player(MEMBER_B, 'Águias Prateadas'),
            permission: ACCESS_PERMISSIONS.CAPACITY_READ,
            allowLegacyAdmin: false,
        });
        const captainTechnical = await authorizeCharacterCommandAccess({
            db,
            actorId: CAPTAIN_NEW,
            targetPlayer: player(MEMBER_A, 'Touros Negros'),
            permission: ACCESS_PERMISSIONS.CAPACITY_TECHNICAL,
            allowLegacyAdmin: false,
        });
        assert.strictEqual(captainOwnMember.ok, true);
        assert.strictEqual(captainOtherMember.ok, false);
        assert.strictEqual(captainTechnical.ok, false);

        const selfTechnical = await authorizeCharacterCommandAccess({
            db,
            actorId: MEMBER_A,
            targetPlayer: player(MEMBER_A, 'Touros Negros'),
            permission: ACCESS_PERMISSIONS.CAPACITY_TECHNICAL,
            allowLegacyAdmin: false,
        });
        assert.strictEqual(selfTechnical.code, 'self');

        const narratorOtherSquad = await authorizeSquadAccess(db, {
            actorId: NARRATOR,
            squad: { squad_key: 'aguias_prateadas' },
            permission: ACCESS_PERMISSIONS.SQUAD_STATE_READ,
        });
        const captainManageOwn = await authorizeSquadAccess(db, {
            actorId: CAPTAIN_NEW,
            squad,
            permission: ACCESS_PERMISSIONS.SQUAD_UPGRADES_MANAGE,
            allowMemberRead: false,
        });
        const captainManageOther = await authorizeSquadAccess(db, {
            actorId: CAPTAIN_NEW,
            squad: { squad_key: 'aguias_prateadas' },
            permission: ACCESS_PERMISSIONS.SQUAD_UPGRADES_MANAGE,
            allowMemberRead: false,
        });
        const memberReadOwn = await authorizeSquadAccess(db, {
            actorId: MEMBER_A,
            squad,
            permission: ACCESS_PERMISSIONS.SQUAD_STATE_READ,
        });
        const outsiderRead = await authorizeSquadAccess(db, {
            actorId: OUTSIDER,
            squad,
            permission: ACCESS_PERMISSIONS.SQUAD_STATE_READ,
        });
        assert.strictEqual(narratorOtherSquad.ok, true);
        assert.strictEqual(captainManageOwn.ok, true);
        assert.strictEqual(captainManageOther.ok, false);
        assert.strictEqual(memberReadOwn.code, 'own_squad');
        assert.strictEqual(outsiderRead.ok, false);

        const mural = await purchaseSquadUpgrade(db, squad, 'mural_meritos', { purchasedBy: CAPTAIN_NEW });
        const watch = await purchaseSquadUpgrade(db, squad, 'posto_vigilancia', { purchasedBy: CAPTAIN_NEW });
        assert.strictEqual(mural.ok, true);
        assert.strictEqual(watch.ok, true);

        const integratedState = await getIntegratedSquadState(db, squad);
        assert.strictEqual(integratedState.structure.registered, true);
        assert.strictEqual(integratedState.structure.count, 2);
        assert.strictEqual(integratedState.structure.sectorCount, 1);
        assert(integratedState.structure.upgrades.includes('Mural de Méritos do Esquadrão'));
        assert(integratedState.structure.description.includes('Posto de Vigilância do QG'));
        assert(integratedState.overallReading.includes('2 benfeitoria(s) ativa(s)'));

        const revocation = await revokeAccessRole(db, {
            subjectId: CAPTAIN_NEW,
            role: 'capitao',
            scopeKey: 'Touros Negros',
            revokedBy: OWNER,
        });
        assert.strictEqual(revocation.ok, true);
        squad = await db.get("SELECT * FROM clover_squads WHERE squad_key = 'touros_negros'");
        assert.strictEqual(squad.captain_player_id, null);
        assert.strictEqual(squad.captain_name, null);
        assert.strictEqual((await canManageSquadUpgrade({ actorId: CAPTAIN_NEW, squad })).ok, false);

        assert.strictEqual(profileCommand.resolveViewMode('completo'), 'full');
        assert.strictEqual(capacityCommand.parseMode('.#capacidade', `@${MEMBER_A.split('@')[0]}`).technical, false);
        assert.strictEqual(capacityCommand.parseMode('.#capacidade técnica', '').technical, true);
        assert.strictEqual(typeof grimoireCommand.resolveGrimoireRequest, 'function');
        assert.strictEqual(typeof spellCommand.resolveSpellView, 'function');

        const report = {
            leadership: {
                replacementCount: replacement.replaced.length,
                captainAfterReplacement: CAPTAIN_NEW,
                captainAfterRevocation: squad.captain_player_id,
            },
            access: {
                narratorGeneral: narratorProfile.ok && narratorGrimoire.ok,
                narratorTechnical: narratorTechnical.ok,
                evaluatorTechnical: evaluatorCapacity.ok && evaluatorSpell.ok,
                captainOwnSquad: captainOwnMember.ok,
                captainOtherSquad: captainOtherMember.ok,
                captainTechnical: captainTechnical.ok,
                memberOwnSquad: memberReadOwn.ok,
                outsiderSquad: outsiderRead.ok,
            },
            structure: integratedState.structure,
        };
        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        const summary = [
            '♧┃INTEGRAÇÃO DE CARGOS 𖥔 CLOVER MULTICOLOR',
            '',
            '> Narrador: leitura geral global; sem ficha técnica.',
            '> Avaliador: leitura geral e técnica global.',
            '> Capitão/Vice: leitura e gestão dentro do próprio esquadrão.',
            '> Membro: leitura do próprio personagem e do próprio esquadrão.',
            '> Liderança do cargo sincronizada com o QG.',
            `> Estrutura detectada: ${integratedState.structure.description}`,
        ].join('\n');
        assertClean(summary, 'summary');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'resumo.txt'), `${summary}\n`, 'utf8');

        console.log('✓ Narrador com leitura geral global e sem visão técnica');
        console.log('✓ Avaliador com capacidade e feitiço técnicos');
        console.log('✓ Capitão e Vice isolados no próprio esquadrão');
        console.log('✓ substituição e revogação sincronizam a liderança do QG');
        console.log('✓ estado do esquadrão lê benfeitorias reais');
        console.log('✓ comandos expõem os novos caminhos de consulta');
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
