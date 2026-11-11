import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../..');
if(!process.env.STUDIO_TYPE_DEPS || !process.env.STUDIO_PLUGIN_TEST_DEPS)
  throw Error('Set STUDIO_TYPE_DEPS and STUDIO_PLUGIN_TEST_DEPS to isolated dependency directories (not node_modules).');
const deps=path.resolve(process.env.STUDIO_TYPE_DEPS,'node_modules');
const plugin=path.resolve(process.env.STUDIO_PLUGIN_TEST_DEPS,'node_modules');
const version=JSON.parse(fs.readFileSync(path.join(deps,'typescript/package.json'),'utf8')).version;
if(version!=='7.0.2')throw Error('Use the source-pinned TypeScript 7.0.2 compiler.');
// ACPX declarations must have the existing upstream-pinned workspace patch.
const acpx=fs.readFileSync(path.join(deps,'acpx/dist/runtime.d.ts'),'utf8');
if(!acpx.includes('spawnCwd?: string') || !acpx.includes('onTerminalSessionFailure?:'))
  throw Error('Apply the .d.ts hunks of the source-pinned acpx@0.12.0 patch to the isolated dependency first.');
const config={compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,
  skipLibCheck:true,noEmit:true,types:['node'],typeRoots:[path.join(deps,'@types')],paths:{
    '@paperclipai/adapter-utils':[path.join(repo,'packages/adapter-utils/src/index.ts')],
    '@paperclipai/adapter-utils/*':[path.join(repo,'packages/adapter-utils/src/*.ts')],
    '@paperclipai/shared':[path.join(repo,'packages/shared/src/index.ts')],
    '@paperclipai/shared/*':[path.join(repo,'packages/shared/src/*.ts')],
    'zod':[path.join(plugin,'zod/index.d.ts')],
    'smol-toml':[path.join(plugin,'smol-toml/dist/index.d.ts')],
    'three':[path.join(plugin,'three/build/three.module.js')],
    'acpx/runtime':[path.join(deps,'acpx/dist/runtime.d.ts')],
  }},files:[
    'server/src/services/adapter-interactive-control.ts',
    'server/src/services/issue-queued-comment-queue.ts',
    'packages/adapters/codex-local/src/server/execute.ts',
  ].map(file=>path.join(repo,file))};
fs.mkdirSync(path.join(here,'.generated'),{recursive:true});
const configPath=path.join(here,'.generated/typecheck.json');
fs.writeFileSync(configPath,JSON.stringify(config,null,2));
const result=spawnSync(process.execPath,[path.join(deps,'typescript/bin/tsc'),'-p',configPath,'--pretty','false'],{stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
