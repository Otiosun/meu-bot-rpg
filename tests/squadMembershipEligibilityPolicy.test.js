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
    APPROVED_SHEET_STATUSES,
    RELEASED_GAME_STATUSES,
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
    alias: 'fixture-alias',
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
            ficha_status TEXT DEFAULT 'incompleta',
            jogo_status TEXT DEFAULT 'bloqueado'
        );
        INSERT INTO jogadores
            (id, personagem_nome, esquadrao, ficha_status, jogo_status)
        VALUES
            ('fixture-captain', 'Capitao Teste', 'Esquadrao Teste', 'aprovada', 'liberado'),
            ('fixture-admin', 'Administrador', '-', 'aprovada', 'liberado'),
            ('fixture-approved', 'Candidata Aprovada', '-', 'aprovada', 'liberado'),
            ('fixture-pending', 'Candidata Pendente', '-', 'em analise', 'liberado'),
            ('fixture-alias', 'Candidata Alias', '-', 'confirmada', 'liberada');
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

test('allowlists refletem exatamente a politica comprovada no snapshot', () => {
    assert.deepEqual(APPROVED_SHEET_STATUSES, ['aprovada']);
    assert.deepEqual(RELEASED_GAME_STATUSES, ['liberado']);
});

test('regra pura exige personagem, ficha aprovada e jogo liberado', () => {
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
        ficha_status: 'aprovada',
        jogo_status: 'liberado',
    }).ok, true);
});

test('aliases não comprovados permanecem bloqueados', () => {
    for (const ficha_status of ['confirmada', 'confirmado', 'aprovado']) {
        assert.equal(squadMembershipEligibility({
            personagem_nome: 'Teste',
            ficha_status,
            jogo_status: 'liberado',
        }).code, 'sheet_not_approved');
    }
    assert.equal(squadMembershipEligibility({
        personagem_nome: 'Teste',
        ficha_status: 'aprovada',
        jogo_status: 'liberada',
    }).code, 'game_not_released');
});

test('busca expõe status e motivo preciso de bloqueio', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const pending = await searchSquadMemberCandidates(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        query: 'Pendente',
    });
    assert.equal(pending.candidates[0].eligible, false);
    assert.equal(pending.candidates[0].blockedReason, 'sheet_not_approved');
    assert.equal(pending.candidates[0].sheetStatus, 'em analise');
    assert.equal(pending.candidates[0].gameStatus, 'liberado');

    const alias = await searchSquadMemberCandidates(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        query: 'Alias',
    });
    assert.equal(alias.candidates[0].eligible, false);
    assert.equal(alias.candidates[0].blockedReason, 'sheet_not_approved');
});

test('chamada direta revalida estado fresco dentro da transação', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await assert.rejects(
        () => addSquadMember(db, {
            actorId: IDS.captain,
            squadInput: 'esquadrao_teste',
            characterId: IDS.pending,
        }),
        (error) => error?.code === 'sheet_not_approved'
            && error?.details?.policy?.approvedSheetStatuses?.[0] === 'aprovada'
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

    const membership = await db.get(
        'SELECT metadata_json FROM clover_squad_memberships WHERE player_id = ? AND status = ?',
        [IDS.pending, 'active']
    );
    const metadata = JSON.parse(membership.metadata_json);
    assert.deepEqual(metadata.eligibility_policy, {
        sheet_status: 'aprovada',
        game_status: 'liberado',
    });
});

test('candidato aprovado e liberado é elegível e entrada é idempotente', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const search = await searchSquadMemberCandidates(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        query: 'Aprovada',
    });
    assert.equal(search.candidates[0].eligible, true);
    assert.equal(search.candidates[0].blockedReason, null);

    const first = await addSquadMember(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        characterId: IDS.approved,
    });
    const second = await addSquadMember(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        characterId: IDS.approved,
    });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);

    const current = await searchSquadMemberCandidates(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        query: 'Aprovada',
    });
    assert.equal(current.candidates[0].eligible, false);
    assert.equal(current.candidates[0].blockedReason, 'already_in_target_squad');
});

test('membro atual continua removível depois de arquivamento', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await addSquadMember(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        characterId: IDS.approved,
    });
    await db.run(
        'UPDATE jogadores SET ficha_status = ?, jogo_status = ? WHERE id = ?',
        ['arquivada', 'arquivado', IDS.approved]
    );

    const duplicate = await addSquadMember(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        characterId: IDS.approved,
    });
    assert.equal(duplicate.duplicate, true);

    const removed = await removeSquadMember(db, {
        actorId: IDS.captain,
        squadInput: 'esquadrao_teste',
        characterId: IDS.approved,
        reason: 'Ficha arquivada pela administracao',
    });
    assert.equal(removed.membership.characterId, IDS.approved);
});
