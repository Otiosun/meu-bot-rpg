'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getAdminOperationExecutors } = require('../helpers/clover/adminOperationRegistry');
const {
    TitleAdminServiceError,
    resolveTitleTemplate,
} = require('../helpers/clover/titleAdminService');

class TemplateDb {
    constructor(category = 'titulo') {
        this.category = category;
    }

    async get(sql) {
        if (!sql.includes('FROM clover_item_templates')) return null;
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
}

test('admin registry exposes title grant/remove executors end-to-end', () => {
    const registry = getAdminOperationExecutors();
    for (const type of ['player.title.grant', 'player.title.remove']) {
        assert.equal(typeof registry[type]?.preview, 'function', `${type} preview`);
        assert.equal(typeof registry[type]?.apply, 'function', `${type} apply`);
        assert.equal(typeof registry[type]?.undo, 'function', `${type} undo`);
    }
});

test('title executor rejects catalog entries that are not titles', async () => {
    const title = await resolveTitleTemplate(new TemplateDb('titulo'), { templateKey: 'titulo_campeao' });
    assert.equal(title.key, 'titulo_campeao');
    assert.equal(title.itemName, 'Campeão');

    await assert.rejects(
        () => resolveTitleTemplate(new TemplateDb('equipamento'), { templateKey: 'espada_comum' }),
        (error) => error instanceof TitleAdminServiceError && error.code === 'item_is_not_title'
    );
});
