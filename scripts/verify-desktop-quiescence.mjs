#!/usr/bin/env node
// Fail-closed package replacement gate. Read process identity, not ps/grep text.
import { readdirSync, readFileSync, readlinkSync, statSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP_ROOTS = ['/opt/codex-desktop/', '/usr/lib/chatgpt/'];
const LAUNCHERS = new Set([
  '/opt/codex-desktop/start.sh',
  '/usr/lib/chatgpt/codex-launcher',
]);

export function matchesChatGptCodex({ comm = '', exe = '', argv = [] } = {}) {
  const basename = String(comm).trim().toLowerCase();
  const executable = String(exe).replace(/ \(deleted\)$/, '');
  const firstArg = String(argv[0] ?? '');
  if (/^(chatgpt|codex(?:$|-)|gpt(?:$|-))/.test(basename)) return true;
  if (DESKTOP_ROOTS.some(root => executable.startsWith(root))) return true;
  if (DESKTOP_ROOTS.some(root => firstArg.startsWith(root))) return true;
  return argv.slice(0, 3).some(arg => LAUNCHERS.has(arg));
}

export function scanOwnedDesktopProcesses(proc = '/proc', uid = process.getuid?.()) {
  if (!Number.isInteger(uid)) {
    throw new Error('The owner UID could not be determined');
  }
  const matches = [];
  for (const name of readdirSync(proc)) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    const directory = join(proc, name);
    let own;
    try {
      own = statSync(directory).uid === uid;
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ESRCH') continue;
      throw err;
    }
    if (!own) continue;
    try {
      const comm = readFileSync(join(directory, 'comm'), 'utf8').trim();
      // Some Electron processes replace argv0 with a single combined string.
      const argv = readFileSync(join(directory, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      let exe = '';
      try {
        exe = readlinkSync(join(directory, 'exe'));
      } catch (err) {
        // Linux ptrace restrictions can hide /proc/.../exe for benign
        // user-owned systemd processes. comm and cmdline remain readable.
        if (err?.code !== 'EACCES' && err?.code !== 'EPERM') throw err;
      }
      if (matchesChatGptCodex({ comm, exe, argv })) matches.push({ pid, comm });
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ESRCH') continue;
      // A process we own but cannot identify may still hold the shared profile.
      throw new Error('Could not inspect user process ' + pid + ': ' + (err?.code ?? 'unknown'));
    }
  }
  return matches.sort((a, b) => a.pid - b.pid);
}

export function checkQuiescence(scan = scanOwnedDesktopProcesses) {
  const first = scan();
  if (first.length) {
    return { ok: false, count: first.length, processes: first };
  }
  const second = scan();
  if (second.length) {
    return { ok: false, count: second.length, processes: second };
  }
  return { ok: true, count: 0, processes: [] };
}

export function isDirectInvocation(entrypoint, moduleUrl = import.meta.url) {
  if (!entrypoint) return false;
  try {
    return realpathSync(resolve(entrypoint)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1])) {
  try {
    const result = checkQuiescence();
    if (result.ok) {
      console.log('PASS install_quiescence: zero ChatGPT/Codex user processes');
    } else {
      console.error('BLOCK install_quiescence: ' + result.count + ' user processes: ' +
        result.processes.map(x => x.pid + ':' + x.comm).join(', '));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('BLOCK install_quiescence: process identity scan failed: ' + err.message);
    process.exitCode = 1;
  }
}
