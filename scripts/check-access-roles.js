'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    assignAccessRole,
    authorizeTargetAccess,
    getAccessContext,
    hasAccessPermission,
    listAccessRoleEvents,
    listActiveAccessRoles,
    revokeAccessRole,
} = require('../helpers/clover/accessControlService');
const cargoCommand = require('../comandos/cargo');

const OWNER_ID = '557998868223@s.whatsapp.net';
const NARRATOR_ID = '5511000000001@s.whatsapp.net';
const EVALUATOR_ID = '5511000000002@s.whatsapp.net';
const CAPTAIN_ID = '5511000000003@s.whatsapp.net';
const VICE_ID = '5511000000004@s.whatsapp.net';
const ADMIN_ID = '5511000000005@s.whatsapp.net';
const MEMBER_A = '5511000000010@s.whatsapp.net';
const MEMBER_B = '5511000000011@s.whatsapp.net';
const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'access-roles');

async function createDb() {
    return open({ filename: ':memory:', driver: sqlite3.Database });
}

function target(id, squad) {
    return { id, personagem_nome: `Personagem ${id.slice(-5, -1)}`, esquadrao: squad };
}

function assertClean(text, label) {
    assert.strictEqual(typeof text, 'string', `${label} não retornou texto.`);
    assert(!text.includes('undefined'), `${label} contém undefined.`);
    assert(!text.includes('[object Object]'), `${label} contém objeto cru.`);
    assert(text.length < 4096, `${label} ultrapassou 4096 caracteres: ${text.length}.`);
}

async function main() {
    const db = await createDb();
    try {
        const narrator = await assignAccessRole(db, {
            subjectId: NARRATOR_ID,
            role: 'narrador',
            assignedBy: OWNER_ID,
            reason: 'Teste narrador',
        });
        assert.strictEqual(narrator.ok, true);
        assert.strictEqual(narrator.assignment.scope_type, 'global');
        assert.strictEqual(narrator.assignment.scope_key, '*');

        const narratorDuplicate = await assignAccessRole(db, {
            subjectId: NARRATOR_ID,
            role: 'narrador',
            assignedBy: OWNER_ID,
        });
        assert.strictEqual(narratorDuplicate.code, 'already_active');
        assert.strictEqual(narratorDuplicate.inserted, false);

        const evaluator = await assignAccessRole(db, {
            subjectId: EVALUATOR_ID,
            role: 'avaliador',
            assignedBy: OWNER_ID,
        });
        assert.strictEqual(evaluator.ok, true);

        const captain = await assignAccessRole(db, {
            subjectId: CAPTAIN_ID,
            role: 'capitao',
            scopeKey: 'Touros Negros',
            assignedBy: OWNER_ID,
            metadata: { scope_label: 'Touros Negros' },
        });
        assert.strictEqual(captain.ok, true);
        assert.strictEqual(captain.assignment.scope_type, 'squad');
        assert.strictEqual(captain.assignment.scope_key, 'touros_negros');

        const vice = await assignAccessRole(db, {
            subjectId: VICE_ID,
            role: 'vice',
            scopeKey: 'Touros Negros',
            assignedBy: OWNER_ID,
        });
        assert.strictEqual(vice.ok, true);

        const admin = await assignAccessRole(db, {
            subjectId: ADMIN_ID,
            role: 'admin',
            assignedBy: OWNER_ID,
        });
        assert.strictEqual(admin.ok, true);

        const missingSquad = await assignAccessRole(db, {
            subjectId: CAPTAIN_ID,
            role: 'capitao',
            assignedBy: OWNER_ID,
        });
        assert.strictEqual(missingSquad.code, 'squad_required');

        const selfRead = await authorizeTargetAccess(db, {
            actorId: MEMBER_A,
            targetPlayer: target(MEMBER_A, 'Touros Negros'),
            permission: 'character.read.profile',
        });
        assert.strictEqual(selfRead.ok, true);
        assert.strictEqual(selfRead.code, 'self');

        const ownerRead = await authorizeTargetAccess(db, {
            actorId: OWNER_ID,
            targetPlayer: target(MEMBER_B, 'Águias Prateadas'),
            permission: 'character.read.capacity',
        });
        assert.strictEqual(ownerRead.ok, true);
        assert.strictEqual(ownerRead.code, 'owner');

        const narratorRead = await authorizeTargetAccess(db, {
            actorId: NARRATOR_ID,
            targetPlayer: target(MEMBER_B, 'Águias Prateadas'),
            permission: 'character.read.grimoire',
        });
        assert.strictEqual(narratorRead.ok, true);
        assert.strictEqual(narratorRead.code, 'global_role');

        const captainOwnSquad = await authorizeTargetAccess(db, {
            actorId: CAPTAIN_ID,
            targetPlayer: target(MEMBER_A, 'Touros Negros'),
            permission: 'character.read.capacity',
        });
        assert.strictEqual(captainOwnSquad.ok, true);
        assert.strictEqual(captainOwnSquad.code, 'squad_role');

        const captainOtherSquad = await authorizeTargetAccess(db, {
            actorId: CAPTAIN_ID,
            targetPlayer: target(MEMBER_B, 'Águias Prateadas'),
            permission: 'character.read.capacity',
        });
        assert.strictEqual(captainOtherSquad.ok, false);
        assert.strictEqual(captainOtherSquad.code, 'forbidden');

        const viceOwnSquad = await authorizeTargetAccess(db, {
            actorId: VICE_ID,
            targetPlayer: target(MEMBER_A, 'Touros Negros'),
            permission: 'character.read.progress',
        });
        assert.strictEqual(viceOwnSquad.ok, true);

        assert.strictEqual(await hasAccessPermission(db, EVALUATOR_ID, 'evaluation.apply'), true);
        assert.strictEqual(await hasAccessPermission(db, EVALUATOR_ID, 'roles.manage'), false);
        assert.strictEqual(await hasAccessPermission(db, NARRATOR_ID, 'character.read.private_notes'), false);
        assert.strictEqual(await hasAccessPermission(db, CAPTAIN_ID, 'character.read.private_notes'), false);
        assert.strictEqual(await hasAccessPermission(db, ADMIN_ID, 'character.read.private_notes'), true);

        const narratorContext = await getAccessContext(db, NARRATOR_ID);
        assert.deepStrictEqual(narratorContext.roleKeys, ['narrator']);
        assert(narratorContext.permissions.includes('character.read.capacity'));
        assert(!narratorContext.permissions.includes('evaluation.apply'));

        const revoke = await revokeAccessRole(db, {
            subjectId: CAPTAIN_ID,
            role: 'capitao',
            scopeKey: 'Touros Negros',
            revokedBy: OWNER_ID,
            reason: 'Teste de revogação',
        });
        assert.strictEqual(revoke.ok, true);
        assert.strictEqual(revoke.revoked.length, 1);

        const afterRevoke = await authorizeTargetAccess(db, {
            actorId: CAPTAIN_ID,
            targetPlayer: target(MEMBER_A, 'Touros Negros'),
            permission: 'character.read.capacity',
        });
        assert.strictEqual(afterRevoke.ok, false);

        const events = await listAccessRoleEvents(db, { subjectId: CAPTAIN_ID });
        assert.strictEqual(events.length, 2);
        assert.deepStrictEqual(events.map((event) => event.action), ['revoked', 'assigned']);

        const active = await listActiveAccessRoles(db);
        assert.strictEqual(active.length, 4);
        assert(!active.some((assignment) => assignment.subject_id === CAPTAIN_ID));

        const samplePlayer = target(CAPTAIN_ID, 'Touros Negros');
        assert.deepStrictEqual(cargoCommand.parseRoleRequest('narrador', samplePlayer), {
            ok: true,
            roleKey: 'narrator',
            definition: cargoCommand.parseRoleRequest('narrador', samplePlayer).definition,
            scopeLabel: null,
        });
        const parsedCaptain = cargoCommand.parseRoleRequest('capitao', samplePlayer);
        assert.strictEqual(parsedCaptain.ok, true);
        assert.strictEqual(parsedCaptain.scopeLabel, 'Touros Negros');
        assert.strictEqual(cargoCommand.parseRoleRequest('capitao', target(CAPTAIN_ID, '-')).code, 'squad_required');
        assert.strictEqual(cargoCommand.parseRoleRequest('qualquer', samplePlayer).code, 'unknown_role');
        assert.strictEqual(cargoCommand.splitAction('dar @player narrador').action, 'dar');

        const activeNarrator = active.find((assignment) => assignment.subject_id === NARRATOR_ID);
        const assignmentText = cargoCommand.renderAssignmentResult({
            ok: true,
            code: 'assigned',
            assignment: activeNarrator,
        }, target(NARRATOR_ID, '-'));
        const playerRolesText = cargoCommand.renderPlayerRoles(
            target(NARRATOR_ID, '-'),
            active.filter((assignment) => assignment.subject_id === NARRATOR_ID)
        );
        const listText = cargoCommand.renderAllRoles(active);
        const historyText = cargoCommand.renderRoleHistory(target(CAPTAIN_ID, 'Touros Negros'), events);
        const usageText = cargoCommand.renderUsage();
        for (const [label, output] of Object.entries({ assignmentText, playerRolesText, listText, historyText, usageText })) {
            assertClean(output, label);
        }

        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'cargos-ativos.txt'), `${listText}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'cargo-player.txt'), `${playerRolesText}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'historico-cargo.txt'), `${historyText}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({
            activeRoles: active.map((assignment) => ({
                subjectId: assignment.subject_id,
                roleKey: assignment.role_key,
                scopeType: assignment.scope_type,
                scopeKey: assignment.scope_key,
            })),
            testedAccess: {
                ownerGlobal: ownerRead.ok,
                narratorGlobal: narratorRead.ok,
                captainOwnSquad: captainOwnSquad.ok,
                captainOtherSquad: captainOtherSquad.ok,
                viceOwnSquad: viceOwnSquad.ok,
                evaluatorCanEvaluate: await hasAccessPermission(db, EVALUATOR_ID, 'evaluation.apply'),
                privateNotesNarrator: await hasAccessPermission(db, NARRATOR_ID, 'character.read.private_notes'),
                privateNotesAdmin: await hasAccessPermission(db, ADMIN_ID, 'character.read.private_notes'),
            },
            captainEvents: events.map((event) => event.action),
            outputLengths: {
                list: listText.length,
                player: playerRolesText.length,
                history: historyText.length,
            },
        }, null, 2)}\n`, 'utf8');

        console.log('✓ cargos globais e por esquadrão');
        console.log('✓ duplicidade ativa bloqueada');
        console.log('✓ Capitão e Vice isolados no próprio esquadrão');
        console.log('✓ Narrador com leitura global sem poder de avaliação');
        console.log('✓ Avaliador separado de Narrador');
        console.log('✓ notas privadas restritas a Administrador/Owner');
        console.log('✓ revogação remove acesso imediatamente');
        console.log('✓ histórico de atribuição e revogação');
        console.log('✓ mensagens abaixo de 4096 caracteres');
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});