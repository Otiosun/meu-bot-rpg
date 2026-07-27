'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
    buildResolutionPlan,
    validateManifest,
} = require('../helpers/clover/legacyEventRewardResolutionService');

const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'data', 'inventory', 'legacy-event-reward-resolutions-v1.json'),
    'utf8'
));

const source = 'eventos_acumulados_20260618';
const examDescription = 'Recompensa do exame completo.';
const navalDescription = 'Recompensa de evento separado / Batalha Naval.';

function item(id, relatedId, characterName, itemName, description, quantity = 1) {
    return {
        id,
        relatedId,
        characterName,
        source,
        templateKey: null,
        itemName,
        description,
        quantity,
        category: 'material',
        kind: 'evento',
        origin: 'Clover',
        status: 'disponivel',
        transferable: 1,
        properties: {},
        effects: {},
    };
}

function inventory() {
    return [
        item(5, `${source}:emil:item:1`, 'Emil', 'Feitiço', examDescription),
        item(4, `${source}:maksim:item:1`, 'Maksim Faust', 'Feitiço', examDescription),
        item(2, `${source}:caelus:item:1`, 'Caelus Apicius', 'Dungeon exclusiva', examDescription, 2),
        item(6, `${source}:zahir:item:1`, 'Zahir Al-Nur', 'Dungeon exclusiva', examDescription),
        item(8, `${source}:nero:item:1`, 'Nero Shirasagi', 'Dungeon exclusiva', navalDescription),
        item(3, `${source}:caelus:item:2`, 'Caelus Apicius', 'Item mágico', examDescription),
        item(9, `${source}:nero:item:2`, 'Nero Shirasagi', 'Item mágico', navalDescription),
        item(7, `${source}:zahir:item:2`, 'Zahir Al-Nur', 'Pedra misteriosa de 12cm', examDescription),
    ];
}

function dungeonTemplate() {
    return {
        templateKey: 'acesso_dungeon_exclusiva',
        itemName: 'Passe da Dungeon Exclusiva',
        description: 'Passe pessoal guardado no inventário. Garante uma vaga na Dungeon Exclusiva do evento e não pode ser vendido, anunciado, trocado ou transferido.',
        category: 'missao',
        kind: 'acesso_dungeon',
        origin: 'Clover',
        transferable: 0,
        properties: {
            eventAccess: 'dungeon_exclusiva',
            bound: true,
            sellable: false,
            tradable: false,
        },
        effects: {},
    };
}

test('manifesto possui oito decisões exatas e nenhuma recompensa pendente ganha efeito', () => {
    const validated = validateManifest(manifest);
    assert.equal(validated.decisions.length, 8);
    const pending = validated.decisions.filter(
        (decision) => decision.resolution.type !== 'retype_and_link_existing_template'
    );
    assert.equal(pending.length, 5);
    for (const decision of pending) {
        assert.deepEqual(decision.resolution.effects, {});
        assert.equal(decision.resolution.properties.automaticEffect, false);
        assert.equal(decision.resolution.properties.specificationStatus, 'pending');
    }
});

test('plano cobre oito linhas, nove unidades e preserva os quatro acessos', () => {
    const plan = buildResolutionPlan(manifest, inventory(), [dungeonTemplate()]);
    assert.equal(plan.mode, 'readonly_plan');
    assert.equal(plan.writesPerformed, false);
    assert.deepEqual(plan.policy, {
        exactRelatedIdOnly: true,
        deletesInventoryItems: false,
        preservesQuantities: true,
        automaticEffects: false,
        convertsSpellRewardToTicket: false,
    });
    assert.equal(plan.summary.decisions, 8);
    assert.equal(plan.summary.inventoryRowsCovered, 8);
    assert.equal(plan.summary.inventoryUnitsCovered, 9);
    assert.equal(plan.summary.dungeonAccessRows, 3);
    assert.equal(plan.summary.dungeonAccessUnits, 4);
    assert.equal(plan.summary.pendingDefinitionRows, 5);
    assert.equal(plan.summary.templatesToCreate, 4);
    assert.equal(plan.summary.unresolvedLegacyItems, 0);
});

test('Dungeon é ligada ao Passe existente sem perder quantidade', () => {
    const plan = buildResolutionPlan(manifest, inventory(), [dungeonTemplate()]);
    const caelus = plan.actions.find(
        (action) => action.relatedId === `${source}:caelus:item:1`
    );
    assert.equal(caelus.before.quantity, 2);
    assert.equal(caelus.after.quantity, 2);
    assert.equal(caelus.after.templateKey, 'acesso_dungeon_exclusiva');
    assert.equal(caelus.after.itemName, 'Passe da Dungeon Exclusiva');
    assert.equal(caelus.after.category, 'missao');
    assert.equal(caelus.after.kind, 'acesso_dungeon');
    assert.equal(caelus.after.transferable, 0);
});

test('Feitiço pendente não vira Ticket de Feitiço nem concede efeito', () => {
    const plan = buildResolutionPlan(manifest, inventory(), [dungeonTemplate()]);
    const spellActions = plan.actions.filter(
        (action) => action.after.templateKey === 'recompensa_feitico_pendente_exame_20260618'
    );
    assert.equal(spellActions.length, 2);
    for (const action of spellActions) {
        assert.match(action.after.description, /não equivale a Ticket de Feitiço/i);
        assert.equal(action.after.kind, 'direito_feitico_pendente');
        assert.deepEqual(action.after.effects, {});
        assert.equal(action.after.properties.automaticEffect, false);
    }
});

test('qualquer divergência no registro original bloqueia o plano inteiro', () => {
    const changed = inventory();
    changed[0] = { ...changed[0], quantity: 2 };
    assert.throws(
        () => buildResolutionPlan(manifest, changed, [dungeonTemplate()]),
        (error) => error?.code === 'stale_legacy_reward'
    );
});

test('modelo da Dungeon ausente ou modelo pendente conflitante bloqueia o plano', () => {
    assert.throws(
        () => buildResolutionPlan(manifest, inventory(), []),
        (error) => error?.code === 'destination_template_not_found'
    );

    const conflict = {
        templateKey: 'recompensa_feitico_pendente_exame_20260618',
        itemName: 'Outro modelo',
        description: 'Conflito',
        category: 'recompensa',
        kind: 'outro',
        origin: 'Clover',
        transferable: 0,
        properties: {},
        effects: {},
    };
    assert.throws(
        () => buildResolutionPlan(manifest, inventory(), [dungeonTemplate(), conflict]),
        (error) => error?.code === 'destination_template_conflict'
    );
});
