'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { auditTraitDescriptions } = require('../helpers/clover/traitDescriptionAuditService');

async function fixture() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE clover_trait_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slot_key TEXT NOT NULL,
            description TEXT,
            effect_text TEXT,
            restrictions_text TEXT,
            status TEXT,
            canonical_key TEXT,
            trait_kind TEXT,
            source TEXT
        );
        CREATE TABLE jogadores (
            id TEXT PRIMARY KEY,
            personagem_nome TEXT,
            historias_extras TEXT
        );
        CREATE TABLE clover_player_traits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT NOT NULL,
            trait_id TEXT NOT NULL,
            slot_key TEXT NOT NULL,
            value_text TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE clover_player_content (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT,
            content_type TEXT,
            title TEXT,
            body TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE clover_character_bonuses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT,
            name TEXT,
            type TEXT,
            description TEXT
        );
    `);

    await db.run(
        `INSERT INTO clover_trait_templates
         (id, name, slot_key, description, effect_text, restrictions_text, status, canonical_key, trait_kind, source)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 'system', 'fixture')`,
        ['TR-1', 'Mãos que Tremem', 'aptidao_comum', null, null, null, 'maos_que_tremem']
    );
    await db.run(
        `INSERT INTO clover_trait_templates
         (id, name, slot_key, description, effect_text, restrictions_text, status, canonical_key, trait_kind, source)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 'system', 'fixture')`,
        ['TR-2', 'Olhar Analítico', 'extra_trait', null, null, null, 'olhar_analitico']
    );
    await db.run(
        `INSERT INTO clover_trait_templates
         (id, name, slot_key, description, effect_text, restrictions_text, status, canonical_key, trait_kind, source)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 'system', 'fixture')`,
        ['TR-3', 'Corpo de Combate', 'marca_comum', 'Descrição já cadastrada.', null, null, 'corpo_de_combate']
    );
    await db.run(
        'INSERT INTO jogadores (id, personagem_nome, historias_extras) VALUES (?, ?, ?)',
        [
            'P1',
            'Emil',
            JSON.stringify([
                {
                    type: 'traço',
                    title: 'Olhar Analítico',
                    description: 'Percebe padrões concretos antes de agir.',
                },
            ]),
        ]
    );
    await db.run(
        `INSERT INTO clover_player_traits
         (player_id, trait_id, slot_key, value_text, active, metadata_json)
         VALUES (?, ?, ?, ?, 1, ?)`,
        [
            'P1',
            'TR-1',
            'aptidao_comum',
            'Mãos que Tremem',
            JSON.stringify({
                traitOverride: {
                    description: 'As mãos tremem em repouso e pioram sob pressão.',
                    effect: 'Afeta ações de precisão em situações específicas.',
                },
            }),
        ]
    );

    return db;
}

test('encontra candidatos sem publicar descrições automaticamente', async (t) => {
    const db = await fixture();
    t.after(() => db.close());

    const report = await auditTraitDescriptions(db);

    assert.equal(report.readOnly, true);
    assert.deepEqual(report.summary, {
        templatesTotal: 3,
        templatesWithDescription: 1,
        templatesMissingDescription: 2,
        missingWithCandidates: 2,
        missingWithHighConfidenceCandidate: 1,
        missingWithoutCandidate: 0,
    });

    const hands = report.templates.find((template) => template.id === 'TR-1');
    assert.equal(hands.candidates.length, 1);
    assert.equal(hands.candidates[0].confidence, 'high');
    assert.equal(hands.candidates[0].source, 'player_trait_override');
    assert.match(hands.candidates[0].description, /mãos tremem/i);

    const analytical = report.templates.find((template) => template.id === 'TR-2');
    assert.equal(analytical.candidates.length, 1);
    assert.equal(analytical.candidates[0].confidence, 'medium');
    assert.equal(analytical.candidates[0].source, 'historias_extras');

    assert.equal(report.templates.some((template) => template.id === 'TR-3'), false);
});

test('funciona com o banco bloqueado para escrita', async (t) => {
    const db = await fixture();
    t.after(() => db.close());
    const before = await db.get('SELECT COUNT(*) AS total FROM clover_trait_templates');

    await db.exec('PRAGMA query_only = ON');
    const report = await auditTraitDescriptions(db);
    const after = await db.get('SELECT COUNT(*) AS total FROM clover_trait_templates');

    assert.equal(report.summary.templatesTotal, 3);
    assert.equal(after.total, before.total);
    await assert.rejects(
        db.run("UPDATE clover_trait_templates SET description = 'não pode' WHERE id = 'TR-1'"),
        /readonly|read-only|attempt to write/i
    );
});
