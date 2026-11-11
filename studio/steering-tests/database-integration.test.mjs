import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import * as native from './.generated/database-integration.mjs';
const require=createRequire(path.resolve(process.env.STUDIO_DB_TEST_DEPS,'package.json'));
const express=require('express'),{eq}=require('drizzle-orm');
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};

export async function databaseFixture(){
 const temp=await native.startEmbeddedPostgresTestDatabase('studio-steering-');
 const db=native.createDb(temp.connectionString),ids=Object.fromEntries(['company','agent','run','issue','wake','comment'].map(k=>[k,randomUUID()]));
 try {
 await db.insert(native.companies).values({id:ids.company,name:'Local steering integration',issuePrefix:'STL',requireBoardApprovalForNewAgents:false});
 await db.insert(native.agents).values({id:ids.agent,companyId:ids.company,name:'Local adapter',role:'engineer',status:'idle',adapterType:'codex_local',adapterConfig:{},runtimeConfig:{},permissions:{}});
 await db.insert(native.companyMemberships).values({companyId:ids.company,principalType:'user',principalId:'local-owner',status:'active',membershipRole:'operator'});
 await db.insert(native.agentWakeupRequests).values({id:ids.wake,companyId:ids.company,agentId:ids.agent,source:'issue_comment',status:'deferred_issue_execution',requestedByActorType:'user',requestedByActorId:'local-owner',payload:{issueId:ids.issue,commentId:ids.comment,_paperclipWakeContext:{wakeCommentIds:[ids.comment]}}});
 await db.insert(native.heartbeatRuns).values({id:ids.run,companyId:ids.company,agentId:ids.agent,invocationSource:'assignment',status:'running',runtimeMode:'legacy',runtimeModeResolvedAt:new Date(),runnerProfileJson:{adapterInteractiveProtocol:'adapter_interactive_v1'},startedAt:new Date(),contextSnapshot:{issueId:ids.issue}});
 await db.insert(native.issues).values({id:ids.issue,companyId:ids.company,identifier:'STL-1',title:'Synthetic steering',status:'in_progress',priority:'medium',assigneeAgentId:ids.agent,executionRunId:ids.run});
 await db.insert(native.issueComments).values({id:ids.comment,companyId:ids.company,issueId:ids.issue,authorType:'user',authorUserId:'local-owner',body:'Apply the synthetic correction',createdAt:new Date(),updatedAt:new Date()});
 await native.initializeRunIdentity(db,{companyId:ids.company,runId:ids.run,issueId:ids.issue,responsibleUserId:'local-owner',cause:'company_default'});
 let actor={type:'board',source:'session',userId:'local-owner',companyIds:[ids.company],memberships:[{companyId:ids.company,status:'active',membershipRole:'operator'}],isInstanceAdmin:false};
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.actor=actor;next();});
 app.use('/api',native.issueRoutes(db,{},{}));
 app.use((error,_req,res,_next)=>{console.error('LOCAL ROUTE ERROR',error.stack);res.status(error.status??500).json({error:error.message,details:error.details});});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 const queue=async()=>{const r=await fetch(origin+`/api/issues/${ids.issue}/queued-comments`);return{status:r.status,body:await r.json()};};
 const steer=async body=>{const r=await fetch(origin+`/api/issues/${ids.issue}/queued-comments/${ids.comment}/steer`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
 const persist=async receipt=>{const type=receipt.phase==='attempt'?'adapter.steering.attempted':'adapter.steering.acknowledged';
  const payload={protocol:'adapter_interactive_v1',turnId:receipt.turnId,correlationId:receipt.correlationId};
  const result=await native.appendHeartbeatRunEvent(db,{companyId:ids.company,runId:ids.run,agentId:ids.agent,eventType:type,payload,nativeSource:{sourceInstanceId:receipt.sourceInstanceId,sourceEventId:(receipt.phase==='attempt'?'adapter-steer-attempt:':'adapter-steer:')+receipt.correlationId,sourceSeq:receipt.sourceSeq,protocolSchemaVersion:1,canonicalPayload:payload}}).catch(error=>{console.error('ACK WRITE ERROR',error.stack);throw error;});
  if(receipt.phase==='attempt'&&result.disposition==='duplicate')throw Error('Already attempted');};
 return {db,ids,queue,steer,persist,native,setActor(value){actor=value;},async close(){server.close();await once(server,'close');await db.$client.end();await temp.cleanup();}};
 }catch(error){console.error('FIXTURE INIT ERROR',error.stack);await db.$client.end();await temp.cleanup();throw error;}
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
test('real issues router and PostgreSQL commit queue delivery only after native durable ACK',async()=>{
 const f=await databaseFixture(),end=defer(),ready=defer();let calls=0;
 const lifetime=native.withAdapterInteractiveControl({runId:f.ids.run,agent:{id:f.ids.agent,companyId:f.ids.company},config:{experimentalLiveSteering:true}},async ctx=>{
  ctx.registerInteractiveControl({protocol:'adapter_interactive_v1',snapshot:()=>({activeTurnId:'turn-local',steering:true}),steer:async input=>{calls++;return{turnId:input.expectedTurnId,correlationId:input.correlationId};}});ready.resolve();await end.promise;
 },f.persist);
 try {await ready.promise;const q=await f.queue();assert.equal(q.status,200,JSON.stringify(q.body));assert.equal(q.body.protocol,'adapter_interactive_v1');
  const body={queueId:q.body.queueId,revision:q.body.revision,targetRunId:q.body.targetRunId};const response=await f.steer(body);assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.entries.length,0);
  assert.equal((await f.steer(body)).status,200);assert.equal(calls,1);
  const events=await f.db.select().from(native.heartbeatRunEvents).where(eq(native.heartbeatRunEvents.runId,f.ids.run));assert.equal(events.filter(x=>x.eventType==='adapter.steering.acknowledged').length,1);
 }finally{end.resolve();await lifetime;await f.close();}
});

test('real PostgreSQL queue serializes concurrent duplicate deliveries and stale revisions',async()=>{
 const f=await databaseFixture(),end=defer(),ready=defer(),ack=defer(),called=defer();let calls=0;
 const lifetime=native.withAdapterInteractiveControl({runId:f.ids.run,agent:{id:f.ids.agent,companyId:f.ids.company},config:{experimentalLiveSteering:true}},async ctx=>{
  ctx.registerInteractiveControl({protocol:'adapter_interactive_v1',snapshot:()=>({activeTurnId:'concurrent-turn',steering:true}),steer:async input=>{calls++;called.resolve();await ack.promise;return{turnId:input.expectedTurnId,correlationId:input.correlationId};}});ready.resolve();await end.promise;
 },f.persist);
 try{await ready.promise;const q=await f.queue(),body={queueId:q.body.queueId,revision:q.body.revision,targetRunId:q.body.targetRunId};
  const stale=await f.steer({...body,revision:'unrelated-stale-revision'});assert.equal(stale.status,409);assert.equal(calls,0);
  const first=f.steer(body);await called.promise;const second=f.steer(body);ack.resolve();
  const responses=await Promise.all([first,second]);assert.ok(responses.every(r=>r.status===200),JSON.stringify(responses));assert.equal(calls,1);
  const events=await f.db.select().from(native.heartbeatRunEvents).where(eq(native.heartbeatRunEvents.runId,f.ids.run));
  assert.equal(events.filter(e=>e.eventType==='adapter.steering.attempted').length,1);
  assert.equal(events.filter(e=>e.eventType==='adapter.steering.acknowledged').length,1);
 }finally{ack.resolve();end.resolve();await lifetime;await f.close();}
});

test('real durable failed attempt keeps the message and rejects replay after owner replacement',async()=>{
 const f=await databaseFixture();let calls=0;
 async function owner(callback){const end=defer(),ready=defer();const lifetime=native.withAdapterInteractiveControl({runId:f.ids.run,agent:{id:f.ids.agent,companyId:f.ids.company},config:{experimentalLiveSteering:true}},async ctx=>{
   ctx.registerInteractiveControl({protocol:'adapter_interactive_v1',snapshot:()=>({activeTurnId:'failed-turn',steering:true}),steer:async()=>{calls++;throw Error('Synthetic SSH loss after uncertain delivery');}});ready.resolve();await end.promise;
  },f.persist);try{await ready.promise;return await callback();}finally{end.resolve();await lifetime;}}
 try{let request;await owner(async()=>{const q=await f.queue();request={queueId:q.body.queueId,revision:q.body.revision,targetRunId:q.body.targetRunId};
    assert.equal((await f.steer(request)).status,409);assert.equal((await f.queue()).body.entries.length,1);});
  await owner(async()=>{assert.equal((await f.steer(request)).status,409);});assert.equal(calls,1);
  const q=await f.queue();assert.equal(q.body.protocol,'adapter_interactive_v1');assert.equal(q.body.steeringDisposition,'temporarily_unavailable');assert.equal(q.body.entries.length,1);
  const events=await f.db.select().from(native.heartbeatRunEvents).where(eq(native.heartbeatRunEvents.runId,f.ids.run));assert.equal(events.filter(e=>e.eventType==='adapter.steering.acknowledged').length,0);
 }finally{await f.close();}
});

test('a durable ACK survives the queue transaction rollback without provider redelivery',async()=>{
 const f=await databaseFixture(),end=defer(),ready=defer();let calls=0;
 const lifetime=native.withAdapterInteractiveControl({runId:f.ids.run,agent:{id:f.ids.agent,companyId:f.ids.company},config:{experimentalLiveSteering:true}},async ctx=>{
  ctx.registerInteractiveControl({protocol:'adapter_interactive_v1',snapshot:()=>({activeTurnId:'ack-turn',steering:true}),steer:async input=>{calls++;return{turnId:input.expectedTurnId,correlationId:input.correlationId};}});ready.resolve();await end.promise;
 },f.persist);
 try{await ready.promise;const q=await f.queue(),request={queueId:q.body.queueId,revision:q.body.revision,targetRunId:q.body.targetRunId};
  // A PostgreSQL trigger is a local fault fixture; the actual route and host ACK
  // owner stay intact. Fail only the eventual wake consumption transaction.
  await f.db.$client.unsafe(`CREATE FUNCTION studio_fail_queue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic queue commit failure'; END $$`);
  await f.db.$client.unsafe(`CREATE TRIGGER studio_fail_queue BEFORE UPDATE ON agent_wakeup_requests FOR EACH ROW EXECUTE FUNCTION studio_fail_queue()`);
  const failed=await f.steer(request);assert.equal(failed.status,500);assert.equal(calls,1);
  await f.db.$client.unsafe('DROP TRIGGER studio_fail_queue ON agent_wakeup_requests');
  assert.equal((await f.queue()).body.entries.length,1);
  const recovered=await f.steer(request);assert.equal(recovered.status,200,JSON.stringify(recovered.body));assert.equal(recovered.body.entries.length,0);assert.equal(calls,1);
 }finally{end.resolve();await lifetime;await f.close();}
});

test('native route authorization refuses an unrelated company before provider access',async()=>{
 const f=await databaseFixture(),end=defer(),ready=defer();let calls=0;
 const lifetime=native.withAdapterInteractiveControl({runId:f.ids.run,agent:{id:f.ids.agent,companyId:f.ids.company},config:{experimentalLiveSteering:true}},async ctx=>{
  ctx.registerInteractiveControl({protocol:'adapter_interactive_v1',snapshot:()=>({activeTurnId:'guarded-turn',steering:true}),steer:async()=>{calls++;throw Error('Must never reach provider');}});ready.resolve();await end.promise;
 },f.persist);
 try{await ready.promise;const q=await f.queue(),request={queueId:q.body.queueId,revision:q.body.revision,targetRunId:q.body.targetRunId};
  f.setActor({type:'board',source:'session',userId:'unrelated-user',companyIds:[randomUUID()],memberships:[],isInstanceAdmin:false});
  // Native access resolution conceals a different company's issue as 404.
  assert.equal((await f.steer(request)).status,404);assert.equal(calls,0);
  const events=await f.db.select().from(native.heartbeatRunEvents).where(eq(native.heartbeatRunEvents.runId,f.ids.run));assert.equal(events.filter(e=>e.eventType.startsWith('adapter.steering.')).length,0);
 }finally{end.resolve();await lifetime;await f.close();}
});
}
