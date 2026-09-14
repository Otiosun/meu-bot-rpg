'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const Module=require('node:module');
const {once}=require('node:events');
const originalLoad=Module._load;
let startSiteApiServer;
try {
 Module._load=function(request,parent,isMain){
  if(request==='./siteApiServerLegacy'&&parent?.filename.endsWith('siteApiServer.js'))return {startSiteApiServer:options=>http.createServer(options.testListener)};
  return originalLoad.call(this,request,parent,isMain);
 };
 ({startSiteApiServer}=require('../helpers/clover/siteApiServer'));
}finally{Module._load=originalLoad;}
test('HTTP central boundary rejects Owner/admin and player current-world mutations before handlers; diagnostics and modern endpoints survive',async(t)=>{
 let calls=0;
 const server=startSiteApiServer({env:{PRE_RESET_LAUNCH_ENABLED:'true'},testListener:(req,res)=>{calls++;res.end('diagnostic');}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const base='http://127.0.0.1:'+server.address().port;
 for(const [method,url] of [['PUT','/character/profile-image'],['POST','/raids'],['POST','/squads/example/members'],['POST','/admin/players/approve'],['GET','/attributes'],['GET','/unclassified-read']]){
  const response=await fetch(base+url,{method,headers:{'X-Owner':'true'}});assert.equal(response.status,423,url);assert.equal((await response.json()).error,'lifecycle_current_world_blocked');
 }
 assert.equal(calls,0);
 const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal(await health.text(),'diagnostic');assert.equal(calls,1);
 const modern=await fetch(base+'/return-points/shop/purchase',{method:'POST'});assert.equal(modern.status,503);assert.equal((await modern.json()).error,'database_unavailable');assert.equal(calls,1);
});
