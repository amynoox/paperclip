// A real PostgreSQL/HTTP queue, host owner, public plugin index and complete
// native Codex preparer. Only controller IPC/projection ports and the SSH wire
// are local fixtures. The wire runs the unchanged native scripts in local WSL.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {databaseFixture} from './database-integration.test.mjs';
import * as processNative from './.generated/native-execute.mjs';
import {createServerAdapter} from './.generated/public-native-harness.mjs';
import {configureLocalSshFixture,windowsToWsl} from './fixtures/child-process.mjs';
import {startLocalWslResponses} from './fixtures/responses-client.mjs';
import {providerArgs} from './fixtures/responses-fixture.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const digest=x=>createHash('sha256').update(x).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('complete local queue to real Codex via public adapter and native SSH preparation', {timeout:120000}, async()=>{
 const scratchBase=path.resolve(process.env.STUDIO_INTEGRATION_SCRATCH??path.join(here,'.generated'));
 await fs.mkdir(scratchBase,{recursive:true});
 const root=await fs.mkdtemp(path.join(scratchBase,'full-native-'));
 for(const d of ['codex','tmp','project','launcher'])await fs.mkdir(path.join(root,d));
 const git=(args)=>execFileSync('git',['-c','gc.auto=0','-c','maintenance.auto=false',...args],{cwd:path.join(root,'project'),encoding:'utf8',windowsHide:true});
 git(['init','--quiet','--initial-branch=fixture']);
 await fs.writeFile(path.join(root,'project','fixture.txt'),'Existing local checkout must survive steering.\n');
 git(['add','fixture.txt']);git(['-c','user.name=Local Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','Seed local synthetic checkout']);
 const originalHead=git(['rev-parse','HEAD']).trim();
 await fs.writeFile(path.join(root,'.steering-local-fixture'),'local steering fixture only\n');
 const nodeDirectory=path.dirname(path.resolve(process.env.STUDIO_WSL_NODE));
 const local=configureLocalSshFixture({home:root,nodeDirectory});
 const api=await startLocalWslResponses({home:root,nodeDirectory});
 const f=await databaseFixture(),events=[],logs=[],calls=[],generation=randomUUID();
 const prior=Object.fromEntries(['CODEX_HOME','PAPERCLIP_HOME','PAPERCLIP_CODEX_AUTH_CACHE','PAPERCLIP_API_URL'].map(k=>[k,process.env[k]]));
 process.env.CODEX_HOME=path.join(root,'codex');process.env.PAPERCLIP_HOME=path.join(root,'paperclip-home');
 process.env.PAPERCLIP_CODEX_AUTH_CACHE='false';process.env.PAPERCLIP_API_URL='http://127.0.0.1:9';
 const modelConfig=providerArgs(api.base).filter((_,i)=>i%2===1).join('\n')+'\n';
 await fs.writeFile(path.join(root,'codex/config.toml'),modelConfig);
 await fs.writeFile(path.join(root,'codex/auth.json'),JSON.stringify({OPENAI_API_KEY:'synthetic-local-unused'}));
 const gitProfile='[user]\n name = Synthetic worker\n email = fixture@example.invalid\n';
 await fs.writeFile(path.join(root,'.gitconfig'),gitProfile);
 const instructions=path.join(root,'AGENTS.md');await fs.writeFile(instructions,'Keep the synthetic checkout and Git profile intact.\n');
 const cwd=local.home+'/project',helper=local.home+'/launcher/mcp.cjs',plan=local.home+'/launcher/mcp.json',command=local.home+'/launcher/codex-router';
 const binary=windowsToWsl(process.env.STUDIO_CODEX_LINUX);
 const plugin=path.resolve(process.env.STUDIO_PLUGIN_SOURCE??process.env.STUDIO_PLUGIN_TEST_DEPS);
 const bytes=await fs.readFile(path.join(plugin,'dist/native/adapter-mcp.cjs'));
 const script='#!/bin/sh\nexec node '+JSON.stringify(helper)+' '+JSON.stringify(plan)+' "$@"\n';
 const planBytes=JSON.stringify({command:binary,plan:[],interactive:true});
 await fs.writeFile(path.join(root,'launcher/mcp.cjs'),bytes);await fs.writeFile(path.join(root,'launcher/mcp.json'),planBytes);
 await fs.writeFile(path.join(root,'launcher/codex-router'),script,{mode:0o700});
 const descriptor={protocol:'codex_owned_v1',runId:f.ids.run,command,scriptSha256:digest(script),helper,helperSha256:digest(bytes),plan,planSha256:digest(planBytes)};
 const target={kind:'remote',transport:'ssh',leaseId:'local-fixture',remoteCwd:cwd,
  workspaceRealization:{mode:'in_place',authoritativeRoot:cwd},spec:{host:local.host,username:'fixtureuser',port:22,remoteWorkspacePath:cwd,remoteCwd:cwd,privateKey:null,knownHosts:null,strictHostKeyChecking:true}};
 const ctx={runId:f.ids.run,agent:{id:f.ids.agent,companyId:f.ids.company,name:'Local native integration',adapterType:'codex_local',adapterConfig:{engine:'cli'}},
  runtime:{sessionId:null,sessionParams:null,sessionDisplayId:null,taskKey:null},executionTarget:{kind:'local',environmentId:'controller'},
  config:{engine:'cli',experimentalLiveSteering:true,env:{CODEX_HOME:path.join(root,'codex'),PAPERCLIP_GITHUB_AUTH_MODE:'host'},instructionsFilePath:instructions,promptTemplate:'Reply with the local fixture. Do not use tools.',model:'fixture-local',modelReasoningEffort:'medium',dangerouslyBypassApprovalsAndSandbox:false,paperclipSkillSync:{desiredSkills:[]},timeoutSec:80},
  context:{issueId:f.ids.issue},authToken:'synthetic-local-run-token',onLog:async(stream,text)=>logs.push({stream,text}),onProviderStopped:async()=>events.push('collected'),onUsage:async()=>{}};
 globalThis.__steeringValidation={routes:{version:1,companies:{[f.ids.company]:{positions:[f.ids.agent]}}},
  ipc:async(method,p)=>{calls.push(method);assert.equal(p.runId,f.ids.run);
   if(method==='select')return{routed:true,controllerEnvironment:'controller'};
   if(method==='claim')return{target,command,interactiveLauncher:descriptor,token:'local-synthetic-token',generation};
   if(method==='started'){events.push('started');return{};}
   if(method==='settle'){events.push('settle:'+p.status);return{};}
   throw Error('Unexpected IPC '+method);},
  files:async c=>({config:c.config,context:c.context,restore:async()=>events.push('files-restored'),cleanup:async()=>events.push('files-cleaned')}),
  scratch:async c=>({config:c.config,context:c.context,restore:async()=>events.push('scratch-restored'),cleanup:async()=>events.push('scratch-cleaned')}),
  ssh:processNative.buildSshSpawnTarget,sanitizeRemoteExecutionEnv:processNative.sanitizeRemoteExecutionEnv};
 let run,pulse,result;
 try{
  run=f.native.withAdapterInteractiveControl(ctx,c=>createServerAdapter().execute(c),f.persist).then(r=>{result=r;return r;});
  const deadline=Date.now()+60000;let q;
  do{q=await f.queue();if(result)throw Error('Preparation failed: '+JSON.stringify({result,logs}));
   if(Date.now()>deadline)throw Error('Preparation timeout: '+JSON.stringify(logs));
   if(q.body.steeringDisposition!=='available')await sleep(100);
  }while(q.body.steeringDisposition!=='available');
  assert.equal(q.body.protocol,'adapter_interactive_v1');
  const request={queueId:q.body.queueId,revision:q.body.revision,targetRunId:q.body.targetRunId};
  const ack=await f.steer(request);assert.equal(ack.status,200,JSON.stringify(ack.body));assert.equal(ack.body.entries.length,0);
  assert.equal((await f.steer(request)).status,200);
  await api.release();pulse=setInterval(()=>void api.release(),100);result=await run;
  assert.equal(result.exitCode,0,JSON.stringify({result,logs}));assert.equal(events.filter(e=>e==='collected').length,1);
  assert.equal(events.at(-1),'settle:stopped');assert.equal(calls.filter(x=>x==='claim').length,1);
  const requests=(await api.inspect()).requests;assert.ok(requests.some(r=>JSON.stringify(r.body.input).includes('Apply the synthetic correction')));
  assert.ok(requests.some(r=>JSON.stringify(r.body.input).includes('Keep the synthetic checkout')));
  assert.equal(await fs.readFile(path.join(root,'.gitconfig'),'utf8'),gitProfile);
  assert.equal(git(['rev-parse','HEAD']).trim(),originalHead);
  assert.equal(await fs.readFile(path.join(root,'project/fixture.txt'),'utf8'),'Existing local checkout must survive steering.\n');
  await fs.writeFile(path.join(root,'receipt.json'),JSON.stringify({at:new Date().toISOString(),runId:f.ids.run,protocol:q.body.protocol,queueConsumed:ack.body.entries.length===0,result,events,calls,requests:requests.length,wire:'local WSL only; no real SSH socket',database:'PostgreSQL 18.1 native migrations'},null,2));
 }finally{
  if(pulse)clearInterval(pulse);await api.release();await api.close();
  if(run&&!result)await run.catch(()=>{});
  await fs.writeFile(path.join(root,'preparation-log.json'),JSON.stringify(logs));
  delete globalThis.__steeringValidation;await f.close();
  for(const [k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
});
