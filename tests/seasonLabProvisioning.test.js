'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {provisionSeasonLab,verifySeasonLab,EMPTY_TABLES}=require('../helpers/clover/seasonLabProvisioning');
const {aliasCandidatesFromInput}=require('../helpers/clover/targetResolver');

test('temporada offline: provisiona banco real exclusivo, sem registros e sem credenciais',async t=>{
    const base=await fs.mkdtemp(path.join(os.tmpdir(),'clover-isolated-season-'));
    t.after(()=>fs.rm(base,{recursive:true,force:true}));
    const root=path.join(base,'new-season');
    const result=await provisionSeasonLab(root);
    assert.equal(result.status,'ready_offline');
    assert.equal(result.runtimeEnabled,false);
    assert.deepEqual(Object.keys(result.emptyTables),EMPTY_TABLES);
    assert.ok(Object.values(result.emptyTables).every(n=>n===0));
    assert.deepEqual(await fs.readdir(path.join(root,'auth')),[]);
    assert.equal((await fs.stat(path.join(root,'season.sqlite'))).isFile(),true);
    await assert.rejects(()=>fs.stat(path.join(root,'owner-access.json')),e=>e.code==='ENOENT');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'season-lab.json'),'utf8')),result);
    await assert.rejects(()=>provisionSeasonLab(root),e=>e.code==='EEXIST');
    await assert.rejects(()=>provisionSeasonLab('relative-path'),/absoluto/);
    await assert.rejects(()=>provisionSeasonLab(path.join(__dirname,'unsafe-season')),/fora do repositório/);
    const backup=path.join(base,'old-db.sqlite');
    await fs.writeFile(backup,'historical-fixture');
    await assert.rejects(()=>provisionSeasonLab(backup),e=>e.code==='EEXIST');
    assert.equal(await fs.readFile(backup,'utf8'),'historical-fixture');
});
test('diretório de autenticação explícito é usado também na busca de aliases',async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'clover-mapping-test-'));
    const previous=process.env.CLOVER_AUTH_INFO_DIR;
    t.after(async()=>{if(previous===undefined)delete process.env.CLOVER_AUTH_INFO_DIR;else process.env.CLOVER_AUTH_INFO_DIR=previous;await fs.rm(dir,{recursive:true,force:true});});
    process.env.CLOVER_AUTH_INFO_DIR=dir;
    const phone='10000000001',lid='10000000002';
    await fs.writeFile(path.join(dir,'lid-mapping-'+phone+'.json'),JSON.stringify({lid}));
    await fs.writeFile(path.join(dir,'lid-mapping-'+lid+'_reverse.json'),JSON.stringify({phoneNumber:phone}));
    assert.ok(aliasCandidatesFromInput(phone).some(c=>c.type==='lid'&&c.value===lid+'@lid'));
    process.env.CLOVER_AUTH_INFO_DIR=path.join(dir,'empty');
    await fs.mkdir(process.env.CLOVER_AUTH_INFO_DIR);
    assert.ok(!aliasCandidatesFromInput(phone).some(c=>c.value===lid+'@lid'));
});

test('verificação separada recusa banco contaminado, credenciais e manifesto inconsistente',async t=>{
    const base=await fs.mkdtemp(path.join(os.tmpdir(),'clover-lab-recheck-'));
    t.after(()=>fs.rm(base,{recursive:true,force:true}));
    const root=path.join(base,'season');
    const manifest=await provisionSeasonLab(root);
    assert.equal((await verifySeasonLab(root)).ok,true);
    await fs.writeFile(path.join(root,'auth','fictional-session.json'),'{}');
    await assert.rejects(()=>verifySeasonLab(root),/autenticação não está vazio/);
    await fs.unlink(path.join(root,'auth','fictional-session.json'));
    await fs.writeFile(path.join(root,'owner-access.json'),'{}');
    await assert.rejects(()=>verifySeasonLab(root),/proprietário/);
    await fs.unlink(path.join(root,'owner-access.json'));
    const file=path.join(root,'season-lab.json');
    await fs.writeFile(file,JSON.stringify({...manifest,runtimeEnabled:true}));
    await assert.rejects(()=>verifySeasonLab(root),/Manifesto/);
    await fs.writeFile(file,JSON.stringify(manifest));
    assert.equal((await verifySeasonLab(root)).ok,true);
    const sqlite3=require('sqlite3'),{open}=require('sqlite');
    const db=await open({filename:path.join(root,'season.sqlite'),driver:sqlite3.Database});
    try{await db.run('INSERT INTO jogadores(id,nome,personagem_nome) VALUES (?,?,?)',['test-contamination','Teste','Teste']);}
    finally{await db.close();}
    await assert.rejects(()=>verifySeasonLab(root),/não está limpa: jogadores/);
});
test('marcação explícita de laboratório impede boot online e preparação da stack',()=>{
    const {assertOnlineStartupAllowed}=require('../helpers/clover/seasonLabStartupGuard');
    assert.doesNotThrow(()=>assertOnlineStartupAllowed({}));
    const env={CLOVER_SEASON_LAB_ROOT:'/fictional/season'};
    assert.throws(()=>assertOnlineStartupAllowed(env),e=>e.code==='season_lab_online_forbidden');
    const {buildStackEnv}=require('../scripts/startCloverSiteStack');
    assert.throws(()=>buildStackEnv(env),e=>e.code==='season_lab_online_forbidden');
});
