import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execute} from './.generated/native-execute.mjs';
import {withAdapterInteractiveControl} from './.generated/owner.mjs';
const base=path.join(path.dirname(fileURLToPath(import.meta.url)),'.generated');

test('full native Codex preparation reaches the hook with instructions, MCP, policy, identity and accounting preserved',async()=>{
  await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'native-prepare-'));
  const home=path.join(root,'provider-home'),workspace=path.join(root,'checkout'),instructions=path.join(root,'AGENTS.md');
  await fs.mkdir(home);await fs.mkdir(workspace);await fs.writeFile(instructions,'Fixture instruction: preserve the existing checkout.\n');
  await fs.writeFile(path.join(home,'config.toml'),'model = "fixture-model"\n');
  await fs.writeFile(path.join(home,'auth.json'),JSON.stringify({OPENAI_API_KEY:'fixture-key-never-sent'}));
  const prior={};for(const name of ['CODEX_HOME','PAPERCLIP_HOME','PAPERCLIP_CODEX_AUTH_CACHE','PAPERCLIP_API_URL'])prior[name]=process.env[name];
  process.env.CODEX_HOME=home;process.env.PAPERCLIP_HOME=path.join(root,'paperclip-home');process.env.PAPERCLIP_CODEX_AUTH_CACHE='false';
  process.env.PAPERCLIP_API_URL='http://127.0.0.1:9';
  let invocation,collections=0;const logs=[];
  try {
    const context={runId:'local-preparation-run',agent:{id:'fixture-agent',companyId:'fixture-company',name:'Fixture',adapterType:'codex_local',adapterConfig:{engine:'cli'}},
      runtime:{sessionId:null,sessionParams:null,sessionDisplayId:null,taskKey:null},
      config:{engine:'cli',experimentalLiveSteering:true,command:process.execPath,cwd:workspace,
        env:{CODEX_HOME:home},instructionsFilePath:instructions,promptTemplate:'Do only the synthetic local task.',
        model:'fixture-model',modelReasoningEffort:'medium',dangerouslyBypassApprovalsAndSandbox:false,paperclipSkillSync:{desiredSkills:[]}},
      context:{},authToken:'fixture-run-token-never-sent',
      runtimeMcp:{getServers:()=>[{name:'fixture-gateway',url:'http://127.0.0.1:9/mcp',token:'fixture-mcp-token-never-sent',connectionId:'fixture'}]},
      onLog:async(stream,text)=>logs.push({stream,text}),onProviderStopped:async()=>{collections++;},
      codexPreparedProcess:async input=>{
        invocation=input;
        assert.equal(input.command,process.execPath);assert.equal(input.options.cwd,workspace);
        assert.equal(input.options.env.CODEX_HOME,home);
        assert.equal(input.options.env.PAPERCLIP_API_KEY,'fixture-run-token-never-sent');
        assert.match(input.options.stdin,/Fixture instruction: preserve the existing checkout/);
        assert.match(input.options.stdin,/Do only the synthetic local task/);
        assert.ok(input.args.includes('exec'));assert.ok(input.args.includes('--json'));
        assert.ok(input.args.some(value=>value.includes('workspace-write')));
        const config=await fs.readFile(path.join(home,'config.toml'),'utf8');
        assert.match(config,/fixture-gateway/);assert.match(config,/fixture-mcp-token-never-sent/);
        const stdout=[{type:'thread.started',thread_id:'fixture-thread'},{type:'item.completed',item:{type:'agent_message',text:'fixture'}},
          {type:'turn.completed',usage:{input_tokens:21,cached_input_tokens:3,output_tokens:7}}].map(value=>JSON.stringify(value)).join('\n')+'\n';
        await input.options.onLog('stdout',stdout);input.options.onProcessStopped();
        return {exitCode:0,signal:null,timedOut:false,stdout,stderr:'',pid:123,startedAt:new Date().toISOString()};
      }};
    const result=await withAdapterInteractiveControl(context,execute,async()=>{});
    assert.ok(invocation);assert.equal(result.exitCode,0);assert.equal(collections,1);
    assert.equal(result.sessionId,'fixture-thread');assert.equal(result.usageBasis,'per_run');
    assert.deepEqual(result.usage,{inputTokens:18,cachedInputTokens:3,outputTokens:7});
    assert.ok(!JSON.stringify(logs).includes('fixture-mcp-token-never-sent'));
  } finally {
    for(const [name,value] of Object.entries(prior)){if(value===undefined)delete process.env[name];else process.env[name]=value;}
    assert.ok(path.resolve(root).startsWith(path.resolve(base)+path.sep));await fs.rm(root,{recursive:true,force:true});
  }
});
