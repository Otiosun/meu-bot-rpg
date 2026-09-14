'use strict';
const {COMMAND_PREFIX}=require('../config/bot');
const {sendReply}=require('../helpers/chatReply');
const service=require('../helpers/clover/returnShopCustomItemService');
module.exports={nome:COMMAND_PREFIX+'itemretorno',aliases:[],lifecycleMutationClass:'PRE_RESET',groupBypass:true,descricao:'Solicita e entrega item personalizado da Loja de Retorno com aprovacao ADM.',async executar({db,idJogador,body,sock,idChat,m}){
 const parts=String(body||'').trim().replace(/^\S*itemretorno\s*/i,'').split(/\s+/);const [action,id,...rest]=parts;
 let result;
 try{if(action==='meus')result=await service.ownerRights(db,idJogador);else if(action==='solicitar')result=await service.submitRequest(db,idJogador,Number(id),rest.join(' '));else if(action==='fila')result=await service.listRequests(db,idJogador);else if(action==='criar')result=await service.createRequestedTemplate(db,idJogador,Number(id),JSON.parse(rest.join(' ')));else if(action==='aprovar')result=await service.approveRequest(db,idJogador,Number(id),rest[0]);else if(action==='entregar')result=await service.deliverRequest(db,idJogador,Number(id));else result={uso:COMMAND_PREFIX+'itemretorno solicitar <direito> <descricao> | meus | fila | criar <direito> <especificacao JSON> | aprovar <direito> <template> | entregar <direito>'};}
 catch(error){if(error instanceof SyntaxError)result={erro:'invalid_specification'};else {if(!error.code)throw error;result={erro:error.code};}}
 await sendReply({sock,idChat,m,text:Array.isArray(result)?(result.map(r=>'Direito #'+r.entitlement_id+' | '+r.status+(r.description?' | '+r.description:'')).join('\n')||'Nenhum pedido pendente.'):(result.erro?'Pedido nao concluido. Verifique o direito, a permissao ADM e a etapa de aprovacao/launch.':result.uso||('Direito #'+result.entitlement_id+' | '+result.status+(result.template_key?' | Modelo: '+result.template_key:'')))});
}};
