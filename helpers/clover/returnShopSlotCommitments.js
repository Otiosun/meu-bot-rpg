'use strict';

const OPTIONS = {
    grimoire: { fourLeaves: 'clover_4f', doubleHeart: 'heart_4f', polishedDiamond: 'diamond_4f', twoSwords: 'spade_4f' },
    race: { witch: 'bruxa', dwarf: 'anao', elf: 'elfo' },
};

async function countReturnShopSlotCommitments(db, category, optionKey, campaignKey, options = {}) {
    const mapping = OPTIONS[category];
    if (!mapping || !Object.values(mapping).includes(optionKey)) return 0;
    const tables = await db.all(`SELECT name FROM sqlite_master WHERE type='table'
        AND name IN ('clover_prereset_entitlements','clover_prereset_purchases')`);
    if (tables.length !== 2) return 0;
    const rows = await db.all(`SELECT e.id,e.metadata_json
        FROM clover_prereset_entitlements e JOIN clover_prereset_purchases p ON p.id=e.purchase_id
        WHERE e.status='active' AND p.status='completed'`);
    let count = 0;
    for (const row of rows) {
        if (Number(options.excludeEntitlementId) === row.id) continue;
        const metadata = JSON.parse(row.metadata_json || '{}') || {};
        if ((metadata.reset_cycle_key || metadata.target_campaign_key || 'mythic_launch_v1') !== campaignKey) continue;
        if (metadata.roll_fulfillment_status === 'fulfilled') continue;
        for (const item of Array.isArray(metadata.items) ? metadata.items : []) {
            if (mapping[item.key] !== optionKey) continue;
            const quantity = Number(item.quantity ?? 1);
            if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`Quantidade de reserva invalida no entitlement ${row.id}`);
            count += quantity;
        }
    }
    return count;
}

module.exports = { countReturnShopSlotCommitments };
