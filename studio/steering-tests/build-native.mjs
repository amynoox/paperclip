import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../..');
const require=createRequire(path.resolve(process.env.STUDIO_TEST_DEPS,'package.json'));
const {build}=require('esbuild');
const typeDeps=path.resolve(process.env.STUDIO_TYPE_DEPS,'node_modules');
const pluginDeps=path.resolve(process.env.STUDIO_PLUGIN_TEST_DEPS,'node_modules');
const source=path.join(repo,'packages/adapters/codex-local/src/server');
const childProcessFixture=process.env.STUDIO_LOCAL_CHILD_PROCESS?path.resolve(process.env.STUDIO_LOCAL_CHILD_PROCESS):null;
await build({stdin:{contents:`import {execute as nativeExecute} from ${JSON.stringify(path.join(source,'execute.ts'))};
export async function execute(ctx){try{return await nativeExecute(ctx);}catch(error){console.error('LOCAL NATIVE PREPARATION ERROR',error.stack);throw error;}}
export {buildSshSpawnTarget} from ${JSON.stringify(path.join(repo,'packages/adapter-utils/src/ssh.ts'))};
export {sanitizeRemoteExecutionEnv,prepareGitHubExecutionEnvironment,runAdapterExecutionTargetShellCommand} from ${JSON.stringify(path.join(repo,'packages/adapter-utils/src/execution-target.ts'))};
export {getConfigSchema} from ${JSON.stringify(path.join(source,'config-schema.ts'))};
export const supportsPreparedInteractiveProcess=true;`,resolveDir:repo,loader:'ts'},outfile:path.join(here,'.generated/native-execute.mjs'),
  bundle:true,platform:'node',format:'esm',target:'node24',tsconfigRaw:{},
  banner:{js:"import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);"},
  nodePaths:[typeDeps,pluginDeps],alias:{
    '@paperclipai/adapter-utils':path.join(repo,'packages/adapter-utils/src/index.ts'),
    '@paperclipai/shared':path.join(repo,'packages/shared/src/index.ts'),
  },plugins:[{name:'workspace-subpath',setup(b){b.onResolve({filter:/^@paperclipai\/(adapter-utils|shared)\//},args=>({
    path:path.join(repo,'packages',args.path.split('/')[1],'src',args.path.split('/').slice(2).join('/')+'.ts')
  }));
  if(childProcessFixture)b.onResolve({filter:/^(node:)?child_process$/},args=>args.importer===childProcessFixture?undefined:{path:childProcessFixture});
 }}]});
for(const file of ['codex-auth-merge-decision.cjs','codex-auth-merge-extract.sh'])
  await fs.copyFile(path.join(source,file),path.join(here,'.generated',file));
console.log('Bundled actual full Codex execute source; '+(childProcessFixture?'local loopback replaces only child-process SSH transport.':'no provider or preparation stubs.'));
