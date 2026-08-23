'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const {
    ensureCloverInventorySchema,
    ensureCloverRaidSchema,
    ensureCloverSquadSchema,
    ensureCloverYullsLedgerSchema,
} = require('../database');
const {
    CURRENT_SCHEMA_MIGRATIONS,
    RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY,
} = require('../helpers/clover/schemaMigrationCatalog');
const {
    prebootstrapCloverSchemaBeforeLegacy,
} = require('../helpers/clover/schemaBasePrebootstrapService');
const {
    assignAccessRole,
    ensureAccessControlSchema,
} = require('../helpers/clover/accessControlService');
const {
    addRaidReward,
    beginRaidFinalization,
    createRaid,
    completeRaid,
    completeRaidForRewardProposal,
    getRaidFinalizationSummary,
    joinRaid,
    setRaidParticipantFinalization,
    startRaid,
} = require('../helpers/clover/raidService');
const {
    createRaidRewardProposal,
    ensureRaidRewardProposalSchema,
    listRaidRewardProposals,
    reviewRaidRewardProposal,
} = require('../helpers/clover/raidRewardProposalService');
const {
    addSquadMember,
    ensureSquadMembershipSchema,
    removeSquadMember,
    searchSquadMemberCandidates,
} = require('../helpers/clover/squadMembershipService');
const {
    grantSquadStarsInTransaction,
    openSquadSeason,
    purchaseSquadStarsInTransaction,
    readSquadNativeStars,
} = require('../helpers/clover/squadSeasonStarService');
const { getYullsSummary } = require('../helpers/clover/yullsService');

const IDS = Object.freeze({
    captain: 'captain@lid',
    otherCaptain: 'other-captain@lid',
    narrator: 'narrator@lid',
    evaluator: 'evaluator@lid',
    admin: 'admin@lid',
    vice: 'vice@lid',
    member: 'member@lid',
    candidate: 'candidate@lid',
    outsider: 'outsider@lid',
});

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
            historias_extras TEXT DEFAULT '[]',
            ficha_status TEXT DEFAULT 'aprovada',
            jogo_status TEXT DEFAULT 'liberado',
            dinheiro INTEGER DEFAULT 0
        );
        INSERT INTO jogadores (id, personagem_nome, esquadrao, magia) VALUES
            ('${IDS.captain}', 'Capitao Magenta', 'Coringas Magenta', 'Fogo'),
            ('${IDS.otherCaptain}', 'Capitao Verde', 'Asas Verdes', 'Vento'),
            ('${IDS.narrator}', 'Narrador', '-', 'Roteiro'),
            ('${IDS.evaluator}', 'Avaliador', '-', 'Balanca'),
            ('${IDS.admin}', 'Administrador', '-', 'Arquivo'),
            ('${IDS.vice}', 'Vice Magenta', 'Coringas Magenta', 'Nuvem'),
            ('${IDS.member}', 'Membro Magenta', 'Coringas Magenta', 'Agua'),
            ('${IDS.candidate}', 'Candidata Livre', '-', 'Luz'),
            ('${IDS.outsider}', 'Membro Verde', 'Asas Verdes', 'Terra');
    `);
    const prebootstrap = await prebootstrapCloverSchemaBeforeLegacy(db, {
        migrations: CURRENT_SCHEMA_MIGRATIONS,
    });
    assert.equal(prebootstrap.prebootstrappedBeforeLegacy, true);
    assert.equal(prebootstrap.transientMigrations.some((item) => item.key === RAID_REWARD_PROPOSAL_IDEMPOTENCY_KEY), true);
    await ensureCloverInventorySchema(db);
    await ensureCloverRaidSchema(db);
    await ensureCloverYullsLedgerSchema(db);
    await ensureCloverSquadSchema(db);
    await ensureAccessControlSchema(db);
    await ensureSquadMembershipSchema(db);
    await ensureRaidRewardProposalSchema(db);
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, captain_player_id, vice_captain_player_id, current_stars, historical_stars)
         VALUES ('coringas_magenta', 'Coringas Magenta', ?, ?, 0, 0)`,
        [IDS.captain, IDS.vice]
    );
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, captain_player_id, current_stars, historical_stars)
         VALUES ('asas_verdes', 'Asas Verdes', ?, 0, 0)`,
        [IDS.otherCaptain]
    );
    await assignAccessRole(db, {
        subjectId: IDS.captain,
        role: 'captain',
        scopeKey: 'coringas_magenta',
        assignedBy: IDS.admin,
        reason: 'fixture',
    });
    await assignAccessRole(db, {
        subjectId: IDS.vice,
        role: 'vice_captain',
        scopeKey: 'coringas_magenta',
        assignedBy: IDS.admin,
        reason: 'fixture',
    });
    await assignAccessRole(db, {
        subjectId: IDS.otherCaptain,
        role: 'captain',
        scopeKey: 'asas_verdes',
        assignedBy: IDS.admin,
        reason: 'fixture',
    });
    await assignAccessRole(db, {
        subjectId: IDS.narrator,
        role: 'narrator',
        assignedBy: IDS.admin,
        reason: 'fixture',
    });
    await assignAccessRole(db, {
        subjectId: IDS.evaluator,
        role: 'evaluator',
        assignedBy: IDS.admin,
        reason: 'fixture',
    });
    await assignAccessRole(db, {
        subjectId: IDS.admin,
        role: 'admin',
        assignedBy: IDS.admin,
        reason: 'fixture',
    });
    return db;
}

async function preparedProposal(db, rewardAmount = 1000) {
    const created = await createRaid(db, IDS.captain, {
        name: 'Missao Magenta',
        category: 'missao_esquadrao',
        scopeSquadKey: 'coringas_magenta',
    });
    await joinRaid(db, created.raid.key, IDS.member);
    await startRaid(db, created.raid.key, IDS.captain);
    await addRaidReward(db, created.raid.key, IDS.captain, {
        targetType: 'general',
        rewardType: 'yulls',
        amount: rewardAmount,
        label: 'Pagamento aprovado',
    });
    await beginRaidFinalization(db, created.raid.key, IDS.captain);
    await setRaidParticipantFinalization(db, created.raid.key, IDS.captain, IDS.member, {
        status: 'eligible',
    });
    const proposal = await createRaidRewardProposal(db, {
        raidKey: created.raid.key,
        actorId: IDS.captain,
    });
    return { created, proposal: proposal.proposal };
}

test('capitao cria raid apenas no proprio esquadrao', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const own = await createRaid(db, IDS.captain, {
        name: 'Treino proprio',
        category: 'treino_esquadrao',
        scopeSquadKey: 'coringas_magenta',
    });
    assert.equal(own.raid.scope.squadKey, 'coringas_magenta');

    await assert.rejects(
        () => createRaid(db, IDS.captain, {
            name: 'Treino alheio',
            category: 'treino_esquadrao',
            scopeSquadKey: 'asas_verdes',
        }),
        (error) => error?.code === 'narrator_required'
    );
});

test('vice-capitao nao recebe permissao V1 para criar raid ou gerenciar membros', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await assert.rejects(
        () => createRaid(db, IDS.vice, {
            name: 'Treino do vice',
            category: 'treino_esquadrao',
            scopeSquadKey: 'coringas_magenta',
        }),
        (error) => error?.code === 'narrator_required'
    );
    await assert.rejects(
        () => addSquadMember(db, {
            actorId: IDS.vice,
            squadInput: 'coringas_magenta',
            characterId: IDS.candidate,
        }),
        (error) => error?.code === 'forbidden'
    );
});

test('avaliador aprova proposta de terceiro e narrador nao aprova', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const { proposal } = await preparedProposal(db, 1500);

    await assert.rejects(
        () => reviewRaidRewardProposal(db, {
            proposalId: proposal.id,
            actorId: IDS.narrator,
            decision: 'approve',
        }),
        (error) => error?.code === 'forbidden'
    );

    const approved = await reviewRaidRewardProposal(db, {
        proposalId: proposal.id,
        actorId: IDS.evaluator,
        decision: 'approve',
    });
    assert.equal(approved.proposal.status, 'delivered');
    assert.equal((await getYullsSummary(db, IDS.member)).balance, 1500);
});

test('completeRaid normal continua restrito ao host mesmo para avaliador', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const { created } = await preparedProposal(db, 700);

    await assert.rejects(
        () => completeRaid(db, created.raid.key, IDS.evaluator),
        (error) => error?.code === 'raid_host_required'
    );
});

test('payload de finalizacao permite leitura ao avaliador mas nao conclusao normal', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const { created } = await preparedProposal(db, 700);

    const summary = await getRaidFinalizationSummary(db, created.raid.key, IDS.evaluator);
    assert.equal(summary.access.canReadAll, true);
    assert.equal(summary.access.canReviewRewardProposal, true);
    assert.equal(summary.access.isHost, false);
    assert.equal(summary.canComplete, false);
    assert.equal(summary.participants.length, 1);
    assert.equal(summary.rewards.length, 1);
});

test('admin aprova proposta de terceiro e autoaprovacao e bloqueada', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const { proposal } = await preparedProposal(db, 800);

    await assert.rejects(
        () => reviewRaidRewardProposal(db, {
            proposalId: proposal.id,
            actorId: IDS.captain,
            decision: 'approve',
        }),
        (error) => error?.code === 'self_review_blocked'
    );

    const approved = await reviewRaidRewardProposal(db, {
        proposalId: proposal.id,
        actorId: IDS.admin,
        decision: 'approve',
        note: 'Revisado por admin.',
    });
    assert.equal(approved.proposal.status, 'delivered');
    assert.equal((await getYullsSummary(db, IDS.member)).balance, 800);
});

test('approve aceita apenas propostas pendentes e nao duplica entrega entregue', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const { proposal } = await preparedProposal(db, 1200);

    await reviewRaidRewardProposal(db, {
        proposalId: proposal.id,
        actorId: IDS.evaluator,
        decision: 'approve',
    });
    await assert.rejects(
        () => reviewRaidRewardProposal(db, {
            proposalId: proposal.id,
            actorId: IDS.evaluator,
            decision: 'approve',
        }),
        (error) => error?.code === 'proposal_not_pending'
    );
    assert.equal((await getYullsSummary(db, IDS.member)).balance, 1200);
    const deliveries = await db.get('SELECT COUNT(*) AS total FROM clover_raid_reward_deliveries');
    assert.equal(Number(deliveries.total), 1);
});

test('autoaprovacao concorrente e revalidada dentro da transacao', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const { proposal } = await preparedProposal(db, 650);

    await assert.rejects(
        () => reviewRaidRewardProposal(db, {
            proposalId: proposal.id,
            actorId: IDS.evaluator,
            decision: 'approve',
            beforeTransactionalReview: async () => {
                await db.run(
                    'UPDATE clover_raid_reward_proposals SET proposed_by = ? WHERE id = ?',
                    [IDS.evaluator, proposal.id]
                );
            },
        }),
        (error) => error?.code === 'self_review_blocked'
    );
    assert.equal((await getYullsSummary(db, IDS.member)).balance, 0);
    const stored = await db.get('SELECT status FROM clover_raid_reward_proposals WHERE id = ?', [proposal.id]);
    assert.equal(stored.status, 'pending');
});

test('return e reject protegem status pendente contra revisao concorrente', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const { proposal } = await preparedProposal(db, 400);

    const returned = await reviewRaidRewardProposal(db, {
        proposalId: proposal.id,
        actorId: IDS.evaluator,
        decision: 'return',
    });
    assert.equal(returned.proposal.status, 'returned');
    await assert.rejects(
        () => reviewRaidRewardProposal(db, {
            proposalId: proposal.id,
            actorId: IDS.admin,
            decision: 'reject',
        }),
        (error) => error?.code === 'proposal_not_pending'
    );
});

test('mutacao de recompensa apos submissao torna proposta stale', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const { proposal } = await preparedProposal(db, 1200);

    await db.run("UPDATE clover_raid_rewards SET amount = 1300 WHERE raid_id = ? AND status = 'draft'", [
        Number(proposal.raidId),
    ]);
    await assert.rejects(
        () => reviewRaidRewardProposal(db, {
            proposalId: proposal.id,
            actorId: IDS.evaluator,
            decision: 'approve',
        }),
        (error) => error?.code === 'proposal_stale'
    );
    assert.equal((await getYullsSummary(db, IDS.member)).balance, 0);
});

test('devolver editar reenviar e aprovar renova snapshot', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const { created, proposal } = await preparedProposal(db, 500);

    const returned = await reviewRaidRewardProposal(db, {
        proposalId: proposal.id,
        actorId: IDS.evaluator,
        decision: 'return',
        note: 'Ajustar valor.',
    });
    assert.equal(returned.proposal.status, 'returned');
    await db.run("UPDATE clover_raid_rewards SET amount = 750 WHERE raid_id = ? AND status = 'draft'", [
        Number(proposal.raidId),
    ]);

    const resubmitted = await createRaidRewardProposal(db, {
        raidKey: created.raid.key,
        actorId: IDS.captain,
    });
    assert.equal(resubmitted.resubmitted, true);
    assert.equal(resubmitted.proposal.id, proposal.id);
    assert.equal(resubmitted.proposal.status, 'pending');

    const approved = await reviewRaidRewardProposal(db, {
        proposalId: proposal.id,
        actorId: IDS.evaluator,
        decision: 'approve',
    });
    assert.equal(approved.proposal.status, 'delivered');
    assert.equal((await getYullsSummary(db, IDS.member)).balance, 750);
});

test('estrelas propostas ficam no esquadrao congelado mesmo apos migracao do personagem', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const created = await createRaid(db, IDS.captain, {
        name: 'Merito Magenta',
        category: 'missao_esquadrao',
        scopeSquadKey: 'coringas_magenta',
    });
    await joinRaid(db, created.raid.key, IDS.member);
    await startRaid(db, created.raid.key, IDS.captain);
    await addRaidReward(db, created.raid.key, IDS.captain, {
        targetType: 'general',
        rewardType: 'stars',
        amount: 5,
        label: 'Estrelas da missao',
    });
    await beginRaidFinalization(db, created.raid.key, IDS.captain);
    await setRaidParticipantFinalization(db, created.raid.key, IDS.captain, IDS.member, {
        status: 'eligible',
    });
    const proposal = await createRaidRewardProposal(db, {
        raidKey: created.raid.key,
        actorId: IDS.captain,
    });

    await db.run('UPDATE jogadores SET esquadrao = ? WHERE id = ?', ['Asas Verdes', IDS.member]);
    const approved = await reviewRaidRewardProposal(db, {
        proposalId: proposal.proposal.id,
        actorId: IDS.evaluator,
        decision: 'approve',
    });
    assert.equal(approved.proposal.status, 'delivered');

    const original = await readSquadNativeStars(db, 'coringas_magenta');
    const migrated = await readSquadNativeStars(db, 'asas_verdes');
    assert.equal(original.balance, 5);
    assert.equal(original.season, 5);
    assert.equal(migrated.balance, 0);
    assert.equal(migrated.season, 0);
});

test('entrega interna de proposta valida proposta raid status permissao e autoaprovacao', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const { created, proposal } = await preparedProposal(db, 500);

    await assert.rejects(
        () => completeRaidForRewardProposal(db, created.raid.key, IDS.evaluator, {
            proposalId: 9999,
        }),
        (error) => error?.code === 'proposal_required'
    );
    await assert.rejects(
        () => completeRaidForRewardProposal(db, created.raid.key, IDS.captain, {
            proposalId: proposal.id,
        }),
        (error) => error?.code === 'self_review_blocked'
    );
    await assert.rejects(
        () => completeRaidForRewardProposal(db, created.raid.key, IDS.narrator, {
            proposalId: proposal.id,
        }),
        (error) => error?.code === 'forbidden'
    );
});

test('proposta retornada nao pode ser aprovada antes de reenviar', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const { proposal } = await preparedProposal(db, 300);

    await reviewRaidRewardProposal(db, {
        proposalId: proposal.id,
        actorId: IDS.evaluator,
        decision: 'return',
    });
    await assert.rejects(
        () => reviewRaidRewardProposal(db, {
            proposalId: proposal.id,
            actorId: IDS.evaluator,
            decision: 'approve',
        }),
        (error) => error?.code === 'proposal_not_pending'
    );
});

test('fila administrativa de propostas exige permissao raid.reward.review', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await preparedProposal(db, 600);

    await assert.rejects(
        () => listRaidRewardProposals(db, { actorId: IDS.narrator }),
        (error) => error?.code === 'forbidden'
    );
    const visible = await listRaidRewardProposals(db, { actorId: IDS.evaluator });
    assert.equal(visible.length, 1);
});

test('falha parcial reverte entrega e mantem proposta pendente', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const { proposal } = await preparedProposal(db, 900);

    await db.exec(`
        CREATE TRIGGER block_yulls_delivery
        BEFORE INSERT ON clover_yulls_ledger
        WHEN NEW.kind = 'ganho'
        BEGIN
            SELECT RAISE(ABORT, 'blocked yulls delivery');
        END
    `);
    await assert.rejects(
        () => reviewRaidRewardProposal(db, {
            proposalId: proposal.id,
            actorId: IDS.evaluator,
            decision: 'approve',
        }),
        /blocked yulls delivery/
    );
    assert.equal((await getYullsSummary(db, IDS.member)).balance, 0);
    const stored = await db.get('SELECT status FROM clover_raid_reward_proposals WHERE id = ?', [proposal.id]);
    assert.equal(stored.status, 'pending');
});

test('compra reduz saldo sem reduzir temporada ou vitalicio, nova temporada preserva patrimonio', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await db.exec('BEGIN IMMEDIATE');
    await grantSquadStarsInTransaction(db, {
        squadKey: 'coringas_magenta',
        playerId: IDS.member,
        amount: 10,
        source: 'test',
        reason: 'Ganho de temporada',
        transactionKey: 'stars:test:grant',
        createdBy: IDS.evaluator,
    });
    await purchaseSquadStarsInTransaction(db, {
        squadKey: 'coringas_magenta',
        amount: 4,
        source: 'test',
        reason: 'Compra de teste',
        transactionKey: 'stars:test:purchase',
        createdBy: IDS.captain,
    });
    await db.exec('COMMIT');

    let stars = await readSquadNativeStars(db, 'coringas_magenta');
    assert.equal(stars.balance, 6);
    assert.equal(stars.season, 10);
    assert.equal(stars.lifetime, 10);

    await openSquadSeason(db, {
        seasonId: 'season-next',
        name: 'Temporada Seguinte',
        createdBy: IDS.admin,
    });
    stars = await readSquadNativeStars(db, 'coringas_magenta');
    assert.equal(stars.balance, 6);
    assert.equal(stars.season, 0);
    assert.equal(stars.lifetime, 10);
});

test('remocao preserva vinculo anterior no historico', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const candidates = await searchSquadMemberCandidates(db, {
        actorId: IDS.captain,
        squadInput: 'coringas_magenta',
        query: 'Candidata',
    });
    assert.equal(candidates.candidates[0].eligible, true);

    const added = await addSquadMember(db, {
        actorId: IDS.captain,
        squadInput: 'coringas_magenta',
        characterId: IDS.candidate,
    });
    assert.equal(added.membership.squadKey, 'coringas_magenta');

    const removed = await removeSquadMember(db, {
        actorId: IDS.captain,
        squadInput: 'coringas_magenta',
        characterId: IDS.candidate,
        reason: 'Saiu do ciclo atual',
    });
    assert.equal(removed.membership.squadKey, 'coringas_magenta');
    const history = await db.get(
        `SELECT status, reason FROM clover_squad_memberships
         WHERE player_id = ? ORDER BY id DESC LIMIT 1`,
        [IDS.candidate]
    );
    assert.equal(history.status, 'removed');
    assert.equal(history.reason, 'Saiu do ciclo atual');
});

test('busca de candidato considera codigo e code', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await db.exec('ALTER TABLE jogadores ADD COLUMN codigo TEXT DEFAULT NULL');
    await db.exec('ALTER TABLE jogadores ADD COLUMN code TEXT DEFAULT NULL');
    await db.run('UPDATE jogadores SET codigo = ?, code = ? WHERE id = ?', [
        'CAND-007',
        'LEGACY-999',
        IDS.candidate,
    ]);

    let candidates = await searchSquadMemberCandidates(db, {
        actorId: IDS.captain,
        squadInput: 'coringas_magenta',
        query: 'CAND-007',
    });
    assert.equal(candidates.candidates[0].characterId, IDS.candidate);

    candidates = await searchSquadMemberCandidates(db, {
        actorId: IDS.captain,
        squadInput: 'coringas_magenta',
        query: 'LEGACY-999',
    });
    assert.equal(candidates.candidates[0].characterId, IDS.candidate);
});

test('membership ativo divergente bloqueia busca, adicao e remocao por esquadrao errado', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await db.run(
        `INSERT INTO clover_squad_memberships
         (squad_key, player_id, status, changed_by, reason)
         VALUES ('asas_verdes', ?, 'active', ?, 'fixture')`,
        [IDS.candidate, IDS.admin]
    );

    const candidates = await searchSquadMemberCandidates(db, {
        actorId: IDS.captain,
        squadInput: 'coringas_magenta',
        query: 'Candidata',
    });
    assert.equal(candidates.candidates[0].eligible, false);
    assert.equal(candidates.candidates[0].blockedReason, 'already_in_other_squad');

    await assert.rejects(
        () => addSquadMember(db, {
            actorId: IDS.captain,
            squadInput: 'coringas_magenta',
            characterId: IDS.candidate,
        }),
        (error) => error?.code === 'active_membership_conflict'
    );

    await db.run('UPDATE jogadores SET esquadrao = ? WHERE id = ?', ['Coringas Magenta', IDS.candidate]);
    await assert.rejects(
        () => removeSquadMember(db, {
            actorId: IDS.captain,
            squadInput: 'coringas_magenta',
            characterId: IDS.candidate,
            reason: 'Divergencia intencional',
        }),
        (error) => error?.code === 'active_membership_conflict'
    );
});

test('estrelas nao seguem personagem migrado de esquadrao', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    await db.exec('BEGIN IMMEDIATE');
    await grantSquadStarsInTransaction(db, {
        squadKey: 'coringas_magenta',
        playerId: IDS.member,
        amount: 7,
        source: 'test',
        reason: 'Merito no esquadrao original',
        transactionKey: 'stars:test:migration',
        createdBy: IDS.evaluator,
    });
    await db.exec('COMMIT');

    await removeSquadMember(db, {
        actorId: IDS.captain,
        squadInput: 'coringas_magenta',
        characterId: IDS.member,
        reason: 'Migracao planejada',
    });
    await addSquadMember(db, {
        actorId: IDS.otherCaptain,
        squadInput: 'asas_verdes',
        characterId: IDS.member,
    });

    const original = await readSquadNativeStars(db, 'coringas_magenta');
    const target = await readSquadNativeStars(db, 'asas_verdes');
    assert.equal(original.balance, 7);
    assert.equal(original.lifetime, 7);
    assert.equal(target.balance, 0);
    assert.equal(target.lifetime, 0);
});
