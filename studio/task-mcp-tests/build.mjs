import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const out = path.join(here, '.generated'); fs.mkdirSync(out, { recursive: true });
const overlay = process.env.STUDIO_MCP_OVERLAY ? path.resolve(process.env.STUDIO_MCP_OVERLAY) : null;
// Bundle the real validators and audience decision, never a permissive copy.
const shared = `export * from ${JSON.stringify(path.join(repo, 'packages/shared/src/validators/issue.ts'))};
export * from ${JSON.stringify(path.join(repo, 'packages/shared/src/validators/project.ts'))};
export * from ${JSON.stringify(path.join(repo, 'packages/shared/src/constants.ts'))};`;
const stubs = {
  '@paperclipai/db': 'export const issues={id:"id",companyId:"companyId"},companies={id:"id",issuePrefix:"issuePrefix"};',
  'drizzle-orm': 'export const eq=(a,b)=>({a,b}),and=(...v)=>v;',
  './run-identity.js': 'export const captureRunIdentity=(...a)=>globalThis.fixtureIdentity(...a);',
  '../vendor/paperclip-runner/index.js': 'export const CAPABILITY_SEMANTIC_TOOL_CATALOG=[{operationId:"list_projects",allowedModes:["standard","ask","planning","skill_test"],description:"Existing project catalogue",inputSchema:{type:"object"}}];',
  './authz.js': 'export const assertCompanyAccess=(req,company)=>{if(req.actor.companyId!==company)throw Error("Company denied")};',
};
const plugins = [{ name: 'bounded-regression-fixtures', setup(b) {
  b.onResolve({filter: /^@paperclipai\/shared$/},()=>({path:'shared',namespace:'fixture'}));
  b.onResolve({filter: /.*/},a => Object.hasOwn(stubs,a.path) ? {path:a.path,namespace:'fixture'} : undefined);
  if (overlay) b.onResolve({filter: /(?:project-tool-context|errors)\.js$/},a=>({path:path.join(repo, a.path.includes('context') ? 'server/src/services/project-tool-context.ts' : 'server/src/errors.ts')}));
  b.onLoad({filter: /.*/,namespace:'fixture'},a=>({contents:a.path==='shared'?shared:stubs[a.path],loader:'ts',resolveDir:repo}));
}}];
for (const [name, file] of Object.entries({
  task: 'server/src/services/run-task-tools.ts',
  route: 'server/src/routes/project-tools.ts',
  audience: 'server/src/services/issue-thread-interaction-resolution.ts',
  context: 'server/src/services/project-tool-context.ts',
})) {
  const entry=overlay && ['task','route'].includes(name) ? path.join(overlay,file.replace('server/src/','').replace(/\.ts$/,'.js')) : path.join(repo,file);
  await build({entryPoints:[entry],outfile:path.join(out,name+'.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',plugins,tsconfigRaw:{}});
}
