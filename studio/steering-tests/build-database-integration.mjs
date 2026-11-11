import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../..');
const deps=path.resolve(process.env.STUDIO_DB_TEST_DEPS??path.join(here,'node_modules/..'));
const toolDeps=path.resolve(process.env.STUDIO_TEST_DEPS??deps);
const uiDeps=process.env.STUDIO_UI_DEPS?path.resolve(process.env.STUDIO_UI_DEPS):deps;
const require=createRequire(path.join(toolDeps,'package.json')),{build}=require('esbuild');
const out=path.join(here,'.generated');fs.mkdirSync(out,{recursive:true});
const actual=new Set([
 'routes/issues','routes/authz','errors','db-errors','database-retry','redaction','middleware/validate','middleware/private-json-etag','attachment-types',
 'services/adapter-interactive-control','services/issue-queued-comment-queue','services/run-identity','services/heartbeat-run-events',
 'services/agent-interaction-delivery','services/agent-interaction-policy','services/plugin-interaction-context',
 'services/queued-interaction-response','services/issue-thread-interaction-resolution',
 'services/task-retry','services/run-task-binding','services/native-runtime/first-turn-queued-input',
 'services/native-runtime/canonical','services/native-runtime/evidence-classifier','services/safe-native-chat-progress',
 'services/issues','services/access','services/authorization','services/issue-display-status',
 'services/settings-visibility','services/company-search-rate-limit','services/run-secret-redaction',
 'services/activity-log','services/source-trust','services/issue-execution-policy',
 'services/slack-conversation-state','services/issue-question-context',
 'lib/request-promise-memo','lib/agent-permissions','services/company-member-roles','services/execution-preparation-timing',
 'services/trust-preset-resolver','services/execution-identity','services/owner-chat-instruction-authority','services/connection-management-policy',
 'services/heartbeat/run-state','adapters/utils','services/agent-conversations',
 'services/native-response-presentation-notifications','services/instance-settings',
 'services/managed-config','services/setting-defaults','services/cloud-instance','log-redaction',
]);
// This builds the entire real issues router. Unrelated route owners are explicit
// inert factories; invoking any of their methods fails the integration test.
// SQL, authorization, identity reservation, queue locks and ACK persistence below
// are the actual production modules, not excerpts or transaction substitutes.
const importNames=new Map(),observedStubs=new Set();
function namesFromSource(source,filename){
 const importRe=/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["'];/g;
 for(const match of source.matchAll(importRe)){
  if(!match[2].startsWith('.'))continue;
  const key=path.resolve(path.dirname(filename),match[2]).replace(/\.js$/,'.ts');
  const names=importNames.get(key)??new Set();
  const braces=match[1].match(/\{([\s\S]*)\}/);
  if(braces)for(const spec of braces[1].split(',')){const n=spec.trim();if(!n||n.startsWith('type '))continue;names.add(n.split(/\s+as\s+/)[0].trim());}
  importNames.set(key,names);
 }
}
for(const file of actual){const f=path.join(repo,'server/src',file+'.ts');namesFromSource(fs.readFileSync(f,'utf8'),f);}
const failFactory=`const unavailable=name=>new Proxy(function(){throw Error('Unexercised integration port called: '+name)},{get:(_t,key)=>key==='then'?undefined:unavailable(name+'.'+String(key))});\n`;
const factories=new Set(['createQueuedCommentQueue','createRunSecretRedactionRegistry','createRequestPromiseMemo','getSecretProvider']);
function stub(file){
 observedStubs.add(path.relative(repo,file).replaceAll('\\','/'));
 const names=importNames.get(file)??new Set();
 let code=failFactory;
 for(const name of names){if(!/^[A-Za-z_$][\w$]*$/.test(name))continue;
  if(name==='logger')code+=`export const logger={warn(){},error(){},info(){},debug(){},child(){return this}};\n`;
  else if(/^notify|^publishLiveEvent$/.test(name))code+=`export function ${name}(...args){(globalThis.__studioIntegrationNotifications??=[]).push(${JSON.stringify(name)});}\n`;
  else if(/Service$/.test(name)||factories.has(name))code+=`export function ${name}(){return unavailable(${JSON.stringify(name)});}\n`;
  else if(/^[A-Z_0-9]+$/.test(name))code+=`export const ${name}=[];\n`;
  else if(/Error$/.test(name))code+=`export class ${name} extends Error{}\n`;
  else code+=`export const ${name}=unavailable(${JSON.stringify(name)});\n`;
 }
 return code;
}
const serviceIndex=path.join(repo,'server/src/services/index.ts');
const entry=`export {issueRoutes} from ${JSON.stringify(path.join(repo,'server/src/routes/issues.ts'))};
export * from ${JSON.stringify(path.join(repo,'server/src/services/adapter-interactive-control.ts'))};
export {appendHeartbeatRunEvent} from ${JSON.stringify(path.join(repo,'server/src/services/heartbeat-run-events.ts'))};
export {initializeRunIdentity} from ${JSON.stringify(path.join(repo,'server/src/services/run-identity.ts'))};
export * from '@paperclipai/db';`;
const alias={'@paperclipai/db':path.join(repo,'packages/db/src/index.ts'),'@paperclipai/shared':path.join(repo,'packages/shared/src/index.ts'),
 '@paperclipai/adapter-utils':path.join(repo,'packages/adapter-utils/src/index.ts')};
await build({stdin:{contents:entry,resolveDir:repo,loader:'ts'},outfile:path.join(out,'database-integration.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',
 tsconfigRaw:{},
 banner:{js:"import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"},nodePaths:[path.join(deps,'node_modules'),path.join(toolDeps,'node_modules'),path.join(uiDeps,'node_modules')],alias,external:['embedded-postgres'],
 plugins:[{name:'bounded-real-route',setup(b){
  b.onResolve({filter:/^(multer|chat|@paperclipai\/shared\/telemetry)$/},args=>({path:args.path,namespace:'unexercised-package'}));
  b.onLoad({filter:/.*/,namespace:'unexercised-package'},args=>({contents:failFactory+(args.path==='chat'?"export const markdownToPlainText=unavailable('chat.markdownToPlainText'),parseMarkdown=unavailable('chat.parseMarkdown');":args.path==='multer'?"export default unavailable('multer');":"export const trackAgentTaskCompleted=unavailable('telemetry');"),loader:'js'}));
  b.onResolve({filter:/^@paperclipai\/(shared|adapter-utils)\//},args=>({path:path.join(repo,'packages',args.path.split('/')[1],'src',args.path.split('/').slice(2).join('/')+'.ts')}));
  b.onLoad({filter:/server[\\/]src[\\/].*\.ts$/},args=>{
   const relative=path.relative(path.join(repo,'server/src'),args.path).replaceAll('\\','/').replace(/\.ts$/,'');
   if(args.path===serviceIndex){let code=stub(args.path);for(const [name,file] of Object.entries({issueService:'issues',accessService:'access',logActivity:'activity-log'})){
     code=code.replace(new RegExp(`export (?:function ${name}\\(\\)\\{[^\\n]*|const ${name}=[^\\n]*)\\n`),'');
     code+=`export {${name}} from './${file}.js';\n`;}
    code=code.replace(/export function heartbeatService\(\)\{[^\n]*\n/,'');
    code+="import {createHeartbeatRunState} from './heartbeat/run-state.js';\nexport function heartbeatService(db){return new Proxy(createHeartbeatRunState(db),{get:(target,key)=>key in target?target[key]:unavailable('heartbeatService.'+String(key))});}\n";
    return{contents:code,loader:'ts',resolveDir:path.dirname(args.path)};}
   if(actual.has(relative))return;
   return{contents:stub(args.path),loader:'ts',resolveDir:path.dirname(args.path)};
  });
 }}],logLevel:'warning'});
fs.writeFileSync(path.join(out,'database-integration-fixtures.json'),JSON.stringify({actualServerModules:[...actual].sort(),unexercisedPorts:[...observedStubs].sort()},null,2)+'\n');
fs.cpSync(path.join(repo,'packages/db/src/migrations'),path.join(out,'migrations'),{recursive:true});
console.log('Built complete real issues router and native PostgreSQL/identity/ACK owners; unrelated ports fail if invoked.');
