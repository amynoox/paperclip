import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const deps=process.env.STUDIO_BUILD_DEPS;
const output=process.argv[2];
if(!deps||!output)throw Error('Set STUDIO_BUILD_DEPS to the isolated esbuild dependency directory and provide a new output directory.');
const out=path.resolve(output);
if(fs.existsSync(out))throw Error('Output must not already exist.');
const git=(...args)=>execFileSync('git',['-c','gc.auto=0','-c','maintenance.auto=false','-c',`safe.directory=${repo.replaceAll('\\','/')}`,'-C',repo,...args],{encoding:'utf8'}).trimEnd();
const sha=x=>createHash('sha256').update(x).digest('hex');
const normalize=x=>x.replaceAll('\r\n','\n').trimEnd()+'\n';
const sourceCommit=git('rev-parse','HEAD');
const require=createRequire(path.join(path.resolve(deps),'package.json'));
const esbuild=require('esbuild');
if(esbuild.version!=='0.28.2')throw Error('Use the verified esbuild 0.28.2 compiler.');
const files=['modules/run-dispatch/adapters/postgres','modules/run-dispatch/domain/policy','modules/run-dispatch/index','services/heartbeat/queue'];
const manifest={schema:1,patch:'STUDIO-0006',sourceCommit,upstreamPr:14378,upstreamHead:'e70c3129049d488b8c3eedbbb9dddc837645b34b',baselineSourceCommit:'10b89f1aaa7d859d921ffa225b93af71b173d862',compiler:{name:'esbuild',version:esbuild.version,target:'node24'},runtimeBaselineVerified:false,deployed:false,files:[]};
fs.mkdirSync(out,{recursive:true});
for(const name of files){
  const sourcePath=`server/src/${name}.ts`;
  const source=normalize(git('show',`${sourceCommit}:${sourcePath}`));
  if(normalize(fs.readFileSync(path.join(repo,sourcePath),'utf8'))!==source)throw Error('Uncommitted runtime source: '+sourcePath);
  const {code,warnings}=await esbuild.transform(source,{loader:'ts',format:'esm',target:'node24',sourcefile:sourcePath});
  if(warnings.length)throw Error('Unexpected compilation warning: '+sourcePath);
  const relativePath=`node_modules/@paperclipai/server/dist/${name}.js`;
  const destination=path.join(out,relativePath);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,code);
  manifest.files.push({sourcePath,sourceSha256:sha(source),relativePath,sha256:sha(code),bytes:Buffer.byteLength(code)});
}
fs.writeFileSync(path.join(out,'interaction-addressee-build.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({sourceCommit,files:manifest.files.length,manifest:path.join(out,'interaction-addressee-build.json'),runtimeBaselineVerified:false,deployed:false}));
