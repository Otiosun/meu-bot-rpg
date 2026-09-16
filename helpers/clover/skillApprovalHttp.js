
'use strict';

const { authenticateSiteSession } = require('./siteAuthService');
const { getPlayerPhase } = require('./playerPhase');
const { buyNode, getNodeDetails } = require('./skillTreeService');
const { runEconomyMutationExclusive } = require('./economyMutationQueue');
const { resolveAdminContext } = require('./adminApiSupportBase');
const { SkillApprovalError, approveSkillApproval, listSkillApprovalRequests, rejectSkillApproval, requestSkillApproval } = require('./skillApprovalService');
const { matchDescriptor, routeDescriptor } = require('./httpRouteDescriptor');
const { getTreeMutationBlock } = require('./treeMaintenancePolicy');

const REVIEW_ROLES = new Set(['owner', 'admin', 'evaluator', 'narrator']);

function setCors(req, res) {
    const origin = String(req.headers?.origin || '*');
    res.setHeader('Access-Control-Allow-Origin', origin === 'null' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Request-Id, ngrok-skip-browser-warning');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}
function sendJson(res, status, payload) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(payload)); }
function extractBearerToken(req) { const m = String(req.headers?.authorization || '').trim().match(/^Bearer\s+(.+)$/i); return m ? m[1].trim() : ''; }
function readJsonBody(req, maxBytes = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let raw = ''; req.setEncoding('utf8');
        req.on('data', (chunk) => { raw += chunk; if (Buffer.byteLength(raw, 'utf8') > maxBytes) { const e = new Error('Corpo da requisição excede o limite permitido.'); e.code='request_body_too_large'; e.status=413; reject(e); req.destroy(); } });
        req.on('end', () => { if (!raw.trim()) return resolve({}); try { resolve(JSON.parse(raw)); } catch { const e=new Error('JSON inválido.'); e.code='invalid_json'; e.status=400; reject(e); } });
        req.on('error', reject);
    });
}
function serializeTreeDefinition(tree) { if (!tree) return null; return { id:tree.id, name:tree.name, subtitle:tree.subtitle||null, aliases:tree.aliases||[], routes:tree.routes||[], nodes:tree.nodes||[], edges:tree.edges||[], goals:tree.goals||[] }; }
function serializeTreeState(state) {
    return {
        playerId:state.playerId, tree:serializeTreeDefinition(state.tree), ph:state.ph, discount:state.discount, ownedIds:state.ownedIds, totalNodes:state.totalNodes, ownedCount:state.ownedCount,
        routeProgress:state.routeProgress.map((x)=>({route:x.route,owned:x.owned,total:x.total,nodeIds:x.nodes.map((n)=>n.id)})),
        nodeStates:state.nodeStates.map((x)=>({node:x.node,status:x.status,missingPh:x.missingPh,missingRequirements:x.missingRequirements||[],missingRequirementLabels:x.missingRequirementLabels||[],satisfiedRequirements:x.satisfiedRequirements||[],satisfiedRequirementLabels:x.satisfiedRequirementLabels||[],baseCost:x.baseCost,effectiveCost:x.effectiveCost,discount:x.discount})),
        availableNodeIds:state.availableNodes.map((x)=>x.node.id),
    };
}
function parsePath(pathname) {
    const tree = String(pathname||'').match(/^\/trees\/([^/]+)\/purchase$/);
    if (tree) return {kind:'tree_purchase',treeId:decodeURIComponent(tree[1])};
    if (pathname === '/admin/skill-approvals') return {kind:'admin_list'};
    const review=String(pathname||'').match(/^\/admin\/skill-approvals\/([^/]+)\/(approve|reject)$/);
    if (review) return {kind:'admin_review',requestRef:decodeURIComponent(review[1]),decision:review[2]};
    return null;
}
function skillPathMatches(kind, decision = null) { return (pathname) => { const route = parsePath(pathname); return route?.kind === kind && (decision === null || route.decision === decision); }; }
const SKILL_APPROVAL_ROUTE_DESCRIPTORS = Object.freeze([
    routeDescriptor({ id:'skill.tree.purchase', methods:['POST'], template:'/trees/:treeId/purchase', samplePath:'/trees/example-tree/purchase', match:skillPathMatches('tree_purchase'), handlerOwner:'handleSkillApprovalHttp', sourceFile:'helpers/clover/skillApprovalHttp.js', authClass:'SITE_SESSION:PLAYABLE_CHARACTER', contractId:'skill-purchase-v1' }),
    routeDescriptor({ id:'admin.skill-approvals.list', methods:['GET'], template:'/admin/skill-approvals', samplePath:'/admin/skill-approvals', match:skillPathMatches('admin_list'), handlerOwner:'handleSkillApprovalHttp', sourceFile:'helpers/clover/skillApprovalHttp.js', authClass:'ADMIN_CAPABILITY:player.manage', contractId:'skill-approval-list-v1', contractShapeId:'admin-skill-approval-list-shape-v1' }),
    routeDescriptor({ id:'admin.skill-approvals.approve', methods:['POST'], template:'/admin/skill-approvals/:requestRef/approve', samplePath:'/admin/skill-approvals/SA-EXAMPLE/approve', match:skillPathMatches('admin_review','approve'), handlerOwner:'handleSkillApprovalHttp', sourceFile:'helpers/clover/skillApprovalHttp.js', authClass:'ADMIN_CAPABILITY:player.manage;REVIEW_ROLE', contractId:'skill-approval-v1', contractShapeId:'admin-skill-approval-approve-shape-v1' }),
    routeDescriptor({ id:'admin.skill-approvals.reject', methods:['POST'], template:'/admin/skill-approvals/:requestRef/reject', samplePath:'/admin/skill-approvals/SA-EXAMPLE/reject', match:skillPathMatches('admin_review','reject'), handlerOwner:'handleSkillApprovalHttp', sourceFile:'helpers/clover/skillApprovalHttp.js', authClass:'ADMIN_CAPABILITY:player.manage;REVIEW_ROLE', contractId:'skill-approval-v1', contractShapeId:'admin-skill-approval-reject-shape-v1' }),
]);
async function handleTreePurchase(req,res,options,route) {
    if (String(req.method||'').toUpperCase() !== 'POST') { sendJson(res,405,{ok:false,error:'method_not_allowed',message:'Método não permitido.'}); return true; }
    const db=options.getDb?.(); if (!db) { sendJson(res,503,{ok:false,error:'database_unavailable',message:'Banco indisponível.'}); return true; }
    const auth=await (options.authenticateSession || authenticateSiteSession)(db,extractBearerToken(req)); if(!auth.ok){sendJson(res,401,{ok:false,error:auth.reason||'unauthorized',message:'Sessão inválida ou expirada.'});return true;}
    const playerId=auth.player.id; const phase=await (options.getPlayerPhase || getPlayerPhase)(db,playerId); if(!phase.canPlay){sendJson(res,403,{ok:false,error:'game_blocked',message:'Personagem ainda não liberado para o jogo.',details:{phase:phase.phase}});return true;}
    const maintenance=getTreeMutationBlock({maintenanceMode:options.treeMaintenanceMode}); if(maintenance){sendJson(res,409,{ok:false,error:maintenance.reason,message:maintenance.message});return true;}
    const body=await readJsonBody(req); const nodeAlias=String(body.nodeId||body.nodeAlias||body.node||'').trim(); if(!nodeAlias){sendJson(res,400,{ok:false,error:'missing_node',message:'Informe nodeId ou nodeAlias.'});return true;}
    const details=await (options.getNodeDetails || getNodeDetails)(db,playerId,route.treeId,nodeAlias); if(!details.ok){sendJson(res,400,{ok:false,error:details.reason||'node_not_found',message:'Nó não encontrado.',details:{suggestions:details.suggestions||null,matches:details.matches||null}});return true;}
    if(details.nodeState.status==='approval'){
        const rr=await (options.mutationRunner || runEconomyMutationExclusive)(()=>(options.requestSkillApproval || requestSkillApproval)(db,playerId,route.treeId,details.node.id,playerId,{maintenanceMode:options.treeMaintenanceMode}),{operation:'POST /trees/:treeId/purchase approval',requestId:req.headers?.['x-request-id']||null});
        sendJson(res,202,{ok:true,applied:false,requiresApproval:true,requires_approval:true,request:rr.request,message:rr.created?'Pedido enviado para aprovação. Nenhum PH foi gasto.':'Este pedido já está aguardando aprovação. Nenhum PH foi gasto.'});return true;
    }
    const result=await (options.mutationRunner || runEconomyMutationExclusive)(()=>(options.buyNode || buyNode)(db,playerId,route.treeId,nodeAlias,playerId,{source:'site_purchase',maintenanceMode:options.treeMaintenanceMode,metadata:{via:'lovable_site'}}),{operation:'POST /trees/:treeId/purchase',requestId:req.headers?.['x-request-id']||null});
    if(!result.ok){sendJson(res,400,{ok:false,error:result.reason||'purchase_failed',message:result.message||'Compra não aplicada.',details:{reason:result.reason,node:result.node||result.details?.node||null,nodeState:result.nodeState||result.details?.nodeState||null,suggestions:result.suggestions||null,matches:result.matches||null}});return true;}
    sendJson(res,200,{ok:true,purchase:{tree:serializeTreeDefinition(result.tree),node:result.node,cost:result.cost,baseCost:result.baseCost,discount:result.discount,purchaseId:result.purchaseId,spend:result.spend},state:serializeTreeState(result.state)});return true;
}
async function handleAdmin(req,res,options,route,url){
    const method=String(req.method||'GET').toUpperCase(); const context=await resolveAdminContext(req,res,options); if(!context)return true; const {db,access}=context;
    if(!access.actor?.capabilities?.includes('player.manage')){
        sendJson(res,403,{ok:false,error:'missing_capability',message:'Seu perfil não possui permissão para revisar melhorias.',details:{capability:'player.manage'}});
        return true;
    }
    if(route.kind==='admin_list'){if(method!=='GET'){sendJson(res,405,{ok:false,error:'method_not_allowed',message:'Método não permitido.'});return true;}const requests=await (options.listSkillApprovals || listSkillApprovalRequests)(db,{status:String(url.searchParams.get('status')||'pending'),limit:Number(url.searchParams.get('limit')||200)});sendJson(res,200,{ok:true,requests});return true;}
    if(method!=='POST'){sendJson(res,405,{ok:false,error:'method_not_allowed',message:'Método não permitido.'});return true;}
    if(!REVIEW_ROLES.has(access.actor.role)){sendJson(res,403,{ok:false,error:'skill_approval_review_forbidden',message:'Seu perfil é somente leitura nesta fila.'});return true;}
    const body=await readJsonBody(req); const reason=String(body.reason||'').trim()||null; const action=route.decision==='approve'?(options.approveSkillApproval || approveSkillApproval):(options.rejectSkillApproval || rejectSkillApproval);
    const result=await runEconomyMutationExclusive(()=>action(db,route.requestRef,access.actor.id,reason,{maintenanceMode:options.treeMaintenanceMode}),{operation:`POST /admin/skill-approvals/:ref/${route.decision}`,requestId:req.headers?.['x-request-id']||null});sendJson(res,200,result);return true;
}
async function handleSkillApprovalHttp(req,res,options={}){
    const url=new URL(req.url||'/','http://localhost'); const route=parsePath(url.pathname); const method=String(req.method||'').toUpperCase(); const descriptor=matchDescriptor(SKILL_APPROVAL_ROUTE_DESCRIPTORS,method,url.pathname); if(!descriptor&&!SKILL_APPROVAL_ROUTE_DESCRIPTORS.some((item)=>item.match(url.pathname)))return false; setCors(req,res);
    if(String(req.method||'').toUpperCase()==='OPTIONS'){res.statusCode=204;res.end();return true;}
    try{return route.kind==='tree_purchase'?await handleTreePurchase(req,res,options,route):await handleAdmin(req,res,options,route,url);}catch(error){if(res.headersSent){res.end();return true;}sendJson(res,error instanceof SkillApprovalError?Number(error.status||400):Number(error?.status||400),{ok:false,error:error?.code||'skill_approval_request_failed',message:error?.message||'Não foi possível concluir a solicitação.',details:error?.details||null});return true;}
}
module.exports={REVIEW_ROLES,SKILL_APPROVAL_ROUTE_DESCRIPTORS,handleSkillApprovalHttp,parsePath,serializeTreeState};
