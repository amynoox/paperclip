import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build,transform} from 'esbuild';
const root=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(root,'../..').replaceAll('\\','/');
const generated=path.join(root,'.generated');fs.mkdirSync(generated,{recursive:true});
const baseline='179694de7dc700aa5b4d0ab58fe8531cd8119f93';
for(const file of ['server/src/services/plugin-worker-manager.ts','packages/plugins/sdk/src/worker-rpc-host.ts']){
 const original=path.join(generated,'original',file);fs.mkdirSync(path.dirname(original),{recursive:true});
 fs.writeFileSync(original,execFileSync('git',['-c','safe.directory='+repo,'-C',repo,'show',baseline+':'+file],{maxBuffer:8*1024*1024}));
}
const realFiles=['plugin-interaction-context','plugin-worker-unavailable-error'];
for(const name of realFiles){
 const data=execFileSync('git',['-c','safe.directory='+repo,'-C',repo,'show','HEAD:server/src/services/'+name+'.ts']);
 fs.mkdirSync(path.join(generated,'support'),{recursive:true});
 fs.writeFileSync(path.join(generated,'support',name+'.ts'),data);
}
const stubs={
 './plugin-idle-catalog.js':'export const pluginIdleManifestGeneration=()=>"fixture";',
 './task-admission.js':'export const beginIdleTrackedWork=()=>()=>{};export const readTaskDrain=()=>null;export const trackIdleWork=p=>p;',
 '@paperclipai/adapter-utils/acpx-engine/startup-timing':'export const getActiveStepContext=()=>undefined;',
 './login-command.js':'export const isLoginCommandKey=()=>false;export const validateLoginSessionHome=()=>{throw Error("unused login path")};',
 '../middleware/logger.js':'const logger={trace(){},debug(){},info(){},warn(){},error(){},fatal(){},child(){return logger}};export{logger};',
 './execution-preparation-timing.js':'export const measureRunPhase=(_name,fn)=>fn();',
 '../instrumentation.js':'export const traceparentFromContextToken=()=>undefined;',
};
for(const version of ['original','candidate']){
 const entry=version==='original'?path.join(generated,'original/server/src/services/plugin-worker-manager.ts'):path.join(repo,'server/src/services/plugin-worker-manager.ts');
 await build({entryPoints:[entry],outfile:path.join(generated,'host-'+version+'.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',plugins:[{name:'isolated-external-services',setup(b){
  b.onResolve({filter:/.*/},args=>{
   if(Object.hasOwn(stubs,args.path))return{path:args.path,namespace:'test-stub'};
   for(const name of realFiles)if(args.path==='./'+name+'.js')return{path:path.join(generated,'support',name+'.ts')};
  });
  b.onLoad({filter:/.*/,namespace:'test-stub'},args=>({contents:stubs[args.path],loader:'js'}));
 }}]});
 const source=fs.readFileSync(version==='original'?path.join(generated,'original/packages/plugins/sdk/src/worker-rpc-host.ts'):path.join(repo,'packages/plugins/sdk/src/worker-rpc-host.ts'),'utf8');
 const {code}=await transform(source,{loader:'ts',format:'esm',target:'node24'});
 fs.writeFileSync(path.join(root,'node_modules/@paperclipai/plugin-sdk/dist/worker-rpc-host-'+version+'.js'),code);
}
console.log('Built baseline and working-tree host/SDK; unrelated logging, tracing, login and idle-service dependencies isolated.');
