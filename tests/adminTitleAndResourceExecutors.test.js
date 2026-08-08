'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const {
    TitleAdminServiceError,
    resolveTitleTemplate,
} = require('../helpers/clover/titleAdminService');
const {
    AdminResourceAdjustmentError,
    createResourceAdjustmentExecutor,
    normalizeResource,
} = require('../helpers/clover/adminResourceAdjustmentService');

class TemplateDb {
    constructor(category = 'titulo') {
        this.category = category;
    }

    async get(sql) {
        if (sql.includes('FROM clover_item_templates')) {
            return {
                template_key: this.category === 'titulo' ? 'titulo_campeao' : 'espada_comum',
                catalog_version: 1,
                item_name: this.category === 'titulo' ? 'Campeão' : 'Espada Comum',
                description: 'Teste',
                category: this.category,
                kind: this.category,
                origin: 'Clover',
                base_price: 0,
                default_quality: 'comum',
                default_durability: null,
                stackable: 0,
                transferable: 0,
                requestable: 0,
                marketable: 0,
                duplicable: 1,
                is_custom: 0,
                active: 1,
                properties_json: '{}',
                effects_json: '{}',
                metadata_json: '{}',
            };
        }
        return null;
    }
}

class PaPreviewDb {
    constructor(balance = 10) {
        this.balance = balance;
    }

    async exec() {}

    async get(sql) {
        if (sql.includes('SELECT id FROM jogadores')) return { id: 'player@test' };
        if (sql.includes('SUM(amount)') && sql.includes('clover_pa_ledger')) return { balance: this.balance };
        return null;
    }
}

test('registry exposes real executors for title grant/remove and resource.adjust', () => {
    const registry = getAdminOperationExecutors();
    for (const type of ['player.title.grant', 'player.title.remove', 'resource.adjust']) {
        assert.equal(typeof registry[type]?.preview, 'function', `${type} preview`);
        assert.equal(typeof registry[type]?.apply, 'function', `${type} apply`);
        assert.equal(typeof registry[type]?.undo, 'function', `${type} undo`);
        assert.equal(registry[type]?.atomicSafe, false, `${type} stays outside atomic allowlist until runner validation`);
    }
});

test('title executor accepts only catalog templates that are actually titles', async () => {
    const title = await resolveTitleTemplate(new TemplateDb('titulo'), { templateKey: 'titulo_campeao' });
    assert.equal(title.key, 'titulo_campeao');
    assert.equal(title.itemName, 'Campeão');

    await assert.rejects(
        () => resolveTitleTemplate(new TemplateDb('equipamento'), { templateKey: 'espada_comum' }),
        (error) => error instanceof TitleAdminServiceError && error.code === 'item_is_not_title'
    );
});

test('resource aliases normalize only to the supported signed adjustment set', () => {
    assert.equal(normalizeResource('dinheiro'), 'yulls');
    assert.equal(normalizeResource('pontos_habilidade'), 'ph');
    assert.equal(normalizeResource('poder_magico'), 'pm');
    assert.equal(normalizeResource('pa'), 'pa');
    assert.throws(
        () => normalizeResource('stars'),
        (error) => error instanceof AdminResourceAdjustmentError && error.code === 'unsupported_resource_adjustment'
    );
});

test('resource.adjust previews a signed PA correction and blocks negative balance', async () => {
    const executor = createResourceAdjustmentExecutor();
    const target = { playerId: 'player@test', characterName: 'Teste' };

    const preview = await executor.preview({
        db: new PaPreviewDb(10),
        action: { payload: { resource: 'pa', amount: -4 } },
        target,
    });
    assert.equal(preview.before.balance, 10);
    assert.equal(preview.after.balance, 6);
    assert.equal(preview.after.amount, -4);
    assert.match(preview.summary, /-4 PA/);

    await assert.rejects(
        () => executor.preview({
            db: new PaPreviewDb(3),
            action: { payload: { resource: 'pa', amount: -4 } },
            target,
        }),
        (error) => error instanceof AdminResourceAdjustmentError && error.code === 'insufficient_pa'
    );
});
