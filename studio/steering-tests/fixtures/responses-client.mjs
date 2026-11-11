import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsToWsl } from './child-process.mjs';

export async function startLocalWslResponses({ home, nodeDirectory }) {
  const marker = path.join(home, '.steering-local-fixture');
  if (fs.readFileSync(marker, 'utf8') !== 'local steering fixture only\n') throw new Error('Isolated fixture home required.');
  const posixHome = windowsToWsl(home), posixNode = windowsToWsl(path.join(nodeDirectory, 'node'));
  const script = windowsToWsl(path.join(path.dirname(fileURLToPath(import.meta.url)), 'responses-server.mjs'));
  const child = spawn(path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'wsl.exe'), ['-d', 'Ubuntu', '--cd', posixHome,
    '--exec', '/usr/bin/env', '-i', 'HOME=' + posixHome, 'TMPDIR=' + posixHome + '/tmp',
    'PATH=/usr/bin:/bin', posixNode, script], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  const pending = new Map(); let sequence = 0, buffer = '', stderr = '', readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => readyReject(new Error('Local WSL Responses startup timed out')), 20000);
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (value.event === 'ready') {
          if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(value.base) || value.platform !== 'linux')
            throw new Error('Unexpected local backend binding');
          clearTimeout(timer); readyResolve(value);
        } else if (pending.has(value.id)) {
          const waiter = pending.get(value.id); pending.delete(value.id);
          clearTimeout(waiter.timer); value.error ? waiter.reject(new Error(value.error)) : waiter.resolve(value);
        }
      } catch (error) { readyReject(error); }
    }
  });
  child.once('error', readyReject);
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    clearTimeout(timer);
    const error = new Error('Local backend closed: ' + code + '; ' + stderr);
    readyReject(error);
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear(); resolve({ code, signal });
  }));
  const request = action => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Local backend command timeout: ' + action)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, action }) + '\n');
    });
  };
  let info;
  try { info = await ready; }
  catch (error) { child.stdin.end(); throw error; }
  return { ...info, child, closed, release: () => request('release'), inspect: () => request('inspect'),
    async close() { try { await request('close'); } finally { child.stdin.end(); } return closed; } };
}
