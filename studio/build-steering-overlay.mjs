// Compile the approved steering modules from committed source. No installation.
// Baseline files must be exported from the authenticated, unchanged studio.3 payload.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [baselineDirectory,destination]=process.argv.slice(2);
assert.ok(baselineDirectory&&destination,'Usage: node studio/build-steering-overlay.mjs <exported studio.3 node_modules> <new output directory>');
assert.ok(process.env.STUDIO_TEST_DEPS,'STUDIO_TEST_DEPS must identify isolated esbuild dependencies');
assert.ok(process.env.STUDIO_TYPE_DEPS,'STUDIO_TYPE_DEPS must identify the pinned TypeScript compiler');
const require=createRequire(path.resolve(process.env.STUDIO_TEST_DEPS,'package.json'));
const {transform}=require('esbuild');
const git=(...args)=>execFileSync('git',['-c','gc.auto=0','-c','maintenance.auto=false','-c','safe.directory='+root.replaceAll('\\','/'),'-C',root,...args],{encoding:'utf8',maxBuffer:32*1024*1024});
const hash=x=>createHash('sha256').update(x).digest('hex');
const compile=async(source,loader,minify=false)=>(await transform(source,{loader,format:'esm',target:'node24',legalComments:'none',minifySyntax:minify,minifyWhitespace:minify,minifyIdentifiers:false})).code;
const baselineCommit='7ca4f1808dfb71f80c2e1b2e1d015a8d66fb6fdd';
const modules=[
  ['server/src/routes/issues.ts','@paperclipai/server/dist/routes/issues.js'],
  ['server/src/services/adapter-interactive-control.ts','@paperclipai/server/dist/services/adapter-interactive-control.js',true],
  ...['run-output','run-state','runtime-execution','runtime-selection'].map(name=>['server/src/services/heartbeat/'+name+'.ts','@paperclipai/server/dist/services/heartbeat/'+name+'.js']),
  ...['issue-queued-comment-queue','run-identity'].map(name=>['server/src/services/'+name+'.ts','@paperclipai/server/dist/services/'+name+'.js']),
  ...['execute','index'].map(name=>['packages/adapters/codex-local/src/server/'+name+'.ts','@paperclipai/adapter-codex-local/dist/server/'+name+'.js']),
];
const output=path.resolve(destination),baseline=path.resolve(baselineDirectory);
assert.ok(!fs.existsSync(output),'Destination must be new');
const commit=git('rev-parse','HEAD').trim();
const declarations=[
  ['packages/adapter-utils/src/index.ts','@paperclipai/adapter-utils/dist/index.d.ts'],
  ['packages/adapter-utils/src/types.ts','@paperclipai/adapter-utils/dist/types.d.ts'],
  ['packages/shared/src/types/issue.ts','@paperclipai/shared/dist/types/issue.d.ts'],
  ['packages/adapters/codex-local/src/server/index.ts','@paperclipai/adapter-codex-local/dist/server/index.d.ts'],
];
const compiler=path.resolve(process.env.STUDIO_TYPE_DEPS,'node_modules/typescript');
assert.equal(JSON.parse(fs.readFileSync(path.join(compiler,'package.json'),'utf8')).version,'7.0.2','Unexpected TypeScript version');
fs.mkdirSync(output,{recursive:true});
// Use the pinned native compiler, not a separate class-field lowering scheme.
// Semantic checks run separately; noResolve/noCheck confines this emit to the
// explicit approved files and leaves their native runtime imports untouched.
for(const [name,revision] of [['before',baselineCommit],['after','HEAD']]){
  const dir=path.join(output,'.compiler',name),sourceRoot=path.join(dir,'source'),files=[];
  for(const sourceFile of new Set([...modules.filter(m=>name==='after'||!m[2]).map(m=>m[0]),...declarations.map(m=>m[0])])){
    const source=git('show',revision+':'+sourceFile),target=path.join(sourceRoot,sourceFile);
    if(name==='after')assert.equal(fs.readFileSync(path.join(root,sourceFile),'utf8').replaceAll('\r\n','\n'),source,'Commit source before building: '+sourceFile);
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,source);files.push(target);
  }
  fs.writeFileSync(path.join(sourceRoot,'package.json'),'{"type":"module"}\n');
  const config={compilerOptions:{target:'ES2023',module:'NodeNext',moduleResolution:'NodeNext',noCheck:true,noResolve:true,
    declaration:true,declarationMap:false,sourceMap:false,removeComments:false,rootDir:sourceRoot,outDir:path.join(dir,'emit')},files};
  fs.writeFileSync(path.join(dir,'tsconfig.json'),JSON.stringify(config,null,2));
  execFileSync(process.execPath,[path.join(compiler,'bin/tsc'),'-p',path.join(dir,'tsconfig.json'),'--pretty','false'],{stdio:'pipe'});
}
const emitted=(which,sourceFile,extension)=>fs.readFileSync(path.join(output,'.compiler',which,'emit',sourceFile.replace(/\.ts$/,extension)),'utf8');
const built=[];
for(const [sourceFile,file,isNew] of modules){
  const input=path.join(baseline,file);let beforeSha256=null;
  if(isNew){assert.ok(!fs.existsSync(input),'New module already exists in baseline: '+file);}
  else{
    const runtime=fs.readFileSync(input,'utf8');beforeSha256=hash(runtime);
    const before=emitted('before',sourceFile,'.js');
    assert.ok(await compile(before,'js',true)===await compile(runtime,'js',true),'Source/runtime baseline mismatch: '+file);
  }
  const source=fs.readFileSync(path.join(root,sourceFile),'utf8').replaceAll('\r\n','\n');
  assert.equal(source,git('show','HEAD:'+sourceFile),'Commit source before building: '+sourceFile);
  const code=emitted('after',sourceFile,'.js');
  built.push({file,sourceFile,beforeSha256,sourceSha256:hash(source),afterSha256:hash(code),code});
}
// Type-only additions cannot introduce another runtime module or dependency.
for(const sourceFile of ['packages/adapter-utils/src/index.ts','packages/adapter-utils/src/types.ts','packages/shared/src/types/issue.ts']){
  const before=git('show',baselineCommit+':'+sourceFile),after=git('show','HEAD:'+sourceFile);
  assert.equal(await compile(before,'ts',true),await compile(after,'ts',true),'Unexpected runtime change in declared type-only module: '+sourceFile);
}
for(const [sourceFile,file] of declarations){
  const input=fs.readFileSync(path.join(baseline,file),'utf8'),before=emitted('before',sourceFile,'.d.ts');
  // Maps are not included in this overlay. Preserve every other declaration
  // byte after normalizing the platform newline and the compiler map footer.
  const normalized=x=>x.replaceAll('\r\n','\n').replace(/^\/\/# sourceMappingURL=.*$/gm,'').trim();
  assert.equal(normalized(before),normalized(input),'Declaration baseline mismatch: '+file);
  const code=emitted('after',sourceFile,'.d.ts'),source=git('show','HEAD:'+sourceFile);
  built.push({file,sourceFile,beforeSha256:hash(input),sourceSha256:hash(source),afterSha256:hash(code),code,declarationOnly:true});
}
for(const item of built){const target=path.join(output,'node_modules',item.file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,item.code);}
for(const item of built.filter(item=>!item.declarationOnly))
  execFileSync(process.execPath,['--check',path.join(output,'node_modules',item.file)],{stdio:'pipe'});
const receipt={schemaVersion:1,patchId:'STUDIO-0005',version:'2026.1110.0-studio.4',sourceCommit:commit,sourceCommitted:true,
  baselineVersion:'2026.1110.0-studio.3',baselineCommit,upstreamCommit:'179694de7dc700aa5b4d0ab58fe8531cd8119f93',
  modules:built.map(({code,...item})=>item),databaseMigration:false,newPermissions:false,networkPolicyChanged:false,
  activeConfigurationChanged:false,featureDefault:false,fullBuild:false,realTestRun:false,
  uiBuildRequired:true,priorOverlaysMustBePreserved:['STUDIO-0001','STUDIO-0003','STUDIO-0004']};
fs.writeFileSync(path.join(output,'studio-steering-build.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt));
