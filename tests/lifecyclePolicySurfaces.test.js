'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const policy=require('../helpers/clover/lifecyclePolicy');
const frozen={PRE_RESET_LAUNCH_ENABLED:'true',PRE_RESET_RETURN_ENABLED:'true'};
const previous={PRE_RESET:process.env.PRE_RESET,PRE_RESET_LAUNCH_ENABLED:process.env.PRE_RESET_LAUNCH_ENABLED,PRE_RESET_RETURN_ENABLED:process.env.PRE_RESET_RETURN_ENABLED};
Object.assign(process.env,frozen);
test.after(()=>{for(const [k,v] of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;});
let effects=0;
const forbidden=()=>{effects++;throw Error('unexpected database/transport effect');};
const db={get:forbidden,all:forbidden,run:forbidden,exec:forbidden};
const sock={sendMessage:forbidden,groupParticipantsUpdate:forbidden,groupRequestParticipantsUpdate:forbidden};
const input={sock,db,m:{},idChat:'group@g.us',idJogador:'player',playerId:'player',groupId:'group@g.us',participants:['player']};
function internal(file,name){
 const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
 const start=source.search(new RegExp('(?:async )?function '+name+'\\('));
 assert.notEqual(start,-1,name);
 const end=source.indexOf('\n}',start)+2;
 assert.ok(end>start,name);
 return vm.runInNewContext(source.slice(start,end)+'\n'+name,{...policy});
}
async function denied(fn){effects=0;await assert.rejects(fn,e=>e.code==='lifecycle_current_world_blocked'&&e.status===423);assert.equal(effects,0);}
for(const actor of ['owner','normal'])test(actor+' cannot bypass current world',()=>{
 const decision=policy.evaluateLifecyclePolicy({env:frozen,surface:'command',operation:'legacy.admin',mutationClass:'CURRENT_WORLD',authorization:{isOwner:actor==='owner',isAdmin:true},actorId:actor});
 assert.equal(decision.ok,false);assert.equal(decision.actorId,actor);assert.equal(decision.authorization.isAdmin,true);
});
for(const mutationClass of ['READ_ONLY','PRE_RESET','SETTLEMENT','MAINTENANCE'])test(mutationClass+' explicit operation remains allowed',()=>{
 assert.equal(policy.evaluateLifecyclePolicy({env:frozen,surface:'internal',operation:'verified.operation',mutationClass}).ok,true);
});
test('partial flags freeze current world; missing classification cannot bypass',()=>{
 assert.equal(policy.evaluateLifecyclePolicy({env:{PRE_RESET_RETURN_ENABLED:'true'},surface:'http',operation:'GET unknown'}).ok,false);
 assert.equal(policy.evaluateLifecyclePolicy({env:frozen,mutationClass:'READ_ONLY'}).ok,false);
});
test('external effects require operation-specific approval',()=>{
 assert.equal(policy.evaluateLifecyclePolicy({env:frozen,surface:'worker',operation:'arbitrary.send',mutationClass:'EXTERNAL_EFFECT',externalDecision:'allow'}).ok,false);
});
for(const name of ['tryHandleProfilePlainText','tryHandleMagicPlainText'])test(name+' blocked before read/write',async()=>{
 effects=0;assert.equal(await internal('index.js',name)(input),false);assert.equal(effects,0);
});
for(const name of ['tryHandleQuickEvaluation'])test(name+' interceptor blocked',async()=>{
 effects=0;assert.equal(await require('../helpers/clover/quickEvaluationService')[name](input),false);assert.equal(effects,0);
});
for(const name of ['tryHandleAppearanceReviewReply','tryHandleAppearanceReaction','tryAttachAppearanceImage'])test(name+' blocked before attachment or transport',async()=>{
 effects=0;assert.equal(await require('../helpers/clover/appearanceManager')[name](input),false);assert.equal(effects,0);
});
test('appearance approval cannot release game/stats/PH',()=>denied(()=>internal('helpers/clover/appearanceManager.js','evaluateAppearanceReview')({...input,action:'approve',review:{player_id:'player'}})));
test('profile preservation cannot restore released access',()=>denied(()=>require('../helpers/clover/profileAccessPreservationService').restoreReleasedAccessAfterProfileConfirmation(db,'player',{released:true})));
test('legacy profile confirmation blocked',()=>denied(()=>require('../helpers/profileForms').confirmPendingProfile(db,'player')));
test('legacy magic confirmation blocked',()=>denied(()=>require('../helpers/magicManager').confirmPendingMagicChoice(db,'player')));
test('private post-ficha instructions cannot release onboarding',()=>denied(()=>require('../helpers/clover/registrationManager').maybeSendPostFichaPrivateInstructions(sock,db,'player')));
test('story approval blocked before writes',()=>denied(()=>internal('comandos/historiaJogo.js','approveStory')({...input,targetId:'player'})));
test('admin release blocked independently of authorization',()=>denied(()=>internal('comandos/historiaJogo.js','releaseGame')({...input,targetId:'player'})));
test('legacy stats are not initialized',()=>denied(()=>require('../helpers/clover/characterStats').ensureCharacterStats({...db,get:async()=>null},'player')));
test('existing stats can be read without initialization',async()=>{
 const existing={player_id:'player'};effects=0;assert.equal(await require('../helpers/clover/characterStats').ensureCharacterStats({...db,get:async()=>existing},'player'),existing);assert.equal(effects,0);
});
test('initial PH is not granted',()=>denied(()=>require('../helpers/clover/phService').ensurePhState({...db,get:async()=>null},'player')));
test('initialized PH read does not write or reinitialize',async()=>{
 const existing={ph_available:7,ph_accumulated:20};effects=0;
 assert.equal(await require('../helpers/clover/phService').ensurePhState({...db,get:async(sql)=>sql.includes('clover_ph_ledger')?{id:1}:existing},'player'),existing);assert.equal(effects,0);
});
test('admin PH adjustment blocked before ledger writes',()=>denied(()=>require('../helpers/clover/phService').adminAdjustPh(db,'player',10,'test','owner')));
test('weekly worker cannot generate current-world rewards',()=>denied(()=>require('../helpers/clover/checklistService').runWeeklyChecklistResetDispatch(db,{})));
test('expired exit worker cannot reset old player',()=>denied(()=>require('../helpers/clover/communityExitManager').processExpiredExitConfirmations({db,sock})));
test('spell scheduler creates no timer during freeze',()=>{
 const result=require('../helpers/clover/spellReviewFlowOrchestrator').startSpellReviewFlowScheduler({env:frozen});assert.equal(result.timer,null);assert.equal(result.skipped,true);
});
for(const name of ['sendWelcomeIfNeeded','sendOffWelcomeIfNeeded','handleCommunityParticipantAdd','handleCommunityParticipantRemove'])test(name+' JOIN/LEAVE cannot create or alter old player',async()=>{
 effects=0;assert.equal((await internal('index.js',name)(input)).skipped,true);assert.equal(effects,0);
});
for(const name of ['tryApproveOffGroupJoinRequests','tryApproveSpellReviewJoinRequests'])test(name+' causes no group transport effect',async()=>{
 effects=0;assert.equal((await require('../helpers/clover/groupManager')[name](input)).handled,false);assert.equal(effects,0);
});
test('weekly market obligation generation blocked; no economy shutdown',async()=>{
 effects=0;const result=await require('../helpers/clover/marketService').ensureWeeklyNpcRequests(db);assert.equal(result.created,0);assert.equal(result.skipped,true);assert.equal(effects,0);
 assert.equal(policy.classifyHttpLifecycle({method:'GET',url:'/economy/salary'}),'SETTLEMENT');
});
test('queued old game-release notification is blocked',()=>{
 const result=require('../helpers/clover/privateDeliveryWorker').evaluateQueuedPrivateJob({kind:'private_text',payload_json:JSON.stringify({source:'game_liberated'})},frozen);assert.equal(result.allowed,false);assert.equal(result.reason,'lifecycle_current_world_blocked');
});
test('Owner allowGameBypass cannot override pre-reset command phase',()=>{
 const {canUseCommandInPhase,PHASES}=require('../helpers/clover/playerPhase');assert.equal(canUseCommandInPhase('.darph',PHASES.PRE_RESET_BUILD,{allowGameBypass:true}),false);
});
test('future command classification preserves modern allowlist; continuar is not read-only',()=>{
 const {COMMAND_PREFIX}=require('../config/bot');
 assert.equal(policy.classifyCommandLifecycle({nome:COMMAND_PREFIX+'continuar'},'jogo_liberado',frozen),'CURRENT_WORLD');
 assert.equal(policy.classifyCommandLifecycle({nome:COMMAND_PREFIX+'Ficha Nova'},'pre_reset_build',frozen),'PRE_RESET');
});
test('mutable and side-effectful HTTP default closed; modern endpoints survive',()=>{
 for(const [method,url] of [['PUT','/character/profile-image'],['POST','/raids'],['POST','/squads/example/members'],['POST','/admin/rewards/grant'],['GET','/attributes'],['GET','/unknown']])assert.equal(policy.classifyHttpLifecycle({method,url}),'CURRENT_WORLD');
 for(const [method,url] of [['POST','/return-points/shop/purchase'],['POST','/pre-reset/future-character'],['GET','/pre-reset/admin/launch/roster']])assert.equal(policy.classifyHttpLifecycle({method,url}),'PRE_RESET');
 assert.equal(policy.classifyHttpLifecycle({method:'GET',url:'/health'}),'READ_ONLY');
});

test('private anti-ghost and exit interceptors do not swallow modern commands',async()=>{
 effects=0;
 assert.equal((await require('../helpers/clover/antiGhostService').handleAntiGhostPrivateReply(input)).handled,false);
 assert.equal((await require('../helpers/clover/communityExitManager').handleExitConfirmationReply(input)).handled,false);
 assert.equal(effects,0);
});
test('current-world timers are not installed; settlement timers install and recheck policy',()=>{
 let installs=0,tick,calls=0;
 const setInterval=callback=>{installs++;tick=callback;return 'timer';};
 assert.equal(policy.createLifecycleInterval('legacy.timer','CURRENT_WORLD',()=>calls++,1,{env:frozen,setInterval}),null);assert.equal(installs,0);
 assert.equal(policy.createLifecycleInterval('existing.salary','SETTLEMENT',()=>calls++,1,{env:frozen,setInterval}),'timer');tick();assert.equal(calls,1);
 const env={};policy.createLifecycleInterval('world.timer','CURRENT_WORLD',()=>calls++,1,{env,setInterval});env.PRE_RESET_RETURN_ENABLED='true';tick();assert.equal(calls,1);
});
test('direct player creation and onboarding release are blocked',async()=>{
 const registry=require('../helpers/playerRegistry');
 await denied(()=>registry.ensurePlayerRecord({...db,get:async()=>null},'player'));
 await denied(()=>registry.updateOnboardingStep(db,'player','jogo_liberado'));
});

test('legacy trait attempt cannot inherit a read-only catalog exemption',async()=>{
 const {COMMAND_PREFIX}=require('../config/bot');assert.equal(policy.classifyCommandLifecycle({nome:COMMAND_PREFIX+'tracos'},'jogo_liberado',frozen),'CURRENT_WORLD');
 await denied(()=>require('../helpers/clover/traitManager').runSpecialAttempt(db,'player','aptidao'));
});
test('status for modern player absent from old world does not create legacy player/onboarding',async()=>{
 effects=0;const command=require('../comandos/status');
 const safeDb={...db,get:async(sql)=>{
  if(sql.includes('jogadores')||sql.includes('player_onboarding'))return null;
  return null;
 },all:async()=>[]};
 // Exercise the real status command with only its phase/future-reader dependencies substituted.
 const source=fs.readFileSync(path.join(__dirname,'../comandos/status.js'),'utf8');
 const Module=require('node:module');const module=new Module(path.join(__dirname,'../comandos/status.js'));module.filename=path.join(__dirname,'../comandos/status.js');module.paths=Module._nodeModulePaths(path.dirname(module.filename));
 const originalRequire=module.require.bind(module);let messages=0;
 module.require=request=>request==='../helpers/clover/playerPhase'?{...require('../helpers/clover/playerPhase'),getPlayerPhase:async()=>({phase:'pre_reset_wait',player:null})}:request==='../helpers/chatReply'?{sendReply:async()=>{messages++;}}:originalRequire(request);
 module._compile(source,module.filename);await module.exports.executar({...input,db:safeDb});assert.equal(messages,1);assert.equal(effects,0);
});

test('internal lifecycle context propagates across awaits without changing global flags',async()=>{
 await policy.runWithLifecycleContext({env:{PRE_RESET_RETURN_ENABLED:'true'},surface:'http',operation:'request'},async()=>{
  await Promise.resolve();assert.equal(policy.evaluateLifecyclePolicy({surface:'internal',operation:'nested.write',mutationClass:'CURRENT_WORLD'}).ok,false);
 });
 await policy.runWithLifecycleContext({env:{}},async()=>{
  await Promise.resolve();assert.equal(policy.evaluateLifecyclePolicy({surface:'internal',operation:'nested.write',mutationClass:'CURRENT_WORLD'}).ok,true);
 });
 assert.equal(process.env.PRE_RESET_RETURN_ENABLED,'true');
});

test('frozen settlement pays an existing salary obligation exactly once and maintenance cleans only welcome state',async(t)=>{
 const Module=require('node:module');
 const fixturePath=path.join(__dirname,'economyOperationsV1.test.js');
 const source=fs.readFileSync(fixturePath,'utf8');
 const fixtureModule=new Module(fixturePath);fixtureModule.filename=fixturePath;fixtureModule.paths=Module._nodeModulePaths(__dirname);
 fixtureModule._compile(source.slice(0,source.indexOf("test('"))+'\nmodule.exports={createTestDb,PLAYER};',fixturePath);
 const {createTestDb,PLAYER}=fixtureModule.exports;
 const salaryDb=await createTestDb({money:0});t.after(()=>salaryDb.close());
 const week='2026-09-07';
 await salaryDb.run("INSERT INTO clover_quick_evaluations(message_key,chat_id,player_id,evaluator_id,modality_key,modality_label,week_key,bypass_weekly_limit,salary_eligible,salary_service_type) VALUES ('existing-salary','on@g.us',?,'admin','missao_auto_narrada','Existing Mission',?,0,1,'missao_auto_narrada')",[PLAYER,week]);
 const economy=require('../helpers/clover/economyService');
 const first=await economy.paySalaryForWeek(salaryDb,PLAYER,week);const retry=await economy.paySalaryForWeek(salaryDb,PLAYER,week);
 assert.equal(first.paid,true);assert.equal(first.claim.amount,750);assert.equal(retry.duplicate,true);
 assert.equal((await require('../helpers/clover/yullsService').getYullsSummary(salaryDb,PLAYER)).total,750);
 assert.equal((await salaryDb.get('SELECT COUNT(*) AS total FROM clover_salary_claims')).total,1);
 await salaryDb.exec('CREATE TABLE IF NOT EXISTS group_member_welcomes(group_id TEXT,player_id TEXT,last_seen_at TEXT)');
 await salaryDb.run('INSERT INTO group_member_welcomes(group_id,player_id) VALUES (?,?)',['group',PLAYER]);
 await require('../helpers/playerRegistry').clearGroupMemberState(salaryDb,'group',PLAYER);
 assert.equal((await salaryDb.get('SELECT COUNT(*) AS total FROM group_member_welcomes')).total,0);
 assert.equal((await salaryDb.get('SELECT COUNT(*) AS total FROM clover_character_stats')).total,0);
 assert.equal((await salaryDb.get('SELECT COUNT(*) AS total FROM clover_ph_ledger')).total,0);
 assert.equal((await salaryDb.get('SELECT jogo_status FROM jogadores WHERE id=?',[PLAYER])).jogo_status,'liberado');
});
