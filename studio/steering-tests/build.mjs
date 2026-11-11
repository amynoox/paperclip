import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../..');
const require=createRequire(process.env.STUDIO_TEST_DEPS ? path.resolve(process.env.STUDIO_TEST_DEPS,'package.json') : import.meta.url);
const {build,transform}=require('esbuild');
const out=path.join(here,'.generated');fs.mkdirSync(out,{recursive:true});
for(const [name,file] of Object.entries({owner:'server/src/services/adapter-interactive-control.ts',queue:'server/src/services/issue-queued-comment-queue.ts',ui:'ui/src/lib/issue-queued-comment-queue.ts'}))
  await build({entryPoints:[path.join(repo,file)],outfile:path.join(out,name+'.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',tsconfigRaw:{}});
const source=fs.readFileSync(path.join(repo,'server/src/routes/issues.ts'),'utf8').replaceAll('\r\n','\n');
function slice(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);if(a<0||b<0||source.indexOf(start,a+1)>=0)throw Error('Source boundary changed: '+start);return source.slice(a,b);}
const schemas=slice('const queuedCommentMutationTargetSchema =','const queuedCommentInterruptTargetSchema =');
const helpers=slice('  async function queueCommentsForWake(','  function operatorInterruptCancelOptions(');
const route=slice('  router.post(\n    "/issues/:id/queued-comments/:commentId/steer",','  router.delete(\n    "/issues/:id/queued-comments/:commentId",');
const bindings=['db','svc','assertBoard','forbidden','conflict','notFound','getAccessibleResource','decideIssueAccess','authorizationDeniedDetails','getActorInfo','readQueuedInteractionResponse','recheckQueuedCommentInteractionDelivery','reserveSteeredIdentity','storedSteeringAcknowledgement','reconcileSteeredIdentity','acceptSteeredIdentity','rejectSteeredIdentity','assertQueuedCommentInteractionDelivery','logActivity','runRedactions','NativeSessionSteeringError','steerNativeSession','getNativeSessionSteeringState','agentWakeupRequests','heartbeatRuns','issueRows','issueComments','agents','eq','and','inArray','queuedInteractionId','firstTurnClaimedCommentIds','findQueuedCommentWake','resolveActiveIssueRun','z','validate'];
const code=`import {AdapterSteeringError,hasAdapterInteractiveControl,getAdapterInteractiveSteeringState,steerAdapterInteractive} from './owner.mjs';
import {buildQueuedCommentQueueSnapshot,decideQueuedCommentQueueSteering,queuedCommentIdsFromWakePayload,withQueuedCommentIdsInWakePayload} from './queue.mjs';
export function mount(router,deps){const {${bindings.join(',')}}=deps;const readObject=v=>v&&typeof v==='object'?v:{};
${schemas}\n${helpers}\n${route}
return {buildQueuedCommentQueue};}`;
fs.writeFileSync(path.join(out,'route.mjs'),(await transform(code,{loader:'ts',format:'esm',target:'node24'})).code);
// Fail compilation on every changed TS/TSX owner, including the native preparation hook.
for(const file of ['server/src/services/heartbeat/runtime-execution.ts','server/src/services/heartbeat/runtime-selection.ts','server/src/services/heartbeat/run-state.ts','server/src/services/heartbeat/run-output.ts','server/src/services/run-identity.ts','packages/adapter-utils/src/types.ts','packages/adapters/codex-local/src/server/execute.ts','ui/src/components/task-chat/TaskChatQueuedMessages.tsx'])
  await transform(fs.readFileSync(path.join(repo,file),'utf8'),{loader:file.endsWith('tsx')?'tsx':'ts',format:'esm',target:'node24'});
// Execute the exact prepared invocation and cleanup statements with inert fixtures.
// This is a boundary regression, not execution of all native preparation steps.
const codex=fs.readFileSync(path.join(repo,'packages/adapters/codex-local/src/server/execute.ts'),'utf8').replaceAll('\r\n','\n');
function codexSlice(start,end){const a=codex.indexOf(start),b=codex.indexOf(end,a+start.length);if(a<0||b<0||codex.indexOf(start,a+1)>=0)throw Error('Codex boundary changed: '+start);return codex.slice(a,b);}
const invocation=codexSlice('        const processStopped = providerStop.beginInvocation();','        await accountingLog.flush();');
const innerCleanup=codexSlice('        await providerStop.collectBeforeRestore();','  } finally {\n    // Remove the staged CODEX_HOME');
const outerCleanup=codexSlice('    // Remove the staged CODEX_HOME','\n  }\n}');
await build({entryPoints:[path.join(repo,'packages/adapter-utils/src/provider-stopped-boundary.ts')],outfile:path.join(out,'provider-boundary.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',tsconfigRaw:{}});
const boundary=`import {createProviderStoppedBoundary} from './provider-boundary.mjs';
export async function runPrepared(input){const {ctx,cwd,env,prompt,timeoutSec,graceSec,wrappedOnSpawn,monitor,accountingLog,onLog,stripCodexRolloutNoise,paperclipBridge,localProcessSandbox,runId,runtimeExecutionTarget,executionTarget,command,args,resumeSessionId,model,runAdapterExecutionTargetProcess,restoreRemoteWorkspace,describeAdapterExecutionTarget,fs,stagedCodexHomeDir,observabilityProfile,preparedRuntimeConfig}=input;
let interactiveInvocationPending=false; let executionError=null;
const providerStop=createProviderStoppedBoundary(ctx.onProviderStopped);
try { try { ${invocation}\nreturn proc; } finally { try { ${innerCleanup} } finally { ${outerCleanup}\n} }`;
fs.writeFileSync(path.join(out,'prepared-boundary.mjs'),(await transform(boundary,{loader:'ts',format:'esm',target:'node24'})).code);
console.log('Compiled real steering owners, exact route handler and native preparation boundary. DB dependencies remain fixtures.');
