import assert from 'node:assert/strict';
import { before, after, beforeEach, test, mock } from 'node:test';
import express from 'express';
import { once } from 'node:events';
import { runTaskToolDefinitions, callRunTaskTool } from './.generated/task.mjs';
import { projectToolRoutes } from './.generated/route.mjs';
import { projectToolContext } from './.generated/context.mjs';
import { evaluateIssueThreadInteractionResolverAudience as audience } from './.generated/audience.mjs';

const ids={ task:'11111111-1111-4111-8111-111111111111', interaction:'22222222-2222-4222-8222-222222222222' };
const actor={ type:'agent',source:'agent_jwt',agentId:'agent-a',companyId:'company-a',runId:'run-a' };
let mode, generation, runGeneration, active, seen, mutationCount, nativeStatus, nativeCode, nativeDelay, responseClosed, contextCalls, nativeRedirect;
const issue=()=>({id:ids.task,companyId:'company-a',workMode:mode,conversationAgentId:'agent-a',conversationSessionGeneration:generation});
const db={select:()=>({from:()=>({where:async()=>[issue()]})})};
let server, api;
before(async()=>{
  const app=express();app.use(express.json());
  // Identity service and DB IO are fixtures; production context/mode/generation
  // guards, native validators, HTTP transport and audience decision are real.
  globalThis.fixtureIdentity=async(_db,binding)=>{
    contextCalls++;
    if(!active||binding.agentId!==actor.agentId||binding.companyId!==actor.companyId||binding.runId!==actor.runId)throw Error('Inactive or mismatched run');
    return{run:{...binding,id:actor.runId,nativeIssueId:ids.task,responsibleUserId:'user-a',contextSnapshot:{conversationSessionGeneration:runGeneration}}};
  };
  app.use((req,_res,next)=>{req.actor=req.header('authorization')==='Bearer fixture-run-token'?actor:{type:'board',userId:'user-a'};next();});
  app.use('/api',projectToolRoutes(db));
  app.use('/api/issues',async(req,res)=>{
    seen.push({method:req.method,url:req.originalUrl,authorization:req.header('authorization'),body:req.body});
    res.once('close',()=>{if(!res.writableEnded)responseClosed=true;});
    if(nativeRedirect)return res.redirect(307,'/unexpected-redirect');
    if(nativeDelay)await new Promise(r=>setTimeout(r,nativeDelay));
    if(nativeStatus)return res.status(nativeStatus).json({error:'private-error-must-not-leak',details:{code:nativeCode}});
    if(req.method==='POST'){mutationCount++;return res.json({id:ids.interaction,status:'answered'});}
    if(req.path.endsWith('/documents')||req.path.endsWith('/interactions'))return res.json([{id:'visible-row'}]);
    res.json({id:ids.task,body:'Native document',status:'blocked'});
  });
  app.use((err,_req,res,_next)=>res.status(err.status??403).json({error:err.message}));
  server=app.listen(0,'127.0.0.1');await once(server,'listening');api=`http://127.0.0.1:${server.address().port}`;process.env.PAPERCLIP_API_URL=api;
});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));delete globalThis.fixtureIdentity;delete process.env.PAPERCLIP_API_URL;});
beforeEach(()=>{mode='standard';generation=1;runGeneration=1;active=true;seen=[];mutationCount=0;nativeStatus=0;nativeCode='';nativeDelay=0;responseClosed=false;contextCalls=0;nativeRedirect=false;});
const invoke=(name,args={},extra={})=>callRunTaskTool({name,arguments:args,apiUrl:api,token:'fixture-run-token',issueId:ids.task,workMode:mode,...extra});
const response={answers:[{questionId:'scope',optionIds:['yes'],otherText:null}],summaryMarkdown:'Verified existing fact.'};
const writeArgs={interactionId:ids.interaction,response};
const mcp=async(name,args={},method='tools/call',token='fixture-run-token')=>{
  const r=await fetch(api+'/api/mcp/project-tools',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{name,arguments:args}})});return{status:r.status,body:await r.json()};
};

test('catalogue has exactly five bounded operations; old read project catalogue is preserved',async()=>{
  assert.equal(runTaskToolDefinitions('standard').length,5);
  const {body}=await mcp(null,{},'tools/list');
  assert.deepEqual(body.result.tools.map(t=>t.name),['list_projects',...runTaskToolDefinitions('standard').map(t=>t.name)]);
  for(const t of runTaskToolDefinitions('standard'))assert.equal(t.inputSchema.additionalProperties,false);
});
for(const readMode of ['ask','planning'])test(`${readMode} lists reads but refuses mutation even through direct service`,async()=>{
  mode=readMode;assert.equal(runTaskToolDefinitions(mode).length,4);
  assert.equal((await mcp('respond_to_task_interaction',writeArgs)).body.result.isError,true);
  await assert.rejects(invoke('respond_to_task_interaction',writeArgs),/unavailable/);assert.equal(seen.length,0);
});
test('unknown mode exposes no new operations',()=>assert.deepEqual(runTaskToolDefinitions('unknown'),[]));
for(const [name,args,suffix,key] of [
  ['get_task',{},'','task'], ['list_task_documents',{},'/documents','documents'],
  ['read_task_document',{key:'report'},'/documents/report','document'],
  ['list_task_interactions',{},'/interactions','interactions'],
])test(`${name} calls the native GET with the exact run credential and object result`,async()=>{
  const result=await invoke(name,args);
  assert.ok(Object.hasOwn(result,key));assert.equal(Array.isArray(result),false);
  assert.equal(seen[0].url,`/api/issues/${ids.task}${suffix}`);assert.equal(seen[0].method,'GET');assert.equal(seen[0].authorization,'Bearer fixture-run-token');
});
test('an explicit related task is encoded without changing actor or company',async()=>{
  await invoke('get_task',{taskId:'EXAMPLE-42'});assert.equal(seen[0].url,'/api/issues/EXAMPLE-42');
});
test('response delegates exactly once to native atomic handler and returns object',async()=>{
  const {body}=await mcp('respond_to_task_interaction',writeArgs);
  assert.equal(body.result.structuredContent.interaction.status,'answered');assert.equal(mutationCount,1);assert.equal(contextCalls,2);
  assert.deepEqual(seen[0].body,response);assert.equal(seen[0].url,`/api/issues/${ids.task}/interactions/${ids.interaction}/respond`);
});
test('skill_test can use the same native response route',async()=>{mode='skill_test';await invoke('respond_to_task_interaction',writeArgs);assert.equal(mutationCount,1);});
for(const args of [{taskId:'../secrets'},{taskId:'x?companyId=other'},{taskId:'https://other/'},{taskId:'ok',companyId:'other'},{agentId:'other'},{userId:'user-a'}])test(`reject unsafe addressing/identity ${JSON.stringify(args)}`,async()=>{
  await assert.rejects(invoke('get_task',args));assert.equal(seen.length,0);
});
test('invalid document keys, malformed answer, and forged relay fields never reach HTTP',async()=>{
  await assert.rejects(invoke('read_task_document',{key:'../../secret'}));
  await assert.rejects(invoke('respond_to_task_interaction',{...writeArgs,response:{answers:[{questionId:'scope'}]}}));
  await assert.rejects(invoke('respond_to_task_interaction',{...writeArgs,response:{...response,relayedHumanUserId:'user-a'}}));
  assert.equal(seen.length,0);
});
for(const [status,code] of [[403,'interaction_human_only'],[403,'interaction_addressee_mismatch'],[403,'interaction_scope_denied'],[409,'interaction_already_resolved'],[422,'interaction_run_attribution_required'],[404,'interaction_not_found']])test(`native ${code} remains authoritative; no retry or raw error leak`,async()=>{
  nativeStatus=status;nativeCode=code;await assert.rejects(invoke('respond_to_task_interaction',writeArgs),e=>e.message.includes(code)&&!e.message.includes('private-error'));
  assert.equal(seen.length,1);assert.equal(mutationCount,0);
});
test('pre-aborted request sends nothing',async()=>{const c=new AbortController();c.abort();await assert.rejects(invoke('get_task',{}, {signal:c.signal}));assert.equal(seen.length,0);});
test('in-flight abort closes native read; no replay',async()=>{
  nativeDelay=100;const c=new AbortController();const p=invoke('get_task',{}, {signal:c.signal});
  while(!seen.length)await new Promise(r=>setTimeout(r,2));c.abort();await assert.rejects(p);
  await new Promise(r=>setTimeout(r,20));assert.equal(responseClosed,true);assert.equal(seen.length,1);
});
test('MCP client disconnect cancels the native request',async()=>{
  nativeDelay=100;const c=new AbortController();const p=fetch(api+'/api/mcp/project-tools',{method:'POST',signal:c.signal,headers:{authorization:'Bearer fixture-run-token','content-type':'application/json'},body:JSON.stringify({method:'tools/call',params:{name:'get_task'}})});
  while(!seen.length)await new Promise(r=>setTimeout(r,2));c.abort();await assert.rejects(p);
  await new Promise(r=>setTimeout(r,20));assert.equal(responseClosed,true);assert.equal(seen.length,1);
});
test('native HTTP 500 does not replay a response',async()=>{nativeStatus=500;await assert.rejects(invoke('respond_to_task_interaction',writeArgs));assert.equal(seen.length,1);});
test('60 second production deadline is installed and aborts a stalled request',async()=>{
  nativeDelay=100;const timeout=AbortSignal.timeout.bind(AbortSignal);let configured;
  const clock=mock.method(AbortSignal,'timeout',ms=>{configured=ms;return timeout(15);});
  try { await assert.rejects(invoke('get_task'));assert.equal(configured,60000);assert.equal(seen.length,1); }
  finally { clock.mock.restore(); }
});
test('native redirects are not followed with the run credential or replayed body',async()=>{
  nativeRedirect=true;await assert.rejects(invoke('respond_to_task_interaction',writeArgs));assert.equal(seen.length,1);assert.equal(mutationCount,0);
});
test('non-run and connector/board identities cannot enter project MCP',async()=>{
  assert.equal((await mcp('get_task',{},'tools/call','wrong-token')).status,403);
  for(const invalid of [{...actor,source:'connection_mcp'},{...actor,runId:null},{...actor,companyId:'other'}])await assert.rejects(projectToolContext(db,invalid));
  assert.equal(seen.length,0);
});
test('inactive run and stale conversation generation fail before native IO',async()=>{
  active=false;assert.equal((await mcp('get_task')).status,403);active=true;generation++;
  assert.equal((await mcp('get_task')).status,403);assert.equal(seen.length,0);
});
test('native audience allows only the addressed agent with a run',()=>{
  const i={effectiveResolverPolicy:'anyone',addresseeAgentId:'agent-a'};
  assert.equal(audience({actor:{type:'agent',agentId:'agent-a',runId:'run-a'},interaction:i}).allowed,true);
  assert.equal(audience({actor:{type:'agent',agentId:'other',runId:'run-a'},interaction:i}).code,'interaction_addressee_mismatch');
  assert.equal(audience({actor:{type:'agent',agentId:'agent-a',runId:null},interaction:i}).code,'interaction_run_attribution_required');
});
test('native audience never turns the run responsible user into a human answer',()=>{
  const a={type:'agent',agentId:'agent-a',runId:'run-a'};
  assert.equal(audience({actor:a,interaction:{effectiveResolverPolicy:'human_only',addresseeUserId:'user-a'}}).code,'interaction_human_only');
  assert.equal(audience({actor:a,interaction:{effectiveResolverPolicy:'anyone',addresseeAgentId:'agent-a'},additionalRestriction:'human_only'}).code,'interaction_human_only');
  assert.equal(audience({actor:a,interaction:{effectiveResolverPolicy:'anyone'},governedAction:true}).code,'interaction_governed_action_denied');
});
