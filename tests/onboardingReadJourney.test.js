'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const sqlite3=require('sqlite3');
const {open}=require('sqlite');
const {getPlayerPhase,PHASES}=require('../helpers/clover/playerPhase');
async function setup(){
    const db=await open({filename:':memory:',driver:sqlite3.Database});
    await db.exec("CREATE TABLE jogadores(id TEXT PRIMARY KEY, ficha_status TEXT, jogo_status TEXT, historia_status TEXT, personagem_aparencia_status TEXT, magia TEXT, numero_roll_escolhido INTEGER,canonical_player_id TEXT,merged_into TEXT,roll_sacrifice_used INTEGER DEFAULT 0); CREATE TABLE player_onboarding(player_id TEXT PRIMARY KEY,current_step TEXT,step_payload TEXT); CREATE TABLE player_rolls(player_id TEXT,roll_number INTEGER,kingdom TEXT,magic_rarity TEXT); CREATE TABLE pending_profile_confirmations(player_id TEXT PRIMARY KEY,payload TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP); CREATE TABLE pending_magic_confirmations(player_id TEXT PRIMARY KEY,magic_label TEXT,roll_number INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP);");
    return db;
}
function withMockReply(path,replies){
    const Module=require('node:module');
    const resolved=require.resolve(path);
    const original=Module._load;
    delete require.cache[resolved];
    Module._load=function(request,parent,isMain){
        if(parent?.filename===resolved&&request==='../helpers/chatReply') return {sendReply:async({text})=>replies.push(text)};
        return original.call(this,request,parent,isMain);
    };
    try{return require(resolved);}finally{Module._load=original;delete require.cache[resolved];}
}
test('status e continuar não criam cadastro de quem apenas consulta',async t=>{
    const db=await setup();t.after(()=>db.close());
    const replies=[];
    const args={db,sock:{},m:{},idChat:'fixture@g.us',idJogador:'visitor',nomeUsuario:'Visitante'};
    await withMockReply('../comandos/status',replies).executar(args);
    await withMockReply('../comandos/continuar',replies).executar(args);
    assert.match(replies[0],/novo cadastro/);
    assert.match(replies[1],/recepção não iniciada/);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM jogadores')).n,0);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM player_onboarding')).n,0);
});
test('fase e comandos leem a mesma identidade canônica e ignoram confirmações expiradas',async t=>{
    const db=await setup();t.after(()=>db.close());
    await db.run("INSERT INTO jogadores(id, ficha_status, magia, numero_roll_escolhido) VALUES ('canonical','incompleta','-',2)");
    await db.run("INSERT INTO jogadores(id,merged_into) VALUES ('shadow','canonical')");
    await db.run("INSERT INTO player_onboarding VALUES ('canonical','confirmar_magia','{}')");
    await db.run("INSERT INTO player_rolls VALUES('canonical',2,'Clover','Comum')");
    await db.run("INSERT INTO pending_magic_confirmations VALUES('canonical','Magia de Fogo',2,datetime('now','-2 hours'))");
    await db.run("INSERT INTO pending_profile_confirmations VALUES('canonical','{}',datetime('now','-8 days'))");
    let phase=await getPlayerPhase(db,'shadow');
    assert.equal(phase.phase,PHASES.ROLL_ESCOLHIDO);
    assert.equal(phase.pendingProfile,false);
    assert.equal(phase.pendingMagic,false);
    const replies=[];
    const args={db,sock:{},m:{},idChat:'fixture@g.us',idJogador:'shadow'};
    await withMockReply('../comandos/status',replies).executar(args);
    await withMockReply('../comandos/continuar',replies).executar(args);
    assert.match(replies[0],/#02/);
    assert.match(replies[1],/magia expirada/);
    assert.equal((await db.get("SELECT current_step FROM player_onboarding WHERE player_id='canonical'")).current_step,'confirmar_magia');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM pending_magic_confirmations')).n,1);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM pending_profile_confirmations')).n,1);
    await db.run("UPDATE pending_magic_confirmations SET created_at=CURRENT_TIMESTAMP");
    phase=await getPlayerPhase(db,'shadow');
    assert.equal(phase.phase,PHASES.MAGIA_PENDENTE);
    assert.equal(phase.pendingMagicData.magic_label,'Magia de Fogo');
    replies.length=0;
    await withMockReply('../comandos/status',replies).executar(args);
    await withMockReply('../comandos/continuar',replies).executar(args);
    assert.match(replies[0],/Magia de Fogo/);
    assert.match(replies[1],/confirmar magia/);
});
