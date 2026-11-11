import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {createPluginWorkerHandle}=await import(process.env.LOCAL_SCOPE_HOST??'./.generated/host-candidate.mjs');
const root=path.dirname(fileURLToPath(import.meta.url));
test('settlement notification MUST NOT retire a still-live agent-origin request',async()=>{
 let calls=0;
 const handle=createPluginWorkerHandle('local.security',{entrypointPath:path.join(root,'settlement-adversary.cjs'),manifest:{id:'local.security',apiVersion:1,version:'1',displayName:'fixture',description:'fixture',author:'local',categories:['automation'],capabilities:[],entrypoints:{worker:'fixture'}},config:{},instanceInfo:{instanceId:'local',hostVersion:'fixture'},apiVersion:1,proactiveCompanyScopes:['company-a'],hostHandlers:{'agents.list':async()=>{calls++;return[];}}});
 try{
  await handle.start();
  const active=handle.call('executeTool',{toolName:'hold',parameters:{},runContext:{companyId:'company-a',agentId:'agent-a',runId:'run-a'}},2000);
  await assert.rejects(handle.call('getData',{key:'probe',params:{}},2000),{code:-32005});
  await active;
  assert.equal(calls,0);
 }finally{await handle.stop();}
});
test('two events settle independently; unknown/repeated settlement cannot retire the other and stale IDs remain denied',async()=>{
 let calls=0;
 const handle=createPluginWorkerHandle('local.events',{entrypointPath:path.join(root,'notification-race.cjs'),manifest:{id:'local.events',apiVersion:1,version:'1',displayName:'fixture',description:'fixture',author:'local',categories:['automation'],capabilities:[],entrypoints:{worker:'fixture'}},config:{},instanceInfo:{instanceId:'local',hostVersion:'fixture'},apiVersion:1,hostHandlers:{'db.query':async()=>{calls++;return[];}}});
 const call=params=>handle.call('getData',{key:'probe',params},2000);
 try{
  await handle.start();
  handle.notify('onEvent',{event:{companyId:'company-a',payload:{key:'one'}}});
  handle.notify('onEvent',{event:{companyId:'company-a',payload:{key:'two'}}});
  assert.equal(await call({count:true}),2);
  await assert.rejects(call({settle:'unknown'}),{code:-32005});
  await assert.rejects(call({settle:'one'}),{code:-32005});
  await assert.rejects(call({settle:'one'}),{code:-32005});
  assert.equal(calls,0);
  assert.deepEqual(await call({settle:'two'}),[]);
  await assert.rejects(call({echo:'one'}),{code:-32005});
  await assert.rejects(call({echo:'unknown'}),{code:-32005});
  assert.equal(calls,1);
  assert.deepEqual(await call({settle:'two'}),[]);
  assert.equal(calls,2);
 }finally{await handle.stop();}
});
