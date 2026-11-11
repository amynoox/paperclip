// Compile only the approved task MCP transport from committed source.
// Inputs must be the exact installed nightly modules; this never installs them.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { transform } = createRequire(new URL('./task-mcp-tests/package.json', import.meta.url))('esbuild');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [serviceInput, routeInput, destination] = process.argv.slice(2);
assert.ok(serviceInput && routeInput && destination, 'Usage: node studio/build-task-mcp-overlay.mjs <installed services/project-tools.js> <installed routes/project-tools.js> <new output directory>');
const git = (...args) => execFileSync('git', ['-c', 'safe.directory='+root.replaceAll('\\','/'), '-C', root, ...args], { encoding:'utf8',maxBuffer:8*1024*1024 });
const baseline = '179694de7dc700aa5b4d0ab58fe8531cd8119f93';
const hash = value => createHash('sha256').update(value).digest('hex');
const compile = async (source, loader, minify=false) => (await transform(source, { loader,format:'esm',target:'node24',legalComments:'none',minifySyntax:minify,minifyWhitespace:minify,minifyIdentifiers:false })).code;
const inputs = [
  ['services/project-tools.js',serviceInput,'051da2a1c8271d6350d68f7279ddc6d2fa35c9554f4ab2c69d520aa6d36214f4'],
  ['routes/project-tools.js',routeInput,'8cc5812f36b720a402cdb4efc70582e09d3687c77dce0cb6305792e4165e89ee'],
];
const modules=[];
for (const [file, input, expected] of inputs) {
  const runtime=fs.readFileSync(input,'utf8');assert.equal(hash(runtime),expected,'Installed baseline mismatch: '+file);
  const sourceFile='server/src/'+file.replace(/\.js$/,'.ts');
  const before=git('show',baseline+':'+sourceFile);
  assert.equal(await compile(before,'ts',true),await compile(runtime,'js',true),'Source/runtime baseline mismatch: '+file);
  modules.push({file,sourceFile,beforeSha256:expected});
}
modules.push({file:'services/run-task-tools.js',sourceFile:'server/src/services/run-task-tools.ts',beforeSha256:null});
const output=path.resolve(destination);assert.ok(!fs.existsSync(output),'Destination must be new');
const built=[];
for (const entry of modules) {
  const source=fs.readFileSync(path.join(root,entry.sourceFile),'utf8').replaceAll('\r\n','\n');
  assert.equal(source,git('show','HEAD:'+entry.sourceFile),'Commit tested source before building');
  const code=await compile(source,'ts');built.push({...entry,code,sourceSha256:hash(source),afterSha256:hash(code)});
}
fs.mkdirSync(output,{recursive:true});
for (const {file,code} of built) {const target=path.join(output,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,code);}
const receipt={schemaVersion:1,patchId:'STUDIO-0004',version:'2026.1110.0-studio.3',sourceCommit:git('rev-parse','HEAD').trim(),sourceCommitted:true,upstreamCommit:baseline,
  modules:built.map(({code,...metadata})=>metadata),databaseMigration:false,newPermissions:false,networkPolicyChanged:false,adapterProfileChanged:false,
  fullBuild:false,realTestRun:false,priorOverlaysMustBePreserved:['STUDIO-0001','STUDIO-0003']};
fs.writeFileSync(path.join(output,'studio-task-mcp-build.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt));
