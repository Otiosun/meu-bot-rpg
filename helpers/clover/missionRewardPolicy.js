'use strict';

// Regra de gameplay aprovada pelo responsável do RPG em 20/11/2026.
// Contratos do mural têm recompensa-base fixa, independente do teto comum.
// Não converte UP tradicional em contrato nem altera limites de participação.
const MISSION_PH_POLICY=Object.freeze({key:'contract_outside_common_cap_v1',outsideWeeklyLimit:true,label:'fora do teto semanal comum'});
module.exports={MISSION_PH_POLICY};
