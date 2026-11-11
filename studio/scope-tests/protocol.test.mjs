import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createHostClientHandlers,PLUGIN_RPC_ERROR_CODES} from '@paperclipai/plugin-sdk';
import {createPluginWorkerHandle as original} from './.generated/host-original.mjs';
const {createPluginWorkerHandle:candidate}=await import(process.env.LOCAL_SCOPE_HOST??'./.generated/host-candidate.mjs');
const root=path.dirname(fileURLToPath(import.meta.url));
const company='00000000-0000-4000-8000-000000000001';
const foreign='00000000-0000-4000-8000-000000000002';
const denied={code:PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED};
const manifest={id:'fixture.scope',apiVersion:1,version:'1.0.0',displayName:'Local fixture',description:'Synthetic',author:'Local',categories:['automation'],capabilities:['events.subscribe','database.namespace.read','database.namespace.write','agents.read'],entrypoints:{worker:'sdk-fixture.mjs'}};
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
async function fixture({host=candidate,sdk=process.env.LOCAL_SCOPE_SDK??'candidate',write=true,discovery=false,state=false}={}){
 const eventEntered=deferred(),eventRelease=deferred(),agentEntered=deferred(),agentRelease=deferred(),calls=[];
 const hostHandlers=createHostClientHandlers({pluginId:manifest.id,capabilities:[...manifest.capabilities.filter(c=>write||c!=='database.namespace.write'),...(discovery?['companies.read']:[]),...(state?['plugin.state.read']:[])],services:{
  events:{subscribe:async()=>null},
  db:{namespace:async()=> 'fixture_scope',query:async p=>{
   calls.push(['query',p.sql,p.params]);
   if(p.sql==='EVENT_HOLD'){eventEntered.resolve();await eventRelease.promise;}
   if(p.sql==='AGENT_HOLD'){agentEntered.resolve();await agentRelease.promise;}
   return[{ok:true}];
  },execute:async p=>{calls.push(['execute',p.sql]);return{rowCount:1};}},
  agents:{list:async p=>{calls.push(['agents',p.companyId]);return[];}},
  companies:{list:async()=>{calls.push(['companies']);return[{id:company},{id:foreign}];}},
  state:{get:async()=>{calls.push(['state']);return 'unreachable-wildcard';}},
 }});
 const handle=host(manifest.id,{entrypointPath:path.join(root,'sdk-fixture.mjs'),manifest,config:{},instanceInfo:{instanceId:'local',hostVersion:'fixture'},apiVersion:1,proactiveCompanyScopes:[company],hostHandlers,env:{LOCAL_SCOPE_SDK:sdk}});
 await handle.start();
 return{handle,calls,eventEntered,eventRelease,agentEntered,agentRelease,async close(){eventRelease.resolve();agentRelease.resolve();await handle.stop();}};
}
const probe=h=>h.call('getData',{key:'probe',params:{}},2000);
const job=(h,target=company)=>h.call('runJob',{job:{jobKey:'fixture-job',runId:'local-run',trigger:'schedule',scheduledAt:new Date().toISOString(),target}},2000);
async function until(fn){let last;for(let i=0;i<40;i++){try{return await fn();}catch(e){last=e;await delay(10);}}throw last;}
test('native event scope denies only while handlers are live; settlement clears it',async()=>{
 const f=await fixture();try{
  assert.deepEqual(await probe(f.handle),[{ok:true}]);
  f.handle.notify('onEvent',{event:{eventType:'fixture.hold',companyId:company,payload:{id:'ok'}}});
  await f.eventEntered.promise;
  const before=f.calls.length;
  await assert.rejects(probe(f.handle),{...denied,message:'Missing or unknown invocation scope'});
  assert.equal(f.calls.length,before,'denial happens before service handler');
  f.eventRelease.resolve();
  assert.deepEqual(await until(()=>probe(f.handle)),[{ok:true}]);
 }finally{await f.close();}
});
test('negative control: old SDK never settles event notification even with patched host',async()=>{
 const f=await fixture({sdk:'original'});try{
  f.handle.notify('onEvent',{event:{eventType:'fixture.hold',companyId:company,payload:{}}});
  await f.eventEntered.promise;f.eventRelease.resolve();await delay(40);
  await assert.rejects(probe(f.handle),denied);
 }finally{await f.close();}
});
test('failed event handler also settles and leaves no phantom scope',async()=>{
 const f=await fixture();try{
  f.handle.notify('onEvent',{event:{eventType:'fixture.hold',companyId:company,payload:{fail:true}}});
  await f.eventEntered.promise;f.eventRelease.resolve();
  assert.deepEqual(await until(()=>probe(f.handle)),[{ok:true}]);
 }finally{await f.close();}
});
test('global job has a native invocation during concurrent event; configured company allowed',async()=>{
 const f=await fixture();try{
  f.handle.notify('onEvent',{event:{eventType:'fixture.hold',companyId:company,payload:{}}});
  await f.eventEntered.promise;
  await job(f.handle);
  assert.ok(f.calls.some(c=>c[0]==='execute'&&c[1]==='JOB_WRITE'));
  assert.ok(f.calls.some(c=>c[0]==='agents'&&c[1]===company));
  await assert.rejects(probe(f.handle),denied,'live event still restricts unscoped calls');
 }finally{await f.close();}
});
test('job cannot access an unconfigured company',async()=>{
 const f=await fixture();try{
  await assert.rejects(job(f.handle,foreign),denied);
  assert.equal(f.calls.some(c=>c[0]==='agents'),false);
 }finally{await f.close();}
});
test('job still needs namespace-write capability',async()=>{
 const f=await fixture({write:false});try{
  await assert.rejects(job(f.handle),{code:PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED});
  assert.equal(f.calls.some(c=>c[0]==='execute'),false);
 }finally{await f.close();}
});
test('unscoped IPC cannot bypass an active agent-origin invocation',async()=>{
 const f=await fixture();try{
  const pending=f.handle.call('executeTool',{toolName:'hold',parameters:{},runContext:{companyId:company,agentId:'agent-local',runId:'run-local'}},2000);
  await f.agentEntered.promise;
  await assert.rejects(f.handle.call('getData',{key:'probe',params:{kind:'company',target:company}},2000),denied);
  f.agentRelease.resolve();await pending;
 }finally{await f.close();}
});
test('negative control: old host retains completed event scope and rejects global job',async()=>{
 const f=await fixture({host:original});try{
  f.handle.notify('onEvent',{event:{eventType:'fixture.hold',companyId:company,payload:{}}});
  await f.eventEntered.promise;f.eventRelease.resolve();await delay(40);
  await assert.rejects(probe(f.handle),denied);
  await assert.rejects(job(f.handle),denied);
 }finally{await f.close();}
});
for(const [label,host] of [['original',original],['candidate',candidate]])test(label+': companies.list retains native global discovery ONLY with existing companies.read',async()=>{
 const f=await fixture({host,discovery:true});try{
  await f.handle.call('runJob',{job:{jobKey:'fixture-job',runId:'discovery',trigger:'schedule',scheduledAt:new Date().toISOString(),kind:'companies'}},2000);
  assert.deepEqual(f.calls.find(c=>c[1]==='DISCOVERY_RESULT')?.[2],[company,foreign]);
 }finally{await f.close();}
});
test('global job without companies.read cannot discover companies (actual router capability set)',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.handle.call('runJob',{job:{jobKey:'fixture-job',runId:'discovery',trigger:'schedule',scheduledAt:new Date().toISOString(),kind:'companies'}},2000),{code:PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED});
  assert.equal(f.calls.some(c=>c[0]==='companies'),false);
 }finally{await f.close();}
});
test('company state wildcard remains denied from a native global job',async()=>{
 const f=await fixture({state:true});try{
  await assert.rejects(f.handle.call('runJob',{job:{jobKey:'fixture-job',runId:'wildcard',trigger:'schedule',scheduledAt:new Date().toISOString(),kind:'state-wildcard'}},2000),denied);
  assert.equal(f.calls.some(c=>c[0]==='state'),false);
 }finally{await f.close();}
});
