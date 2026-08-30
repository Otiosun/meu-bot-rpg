'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadService(state) {
    const filename = path.join(__dirname, '..', 'helpers', 'clover', 'returnPointShopFulfillmentService.js');
    const source = fs.readFileSync(filename, 'utf8');
    const module = { exports: {} };
    const customRequire = (request) => {
        if (request === './returnPointShopCatalog') {
            return {
                getReturnPointShopItem(itemKey) {
                    if (itemKey === 'yulls_5000') {
                        return {
                            itemKey:'yulls_5000',
                            name:'5.000 Yulls',
                            effectKind:'future_yulls',
                            effectValue:5000,
                        };
                    }
                    if (itemKey === 'ticket_feitico') {
                        return {
                            itemKey:'ticket_feitico',
                            name:'Ticket de Feitico',
                            effectKind:'future_item',
                            effectValue:'ticket_feitico',
                        };
                    }
                    return null;
                },
            };
        }
        if (request === './yullsService') {
            return {
                async addYullsInTransaction(db, playerId, amount, sourceName, reason, createdBy, options = {}) {
                    state.credits.push({
                        playerId,
                        amount,
                        source:sourceName,
                        createdBy,
                        idempotencyKey:options.idempotencyKey,
                        relatedId:options.relatedId,
                    });
                    return { ok:true, duplicate:false };
                },
            };
        }
        throw new Error(`Unexpected require in isolated fulfillment test: ${request}`);
    };
    const wrapper = vm.runInThisContext(
        `(function(require,module,exports,__filename,__dirname){${source}\n})`,
        { filename }
    );
    wrapper(customRequire, module, module.exports, filename, path.dirname(filename));
    return module.exports;
}

function fakeDb(state) {
    return {
        async exec(sql) {
            state.execs.push(String(sql));
        },
        async all(sql, params) {
            assert.match(String(sql), /clover_prereset_entitlements/);
            return state.entitlements.filter((row) => (
                row.player_id === params[0]
                && row.status === 'active'
                && row.purchase_status === 'completed'
            ));
        },
        async run(sql, params) {
            assert.match(String(sql), /UPDATE clover_prereset_entitlements/);
            const row = state.entitlements.find((entry) => Number(entry.id) === Number(params[0]));
            if (!row || row.player_id !== params[1] || row.status !== 'active') return { changes:0 };
            row.status = 'consumed';
            row.consumed_at = 'now';
            return { changes:1 };
        },
    };
}

test('fulfillment future_yulls credita e consome entitlement exatamente uma vez', async () => {
    const state = {
        execs:[],
        credits:[],
        entitlements:[
            {
                id:7,
                player_id:'p1',
                purchase_id:11,
                status:'active',
                purchase_status:'completed',
                catalog_item_key:'yulls_5000',
                metadata_json:JSON.stringify({ effectKind:'future_yulls', effectValue:5000, quantity:1 }),
            },
            {
                id:8,
                player_id:'p1',
                purchase_id:12,
                status:'active',
                purchase_status:'completed',
                catalog_item_key:'ticket_feitico',
                metadata_json:JSON.stringify({ effectKind:'future_item', effectValue:'ticket_feitico', quantity:1 }),
            },
        ],
    };
    const service = loadService(state);
    const db = fakeDb(state);

    const first = await service.fulfillReturnPointShopEconomicEntitlements(db, 'p1', {
        campaignKey:'f10',
        actorId:'admin-f10',
    });
    assert.equal(first.fulfilledCount, 1);
    assert.equal(first.yullsAdded, 5000);
    assert.equal(state.entitlements[0].status, 'consumed');
    assert.equal(state.entitlements[1].status, 'active');
    assert.deepEqual(state.credits, [{
        playerId:'p1',
        amount:5000,
        source:'return_point_shop_fulfillment',
        createdBy:'admin-f10',
        idempotencyKey:'return-shop:fulfillment:yulls:11',
        relatedId:'11',
    }]);

    const replay = await service.fulfillReturnPointShopEconomicEntitlements(db, 'p1', {
        campaignKey:'f10',
        actorId:'admin-f10',
    });
    assert.equal(replay.fulfilledCount, 0);
    assert.equal(replay.yullsAdded, 0);
    assert.equal(state.credits.length, 1);
    assert.equal(state.execs.filter((value) => value === 'COMMIT').length, 2);
});

test('fulfillment future_yulls falha fechado se snapshot divergir do catalogo', async () => {
    const state = {
        execs:[],
        credits:[],
        entitlements:[{
            id:9,
            player_id:'p2',
            purchase_id:13,
            status:'active',
            purchase_status:'completed',
            catalog_item_key:'yulls_5000',
            metadata_json:JSON.stringify({ effectKind:'future_yulls', effectValue:20000, quantity:1 }),
        }],
    };
    const service = loadService(state);
    await assert.rejects(
        service.fulfillReturnPointShopEconomicEntitlements(fakeDb(state), 'p2', {
            campaignKey:'f10',
            actorId:'admin-f10',
        }),
        (error) => error?.code === 'return_shop_yulls_snapshot_invalid'
    );
    assert.equal(state.entitlements[0].status, 'active');
    assert.equal(state.credits.length, 0);
    assert.ok(state.execs.includes('ROLLBACK'));
});
