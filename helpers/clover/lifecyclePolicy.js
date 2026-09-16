'use strict';

const {AsyncLocalStorage}=require('node:async_hooks');
const lifecycleContexts=new AsyncLocalStorage();
function runWithLifecycleContext(context,work){return lifecycleContexts.run(context,work);}

const MUTATION_CLASSES = Object.freeze({READ_ONLY:'READ_ONLY',PRE_RESET:'PRE_RESET',SETTLEMENT:'SETTLEMENT',MAINTENANCE:'MAINTENANCE',CURRENT_WORLD:'CURRENT_WORLD',EXTERNAL_EFFECT:'EXTERNAL_EFFECT'});
const classes = new Set(Object.values(MUTATION_CLASSES));
function isPreResetLifecycle(env = lifecycleContexts.getStore()?.env || process.env, lifecycle) {
    if (String(lifecycle || '').toLowerCase().startsWith('pre_reset')) return true;
    if (lifecycleContexts.getStore()?.canonicalWorldReady === true) return false;
    const mode = String(env?.PRE_RESET || '').trim().toLowerCase();
    return Boolean(mode && !['off','false','0'].includes(mode))
        || env?.PRE_RESET_LAUNCH_ENABLED === 'true' || env?.PRE_RESET_RETURN_ENABLED === 'true';
}
function evaluateLifecyclePolicy(context = {}) {
    const inherited=lifecycleContexts.getStore() || {};
    context={...inherited,...context,env:context.env || inherited.env || process.env};
    const mutationClass = classes.has(context.mutationClass) ? context.mutationClass : MUTATION_CLASSES.CURRENT_WORLD;
    const active = context.canonicalWorldReady === true
        ? String(context.lifecycle || '').toLowerCase().startsWith('pre_reset')
        : isPreResetLifecycle(context.env || process.env,context.lifecycle);
    const explicit = Boolean(context.operation && context.surface && classes.has(context.mutationClass));
    const allowedClass = ['READ_ONLY','PRE_RESET','SETTLEMENT','MAINTENANCE'].includes(mutationClass);
    const externalApproved = mutationClass === 'EXTERNAL_EFFECT' && context.externalDecision === 'allow'
        && ['whatsapp.read_receipts','private_delivery.existing_job'].includes(context.operation);
    const ok = !active || (explicit && (allowedClass || externalApproved));
    return Object.freeze({ok,active,code:ok ? null:'lifecycle_current_world_blocked',
        lifecycle:context.lifecycle || (active ? 'pre_reset':'current_world'),surface:context.surface || 'internal',
        operation:context.operation || 'unclassified',mutationClass,
        actorId:context.actorId || null,authorization:context.authorization ?? null});
}
class LifecyclePolicyError extends Error {
    constructor(decision) {
        super('Operacao do mundo atual bloqueada durante PRE_RESET.');
        this.code=decision.code; this.status=423; this.decision=decision;
    }
}
function assertLifecycleAllowed(context) {
    const decision=evaluateLifecyclePolicy(context);
    if (!decision.ok) throw new LifecyclePolicyError(decision);
    return decision;
}
function lifecycleSkip(context) {
    const decision=evaluateLifecyclePolicy(context);
    return decision.ok ? null : {ok:false,skipped:true,reason:decision.code,decision};
}
function classifyCommandLifecycle(command,phase,env=process.env) {
    const {normalizeCommandText}=require('../textUtils');
    const {canUseCommandInPhase}=require('./playerPhase');
    const {COMMAND_PREFIX}=require('../../config/bot');
    const name=normalizeCommandText(command.nome);
    const basic=new Set(['ping','ajuda','status','reinos','racas','classes','classessociais','grimorios','familias'].map(n=>normalizeCommandText(COMMAND_PREFIX+n)));
    const admin=new Set(['lojaretornoadmin','preResetAdmin','preresetadmin'].map(n=>normalizeCommandText(COMMAND_PREFIX+n)));
    if (command.lifecycleMutationClass && classes.has(command.lifecycleMutationClass)) return command.lifecycleMutationClass;
    if (basic.has(name)) return 'READ_ONLY';
    if (admin.has(name)) return 'PRE_RESET';
    if (env.PRE_RESET_LAUNCH_ENABLED === 'true' && env.PRE_RESET_RETURN_ENABLED === 'true'
        && String(phase).startsWith('pre_reset') && canUseCommandInPhase(name,phase)) return 'PRE_RESET';
    return 'CURRENT_WORLD';
}

const HTTP_LIFECYCLE_BY_DESCRIPTOR_ID = Object.freeze(new Map([
    ...[
        'site.routePublic.get.root', 'site.routePublic.get.health', 'site.routeAuthed.get.me',
        'site.routeAuthed.get.status', 'site.routeAuthed.get.character.appearance', 'raid.categories.read',
    ].map((id) => [id, MUTATION_CLASSES.READ_ONLY]),
    ...[
        'site.routePublic.post.auth.login', 'site.routeAuthed.post.auth.logout',
        'reception.read', 'site.routeAuthed.get.access', 'site.routeAuthed.get.context',
        'site.routeAuthed.get.bonus', 'site.routeAuthed.get.bonuses', 'site.routeAuthed.get.shops',
        'site.routeAuthed.get.shops.key', 'site.routeAuthed.get.inventory', 'site.routeAuthed.get.boxes',
        'admin.command-center.inbox', 'admin.command-center.history', 'admin.raid-reward-proposals.list',
        'admin.items.list', 'admin.rewards.list', 'raid.options.read', 'raid.usage.read',
        'raid.checklist.read', 'raid.reward-proposals.list', 'raid.finalization.summary',
        'site.routeAuthed.get.squads.key.members', 'site.routeAuthed.get.squads.key.upgrades',
        'squad.operations.read', 'squad.member-candidates.read',
    ].map((id) => [id, MUTATION_CLASSES.MAINTENANCE]),
    ...[
        'site.routeAuthed.get.economy', 'site.routeAuthed.get.economy.salary',
        'site.routeAuthed.get.economy.market', 'site.routeAuthed.get.economy.market.dashboard',
    ].map((id) => [id, MUTATION_CLASSES.SETTLEMENT]),
]));

function requestPathname(req) {
    const requestTarget = String(req?.url || '/');
    return new URL(requestTarget, 'http://localhost').pathname;
}

function canonicalHttpLifecycle(method, pathname) {
    const { RUNTIME_DESCRIPTOR_GROUPS } = require('./siteApiContractRegistry');
    const descriptor = RUNTIME_DESCRIPTOR_GROUPS.flat().find((candidate) => (
        candidate.methods.includes(method) && candidate.match(pathname)
    ));
    if (!descriptor) return null;
    if (descriptor.id.startsWith('prereset.')) return MUTATION_CLASSES.PRE_RESET;
    return HTTP_LIFECYCLE_BY_DESCRIPTOR_ID.get(descriptor.id) || null;
}

// Canonical descriptor IDs classify shared HTTP routes. Unknown paths and
// methods remain current-world, including GET.
function classifyHttpLifecycle(req) {
    const method=String(req.method || 'GET').toUpperCase();
    const path=requestPathname(req);
    if(method==='OPTIONS') return MUTATION_CLASSES.READ_ONLY;
    const {PRE_RESET_ROUTES}=require('./preResetSiteApiService');
    const {ROUTES}=require('./preResetTransitionAdminHttp');
    const {RETURN_SHOP_PATHS}=require('./returnPointShopHttp');
    if(PRE_RESET_ROUTES.some(r=>r.match(path)&&r.methods.includes(method))
        || Object.values(ROUTES).includes(path) || RETURN_SHOP_PATHS.has(path)) return MUTATION_CLASSES.PRE_RESET;
    return canonicalHttpLifecycle(method,path) || MUTATION_CLASSES.CURRENT_WORLD;
}

function createLifecycleInterval(operation,mutationClass,callback,delay,options={}) {
    const context={env:options.env || lifecycleContexts.getStore()?.env || process.env,surface:'timer',operation,mutationClass};
    if(lifecycleSkip(context)) return null;
    return (options.setInterval || setInterval)(()=>{
        if(lifecycleSkip(context)) return;
        return callback();
    },delay);
}

module.exports={MUTATION_CLASSES,LifecyclePolicyError,isPreResetLifecycle,evaluateLifecyclePolicy,assertLifecycleAllowed,lifecycleSkip,classifyCommandLifecycle,classifyHttpLifecycle,createLifecycleInterval,runWithLifecycleContext};
