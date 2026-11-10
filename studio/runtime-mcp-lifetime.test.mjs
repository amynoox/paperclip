// Focused, offline tests of the owning TypeScript functions. The database and
// gateway mint are synthetic. These do not claim PostgreSQL or live-run coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const file = process.env.STUDIO_RUNTIME_MODULE
  ? pathToFileURL(process.env.STUDIO_RUNTIME_MODULE)
  : new URL('../server/src/services/heartbeat/run-preparation.ts', import.meta.url);
const source = stripTypeScriptTypes(fs.readFileSync(file, 'utf8'));
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing source boundary ${start}`);
  return source.slice(a, b).replaceAll('export ', '');
}
const code = section('export async function revokeHeartbeatRunGatewayTokens(', 'export function createAdapterRuntimeMcpAccess(')
  + section('const MANAGED_MCP_LOCAL_ADAPTERS', 'export function deriveTaskKey(')
  + '\nglobalThis.subject = {buildPaperclipRuntimeMcpServers, createManagedMcpRunConfig, revokeHeartbeatRunGatewayTokens};';
const now = Date.parse('2030-01-01T00:00:00Z'), fourDays = 345600000;
const agent = {id: 'agent-a', companyId: 'company-a', name: 'Example', adapterType: 'codex_local'};
const connection = {id: 'connection-a', applicationId: 'app-a', name: 'Example MCP', transport: 'mcp_remote', enabled: true, status: 'active', healthStatus: 'healthy'};
const assignment = {version: 1, agentId: agent.id, connections: [connection.id], tools: ['tool-a']};
const digest = createHash('sha256').update(JSON.stringify(assignment)).digest('hex');
const profile = {id: 'profile-a', metadata: {source: 'paperclip_runner', agentId: agent.id, assignmentDigest: digest}};
const gateway = {id: 'gateway-a', profileId: profile.id, gatewayPublicId: 'example', agentId: agent.id, metadata: {agentId: agent.id, nativeRuntimeAssignmentDigest: digest}};

function fixture({managed = false, available = true, tokens = []} = {}) {
  const minted = [], selects = managed
    ? [[{id: 'managed-a', profileId: 'managed-profile', gatewayPublicId: 'managed', name: 'Managed', metadata: {managedRuntimeConnectionId: connection.id}}], [{connectionId: connection.id, enabled: true, status: 'active'}], [{activeIdentityContextId: 'identity-a'}]]
    : [[{activeIdentityContextId: 'identity-a'}], [connection], [profile], [gateway]];
  const db = {
    select() {
      const rows = selects.shift(); assert.ok(rows, 'Unexpected database query');
      const q = {from: () => q, where: () => q, limit: () => q, innerJoin: () => q, orderBy: () => q,
        then: resolve => Promise.resolve(rows).then(resolve)};
      return q;
    },
    update() {return {set: changes => ({where: async predicate => {for (const token of tokens) if (predicate(token)) Object.assign(token, changes);}})};},
  };
  const context = {
    createHash, Object, Set,
    Date: class extends Date {constructor(...args) {super(...(args.length ? args : [now]));} static now() {return now;}},
    toolAccessService: () => ({getEffectiveToolAssignmentsForAgent: async () => ({
      installedConnections: available ? [connection] : [],
      entries: [{connectionId: connection.id, effect: 'include', selectorType: 'connection'}],
      allowedTools: [{id: 'tool-a', connectionId: connection.id}],
    })}),
    createToolGatewayService: () => ({recordRuntimeMcpDeliveryDiagnostic: async () => {},
      createNamedGatewayToken: async input => {minted.push(input); return {token: 'synthetic', tokenPrefix: 'synthetic'};}}),
    eq: (key, value) => row => row[key] === value,
    and: (...conditions) => row => conditions.every(p => p(row)),
    isNull: key => row => row[key] == null,
    inArray: (key, values) => row => values.includes(row[key]),
    asc: value => value, sql: () => () => true, boundRunIssueIdSql: () => 'issue',
    githubBotConnectionIdsForRun: async () => new Set(),
    isToolConnectionAttentionHealth: () => false,
    paperclipApiBaseUrl: () => 'https://example.invalid', ASSIGNED_MCP_SERVER_NAME: 'paperclip-assigned',
    readNonEmptyString: value => typeof value === 'string' && value.trim() ? value : null,
  };
  for (const table of ['heartbeatRuns','toolConnections','toolProfiles','toolMcpGateways','toolMcpGatewayTokens','toolConnectionInstalls','toolProfileEntries','toolCatalogEntries'])
    context[table] = new Proxy({}, {get: (_, key) => key});
  vm.createContext(context); vm.runInContext(code, context, {filename: file.pathname});
  return {subject: context.subject, db, minted, input: {db, agent, runId: 'run-a', config: {}, issueId: 'issue-a', projectId: null}};
}

for (const managed of [false, true]) test(`${managed ? 'managed' : 'assigned'} run token lasts four days and keeps its authority`, async () => {
  const f = fixture({managed});
  const result = managed ? await f.subject.createManagedMcpRunConfig(f.input) : await f.subject.buildPaperclipRuntimeMcpServers(f.input);
  assert.ok(result); assert.equal(f.minted.length, 1);
  const token = f.minted[0];
  assert.equal(token.body.expiresAt.getTime(), now + fourDays);
  assert.equal(token.body.subjectType, 'heartbeat_run'); assert.equal(token.body.subjectId, 'run-a');
  assert.equal(token.companyId, agent.companyId); assert.equal(token.actor.agentId, agent.id);
  assert.equal(JSON.stringify(token.body.allowedActions), '["tools/list","tools/call"]');
});

test('an assignment mismatch still mints no token', async () => {
  const f = fixture();
  assert.equal((await f.subject.buildPaperclipRuntimeMcpServers({...f.input, expectedAssignmentDigest: 'changed'})).length, 0);
  assert.equal(f.minted.length, 0);
});
test('unavailable assignments still mint no token', async () => {
  const f = fixture({available: false});
  assert.equal((await f.subject.buildPaperclipRuntimeMcpServers(f.input)).length, 0);
  assert.equal(f.minted.length, 0);
});
test('disabled managed delivery still mints no token', async () => {
  const f = fixture({managed: true});
  assert.equal(await f.subject.createManagedMcpRunConfig({...f.input, config: {managedMcpOnly: false}}), null);
  assert.equal(f.minted.length, 0);
});
test('terminal revocation remains scoped to the original company and run', async () => {
  const base = {companyId: agent.companyId, subjectType: 'heartbeat_run', subjectId: 'run-a', revokedAt: null};
  const tokens = [{...base}, {...base, companyId: 'company-b'}, {...base, subjectId: 'run-b'}, {...base, subjectType: 'gateway_client'}, {...base, revokedAt: new Date(1)}];
  const f = fixture({tokens});
  await f.subject.revokeHeartbeatRunGatewayTokens({db: f.db, companyId: agent.companyId, runId: 'run-a'});
  assert.equal(tokens[0].revokedAt.getTime(), now);
  assert.equal(tokens[1].revokedAt, null); assert.equal(tokens[2].revokedAt, null); assert.equal(tokens[3].revokedAt, null);
  assert.equal(tokens[4].revokedAt.getTime(), 1);
});
