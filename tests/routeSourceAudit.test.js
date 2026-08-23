'use strict';
const assert=require('node:assert/strict'); const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path'); const test=require('node:test');
const { discoveredRoutes }=require('../helpers/clover/routeSourceAudit');
test('F7 source route discovery finds runtime paths',()=>assert.ok(discoveredRoutes().length>0));
test('F7 discovery exposes a synthetic unregistered route',t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'clover-f7-route-')); const f=path.join(d,'router.js'); fs.writeFileSync(f,"if (path === '/unregistered-critical') {}\n"); t.after(()=>fs.rmSync(d,{recursive:true,force:true})); assert.ok(discoveredRoutes([f]).includes('/unregistered-critical'));});
