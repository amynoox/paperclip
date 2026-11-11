// Reproducible minimal overlay on the exact published upstream module.
// This is not a full rebuild or a new dependency resolution of Paperclip.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const [input, output] = process.argv.slice(2);
assert.ok(input && output, 'Usage: node studio/build-runtime-overlay.mjs <upstream run-preparation.js> <output directory>');
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\','/').replace(/\/$/,'')}`, ...args], {cwd: root, encoding: 'utf8'}).trimEnd();
const upstream = JSON.parse(fs.readFileSync(new URL('upstream.json', import.meta.url)));
const original = fs.readFileSync(input, 'utf8');
const expectedHash = 'c07dba86815d7fc1e29df861013eb691181f908255c46c6b5ef41a4a5a529992';
assert.equal(hash(original), expectedHash, 'Wrong upstream runtime module');
const replacements = [
  ['new Date(Date.now() + 60 * 60 * 1_000)', 'new Date(Date.now() + 4 * 24 * 60 * 60 * 1_000)'],
  ['new Date(Date.now() + 60 * 60 * 1000)', 'new Date(Date.now() + 4 * 24 * 60 * 60 * 1000)'],
  ['Short-lived runtime MCP token', 'Run-scoped runtime MCP token'],
  ['Short-lived Paperclip-managed MCP token', 'Run-scoped Paperclip-managed MCP token'],
];
function patch(text) {
  for (const [before, after] of replacements) {
    assert.equal(text.split(before).length - 1, 1, `Unexpected occurrence count: ${before}`);
    text = text.replace(before, after);
  }
  return text;
}
const sourcePath = 'server/src/services/heartbeat/run-preparation.ts';
const base = git('show', `179694de7dc700aa5b4d0ab58fe8531cd8119f93:${sourcePath}`);
const source = fs.readFileSync(path.join(root, sourcePath), 'utf8').replaceAll('\r\n','\n').trimEnd();
assert.equal(git('show', `HEAD:${sourcePath}`), source, 'Commit the tested source before creating a release artifact');
const comments = '      // Long tasks retain their original credential. Terminal revocation and\n      // current run/permission checks still apply; this is only an expiry cap.\n';
assert.equal(source, patch(base).replace('      expiresAt: new Date(Date.now() + 4', comments + '      expiresAt: new Date(Date.now() + 4'), 'Source and artifact patch differ');
const built = patch(original).replace(/\n\/\/# sourceMappingURL=run-preparation\.js\.map\s*$/, '\n');
const destination = path.resolve(output);
fs.mkdirSync(destination, {recursive: true});
fs.writeFileSync(path.join(destination, 'run-preparation.js'), built, {flag: 'wx'});
const receipt = {schemaVersion: 1, patchId: 'STUDIO-0001', version: '2026.1110.0-studio.1',
  upstream, sourceCommit: git('rev-parse','HEAD'), sourcePath, sourceSha256: hash(source),
  runtimePath: 'node_modules/@paperclipai/server/dist/services/heartbeat/run-preparation.js',
  upstreamRuntimeSha256: expectedHash, runtimeSha256: hash(built), lifetimeHours: 96,
  format: 'verified-upstream-runtime-overlay', fullBuild: false, databaseMigration: false};
fs.writeFileSync(path.join(destination, 'studio-build.json'), JSON.stringify(receipt, null, 2)+'\n', {flag: 'wx'});
console.log(JSON.stringify(receipt));
