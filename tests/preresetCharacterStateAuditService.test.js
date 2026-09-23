'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const {
    auditPreresetCharacterStates,
} = require('../helpers/clover/preresetCharacterStateAuditService');

async function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clover-prereset-audit-'));
    const db = await open({ filename: path.join(dir, 'fixture.sqlite'), driver: sqlite3.Database });
    t.after(async () => {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    await db.exec(`
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY, nome TEXT, display_name TEXT, personagem_nome TEXT,
            numero_roll_escolhido INTEGER, esquadrao TEXT,
            aptidao_comum TEXT, aptidao_comum_key TEXT, aptidao_rara TEXT, aptidao_rara_key TEXT,
            marca_comum TEXT, marca_comum_key TEXT, marca_rara TEXT, marca_rara_key TEXT,
            anomalia TEXT, anomalia_key TEXT
        );
        CREATE TABLE clover_prereset_characters (
            player_id TEXT PRIMARY KEY, status TEXT, revision INTEGER, draft_json TEXT
        );
        CREATE TABLE clover_prereset_future_rolls (
            campaign_key TEXT, player_id TEXT, roll_number INTEGER,
            kingdom TEXT, social_class TEXT, race TEXT, grimoire TEXT
        );
        CREATE TABLE clover_squad_memberships (
            id INTEGER PRIMARY KEY, player_id TEXT, squad_key TEXT, status TEXT
        );
    `);
    return db;
}

test('auditoria mostra tracos de ficha aprovada ausentes no canonico e esquadrao fantasma', async (t) => {
    const db = await fixture(t);
    await db.run(`INSERT INTO jogadores VALUES
        ('player@lid','Jogador','Jogador','Nova Heroina',2,'Esquadrao Antigo',
         '-',NULL,'-',NULL,'-',NULL,'-',NULL,'-',NULL)`);
    await db.run(`INSERT INTO clover_prereset_characters VALUES (?,?,?,?)`, [
        'player@lid',
        'approved',
        4,
        JSON.stringify({
            name: 'Nova Heroina',
            rollNumber: 2,
            traits: {
                aptitude: { key: 'mente_afiada', name: 'Mente Afiada', rarity: 'common' },
                mark: { key: 'marca_lunar', name: 'Marca Lunar', rarity: 'rare' },
                anomaly: { key: 'eco_vazio', name: 'Eco do Vazio', rarity: 'rare' },
            },
        }),
    ]);
    await db.run(`INSERT INTO clover_prereset_future_rolls VALUES
        ('mythic_launch_v1','player@lid',2,'Clover','Nobreza','Humano','Grimorio de 4 Folhas')`);
    await db.run(`INSERT INTO clover_squad_memberships VALUES
        (1,'player@lid','esquadrao_antigo','active')`);

    const result = await auditPreresetCharacterStates(db);
    assert.deepEqual(result.counts, { approved: 1 });
    assert.equal(result.records[0].promotionState, 'promoted_traits_missing');
    assert.deepEqual(result.records[0].traitMismatches, ['aptitude', 'mark', 'anomaly']);
    assert.deepEqual(result.records[0].activeSquads, ['esquadrao_antigo']);
    assert.ok(result.records[0].issues.includes('legacy_squad_present'));
    assert.ok(result.records[0].issues.includes('active_squad_membership'));
});

test('auditoria lista tracos de ficha enviada sem trata-la como personagem promovido', async (t) => {
    const db = await fixture(t);
    await db.run(`INSERT INTO jogadores VALUES
        ('waiting@lid','Espera','Espera','Personagem Antigo',1,'-',
         'Persistente','persistente','-',NULL,'-',NULL,'-',NULL,'-',NULL)`);
    await db.run(`INSERT INTO clover_prereset_characters VALUES (?,?,?,?)`, [
        'waiting@lid',
        'submitted',
        3,
        JSON.stringify({
            name: 'Personagem Futuro',
            rollNumber: 1,
            traits: { aptitude: { key: 'veloz', name: 'Veloz', rarity: 'common' } },
        }),
    ]);

    const result = await auditPreresetCharacterStates(db);
    assert.equal(result.records[0].status, 'submitted');
    assert.equal(result.records[0].promotionState, 'not_eligible');
    assert.equal(result.records[0].traits.aptitude.name, 'Veloz');
    assert.deepEqual(result.records[0].traitMismatches, ['aptitude']);
    assert.ok(!result.records[0].issues.includes('canonical_traits_mismatch'));
});
