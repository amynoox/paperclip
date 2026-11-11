// Actual public index + actual native Codex execute. Local test ports are only
// IPC registration, filesystem transfer and the SSH channel; no replacement of
// native Codex decisions/preparation and no replacement provider-stop callback.
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
if (!process.env.STUDIO_PLUGIN_TEST_DEPS) throw new Error('Set STUDIO_PLUGIN_TEST_DEPS to the isolated plugin checkout with installed test dependencies.');
const plugin=path.resolve(process.env.STUDIO_PLUGIN_SOURCE ?? process.env.STUDIO_PLUGIN_TEST_DEPS);
const native=path.resolve(here,'../.generated/native-execute.mjs');
const localProcess=process.env.STUDIO_LOCAL_CHILD_PROCESS?path.resolve(process.env.STUDIO_LOCAL_CHILD_PROCESS):null;
const require=createRequire(path.join(path.resolve(process.env.STUDIO_PLUGIN_TEST_DEPS),'package.json'));
const {build}=require('esbuild');
const fail='()=>{throw new Error("Unexpected unrelated boundary call in public native harness")}';
const modules={
  '@paperclipai/adapter-codex-local/server':`export * from ${JSON.stringify(pathToFileURL(native).href)};`,
  '@paperclipai/adapter-codex-local':`export const models=[],agentConfigurationDoc='Native integration harness';`,
  '@paperclipai/adapter-utils':`export const buildSandboxNpmInstallCommand=${fail};export const getAdapterSessionManagement=()=>null;`,
  '@paperclipai/adapter-utils/ssh':`
    export const buildSshSpawnTarget=input=>globalThis.__steeringValidation.ssh(input);
    export const syncDirectoryToSsh=${fail},restoreWorkspaceFromSshExecution=${fail};`,
  '@paperclipai/adapter-utils/workspace-restore-merge':`
    export const captureDirectorySnapshot=${fail},serializeDirectorySnapshot=${fail},directorySnapshotSha256=${fail},mergeDirectoryWithBaseline=${fail};`,
  '@paperclipai/adapter-utils/execution-target':`
    export {runAdapterExecutionTargetShellCommand,prepareGitHubExecutionEnvironment,sanitizeRemoteExecutionEnv} from ${JSON.stringify(pathToFileURL(native).href)};`,
  'fixture-ipc':`
    export const ipcRoot=()=>'/isolated-native-integration';
    export const privateJson=async()=>globalThis.__steeringValidation.routes;
    export const controlRequest=(root,method,params,options)=>globalThis.__steeringValidation.ipc(method,params,options);`,
  'fixture-agent-files':`export const prepareAgentFiles=(ctx,target,native,options)=>globalThis.__steeringValidation.files(ctx,target,options);`,
  'fixture-scratch':`export const prepareRunScratch=(ctx,target,native,options)=>globalThis.__steeringValidation.scratch(ctx,target,options);`,
};
await build({entryPoints:[path.join(plugin,'adapters/native-ssh/index.js')],outfile:path.resolve(here,'../.generated/public-native-harness.mjs'),
  bundle:true,format:'esm',platform:'node',target:'node24',logLevel:'warning',
  banner:{js:"import {createRequire as __harnessRequire} from 'node:module'; const require=__harnessRequire(import.meta.url);"},
  plugins:[{name:'local-transport-ports',setup(b){
    if(localProcess)b.onResolve({filter:/^(?:node:)?child_process$/},a=>path.resolve(a.importer)===localProcess?{path:a.path,external:true}:{path:localProcess});
    b.onResolve({filter:/^@paperclipai\//},a=>{
      if(!Object.hasOwn(modules,a.path))throw new Error('Unexpected external import '+a.path);
      return {path:a.path,namespace:'harness'};
    });
    b.onResolve({filter:/^\.\/ipc\.js$/},a=>a.importer.startsWith(plugin)?{path:'fixture-ipc',namespace:'harness'}:undefined);
    b.onResolve({filter:/^\.\/agent-files\.js$/},a=>a.importer.startsWith(plugin)?{path:'fixture-agent-files',namespace:'harness'}:undefined);
    b.onResolve({filter:/^\.\/scratch-files\.js$/},a=>a.importer.startsWith(plugin)?{path:'fixture-scratch',namespace:'harness'}:undefined);
    b.onResolve({filter:/.*/,namespace:'harness'},a=>a.path.startsWith('file:')?{path:a.path,external:true}:path.isAbsolute(a.path)?{path:a.path}:undefined);
    b.onLoad({filter:/.*/,namespace:'harness'},a=>({contents:modules[a.path],loader:'js'}));
  }}]});
console.log(JSON.stringify({output:path.resolve(here,'../.generated/public-native-harness.mjs'),nativeExecute:native,providerStop:'actual public index owner, not substituted',remoteCalls:false}));
