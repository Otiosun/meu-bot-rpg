'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const database = require('../database');
const magicRarities = require('../data/clover/raridadesMagicas.json');
const slotMagics = require('../data/clover/magias.json');
const {
    getAllMagics,
    getRarityMeta,
    renderMagicChoicePrompt,
} = require('../helpers/magicManager');
const {
    getMagicRarityMeta,
    getRareRollHighlights,
    getRollQualityScore,
} = require('../helpers/rollManager');

const EXPECTED_RARITIES = [
    ['incomum', 42, 2],
    ['rara', 30, 3],
    ['epica', 17, 4],
    ['lendaria', 10, 5],
    ['mitica', 1, 6],
];

const EXPECTED_MYTHICS = new Map([
    ['magia_de_chave', 1],
    ['magia_de_luar', 1],
    ['magia_de_transcricao', 1],
    ['magia_criada', 3],
]);

function temporaryFilename() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-prereset-mythic-'));
    return path.join(dir, 'database.sqlite');
}

test('raridades magicas do pre-reset usam a tabela canonica 42/30/17/10/1', () => {
    assert.equal(magicRarities.reduce((sum, option) => sum + Number(option.chance || 0), 0), 100);
    assert.deepEqual(
        magicRarities.map((option) => [option.key, option.chance, option.level]),
        EXPECTED_RARITIES
    );
    assert.equal(magicRarities.some((option) => option.key === 'comum'), false);
    assert.deepEqual(getRarityMeta('Mitica'), {
        label: 'Mítica', headerLabel: '𝐌𝐈́𝐓𝐈𝐂𝐀', emoji: '🔴', level: 6,
    });
    assert.deepEqual(getMagicRarityMeta('Mitica'), { label: 'Mítica', emoji: '🔴' });
    assert.equal(getRollQualityScore({ magic_rarity_key: 'mitica' }), 7);
    assert.equal(getRareRollHighlights({ magic_rarity_key: 'mitica' }).includes('mitica'), true);
});

test('catalogo mitico preserva identidade de Chave/Luar e aplica vagas 1/1/1/3', () => {
    const configured = slotMagics.filter((magic) => String(magic.rarity).toLowerCase() === 'mitica');
    assert.equal(configured.length, 4);
    assert.deepEqual(new Map(configured.map((magic) => [magic.key, magic.capacity])), EXPECTED_MYTHICS);

    const allMagics = getAllMagics();
    const mythics = allMagics.filter((magic) => magic.rarity === 'Mitica');
    assert.equal(mythics.length, 4);
    assert.deepEqual(
        new Map(mythics.map((magic) => [magic.key, magic.capacity])),
        EXPECTED_MYTHICS
    );
    assert.equal(allMagics.find((magic) => magic.key === 'magia_de_luar')?.rarity, 'Mitica');
    assert.equal(allMagics.find((magic) => magic.key === 'magia_de_chave')?.rarity, 'Mitica');
    assert.equal(allMagics.some((magic) => magic.key === 'magia_de_luar' && magic.capacity === 2), false);
});

test('.#magias renderiza classe Mitica e as quatro opcoes com vagas corretas', async (t) => {
    const filename = temporaryFilename();
    const db = await database.criarBanco({ filename });
    t.after(async () => {
        await db.close();
        fs.rmSync(path.dirname(filename), { recursive: true, force: true });
    });

    const rendered = await renderMagicChoicePrompt(db, { magic_rarity: 'Mitica' });
    assert.match(rendered, /𝐂𝐋𝐀𝐒𝐒𝐄 𝐌𝐈́𝐓𝐈𝐂𝐀/);
    assert.match(rendered, /Magia de Chave \*\(0\/1\)\*/);
    assert.match(rendered, /Magia de Luar \*\(0\/1\)\*/);
    assert.match(rendered, /Magia de Transcrição \*\(0\/1\)\*/);
    assert.match(rendered, /Magia Criada \*\(0\/3\)\*/);
    assert.doesNotMatch(rendered, /Magia de Luar \*\(0\/2\)\*/);
});
