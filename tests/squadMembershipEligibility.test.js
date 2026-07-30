'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const { ensureCloverSquadSchema } = require('../database');
const {
    assignAccessRole,
    ensureAccessControlSchema,
} = require('../helpers/clover/accessControlService');
const {
    addSquadMember,
    ensureSquadMembershipSchema,
    removeSquadMember,
    searchSquadMemberCandidates,
    squadMembershipEligibility,
} = require('../helpers/clover/squadMembershipService');

const IDS = Object.freeze({
    captain: 'fixture-captain',
    admin: 'fixture-admin',
    approved: 'fixture-approved',
    pending: 'fixture-pending',
});

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            codigo TEXT DEFAULT NULL,
            code TEXT DEFAULT NULL,
            magia TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT '-',
            site_profile_image_data TEXT DEFAULT NULL,
            personagem_aparencia_image_path TEXT DEFAULT NULL,
            ficha_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado'
        );
        INSERT INTO jogadores
            (id, personagem_nome, esquadrao, ficha_status, jogo_status)
        VALUES
            ('fixture-captain', 'Capitao Teste', 'Esquadrao Teste', 'aprovada', 'liberado'),
            ('fixture-admin', 'Administrador', '-', 'aprovada', 'liberado'),
            ('fixture-approved', 'Candidata Aprovada', '-', 'aprovada', 'liberado'),
            ('fixture-pending', 'Candidata Pendente', '-', 'em analise', 'liberado');
    `);
    await ensureCloverSquadSchema(db);
    await ensureAccessControlSchema(db);
    await ensureSquadMembershipSchema(db);
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, captain_player_id)
         VALUES ('esquadrao_teste', 'Esquadrao Teste', ?)`,
        [IDS.captain]
    );
    await assignAccessRole(db, {
        subjectId: IDS.captain,
        role: 'captain',
        scopeKey: 'esquadrao_teste',
        assignedBy: IDS.admin,
        reason: 'fixture',
    });
    return db;
}

test('regra pura bloqueia cadastro incompleto, ficha pendente e jogo nao liberado', () => {
    assert.equal(squadMembershipEligibility({
        personagem_nome: '-',
        ficha_status: 'aprovada',
        jogo_status: 'liberado',
    }).code, 'character_incomplete');
    assert.equal(squadMembershipEligibility({
        personagem_nome: 'Teste',
        ficha_status: 'em analise',
        jogo_status: 'liberado',
    }).code, 'sheet_not_approved');
    assert.equal(squadMembershipEligibility({
        personagem_nome: 'Teste',
        ficha_status: 'aprovada',
        jogo_status: 'pausado',
    }).code, 'game_not_released');
    assert.equal(squadMembershipEligibility({
        personagem_nome: 'Teste',
        ficha_status: 'confirmada',
        jogo_status: 'liberado',
    }).ok, true);
});

test('busca explica bloqueio e escrita revalida o estado', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const result = await searchSquadMemberCandidates(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        query: 'Pendente',
    });
    assert.equal(result.candidates[0].eligible, false);
    assert.equal(result.candidates[0].blockedReason, 'sheet_not_approved');

    await assert.rejects(
        () => addSquadMember(db, {
            actorId: IDS.captain,
            squadInput: 'esquadrao_teste',
            characterId: IDS.pending,
        }),
        (error) => error?.code === 'sheet_not_approved'
    );

    await db.run(
        'UPDATE jogadores SET ficha_status = ?, jogo_status = ? WHERE id = ?',
        ['aprovada', 'pausado', IDS.pending]
    );
    await assert.rejects(
        () => addSquadMember(db, {
            actorId: IDS.captain,
            squadInput: 'esquadrao_teste',
            characterId: IDS.pending,
        }),
        (error) => error?.code === 'game_not_released'
    );

    await db.run(
        'UPDATE jogadores SET jogo_status = ? WHERE id = ?',
        ['liberado', IDS.pending]
    );
    const added = await addSquadMember(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        characterId: IDS.pending,
    });
    assert.equal(added.membership.characterId, IDS.pending);
});

test('membro atual continua removivel mesmo se a ficha for arquivada depois', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await addSquadMember(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        characterId: IDS.approved,
    });
    await db.run(
        'UPDATE jogadores SET ficha_status = ?, jogo_status = ? WHERE id = ?',
        ['arquivada', 'pausado', IDS.approved]
    );

    const result = await searchSquadMemberCandidates(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        query: 'Aprovada',
    });
    assert.equal(result.candidates[0].currentSquad.key, 'esquadrao_teste');

    const removed = await removeSquadMember(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        characterId: IDS.approved,
        reason: 'Ficha arquivada pela administracao',
    });
    assert.equal(removed.membership.characterId, IDS.approved);
});

test('candidato aprovado e liberado permanece elegivel', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const result = await searchSquadMemberCandidates(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        query: 'Aprovada',
    });
    assert.equal(result.candidates[0].eligible, true);
    assert.equal(result.candidates[0].blockedReason, null);
});
