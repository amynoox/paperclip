// Local test fixture only. SSH wire replacement; no worker or network SSH.
// Native SSH preparation/quoting/auth-file owners remain in the tested bundle.
import * as native from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
export * from 'node:child_process';

const markerText = 'local steering fixture only\n';

export function windowsToWsl(file) {
  const normalized = path.resolve(file).replaceAll('\\', '/');
  if (!/^[A-Za-z]:\//.test(normalized)) throw new Error('Fixture path must be on a local drive.');
  return '/mnt/' + normalized[0].toLowerCase() + normalized.slice(2);
}

export function configureLocalSshFixture({ home, nodeDirectory, host = 'steering-local.invalid' }) {
  const full = fs.realpathSync(home);
  if (fs.readFileSync(path.join(full, '.steering-local-fixture'), 'utf8') !== markerText)
    throw new Error('Local SSH fixture marker absent or invalid.');
  if (!/^[a-z0-9-]+\.invalid$/.test(host)) throw new Error('Synthetic SSH host required.');
  process.env.STUDIO_WSL_SSH_HOME = windowsToWsl(full);
  process.env.STUDIO_WSL_SSH_MARKER = path.join(full, '.steering-local-fixture');
  process.env.STUDIO_WSL_SSH_HOST = host;
  process.env.STUDIO_WSL_SSH_PATH = windowsToWsl(fs.realpathSync(nodeDirectory)) + ':/usr/bin:/bin';
  const profile = path.join(full, '.profile');
  if (!fs.existsSync(profile)) {
    const quoted = "'" + process.env.STUDIO_WSL_SSH_PATH.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(profile, 'export PATH=' + quoted + '\n', {flag: 'wx'});
  }
  return { home: process.env.STUDIO_WSL_SSH_HOME, host, path: process.env.STUDIO_WSL_SSH_PATH };
}

function translate(command, args = []) {
  const base = path.basename(command).toLowerCase();
  if (base === 'scp' || base === 'scp.exe') throw new Error('Local fixture refuses network SCP.');
  if (base !== 'ssh' && base !== 'ssh.exe') return { command, args };
  const home = process.env.STUDIO_WSL_SSH_HOME;
  const marker = process.env.STUDIO_WSL_SSH_MARKER;
  const host = process.env.STUDIO_WSL_SSH_HOST;
  const fixturePath = process.env.STUDIO_WSL_SSH_PATH;
  if (!home || !marker || !fixturePath || !/^[a-z0-9-]+\.invalid$/.test(host ?? '') ||
      fs.readFileSync(marker, 'utf8') !== markerText)
    throw new Error('Local SSH fixture is not configured. No SSH was executed.');
  const destination = args.at(-2), script = args.at(-1);
  if (typeof destination !== 'string' || !destination.endsWith('@' + host) ||
      !/^[a-zA-Z0-9_-]+@/.test(destination) || typeof script !== 'string')
    throw new Error('SSH destination is not the synthetic local fixture. No SSH was executed.');
  return {
    command: path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'wsl.exe'),
    args: ['--distribution', 'Ubuntu', '--cd', home, '--exec', '/usr/bin/env', '-i',
      'HOME=' + home, 'CODEX_HOME=' + home + '/codex', 'TMPDIR=' + home + '/tmp',
      'USER=steering_fixture', 'LOGNAME=steering_fixture', 'PATH=' + fixturePath,
      'LANG=C.UTF-8', '/usr/bin/nohup', '/bin/sh', '-c', script],
  };
}

export function spawn(command, args, options = {}) {
  const target = translate(command, args);
  return native.spawn(target.command, target.args, { ...options, windowsHide: true });
}

export function execFile(command, args, options, callback) {
  if (!Array.isArray(args)) { callback = options; options = args; args = []; }
  if (typeof options === 'function') { callback = options; options = {}; }
  const target = translate(command, args);
  return native.execFile(target.command, target.args, { ...options, windowsHide: true }, callback);
}

execFile[promisify.custom] = (command, args, options) => {
  let child;
  const promise = new Promise((resolve, reject) => {
    child = execFile(command, args, options, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
  });
  promise.child = child;
  return promise;
};

export function spawnSync(command, args, options = {}) {
  const target = translate(command, args);
  return native.spawnSync(target.command, target.args, { ...options, windowsHide: true });
}

export function execFileSync(command, args, options = {}) {
  const target = translate(command, args);
  return native.execFileSync(target.command, target.args, { ...options, windowsHide: true });
}
