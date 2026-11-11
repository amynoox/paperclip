import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../..');
const uiDeps=path.resolve(process.env.STUDIO_UI_DEPS??path.join(repo,'../steering-ui-deps'));
const pluginDeps=path.resolve(process.env.STUDIO_PLUGIN_TEST_DEPS??path.join(repo,'../plugin-steering-prototype'));
const require=createRequire(path.join(pluginDeps,'package.json'));
const uiRequire=createRequire(path.join(uiDeps,'package.json'));
const {build}=require('esbuild');

// Real queue component, React, DOM and DnD. Only presentation dependencies and
// unused image/automatic-send helpers are doubles; these tests never enable
// autoSteerDelayMs or attachments and make no claim about those features.
const doubles={
  '@/lib/utils':`export const cn=(...values)=>values.filter(Boolean).join(' ');`,
  '@/components/MarkdownBody':`import React from 'react'; export function MarkdownBody({children}) {return React.createElement('span',null,children);}`,
  './task-chat-attachments':`export const extractImageRefs=()=>[]; export const stripStandaloneImageEmbeds=value=>value;`,
  './TaskChatComposerBar':`import React from 'react'; export function TaskChatComposerBar({children,...props}) {return React.createElement('section',props,children);}`,
  './queued-message-auto-steer':`const unused=()=>{throw new Error('Automatic sending is outside this fixture');}; export const queuedMessageAutoSteerDeadline=unused,queuedMessageAutoSteerEligible=unused,queuedMessageAutoSteerKey=unused;`,
  '@/components/ui/dropdown-menu':`import React from 'react'; export const DropdownMenu=({children})=>React.createElement(React.Fragment,null,children); export const DropdownMenuTrigger=({children})=>children; export const DropdownMenuContent=()=>null; export const DropdownMenuItem=()=>null;`,
};
await build({
  entryPoints:[path.join(repo,'ui/src/components/task-chat/TaskChatQueuedMessages.tsx')],
  outfile:path.join(here,'.generated/queued-messages-ui.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',
  jsx:'automatic',tsconfigRaw:{},nodePaths:[path.join(uiDeps,'node_modules')],
  plugins:[{name:'declared-ui-boundaries',setup(b){
    b.onResolve({filter:/^(react|react-dom|lucide-react|@dnd-kit\/[^/]+)(\/.*)?$/},args=>({path:pathToFileURL(uiRequire.resolve(args.path)).href,external:true}));
    b.onResolve({filter:/.*/},args=>Object.hasOwn(doubles,args.path)?{path:args.path,namespace:'ui-decoration'}:undefined);
    b.onLoad({filter:/.*/,namespace:'ui-decoration'},args=>({contents:doubles[args.path],loader:'js',resolveDir:uiDeps}));
  }}],
});
console.log('Bundled actual queue UI with real React/DnD; presentation, attachments and disabled automatic-send helpers are declared doubles.');
