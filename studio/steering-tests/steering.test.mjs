import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import path from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mount} from './.generated/route.mjs';
import {withAdapterInteractiveControl,steerAdapterInteractive,hasAdapterInteractiveControl,
  getAdapterInteractiveSteeringState,selectsAdapterInteractiveControl} from './.generated/owner.mjs';
import {decideQueuedCommentQueueSteering} from './.generated/queue.mjs';
import {normalizeIssueQueuedCommentQueue} from './.generated/ui.mjs';
const require=createRequire(process.env.STUDIO_TEST_DEPS ? path.resolve(process.env.STUDIO_TEST_DEPS,'package.json') : import.meta.url);
const express=require('express'),{z}=require('zod');
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const error=(status,message,details={})=>Object.assign(new Error(message),{status,details});

// A transactional fixture preserves queue rollback separately from durable host
// receipts. It exercises actual route/lock/selector code but is NOT PostgreSQL.
async function fixture({optIn=true,protocol=optIn?'adapter_interactive_v1':null,receiptStore=new Map()}={}) {
  const ids={company:randomUUID(),run:randomUUID(),issue:randomUUID(),agent:randomUUID(),wake:randomUUID(),comment:randomUUID(),user:randomUUID()};
  const issue={id:ids.issue,companyId:ids.company,assigneeAgentId:ids.agent,executionRunId:ids.run};
  const run={id:ids.run,companyId:ids.company,agentId:ids.agent,status:'running',runtimeMode:'legacy',runtimeModeResolvedAt:new Date(),
    runnerProfileJson:protocol?{adapterInteractiveProtocol:protocol}:{},contextSnapshot:{issueId:ids.issue},resultJson:{}};
  const wake={id:ids.wake,companyId:ids.company,agentId:ids.agent,status:'deferred_issue_execution',payload:{issueId:ids.issue,_paperclipWakeContext:{wakeCommentIds:[ids.comment]}}};
  const comment={id:ids.comment,issueId:ids.issue,body:'Apply this bounded correction',authorUserId:ids.user,updatedAt:new Date(),createdAt:new Date()};
  let rows={issues:[issue],runs:[run],wakes:[wake],comments:[comment],agents:[{id:ids.agent,companyId:ids.company,adapterType:'codex_local'}]};
  const tables=Object.fromEntries(Object.keys(rows).map(name=>[name,new Proxy({name},{get:(o,k)=>k==='name'?o.name:String(k)})]));
  let lockTail=Promise.resolve(),rollbackAfterAck=false,denyAudience=false,response=null,denyAccess=false;
  const matches=(row,c)=>!c || c.kind==='and'?(!c||c.items.every(i=>matches(row,i))):c.kind==='in'?c.values.includes(row[c.key]):row[c.key]===c.value;
  const eq=(key,value)=>({kind:'eq',key,value}),and=(...items)=>({kind:'and',items}),inArray=(key,values)=>({kind:'in',key,values});
  function query(mode,table,projection){let condition,values,limit;
    const q={from:t=>(table=t,q),where:c=>(condition=c,q),for:()=>q,$dynamic:()=>q,limit:n=>(limit=n,q),set:v=>(values=v,q),returning:()=>q,
      then(resolve,reject){return Promise.resolve().then(()=>{let selected=rows[table.name].filter(r=>matches(r,condition));if(limit)selected=selected.slice(0,limit);
        if(mode==='update')for(const r of selected)Object.assign(r,values);
        return selected.map(r=>projection?Object.fromEntries(Object.entries(projection).map(([k,v])=>[k,r[v]])):{...r});}).then(resolve,reject);}};return q;}
  const db={select:p=>query('select',null,p),update:t=>query('update',t),async transaction(fn){const previous=lockTail,unlock=defer();lockTail=unlock.promise;await previous;
    const pre=structuredClone(rows);try{const result=await fn(db);if(rollbackAfterAck){rollbackAfterAck=false;throw Error('fixture transaction commit failed');}return result;}catch(e){rows=pre;throw e;}finally{unlock.resolve();}}};
  const end=defer(),ready=defer(),abort=new AbortController();let ctx,providerCalls=0,turn='turn-a',provider=async i=>({turnId:i.expectedTurnId,correlationId:i.correlationId}),attempts=0;
  const lifetime=withAdapterInteractiveControl({agent:{id:ids.agent,companyId:ids.company},runId:ids.run,config:{experimentalLiveSteering:optIn},signal:abort.signal},async c=>{ctx=c;ready.resolve();await end.promise;},async r=>{
    const id=`${ids.company}:${ids.run}:${r.phase}:${r.correlationId}`;
    if(r.phase==='attempt'){attempts++;if(receiptStore.has(id))throw Error('duplicate durable attempt');}
    receiptStore.set(id,r);
  });await ready.promise;
  const register=()=>ctx.registerInteractiveControl({protocol:'adapter_interactive_v1',snapshot:()=>({activeTurnId:turn,steering:true}),steer:async i=>{providerCalls++;return provider(i);}});
  let dispose=optIn?register():()=>{};
  const stored=async(_tx,c)=>receiptStore.get(`${c.companyId}:${c.runId}:acknowledged:${c.messageId}`)??null;
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.actor={type:req.header('x-actor')??'board',userId:ids.user};next();});
  const router=express.Router();let api;
  const deps={db,svc:{getById:async()=>rows.issues[0]},assertBoard:req=>{if(req.actor.type!=='board')throw error(403,'Board required');},
    forbidden:m=>error(403,m),conflict:(m,d)=>error(409,m,d),notFound:m=>error(404,m),
    getAccessibleResource:async(_req,_res,p)=>p,decideIssueAccess:async()=>({allowed:!denyAccess,explanation:'Denied'}),authorizationDeniedDetails:()=>({}),
    getActorInfo:()=>({actorType:'user',actorId:ids.user}),readQueuedInteractionResponse:async()=>response,
    recheckQueuedCommentInteractionDelivery:async()=>{if(denyAudience)throw error(403,'Audience denied');},
    reserveSteeredIdentity:async(_db,i)=>i,storedSteeringAcknowledgement:stored,reconcileSteeredIdentity:async()=>{},acceptSteeredIdentity:async()=>{},rejectSteeredIdentity:async()=>{},
    assertQueuedCommentInteractionDelivery:async()=>{if(denyAudience)throw error(403,'Audience denied');},
    logActivity:async()=>{},runRedactions:{redactForIssue:async(_c,_i,v)=>v},
    NativeSessionSteeringError:class extends Error{},steerNativeSession:async()=>{throw Error('Unexpected native dispatch');},getNativeSessionSteeringState:async()=>({disposition:'unsupported'}),
    agentWakeupRequests:tables.wakes,heartbeatRuns:tables.runs,issueRows:tables.issues,issueComments:tables.comments,agents:tables.agents,eq,and,inArray,
    queuedInteractionId:p=>p?.interactionId??null,firstTurnClaimedCommentIds:()=>new Set(),
    findQueuedCommentWake:async()=>rows.wakes[0].status==='deferred_issue_execution'?{wake:rows.wakes[0],state:'deferred',queueRun:null}:null,
    resolveActiveIssueRun:async()=>rows.runs[0].status==='running'?rows.runs[0]:null,z,
    validate:schema=>(req,_res,next)=>{try{req.body=schema.parse(req.body);next();}catch(e){next(error(400,'Invalid request'));}}};
  api=mount(router,deps);app.use(router);
  app.get('/queue',async(req,res,next)=>{try{res.json(await api.buildQueuedCommentQueue({executor:db,issue:rows.issues[0],activeRun:rows.runs[0],actor:deps.getActorInfo()}));}catch(e){next(e);}});
  app.use((e,_req,res,_next)=>res.status(e.status??500).json({error:e.message,details:e.details}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
  const queue=async()=>fetch(url+'/queue').then(r=>r.json());
  const post=async(body,actor)=>fetch(url+`/issues/${ids.issue}/queued-comments/${ids.comment}/steer`,{method:'POST',headers:{'content-type':'application/json',...(actor?{'x-actor':actor}:{})},body:JSON.stringify(body)}).then(async r=>({status:r.status,body:await r.json()}));
  return {ids,rows:()=>rows,ctx,queue,post,receiptStore,register,dispose:()=>dispose(),setProvider:p=>{provider=p;},setTurn:t=>{turn=t;},
    setRollback:()=>{rollbackAfterAck=true;},denyAudience:()=>{denyAudience=true;},denyAccess:()=>{denyAccess=true;},
    fresh:()=>{rows.wakes[0].payload.interactionId='question';response={comment,source:{kind:'interaction',interactionId:'question',interactionKind:'question',requiresFreshSession:true}};},
    providerCalls:()=>providerCalls,attempts:()=>attempts,abort,
    async target(){const q=await queue();return{queueId:q.queueId,targetRunId:q.targetRunId,revision:q.revision};},
    async close(){end.resolve();await lifetime;server.close();await once(server,'close');}};
}

test('registration → real queue selector/UI → exact HTTP steer route → durable ACK → consumption and idempotency',async()=>{
  const f=await fixture();try{const q=await f.queue();assert.equal(q.protocol,'adapter_interactive_v1');assert.equal(normalizeIssueQueuedCommentQueue(q,f.ids.issue).steeringDisposition,'available');
    const body=await f.target(),r=await f.post(body);assert.equal(r.status,200);assert.equal(r.body.entries.length,0);assert.equal(f.providerCalls(),1);
    assert.equal((await f.post(body)).status,200);assert.equal(f.providerCalls(),1);assert.equal(f.receiptStore.size,2);
  }finally{await f.close();}});
test('legacy adapters remain unsupported and feature off exposes no registration',async()=>{
  const f=await fixture({optIn:false});try{assert.equal(f.ctx.registerInteractiveControl,undefined);assert.equal((await f.queue()).protocol,'legacy');
    assert.equal((await f.post(await f.target())).body.details.code,'steering_unsupported');assert.equal(f.providerCalls(),0);
  }finally{await f.close();}});
test('detached opted-in run remains interactive unavailable, never disguised as legacy',async()=>{
  const f=await fixture();try{f.dispose();const q=await f.queue();assert.equal(q.protocol,'adapter_interactive_v1');assert.equal(q.steeringDisposition,'temporarily_unavailable');
    assert.equal((await f.post(await f.target())).status,409);assert.equal((await f.queue()).entries.length,1);
  }finally{await f.close();}});
test('revision, board, access, target and audience failures never reach provider',async()=>{
  for(const kind of ['revision','actor','access','target','audience']){const f=await fixture();try{const body=await f.target();if(kind==='revision')body.revision='stale';if(kind==='target')body.targetRunId=randomUUID();if(kind==='audience')f.denyAudience();if(kind==='access')f.denyAccess();
    const r=await f.post(body,kind==='actor'?'agent':undefined);assert.ok([403,409].includes(r.status),JSON.stringify(r));assert.equal(f.providerCalls(),0);assert.equal(f.receiptStore.size,0);
  }finally{await f.close();}}});
test('fresh-session interaction cannot be steered into current turn',async()=>{const f=await fixture();try{f.fresh();assert.equal((await f.post(await f.target())).body.details.code,'queued_response_requires_fresh_session');assert.equal(f.providerCalls(),0);}finally{await f.close();}});
test('provider rejection/connection loss preserves message and cannot replay across MCP phases',async()=>{const f=await fixture();try{f.setProvider(async()=>{throw Error('lost SSH after possible acceptance');});const body=await f.target();assert.equal((await f.post(body)).status,409);assert.equal((await f.queue()).entries.length,1);f.dispose();f.register();assert.equal((await f.post(body)).status,409);assert.equal(f.providerCalls(),1);}finally{await f.close();}});
test('saved ACK survives route transaction rollback and skips second provider delivery',async()=>{const f=await fixture();try{f.setRollback();const body=await f.target();assert.equal((await f.post(body)).status,500);assert.equal((await f.queue()).entries.length,1);assert.equal(f.receiptStore.size,2);assert.equal((await f.post(body)).status,200);assert.equal(f.providerCalls(),1);}finally{await f.close();}});
test('stopped run after ACK retains queue despite successful provider receipt',async()=>{const f=await fixture();try{f.setProvider(async i=>{f.rows().runs[0].status='succeeded';return{turnId:i.expectedTurnId,correlationId:i.correlationId};});const r=await f.post(await f.target());assert.equal(r.status,409);assert.equal(r.body.details.code,'queued_comment_stale_target');assert.equal((await f.queue()).entries.length,1);}finally{await f.close();}});
test('mismatched ACK remains uncertain and does not consume queue',async()=>{const f=await fixture();try{f.setProvider(async()=>({turnId:'wrong-turn',correlationId:'wrong-id'}));assert.equal((await f.post(await f.target())).status,409);assert.equal(f.receiptStore.size,1);assert.equal((await f.queue()).entries.length,1);}finally{await f.close();}});
test('timeout may later persist ACK without replay; cancellation removes port but not stop authority',async()=>{const f=await fixture();try{const ack=defer();f.setProvider(()=>ack.promise);const msg={companyId:f.ids.company,runId:f.ids.run,correlationId:f.ids.comment,message:'message',timeoutMs:5};await assert.rejects(steerAdapterInteractive(msg),e=>e.code==='steering_timeout');ack.resolve({turnId:'turn-a',correlationId:f.ids.comment});await steerAdapterInteractive(msg);assert.equal(f.providerCalls(),1);assert.equal(f.receiptStore.size,2);f.abort.abort();assert.equal(hasAdapterInteractiveControl(f.ids.company,f.ids.run),false);}finally{await f.close();}});
test('durable attempted identity rejects fresh controller replay after lost acknowledgement',async()=>{const f=await fixture();try{f.receiptStore.set(`${f.ids.company}:${f.ids.run}:attempt:${f.ids.comment}`,{phase:'attempt'});assert.equal((await f.post(await f.target())).status,409);assert.equal(f.providerCalls(),0);assert.equal((await f.queue()).entries.length,1);}finally{await f.close();}});
test('old resolved runs cannot be upgraded by mutable config; no cross-company registry authority',async()=>{
  assert.equal(selectsAdapterInteractiveControl({runtimeModeResolvedAt:new Date(),runnerProfileJson:{}},{experimentalLiveSteering:true}),false);
  assert.equal(selectsAdapterInteractiveControl({runtimeModeResolvedAt:null},{experimentalLiveSteering:true}),true);
  const f=await fixture();try{await assert.rejects(steerAdapterInteractive({companyId:'other-company',runId:f.ids.run,message:'x',correlationId:'x'}));assert.equal(f.providerCalls(),0);}finally{await f.close();}
});
