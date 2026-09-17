'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const {
    ensureCloverInventorySchema,
    ensureCloverSquadSchema,
} = require('../database');
const {
    getCavalierSummary,
    getInventoryItemByPosition,
    getInventoryPage,
} = require('../helpers/clover/cavalierService');
const {
    renderInventoryDetail,
    renderInventoryFull,
    renderInventoryPage,
    renderProfileCompact,
    renderProfileFull,
} = require('../helpers/clover/playerOverviewPresentation');
const inventoryCommand = require('../comandos/inventario');
const profileCommand = require('../comandos/perfil');

const PLAYER_ID = '5511999999999@s.whatsapp.net';
const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'player-overview');

function sampleProfileData() {
    const player = {
        id: PLAYER_ID,
        nome: 'Noelle',
        personagem_nome: 'Noelle Silva',
        reino: 'Clover',
        raca: 'Humana',
        classe: 'Nobre',
        familia: 'Silva',
        grimorio: 'Três folhas',
        magia: 'Água',
        ficha_status: 'aprovada',
        personagem_aparencia_status: 'approved',
        historia_status: 'approved',
        jogo_status: 'liberado',
        aptidao_rara: 'Controle Excepcional',
        marca_comum: 'Coração de Mana',
        anomalia: '-',
        gancho_narrativo: 'Reconstruir a confiança no próprio poder.',
        esquadrao: 'Águias Prateadas',
    };
    const stats = {
        player_id: PLAYER_ID,
        distribution_status: 'confirmed',
        pb_total: 24,
        pb_spent: 20,
        ph_available: 18,
        ph_accumulated: 146,
        stage_key: '4',
        forca: 3,
        velocidade: 4,
        agilidade: 5,
        resistencia: 3,
        poder_magico: 5,
    };
    const capacity = {
        ok: true,
        playerId: PLAYER_ID,
        player,
        stats,
        ph: { phAvailable: 18, phAccumulated: 146 },
        stageName: 'Estágio 4',
        manaTotal: 920,
        hexagon: { controle: 4, precisao: 3, estabilidade: 3, retencao: 2, alcance: 3, escala: 3 },
        limits: {
            alcanceLabel: 'média distância',
            duracaoLabel: '3 turnos',
            controleLabel: 'controle refinado',
            estabilidadeLabel: 'interferência moderada',
            precisaoLabel: 'alvo pequeno ou contorno fino',
            escalaLabel: 'alguns alvos próximos ou sala pequena',
        },
        creation: { flags: { base: true, control: true, forceLevel: 2, speedLevel: 1, defenseLevel: 1, environmentLevel: 0, junction: false } },
        reinforcement: { flags: { base: true, selfBuff: true, otherBuff: false, collectiveBuff: false, advancedEnvironment: false, stabilityLevel: 1 } },
        mana: { flags: { flow: true, fineControl: true, manaSkin: true, bulletLevel: 2, environment: false, zone: false } },
        physical: { flags: { base: true, vigor: true, control: true, barbarian: false, cult: false, antiMage: false, instinct: false, ki: false, zetten: false, apex: false } },
        trees: { mana: { ownedIds: ['mana', 'fluxo_de_mana_i'] } },
    };
    const bonusSummary = {
        ok: true,
        identity: {
            name: 'Noelle Silva',
            kingdom: 'Clover',
            race: 'Humana',
            socialClass: 'Nobre',
            family: 'Silva',
            grimoire: 'Três folhas',
            magic: 'Água',
        },
        mana: { total: 920 },
        reserve: { percent: 40, amount: 368 },
        traits: {
            aptitude: { label: 'Controle Excepcional' },
            mark: { label: 'Coração de Mana' },
            anomaly: { label: 'Nenhuma' },
            hook: 'Reconstruir a confiança no próprio poder.',
        },
    };
    const cavalierSummary = {
        ok: true,
        player: { ...player, dinheiro: 12350, estrelas: 18, patente: 'Cavaleiro Mágico Júnior de 1ª Classe' },
        yulls: 12350,
        stars: 18,
        patent: 'Cavaleiro Mágico Júnior de 1ª Classe',
        squad: { name: 'Águias Prateadas', currentStars: 34, historicalStars: 87, blackStars: 1 },
        inventoryCount: 31,
    };
    return { capacity, bonusSummary, cavalierSummary };
}

async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            nome TEXT DEFAULT '-',
            personagem_nome TEXT DEFAULT '-',
            dinheiro INTEGER DEFAULT 0,
            estrelas INTEGER DEFAULT 0,
            esquadrao TEXT DEFAULT '-',
            patente TEXT DEFAULT '-'
        )
    `);
    await db.run(
        `INSERT INTO jogadores (id, nome, personagem_nome, dinheiro, estrelas, esquadrao, patente)
         VALUES (?, 'Noelle', 'Noelle Silva', 12350, 18, 'Águias Prateadas', 'Cavaleiro Mágico Júnior de 1ª Classe')`,
        [PLAYER_ID]
    );
    await ensureCloverInventorySchema(db);
    await ensureCloverSquadSchema(db);
    await db.run(
        `INSERT INTO clover_squads (squad_key, name, historical_stars, current_stars, black_stars)
         VALUES ('aguias_prateadas', 'Águias Prateadas', 87, 34, 1)`
    );

    for (let index = 1; index <= 23; index += 1) {
        const kind = index === 23 ? 'caixa_pa' : index === 22 ? 'cupom_pa' : 'narrativo';
        const name = index === 23
            ? 'Caixa Simples de Serviço'
            : index === 22
                ? 'Cupom de Prioridade'
                : `Item Narrativo ${String(index).padStart(2, '0')}`;
        await db.run(
            `INSERT INTO clover_inventory_items
             (player_id, item_name, description, quantity, kind, source, related_id, created_by)
             VALUES (?, ?, ?, ?, ?, 'test', ?, 'test')`,
            [PLAYER_ID, name, `Descrição extensa e útil do item ${index}.`, index % 4 === 0 ? 3 : 1, kind, `item:${index}`]
        );
    }
    return db;
}

function assertClean(text, label, max = 4096) {
    assert.strictEqual(typeof text, 'string', `${label} não retornou texto.`);
    assert(!text.includes('undefined'), `${label} contém undefined.`);
    assert(!text.includes('[object Object]'), `${label} contém objeto cru.`);
    assert(text.length < max, `${label} ficou longo demais: ${text.length}.`);
}

async function main() {
    const profile = sampleProfileData();
    const compactProfile = renderProfileCompact(profile.capacity, profile.bonusSummary, profile.cavalierSummary);
    const fullProfile = renderProfileFull(profile.capacity, profile.bonusSummary, profile.cavalierSummary);
    assertClean(compactProfile, 'perfil compacto');
    assertClean(fullProfile, 'perfil completo', 8000);
    assert(compactProfile.length < fullProfile.length * 0.7, `Resumo ainda muito próximo do completo: ${compactProfile.length}/${fullProfile.length}.`);
    assert(compactProfile.includes('visão rápida'));
    assert(compactProfile.includes('𝐅𝐎𝐑'));
    assert(!compactProfile.includes('𝗛𝗲𝘅𝗮́𝗴𝗼𝗻𝗼'));
    assert(!compactProfile.includes('𝐆𝐚𝐧𝐜𝐡𝐨 𝐍𝐚𝐫𝐫𝐚𝐭𝐢𝐯𝐨'));
    assert(fullProfile.includes('𝗛𝗲𝘅𝗮́𝗴𝗼𝗻𝗼'));
    assert(fullProfile.includes('𝐆𝐚𝐧𝐜𝐡𝐨 𝐍𝐚𝐫𝐫𝐚𝐭𝐢𝐯𝐨'));
    assert.strictEqual(profileCommand.resolveViewMode(''), 'compact');
    assert.strictEqual(profileCommand.resolveViewMode('completo'), 'full');
    assert.strictEqual(profileCommand.resolveViewMode('coisa'), null);

    const db = await createDb();
    try {
        const summary = await getCavalierSummary(db, PLAYER_ID);
        const page1 = await getInventoryPage(db, PLAYER_ID, { page: 1, pageSize: 8 });
        const page2 = await getInventoryPage(db, PLAYER_ID, { page: 2, pageSize: 8 });
        const page3 = await getInventoryPage(db, PLAYER_ID, { page: 3, pageSize: 8 });
        const invalidPage = await getInventoryPage(db, PLAYER_ID, { page: 4, pageSize: 8 });
        assert.strictEqual(page1.items.length, 8);
        assert.strictEqual(page2.items.length, 8);
        assert.strictEqual(page3.items.length, 7);
        assert.strictEqual(page1.totalRecords, 23);
        assert.strictEqual(page1.totalPages, 3);
        assert.strictEqual(invalidPage.valid, false);

        const detail = await getInventoryItemByPosition(db, PLAYER_ID, 1);
        const missing = await getInventoryItemByPosition(db, PLAYER_ID, 24);
        assert.strictEqual(detail.ok, true);
        assert.strictEqual(detail.item.item_name, 'Caixa Simples de Serviço');
        assert.strictEqual(missing.code, 'position_out_of_range');

        const pageText1 = renderInventoryPage(summary, page1);
        const pageText2 = renderInventoryPage(summary, page2);
        const pageText3 = renderInventoryPage(summary, page3);
        const invalidText = renderInventoryPage(summary, invalidPage);
        const detailText = renderInventoryDetail(summary, detail);
        const missingText = renderInventoryDetail(summary, missing);
        const fullText = renderInventoryFull(summary, [...page1.items, ...page2.items, ...page3.items]);
        for (const [label, output] of Object.entries({ pageText1, pageText2, pageText3, invalidText, detailText, missingText })) {
            assertClean(output, label);
        }
        assertClean(fullText, 'inventário completo', 10000);

        assert(pageText1.includes('*1. Caixa Simples de Serviço*'));
        assert(pageText1.includes('usável'));
        assert(!pageText1.includes('Descrição extensa'));
        assert(pageText2.includes('*9. Item Narrativo 15*'));
        assert(pageText3.includes('*23. Item Narrativo 01*'));
        assert(detailText.includes('Descrição extensa e útil do item 23.'));
        assert(detailText.includes('.#pa abrir'));
        assert(fullText.includes('Descrição extensa'));
        assert(invalidText.includes('Página 4 não existe'));
        assert(missingText.includes('23 registro(s)'));

        assert.deepStrictEqual(inventoryCommand.parseInventoryRequest(''), { mode: 'page', page: 1 });
        assert.deepStrictEqual(inventoryCommand.parseInventoryRequest('pagina 2'), { mode: 'page', page: 2 });
        assert.deepStrictEqual(inventoryCommand.parseInventoryRequest('2'), { mode: 'page', page: 2 });
        assert.deepStrictEqual(inventoryCommand.parseInventoryRequest('detalhe 3'), { mode: 'detail', position: 3 });
        assert.deepStrictEqual(inventoryCommand.parseInventoryRequest('completo'), { mode: 'full' });
        assert.deepStrictEqual(inventoryCommand.parseInventoryRequest('detalhe'), { mode: 'invalid' });
        assert.strictEqual(typeof inventoryCommand.renderInventoryMessage, 'function');
        assert.strictEqual(typeof inventoryCommand.formatItemLine, 'function');
        assert.strictEqual(typeof inventoryCommand.getItemUseHint, 'function');

        fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'perfil-resumo.txt'), `${compactProfile}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'perfil-completo.txt'), `${fullProfile}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'inventario-pagina-1.txt'), `${pageText1}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'inventario-pagina-2.txt'), `${pageText2}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'inventario-detalhe.txt'), `${detailText}\n`, 'utf8');
        fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({
            profileLengths: { compact: compactProfile.length, full: fullProfile.length },
            inventory: {
                totalRecords: page1.totalRecords,
                totalUnits: page1.totalUnits,
                pages: [page1.items.length, page2.items.length, page3.items.length],
                page1Length: pageText1.length,
                detailLength: detailText.length,
                fullLength: fullText.length,
            },
        }, null, 2)}\n`, 'utf8');

        console.log('✓ perfil resumido menor que 70% da visão completa');
        console.log('✓ perfil completo preservado sob comando explícito');
        console.log('✓ inventário paginado em 8/8/7 registros');
        console.log('✓ índice do inventário não repete descrições');
        console.log('✓ detalhe por número exibe descrição e uso');
        console.log('✓ exports legados do inventário preservados');
        console.log('✓ saídas principais abaixo de 4096 caracteres');
    } finally {
        await db.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
