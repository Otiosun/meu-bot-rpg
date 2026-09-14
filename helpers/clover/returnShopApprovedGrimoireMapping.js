'use strict';
// Explicit product decisions; source snapshots/manifests remain unchanged.
const MAP=Object.freeze({spade_1:'spade_3f',spade_2:'spade_4f',heart_comum:'heart_3f',heart_duplo:'heart_4f',diamond_comum:'diamond_3f',diamond_lapidado:'diamond_4f'});
function canonicalEffectValue(effect){return effect.effectKind==='grimoire'?(MAP[effect.effectValue]||effect.effectValue):effect.effectValue;}
module.exports={canonicalEffectValue};
