'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    paginateSpells,
    parsePageNumber,
    renderGrimoirePage,
    renderSpellCardPlayer,
    renderSpellCardTechnical,
    renderSpellbookUsage,
    selectSpellByIndex,
} = require('../helpers/clover/spellbookPresentation');

const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'spellbook-presentation');

function makeSpell(index) {
    const types = ['Criação', 'Reforço', 'Suporte', 'Misto'];
    return {
        id: index,
        name: `Feitiço de Teste ${String(index).padStart(2, '0')}`,
        normalized_name: `feitico_de_teste_${String(index).padStart(2, '0')}`,
        version: (index % 3) + 1,
        type: types[(index - 1) % types.length],
        cost: `${20 + index * 5} mana`,
        reach: index % 2 ? 'curto' : 'médio',
        duration: `${(index % 3) + 1} turno(s)`,
        effect: `Produz o efeito aprovado do feitiço ${index}.\nA segunda linha permanece legível.`,
        limits: `Possui limite narrativo ${index}.`,
        adm_notes: `Nota reservada ao ADM para o feitiço ${index}.`,
    };
}

function assertCleanOutput(text, label) {
    assert.strictEqual(typeof text, 'string', `${label} não retornou texto.`);
    assert(!text.includes('undefined'), `${label} contém undefined.`);
    assert(!text.includes('[object Object]'), `${label} contém objeto cru.`);
    assert(text.length < 4096, `${label} ultrapassou 4096 caracteres: ${text.length}.`);
}

function main() {
    const spells = Array.from({ length: 19 }, (_, index) => makeSpell(index + 1));

    assert.strictEqual(parsePageNumber('', 1), 1);
    assert.strictEqual(parsePageNumber('pagina 2', 1), 2);
    assert.strictEqual(parsePageNumber('pág 3', 1), 3);
    assert.strictEqual(parsePageNumber('2', 1), 2);
    assert.strictEqual(parsePageNumber('pagina dois', 1), null);

    const first = paginateSpells(spells, 1);
    const second = paginateSpells(spells, 2);
    const third = paginateSpells(spells, 3);
    assert.strictEqual(first.items.length, 8);
    assert.strictEqual(second.items.length, 8);
    assert.strictEqual(third.items.length, 3);
    assert.strictEqual(third.totalPages, 3);

    const page1 = renderGrimoirePage('Noelle Silva (@5511999999999)', spells, { page: 1 });
    const page2 = renderGrimoirePage('Noelle Silva (@5511999999999)', spells, { page: 2 });
    const page3 = renderGrimoirePage('Noelle Silva (@5511999999999)', spells, { page: 3 });
    const externalPage = renderGrimoirePage('Asta (@5511888888888)', spells, {
        page: 2,
        targetMention: '@5511888888888',
    });
    const invalidPage = renderGrimoirePage('Noelle Silva', spells, { page: 4 });
    const empty = renderGrimoirePage('Noelle Silva', [], { page: 1 });

    for (const [label, output] of Object.entries({ page1, page2, page3, externalPage, invalidPage, empty })) {
        assertCleanOutput(output, label);
    }

    assert(page1.includes('*1. Feitiço de Teste 01*'));
    assert(page1.includes('*8. Feitiço de Teste 08*'));
    assert(!page1.includes('*9. Feitiço de Teste 09*'));
    assert(page2.includes('*9. Feitiço de Teste 09*'));
    assert(page3.includes('*19. Feitiço de Teste 19*'));
    assert(!page1.includes('mana'), 'O índice não deve repetir custo de cada feitiço.');
    assert(!page1.includes('Alcance'), 'O índice não deve repetir alcance.');
    assert(externalPage.includes('.#feitico @5511888888888 <número ou nome>'));
    assert(invalidPage.includes('Página 4 não existe'));
    assert(empty.includes('Nenhum feitiço aprovado'));

    const selected = selectSpellByIndex(spells, '12');
    assert.strictEqual(selected.ok, true);
    assert.strictEqual(selected.spell.name, 'Feitiço de Teste 12');
    const outOfRange = selectSpellByIndex(spells, '20');
    assert.strictEqual(outOfRange.code, 'index_out_of_range');
    assert.strictEqual(selectSpellByIndex(spells, 'Teste 12'), null);

    const playerCard = renderSpellCardPlayer(spells[0]);
    const technicalCard = renderSpellCardTechnical(spells[0]);
    const usage = renderSpellbookUsage('.#');
    for (const [label, output] of Object.entries({ playerCard, technicalCard, usage })) {
        assertCleanOutput(output, label);
    }

    assert(playerCard.includes('𝐄𝐟𝗲𝗶𝘁𝗼') || playerCard.includes('𝗘𝗳𝗲𝗶𝘁𝗼'));
    assert(playerCard.includes('25 mana · curto · 2 turno(s)'));
    assert(!playerCard.includes('Nota reservada ao ADM'));
    assert(!playerCard.includes('𝗡𝗼𝘁𝗮𝘀 𝗔𝗗𝗠'));
    assert(technicalCard.includes('Nota reservada ao ADM'));
    assert(technicalCard.includes('𝐀𝐥𝐜𝐚𝐧𝐜𝐞'));
    assert(usage.includes('.#grimorio pagina 2'));
    assert(usage.includes('.#feitico tecnico <número ou nome>'));

    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'grimorio-pagina-1.txt'), `${page1}\n`, 'utf8');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'grimorio-pagina-2.txt'), `${page2}\n`, 'utf8');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'feitico-player.txt'), `${playerCard}\n`, 'utf8');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'feitico-tecnico.txt'), `${technicalCard}\n`, 'utf8');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({
        totalSpells: spells.length,
        pageSize: first.pageSize,
        totalPages: first.totalPages,
        outputLengths: {
            page1: page1.length,
            page2: page2.length,
            page3: page3.length,
            playerCard: playerCard.length,
            technicalCard: technicalCard.length,
        },
        playerCardHidesAdmNotes: !playerCard.includes('Nota reservada ao ADM'),
        technicalCardShowsAdmNotes: technicalCard.includes('Nota reservada ao ADM'),
    }, null, 2)}\n`, 'utf8');

    console.log('✓ grimório paginado em 8 itens');
    console.log('✓ numeração global preservada entre páginas');
    console.log('✓ índice sem custo, alcance e duração repetidos');
    console.log('✓ seleção de feitiço por número');
    console.log('✓ notas ADM ocultas do cartão comum');
    console.log('✓ visão técnica mantém notas administrativas');
    console.log('✓ todas as saídas abaixo de 4096 caracteres');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}