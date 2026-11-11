import test from 'node:test';
import assert from 'node:assert/strict';
import {runPrepared} from './.generated/prepared-boundary.mjs';

// Exact invocation/finally statements from native execute.ts; all preparers,
// filesystem, provider and transport are inert fixtures. No worker is contacted.
function fixture(hook) {
  const effects=[];
  const result={exitCode:0,signal:null,timedOut:false,stdout:'',stderr:''};
  const input={ctx:{config:{experimentalLiveSteering:!!hook},registerInteractiveControl:()=>()=>{},
    onProviderStopped:async()=>effects.push('collect'),onRuntimeProgress:()=>{}},
    cwd:'/existing/checkout',env:{FIXTURE:'preserved'},prompt:'prepared prompt',timeoutSec:30,graceSec:1,
    wrappedOnSpawn:async()=>{},monitor:null,accountingLog:async()=>{},onLog:async()=>{},
    stripCodexRolloutNoise:x=>x,paperclipBridge:{stop:async()=>effects.push('bridge'),runLogTail:{fixture:true}},
    localProcessSandbox:null,runId:'fixture-run',runtimeExecutionTarget:{kind:'remote',transport:'ssh',fixture:true},
    executionTarget:{kind:'remote'},command:'/approved/launcher',args:['exec','--json','-'],resumeSessionId:'existing-thread',model:'fixture-model',
    runAdapterExecutionTargetProcess:async(...args)=>{effects.push('legacy');args.at(-1).onProcessStopped();return result;},
    restoreRemoteWorkspace:async()=>effects.push('restore'),describeAdapterExecutionTarget:()=> 'fixture',
    fs:{rm:async()=>effects.push('home')},stagedCodexHomeDir:'/fixture/staged',
    observabilityProfile:{cleanup:async()=>effects.push('observability')},preparedRuntimeConfig:{cleanup:async()=>effects.push('runtime')}};
  if(hook)input.ctx.codexPreparedProcess=async prepared=>hook(prepared,{input,effects,result});
  return {input,effects,result};
}
const normalCleanup=['collect','bridge','restore','home','observability','runtime'];
test('feature off uses the existing process and normal cleanup',async()=>{
  const f=fixture();assert.equal(await runPrepared(f.input),f.result);
  assert.deepEqual(f.effects,['legacy',...normalCleanup]);
});
test('prepared hook receives unchanged native context and verified stop enables collection',async()=>{
  const f=fixture(async(p,{input,effects,result})=>{
    assert.equal(p.target,input.runtimeExecutionTarget);assert.equal(p.command,input.command);
    assert.equal(p.args,input.args);assert.equal(p.options.env,input.env);
    assert.equal(p.options.stdin,input.prompt);assert.equal(p.options.cwd,input.cwd);
    assert.equal(p.options.onSpawn,input.wrappedOnSpawn);assert.equal(p.options.runLogTail,input.paperclipBridge.runLogTail);
    assert.equal(p.resumeSessionId,'existing-thread');assert.equal(p.model,'fixture-model');
    effects.push('hook');p.options.onProcessStopped();return result;
  });
  assert.equal(await runPrepared(f.input),f.result);assert.deepEqual(f.effects,['hook',...normalCleanup]);
});
test('uncertain hook preserves native bridge, home and projections; no stop or collection inferred',async()=>{
  const f=fixture(async()=>{throw Error('SSH lost; provider status unknown');});
  await assert.rejects(runPrepared(f.input),/provider status unknown/);assert.deepEqual(f.effects,[]);
});
test('a success-looking result without provider stop proof still cannot clean up',async()=>{
  const f=fixture(async(p,{result})=>result);
  await runPrepared(f.input);assert.deepEqual(f.effects,[]);
});
test('missing opt-in or host owner rejects before invocation, retaining normal setup cleanup',async()=>{
  for(const missing of ['flag','owner']) {
    let called=false;const f=fixture(async()=>{called=true;});
    if(missing==='flag')f.input.ctx.config.experimentalLiveSteering=false;
    else delete f.input.ctx.registerInteractiveControl;
    await assert.rejects(runPrepared(f.input),/requires host opt-in/);
    assert.equal(called,false);assert.deepEqual(f.effects,normalCleanup.slice(1));
  }
});
