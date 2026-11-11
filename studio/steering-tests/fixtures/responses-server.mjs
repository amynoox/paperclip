// Runs only inside local WSL. Never authenticates or calls an external model.
import readline from 'node:readline';
import { fakeResponses } from './responses-fixture.mjs';

const api = await fakeResponses({ hold: true });
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let closing;
const close = () => closing ??= api.close();
emit({ event: 'ready', base: api.base, pid: process.pid, platform: process.platform });
const input = readline.createInterface({ input: process.stdin });
input.on('line', async line => {
  let message;
  try {
    message = JSON.parse(line);
    if (message.action === 'release') { api.release(); emit({ id: message.id, ok: true }); }
    else if (message.action === 'inspect') emit({ id: message.id, requests: api.requests });
    else if (message.action === 'close') {
      await close(); emit({ id: message.id, ok: true }); input.close(); process.stdin.destroy();
    } else emit({ id: message.id, error: 'Unknown local fixture command' });
  } catch (error) { emit({ id: message?.id, error: error.message }); }
});
input.on('close', () => { void close(); });
process.stdin.on('error', () => { void close(); });
