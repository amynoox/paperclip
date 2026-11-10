#!/usr/bin/env node
// Read-only local Git comparison. No fetch, credentials, execution or deployment.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024}).trim();
const target=process.argv[2];
if(!target||process.argv.length!==3){console.error('Usage: node studio/compare-upstream.mjs <locally-fetched-tag-or-commit>');process.exit(2);}
const baseline=JSON.parse(fs.readFileSync(path.join(root,'studio/upstream.json'),'utf8'));
const registry=JSON.parse(fs.readFileSync(path.join(root,'studio/patches.json'),'utf8'));
const resolve=ref=>git('rev-parse','--verify','--end-of-options',`${ref}^{commit}`);
const oldBase=resolve(baseline.commit),newBase=resolve(target),head=resolve('HEAD');
const changed=git('diff','--name-only',oldBase,newBase,'--').split('\n').filter(Boolean);
const report={
  oldUpstream:{version:baseline.version,commit:oldBase},
  newUpstream:{requested:target,commit:newBase},
  downstreamHead:head,
  upstreamChangedFileCount:changed.length,
  downstreamCommits:git('log','--format=%H %s',`${oldBase}..${head}`,'--').split('\n').filter(Boolean),
  patches:registry.patches.map(p=>({
    id:p.id,status:p.status,
    upstreamTouchedPaths:changed.filter(file=>p.paths.some(owned=>file===owned||file.startsWith(owned+'/'))),
    recordedCommits:p.commits,
    decision:'Review required; clean text merges do not establish behavioral compatibility',
    retireWhen:p.retireWhen
  })),
  rangeDiffCommand:`git range-diff ${oldBase}..${head} ${newBase}..<ported-studio-head>`,
  mutationsPerformed:false
};
process.stdout.write(JSON.stringify(report,null,2)+'\n');
