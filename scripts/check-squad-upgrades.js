'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { ensureCloverSquadSchema } = require('../database');
const {
    SQUAD_UPGRADES,
    getRenownGradeFromHistory,
    getSquadUpgrade,
    listUpgradeCategories,
} = require('../helpers/clover/squadUpgradeCatalog');
const {
    canManageSquadUpgrade,
    getSquadUpgradeState,
    listSquadUpgradeHistory,
    purchaseSquadUpgrade,
    resolveSquadForContext,
} = require('../helpers/clover/squadUpgradeService');
const command = require('../comandos/qg');

const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'squad-upgrades');
const GROUP_ID = '120363000000000001@g.us';
const CAPTAIN = '5511000000001@s.whatsapp.net';
const VICE = '5511000000002@s.whatsapp.net';
const MEMBER = '5511000000003@s.whatsapp.net';
const OWNER = '557998868223@s.whatsapp.net';

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            display_name TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            esquadrao TEXT DEFAULT '-',
            estrelas INTEGER DEFAULT 0
        )
    `);
    await ensureCloverSquadSchema(db);
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, group_id, captain_name, captain_player_id,
          vice_captain_player_id, historical_stars, current_stars, black_stars)
         VALUES ('touros_negros', 'Touros Negros', ?, 'Yami', ?, ?, 37, 25, 0)`,
        [GROUP_ID, CAPTAIN, VICE]
    );
    await db.run(
        `INSERT INTO clover_squads
         (squad_key, name, historical_stars, current_stars, black_stars)
         VALUES ('aguias_prateadas', 'Águias Prateadas', 100, 100, 0)`
    );
    for (const [id, name, squad] of [
        [CAPTAIN, 'Capitão', 'Touros Negros'],
        [VICE, 'Vice', 'Touros Negros'],
        [MEMBER, 'Membro', 'Touros Negros'],
    ]) {
        await db.run(
            `INSERT INTO jogadores (id, nome, display_name, personagem_nome, esquadrao)
             VALUES (?, ?, ?, ?, ?)`,
            [id, name, name, name, squad]
        );
    }
    return db;
}

function assertClean(text, label) {
    assert.strictEqual(typeof text, 'string', `${label} não retornou texto.`);
    assert(!text.includes('undefined'), `${label} contém undefined.`);
    assert(!text.includes('[object Object]'), `${label} contém objeto cru.`);
    assert(text.length < 4096, `${label} ultrapassou 4096 caracteres: ${text.length}.`);
}

function validateCatalog() {
    assert.strictEqual(SQUAD_UPGRADES.length, 41);
    assert.strictEqual(listUpgradeCategories().length, 7);
    assert.strictEqual(new Set(SQUAD_UPGRADES.map((item) => item.key)).size, 41);
    assert.strictEqual(getSquadUpgrade('1').key, 'mural_meritos');
    assert.strictEqual(getSquadUpgrade('Cela de Contenção Mágica').requiresApproval, true);
    assert.strictEqual(getSquadUpgrade('Círculo de Transporte Espacial Selado').requiresApproval, true);
    assert.strictEqual(getSquadUpgrade('Campo de Treinamento Avançado').activation, 'weekly_review');
    assert.deepStrictEqual(getSquadUpgrade('Arena de Duelo Controlado').prerequisites, ['patio_treinamento']);
    assert.deepStrictEqual(getSquadUpgrade('Gabinete de Relatórios').prerequisites, ['arquivo_missoes']);
    assert.strictEqual(getRenownGradeFromHistory(0), 0);
    assert.strictEqual(getRenownGradeFromHistory(10), 1);
    assert.strictEqual(getRenownGradeFromHistory(25), 2);
    assert.strictEqual(getRenownGradeFromHistory(50), 3);
    assert.strictEqual(getRenownGradeFromHistory(85), 4);
    assert.strictEqual(getRenownGradeFromHistory(130), 5);
    assert.strictEqual(getRenownGradeFromHistory(200), 6);
}

async function main() {
    validateCatalog();
    const db = await createDb();
    try {
        const byGroup = await resolveSquadForContext(db, { groupId: GROUP_ID });
        const byPlayer = await resolveSquadForContext(db, { playerId: MEMBER });
        const byName = await resolveSquadForContext(db, { squadName: 'Touros Negros' });
        assert.strictEqual(byGroup.squad_key, 'touros_negros');
        assert.strictEqual(byPlayer.squad_key, 'touros_negros');
        assert.strictEqual(byName.squad_key, 'touros_negros');

        const captainPermission = await canManageSquadUpgrade({ actorId: CAPTAIN, squad: byGroup });
        const vicePermission = await canManageSquadUpgrade({ actorId: VICE, squad: byGroup });
        const ownerPermission = await canManageSquadUpgrade({ actorId: OWNER, squad: byGroup });
        const memberPermission = await canManageSquadUpgrade({ actorId: MEMBER, squad: byGroup });
        assert.strictEqual(captainPermission.code, 'captain');
        assert.strictEqual(vicePermission.code, 'vice_captain');
        assert.strictEqual(ownerPermission.code, 'owner');
        assert.strictEqual(memberPermission.ok, false);

        let state = await getSquadUpgradeState(db, byGroup);
        assert.strictEqual(state.totalCount, 41);
        assert.strictEqual(state.ownedCount, 0);
        assert.strictEqual(state.currentStars, 25);
        assert.strictEqual(state.renownGrade, 2);
        assert.strictEqual(state.categories.length, 7);

        const mural = await purchaseSquadUpgrade(db, byGroup, 'mural_meritos', { purchasedBy: CAPTAIN });
        assert.strictEqual(mural.ok, true);
        assert.strictEqual(mural.upgrade.cost, 0);
        assert.strictEqual(mural.starsBefore, 25);
        assert.strictEqual(mural.starsAfter, 25);
        assert.strictEqual(Number((await db.get(
            `SELECT COUNT(*) AS total FROM clover_squad_star_ledger WHERE squad_key = 'touros_negros'`
        )).total), 0);

        const missingPatio = await purchaseSquadUpgrade(db, byGroup, 'arena_duelo_controlado', { purchasedBy: CAPTAIN });
        assert.strictEqual(missingPatio.code, 'missing_prerequisites');
        assert.deepStrictEqual(missingPatio.missingPrerequisites, ['patio_treinamento']);

        const patio = await purchaseSquadUpgrade(db, byGroup, 'patio_treinamento', { purchasedBy: CAPTAIN });
        assert.strictEqual(patio.ok, true);
        assert.strictEqual(patio.starsBefore, 25);
        assert.strictEqual(patio.starsAfter, 21);

        const arena = await purchaseSquadUpgrade(db, byGroup, 'arena_duelo_controlado', { purchasedBy: VICE });
        assert.strictEqual(arena.ok, true);
        assert.strictEqual(arena.starsBefore, 21);
        assert.strictEqual(arena.starsAfter, 11);

        const duplicate = await purchaseSquadUpgrade(db, byGroup, 'patio_treinamento', { purchasedBy: CAPTAIN });
        assert.strictEqual(duplicate.code, 'already_owned');
        assert.strictEqual(Number((await db.get(
            `SELECT current_stars FROM clover_squads WHERE squad_key = 'touros_negros'`
        )).current_stars), 11);

        const gradeBlocked = await purchaseSquadUpgrade(db, byGroup, 'sala_condicionamento_mana', { purchasedBy: CAPTAIN });
        assert.strictEqual(gradeBlocked.code, 'grade_required');
        assert.strictEqual(gradeBlocked.requiredGrade, 3);
        assert.strictEqual(gradeBlocked.renownGrade, 2);

        const insufficient = await purchaseSquadUpgrade(db, byGroup, 'arsenal_contencao', { purchasedBy: CAPTAIN });
        assert.strictEqual(insufficient.code, 'insufficient_stars');
        assert.strictEqual(insufficient.currentStars, 11);
        assert.strictEqual(Number((await db.get(
            `SELECT current_stars FROM clover_squads WHERE squad_key = 'touros_negros'`
        )).current_stars), 11);

        const archiveFirst = await purchaseSquadUpgrade(db, 'aguias_prateadas', 'arquivo_missoes', { purchasedBy: OWNER });
        assert.strictEqual(archiveFirst.ok, true);
        const cabinet = await purchaseSquadUpgrade(db, 'aguias_prateadas', 'gabinete_relatorios', { purchasedBy: OWNER });
        assert.strictEqual(cabinet.ok, true);
        assert.strictEqual(cabinet.starsAfter, 87);

        state = await getSquadUpgradeState(db, byGroup);
        assert.strictEqual(state.ownedCount, 3);
        assert.strictEqual(state.currentStars, 11);
        assert.strictEqual(state.items.find((item) => item.key === 'mural_meritos').owned, true);
        assert.strictEqual(state.items.find((item) => item.key === 'arena_duelo_controlado').owned, true);

        const ledger = await db.all(
            `SELECT * FROM clover_squad_star_ledger
             WHERE squad_key = 'touros_negros'
             ORDER BY id ASC`
        );
        assert.deepStrictEqual(ledger.map((row) => Number(row.amount)), [-4, -10]);
        assert(ledger.every((row) => row.kind === 'gasto' && row.source === 'qg_upgrade'));
        const spent = ledger.reduce((sum, row) => sum + Math.abs(Number(row.amount)), 0);
        assert.strictEqual(spent, 14);
        assert.strictEqual(25 - spent, state.currentStars);

        const events = await listSquadUpgradeHistory(db, 'touros_negros', 20);
        assert.strictEqual(events.length, 3);
        assert.strictEqual(events[0].action, 'purchased');
        assert.strictEqual(events.reduce((sum, event) => sum + Number(event.stars_delta), 0), -14);

        const categoryIndex = command.renderCategoryIndex(state);
        const baseCategory = command.resolveCategory('1');
        const categoryText = command.renderCategory(state, baseCategory);
        const detailText = command.renderUpgradeDetail(
            state,
            state.items.find((item) => item.key === 'cela_contencao_magica')
        );
        const stateText = command.renderHeadquartersState(state);
        const purchaseText = command.renderPurchase(arena);
        const historyText = command.renderHistory(state, events);
        const blockedText = command.renderPurchase(insufficient);
        for (const [label, text] of Object.entries({ categoryIndex, categoryText, detailText, stateText, purchaseText, historyText, blockedText })) {
            assertClean(text, label);
        }
        assert(categoryIndex.includes('11 Estrelas'));
        assert(categoryIndex.includes('Base e Defesa'));
        assert(categoryText.includes('Mural de Méritos do Esquadrão'));
        assert(detailText.includes('Exige aprovação no uso relevante'));
        assert(detailText.includes('não concede vitória ou bônus automático'));
        assert(purchaseText.includes('21 → 11 Estrelas Atuais'));
        assert(blockedText.includes('Estrelas Atuais insuficientes'));
        assert(historyText.includes('Arena de Duelo Controlado'));
        assert.strictEqual(command.resolveCategory('Pesquisa e Magia').key, 'pesquisa_magia');
        assert.strictEqual(command.splitBody('comprar 7').action, 'comprar');

        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'qg-resumo.txt'), `${stateText}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'qg-catalogo.txt'), `${categoryIndex}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'qg-categoria.txt'), `${categoryText}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'qg-detalhe.txt'), `${detailText}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'qg-compra.txt'), `${purchaseText}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({
            catalog: {
                total: SQUAD_UPGRADES.length,
                categories: listUpgradeCategories().map((category) => category.label),
                approvals: SQUAD_UPGRADES.filter((item) => item.requiresApproval).map((item) => item.name),
                weeklyReview: SQUAD_UPGRADES.filter((item) => item.activation === 'weekly_review').map((item) => item.name),
            },
            touros: {
                starsBefore: 25,
                starsAfter: state.currentStars,
                owned: state.activeRows.map((row) => row.upgrade_key),
                ledger: ledger.map((row) => ({ amount: Number(row.amount), kind: row.kind, source: row.source })),
                events: events.map((event) => ({ upgradeKey: event.upgrade_key, starsDelta: Number(event.stars_delta) })),
            },
            negativeScenarios: {
                missingPrerequisite: missingPatio.code,
                duplicate: duplicate.code,
                grade: gradeBlocked.code,
                insufficient: insufficient.code,
                forbidden: memberPermission.code,
            },
            outputLengths: {
                summary: stateText.length,
                catalog: categoryIndex.length,
                category: categoryText.length,
                detail: detailText.length,
                purchase: purchaseText.length,
            },
        }, null, 2)}\n`, 'utf8');

        console.log('✓ 41 benfeitorias e 7 categorias oficiais');
        console.log('✓ compra grátis sem lançamento inválido de 0 estrelas');
        console.log('✓ gasto atômico e ledger contábil');
        console.log('✓ Grau, pré-requisito, saldo e duplicidade validados');
        console.log('✓ Capitão, Vice e Owner autorizados; membro comum bloqueado');
        console.log('✓ efeitos permanecem narrativos/contextuais');
        console.log('✓ mensagens abaixo de 4096 caracteres');
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
