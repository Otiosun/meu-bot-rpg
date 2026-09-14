'use strict';
const {getReturnPointShopItem}=require('./returnPointShopCatalog');
const INVENTORY_PROVIDERS=Object.freeze({
    caixa_comum:['future_box','box_simple_v1'],
    caixa_real:['future_box','box_royal_v1'],
    caixa_rara:['future_box','box_rare_v1'],
    ticket_feitico:['future_item','ticket_feitico'],
    cupom_prioridade_feitico:['future_item','cupom_prioridade'],
});
function inventoryProvider(item){
    const provider=INVENTORY_PROVIDERS[item?.itemKey];
    return provider && item.effectKind===provider[0] && item.effectValue===provider[1] ? provider[1]:null;
}
function hasEconomicProvider(itemKey){
    const item=getReturnPointShopItem(itemKey);
    return Boolean(item && (item.effectKind==='future_yulls' || (item.itemKey==='ph_1' && item.effectKind==='future_ph' && item.effectValue===null) || item.itemKey==='item_magico_personalizado' || item.itemKey==='salvamento_inventario' || inventoryProvider(item)));
}
module.exports={inventoryProvider,hasEconomicProvider};
