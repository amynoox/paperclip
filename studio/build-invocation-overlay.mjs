// Build a minimal, hash-checked overlay from the exact committed fork source.
// This does not install anything or perform a full server rebuild.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const {transform}=createRequire(new URL('./scope-tests/package.json',import.meta.url))('esbuild');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [hostInput,sdkInput,output]=process.argv.slice(2);
assert.ok(hostInput&&sdkInput&&output,'Usage: node studio/build-invocation-overlay.mjs <upstream host module> <upstream SDK module> <new output directory>');
const git=(...args)=>execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),'-C',root,...args],{encoding:'utf8',maxBuffer:8*1024*1024});
const baseline='179694de7dc700aa5b4d0ab58fe8531cd8119f93';
const committed=file=>{const s=fs.readFileSync(path.join(root,file),'utf8').replaceAll('\r\n','\n');assert.equal(s,git('show','HEAD:'+file),'Commit tested source before building');return s;};
const hash=s=>createHash('sha256').update(s).digest('hex');
const hostFile='server/src/services/plugin-worker-manager.ts';
const sdkFile='packages/plugins/sdk/src/worker-rpc-host.ts';
const beforeHost=git('show',baseline+':'+hostFile);
const afterHost=committed(hostFile);
const beforeSdk=git('show',baseline+':'+sdkFile);
const afterSdk=committed(sdkFile);
const upstreamHost=fs.readFileSync(hostInput,'utf8');
const upstreamSdk=fs.readFileSync(sdkInput,'utf8');
assert.equal(hash(upstreamHost),'ea15af752dbd69de9b4197b2895a21782a0a68d6fbde333336159396b36da23f');
assert.equal(hash(upstreamSdk),'8807fd56e580a2d9431a9bae8ec98bdc16cf33fde6c8756789f4fb2bbb965713');
function block(text,name,{method=false,arrow=false}={}){
 const regex=new RegExp('^( +)'+(method?'':arrow?'const ':'function ')+name+'\\b[^\\n]*'+(method?'\\{\\r?$':''),'m');
 const match=regex.exec(text);assert.ok(match,'Missing block '+name);
 const indent=match[1];
 const endMarker='\n'+indent+(method?'},':arrow?'};':'}');
 const end=text.indexOf(endMarker,match.index)+endMarker.length;
 assert.ok(end>match.index,'Missing block end '+name);
 const raw=text.slice(match.index,end);
 let normalized=raw.split('\n').map(l=>l.startsWith(indent)?l.slice(indent.length):l).join('\n');
 if(method)normalized='function '+normalized.slice(0,-1);
 return{raw,normalized,indent};
}
const compile=(code,loader='ts',minify=false)=>transform(code,{loader,target:'node24',format:'esm',minifySyntax:minify,minifyWhitespace:minify,minifyIdentifiers:false,legalComments:'none'}).then(x=>x.code.trim());
let host=upstreamHost;
const replaced=[];
for(const name of ['deriveInvocationScope','registerInvocation','clearInvocation','contextForWorkerMessage','handleWorkerNotification','notify']){
 const options={method:name==='notify'};
 const oldSource=block(beforeHost,name,options),oldRuntime=block(host,name,options),newSource=block(afterHost,name,options);
 assert.equal(await compile(oldSource.normalized,'ts',true),await compile(oldRuntime.normalized,'js',true),'Source/runtime baseline mismatch: '+name);
 let compiled=await compile(newSource.normalized);
 if(name==='clearInvocation')compiled+='\n'+await compile(block(afterHost,'clearInvocationById').normalized);
 if(options.method)compiled=compiled.replace(/^function /,'')+',';
 const replacement=compiled.split('\n').map(l=>oldRuntime.indent+l).join('\n');
 assert.equal(host.split(oldRuntime.raw).length-1,1);
 host=host.replace(oldRuntime.raw,replacement);replaced.push(name);
}
const oldSource=block(beforeSdk,'runNotification',{arrow:true});
const oldRuntime=block(upstreamSdk,'runNotification',{arrow:true});
const newSource=block(afterSdk,'runNotification',{arrow:true});
assert.equal(await compile(oldSource.normalized,'ts',true),await compile(oldRuntime.normalized,'js',true),'SDK source/runtime baseline mismatch');
const sdk=upstreamSdk.replace(oldRuntime.raw,(await compile(newSource.normalized)).split('\n').map(l=>oldRuntime.indent+l).join('\n'));
const out=path.resolve(output);assert.ok(!fs.existsSync(out),'Output must not already exist');fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'plugin-worker-manager.js'),host);
fs.writeFileSync(path.join(out,'worker-rpc-host.js'),sdk);
const receipt={schemaVersion:1,patchId:'STUDIO-0003',version:'2026.1110.0-studio.2',sourceCommit:git('rev-parse','HEAD').trim(),sourceCommitted:true,notificationOnlySettlement:true,upstream:'2026.1110.0-nightly.0',upstreamCommit:'179694de7dc700aa5b4d0ab58fe8531cd8119f93',pr15925:'59cf44a3ac2a479ef6e9795acd16b8e85954e974',pr9368:'4558c6fc38cd08b2d977b740ce61aea1d03e7dbb',customDelta:'notification-delivery-only settlement guard, explicitly approved 2026-11-10',host:{beforeSha256:hash(upstreamHost),afterSha256:hash(host),sourceSha256:hash(afterHost),replaced},sdk:{beforeSha256:hash(upstreamSdk),afterSha256:hash(sdk),sourceSha256:hash(afterSdk),replaced:['runNotification']},fullBuild:false,databaseMigration:false};
fs.writeFileSync(path.join(out,'studio-scope-build.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt));
