// Build the complete board with the native Vite configuration. Dependency
// installation is a separate, frozen-lockfile/ignore-scripts local operation.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ui=path.join(repo,'ui');
if(!process.env.STUDIO_UI_RELEASE_DEPS||!process.env.STUDIO_UI_RELEASE_OUT)
  throw new Error('Set isolated STUDIO_UI_RELEASE_DEPS and STUDIO_UI_RELEASE_OUT.');
const deps=path.resolve(process.env.STUDIO_UI_RELEASE_DEPS);
const out=path.resolve(process.env.STUDIO_UI_RELEASE_OUT);
if(out===repo||out===ui||out.startsWith(path.join(repo,'ui','src')+path.sep))
  throw new Error('Refusing a source directory as build output.');
if(fs.existsSync(out)&&fs.readdirSync(out).length)throw new Error('Use a new, empty build output directory.');
const commit=process.env.PAPERCLIP_BUILD_COMMIT;
if(!/^[a-f0-9]{40}$/.test(commit??''))throw new Error('PAPERCLIP_BUILD_COMMIT must be a full reviewed source commit.');
const actualCommit=execFileSync('git',['-c','safe.directory='+repo.replaceAll('\\','/'),'rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true}).trim();
if(actualCommit!==commit)throw new Error('Browser build commit differs from checkout HEAD.');
const require=createRequire(path.join(deps,'package.json'));
const {loadConfigFromFile,mergeConfig,build}=await import(pathToFileURL(require.resolve('vite')).href);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const aliases=[];
const roots=[path.join(repo,'packages/shared'),path.join(repo,'packages/adapter-utils'),path.join(repo,'packages/plugins/sdk'),
  ...fs.readdirSync(path.join(repo,'packages/adapters'),{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>path.join(repo,'packages/adapters',x.name))];
const escaped=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
for(const root of roots){
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  for(const [sub,raw]of Object.entries(manifest.exports??{})){
    let entry=typeof raw==='string'?raw:raw.import??raw.default;
    if(typeof entry!=='string')continue;
    entry=entry.replace('./dist/','./src/').replace(/\.js$/,'.ts');
    const name=manifest.name+(sub==='.'?'':sub.slice(1));
    if(entry.includes('*')){aliases.push({find:new RegExp('^'+escaped(name).replace('\\*','(.+)')+'$'),replacement:path.join(root,entry).replaceAll('\\','/').replace('*','$1')});continue;}
    let target=path.join(root,entry);
    if(!fs.existsSync(target)&&target.endsWith('.ts')&&fs.existsSync(target+'x'))target+='x';
    if(fs.existsSync(target))aliases.push({find:new RegExp('^'+escaped(name)+'$'),replacement:target.replaceAll('\\','/')});
  }
}
const loaded=await loadConfigFromFile({command:'build',mode:'production'},path.join(ui,'vite.config.ts'),ui);
if(!loaded)throw new Error('Native Vite configuration could not be loaded.');
const config=mergeConfig(loaded.config,{root:ui,configFile:false,mode:'production',resolve:{alias:aliases},build:{outDir:out,emptyOutDir:false}});
// Preserve the primary bundling error if Vite also invokes the native service
// worker close hook after a failed build (there is then no sw.js to read).
// A close-hook failure still fails a successful build; none is silently ignored.
let closeFailure;
for(const plugin of config.plugins.flat(Infinity).filter(Boolean)){
  if(plugin.name!=='paperclip-sw-build-id'||typeof plugin.closeBundle!=='function')continue;
  const close=plugin.closeBundle;
  plugin.closeBundle=function(...args){try{return close.apply(this,args);}catch(error){closeFailure=error;}};
}
try{await build(config);}catch(error){if(closeFailure)console.error('Secondary native close-hook failure:',closeFailure.message);throw error;}
if(closeFailure)throw closeFailure;
const files=[];
function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw new Error('Unexpected output link');if(e.isDirectory())visit(p);else{const bytes=fs.readFileSync(p);files.push({file:path.relative(out,p).replaceAll('\\','/'),bytes:bytes.length,sha256:hash(bytes)});}}}
visit(out);
if(!files.some(x=>x.file==='index.html'))throw new Error('Missing complete UI entry point.');
const manifest={sourceCommit:commit,sourceLockSha256:hash(fs.readFileSync(path.join(repo,'pnpm-lock.yaml'))),
  nativeConfigSha256:hash(fs.readFileSync(path.join(ui,'vite.config.ts'))),dependencyLockSha256:hash(fs.readFileSync(path.join(deps,'pnpm-lock.yaml'))),
  node:process.version,config:'ui/vite.config.ts (native plugins, splitting, service-worker build id)',workspaceAliases:aliases.map(x=>String(x.find)),
  fileCount:files.length,totalBytes:files.reduce((sum,x)=>sum+x.bytes,0),files};
fs.writeFileSync(out+'.manifest.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({output:out,manifest:out+'.manifest.json',sourceCommit:commit,fileCount:manifest.fileCount,totalBytes:manifest.totalBytes}));
