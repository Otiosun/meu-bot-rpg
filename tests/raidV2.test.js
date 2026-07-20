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
const { assignAccessRole, ensureAccessControlSchema } = require('../helpers/clover/accessControlService');
const {
    RaidServiceError,
    cancelRaid,
    createRaid,
    getRaidCategoryCatalog,
    getRaidDashboard,
    getRaidParticipantDetail,
    joinRaid,
} = require('../helpers/clover/raidService');

const IDS = {
    narrator: '5511111111111@s.whatsapp.net',
    one: '5522222222222@s.whatsapp.net',
    two: '5533333333333@s.whatsapp.net',
};

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY, nome TEXT DEFAULT '-', display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-', personagem_idade INTEGER DEFAULT NULL,
            personagem_genero TEXT DEFAULT '-', personagem_aparencia TEXT DEFAULT '-',
            personagem_aparencia_status TEXT DEFAULT 'approved',
            personagem_aparencia_image_path TEXT DEFAULT NULL, site_profile_image_data TEXT DEFAULT NULL,
            reino TEXT DEFAULT 'Clover', classe TEXT DEFAULT '-', familia TEXT DEFAULT '-', raca TEXT DEFAULT 'Humano',
            grimorio TEXT DEFAULT '-', magia TEXT DEFAULT '-', formas TEXT DEFAULT '-', esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0, patente TEXT DEFAULT '-', aptidao_comum TEXT DEFAULT '-',
            aptidao_rara TEXT DEFAULT '-', marca_comum TEXT DEFAULT '-', marca_rara TEXT DEFAULT '-',
            anomalia TEXT DEFAULT '-', gancho_narrativo TEXT DEFAULT '-', jogo_status TEXT DEFAULT 'liberado',
            dinheiro INTEGER DEFAULT 0
        );
        INSERT INTO jogadores (id, personagem_nome, esquadrao, magia, grimorio) VALUES
            ('${IDS.narrator}', 'Narrador', '-', 'Registro', 'Comum'),
            ('${IDS.one}', 'Player Um', 'Coringas Magenta', 'Fogo', 'Trevo'),
            ('${IDS.two}', 'Player Dois', 'Asas Verdes', 'Água', 'Trevo');
    `);
    await ensureCloverInventorySchema(db);
    await ensureCloverRaidSchema(db);
    await ensureCloverYullsLedgerSchema(db);
    await ensureCloverSquadSchema(db);
    await ensureAccessControlSchema(db);
    await db.run(`INSERT INTO clover_squads (squad_key, name) VALUES ('coringas_magenta', 'Coringas Magenta')`);
    await assignAccessRole(db, {
        subjectId: IDS.narrator,
        role: 'narrator',
        assignedBy: IDS.narrator,
        reason: 'teste Raid V2',
    });
    return db;
}

test('catálogo oficial expõe categorias e políticas mensais', () => {
    const catalog = getRaidCategoryCatalog();
    assert.deepEqual(catalog.map((item) => item.key), [
        'saga_pessoal', 'missao_desenvolvimento', 'missao_esquadrao',
        'treino_esquadrao', 'evento_especial',
    ]);
    assert.equal(catalog.find((item) => item.key === 'missao_esquadrao').scopeType, 'squad');
    assert.equal(catalog.find((item) => item.key === 'evento_especial').countsMonthly, false);
});

test('limite mensal é atômico e cancelamento devolve a vaga', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const input = { name: 'Saga do mês', category: 'saga_pessoal', scopePlayerId: IDS.one };
    const first = await createRaid(db, IDS.narrator, input);
    assert.equal(first.raid.monthlyUsage.used, 1);
    await assert.rejects(
        () => createRaid(db, IDS.narrator, { ...input, name: 'Outra saga' }),
        (error) => error instanceof RaidServiceError && error.code === 'raid_monthly_limit_reached'
    );
    await cancelRaid(db, first.raid.key, IDS.narrator, 'troca de lobby');
    const replacement = await createRaid(db, IDS.narrator, { ...input, name: 'Saga substituta' });
    assert.equal(replacement.raid.monthlyUsage.used, 1);
});

test('escopo de esquadrão é obrigatório e validado', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    await assert.rejects(
        () => createRaid(db, IDS.narrator, { name: 'Sem esquadrão', category: 'missao_esquadrao' }),
        (error) => error instanceof RaidServiceError && error.code === 'raid_scope_squad_required'
    );
    const created = await createRaid(db, IDS.narrator, {
        name: 'Operação Magenta', category: 'missao_esquadrao', scopeSquadKey: 'Coringas Magenta',
    });
    assert.equal(created.raid.scope.squadKey, 'coringas_magenta');
});

test('dashboard resolve permissão canônica e detalhe chega organizado', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const created = await createRaid(db, IDS.narrator, {
        name: 'Leitura operacional', category: 'missao_desenvolvimento', scopePlayerId: IDS.one,
    });
    await joinRaid(db, created.raid.key, IDS.one);
    await joinRaid(db, created.raid.key, IDS.two);
    const dashboard = await getRaidDashboard(db, created.raid.key, IDS.one);
    assert.equal(dashboard.participants.find((p) => p.playerId === IDS.one).access.canInspect, true);
    assert.equal(dashboard.participants.find((p) => p.playerId === IDS.two).access.canInspect, false);
    const detail = await getRaidParticipantDetail(db, created.raid.key, IDS.one, IDS.one);
    assert.equal(detail.sections.overview.player.personagem_nome, 'Player Um');
    assert.ok(Array.isArray(detail.sections.spells));
    assert.ok(Array.isArray(detail.sections.equipment));
    assert.ok(Array.isArray(detail.sections.conditions));
    assert.ok(Array.isArray(detail.sections.history));
});
