import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { classify, fetchLocalTargets, inspectShell, isLocalDebuggerUrl, isPrimaryShellTarget, parseArgs } from './check-chat-boot.mjs';

const shell = { id: 'primary', type: 'page', url: 'app://-/index.html' };
const overlay = { id: 'overlay', type: 'page', url: 'app://-/overlay.html' };
const brave = { id: 'browser', type: 'page', url: 'https://learn.chatgpt.com/' };

test('known-good primary shell mounts chat webviews', () => {
  const result = classify([shell, overlay], new Map([
    ['primary', { webviews: 3, rootChildren: 5, runtimeIdentity: true }],
    ['overlay', { webviews: 0, rootChildren: 2 }]
  ]));
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'chat_shell_mounted');
});

test('26.1021 stuck shell fails even though React exists', () => {
  const result = classify([shell], new Map([
    ['primary', { webviews: 0, rootChildren: 2, runtimeIdentity: true }]
  ]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'shell_without_chat_webview');
});

test('partial overlay webview is insufficient for a primary chat mount', () => {
  const result = classify([shell], new Map([
    ['primary', { webviews: 1, rootChildren: 2, runtimeIdentity: true }]
  ]));
  assert.equal(result.ok, false);
});

test('Brave debugging port cannot impersonate the ChatGPT desktop', () => {
  const result = classify([brave], new Map());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong_debugger_or_no_shell');
});

test('unrelated app target cannot impersonate primary ChatGPT shell', () => {
  const unrelated = { id: 'foreign', type: 'page', url: 'app://other/index.html' };
  assert.equal(isPrimaryShellTarget(unrelated), false);
  const result = classify([unrelated], new Map([['foreign', {
    webviews: 3, rootChildren: 5, runtimeIdentity: true
  }]]));
  assert.equal(result.ok, false);
});

test('identical generic app index without Codex runtime markers is rejected', () => {
  const result = classify([shell], new Map([['primary', {
    webviews: 3, rootChildren: 5, runtimeIdentity: false
  }]]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'shell_identity_unverified');
});

test('CDP evaluation errors fail closed', () => {
  const result = classify([shell], new Map([
    ['primary', { error: 'cdp_socket_error' }]
  ]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'shell_inspection_failed');
});

test('debugging endpoints must be local and bound to the selected port', () => {
  assert.equal(isLocalDebuggerUrl('ws://127.0.0.1:9223/devtools/page/a', 9223), true);
  assert.equal(isLocalDebuggerUrl('ws://[::1]:9223/devtools/page/a', 9223), true);
  assert.equal(isLocalDebuggerUrl('ws://[::1]:9224/devtools/page/a', 9223), false);
  assert.equal(isLocalDebuggerUrl('ws://[::2]:9223/devtools/page/a', 9223), false);
  assert.equal(isLocalDebuggerUrl('ws://localhost:9223/devtools/page/a', 9223), true);
  assert.equal(isLocalDebuggerUrl('ws://127.0.0.1:9224/devtools/page/a', 9223), false);
  assert.equal(isLocalDebuggerUrl('ws://example.com:9223/devtools/page/a', 9223), false);
  assert.equal(isLocalDebuggerUrl('wss://127.0.0.1:9223/devtools/page/a', 9223), false);
});

test('Node without global WebSocket fails gracefully with an actionable reason', async () => {
  const original = globalThis.WebSocket;
  try {
    globalThis.WebSocket = undefined;
    const shellSnapshot = await inspectShell({
      webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/a'
    }, 9223);
    assert.deepEqual(shellSnapshot, { error: 'node_22_websocket_required' });
    assert.equal(classify([shell], new Map([['primary', shellSnapshot]])).reason, 'node_22_websocket_required');
  } finally {
    globalThis.WebSocket = original;
  }
});

test('symlinked CLI entrypoint cannot exit successfully without probing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatgpt-boot-symlink-'));
  try {
    const alias = join(dir, 'boot.mjs');
    symlinkSync(fileURLToPath(new URL('./check-chat-boot.mjs', import.meta.url)), alias);
    const result = spawnSync(process.execPath, [alias, '--port', '65535', '--timeout', '1'], {
      encoding: 'utf8', timeout: 7000
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /FAIL chat_boot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strict numeric argument parsing', () => {
  assert.deepEqual(parseArgs([]), { port: 9223, timeoutSeconds: 20, intervalMs: 800 });
  assert.equal(parseArgs(['--port', '9237', '--timeout', '2']).port, 9237);
  assert.throws(() => parseArgs(['--port', '9233;rm -rf /']));
  assert.throws(() => parseArgs(['--port', '0']));
  assert.throws(() => parseArgs(['--port', '65536']));
  assert.throws(() => parseArgs(['--timeout', '0']));
  assert.throws(() => parseArgs(['--interval-ms', '20']));
  assert.throws(() => parseArgs(['--bogus', '100']));
});


test('CDP loopback lookup falls back to IPv6 after IPv4 is unavailable', async () => {
  const calls = [];
  const targets = [{ id: 'primary', type: 'page', url: 'app://-/index.html' }];
  const got = await fetchLocalTargets(9223, async url => {
    calls.push(url);
    if (url.includes('127.0.0.1')) throw new TypeError('fetch failed');
    return { ok: true, json: async () => targets };
  });
  assert.deepEqual(got, targets);
  assert.deepEqual(calls, ['http://127.0.0.1:9223/json/list', 'http://[::1]:9223/json/list']);
});

test('CDP loopback lookup uses IPv4 when it has the actual ChatGPT shell', async () => {
  const calls = [];
  const shellTargets = [{ id: 'primary', type: 'page', url: 'app://-/index.html' }];
  const got = await fetchLocalTargets(9223, async url => {
    calls.push(url);
    return { ok: true, json: async () => shellTargets };
  });
  assert.deepEqual(got, shellTargets);
  assert.deepEqual(calls, ['http://127.0.0.1:9223/json/list']);
});

test('CDP loopback lookup also checks IPv6 when IPv4 returns an empty target list', async () => {
  const calls = [];
  const shellTargets = [{ id: 'primary', type: 'page', url: 'app://-/index.html' }];
  const got = await fetchLocalTargets(9223, async url => {
    calls.push(url);
    return { ok: true, json: async () => url.includes('127.0.0.1') ? [] : shellTargets };
  });
  assert.deepEqual(got, shellTargets);
  assert.deepEqual(calls, ['http://127.0.0.1:9223/json/list', 'http://[::1]:9223/json/list']);
});

test('CDP loopback lookup returns no shell only after checking both interfaces', async () => {
  const calls = [];
  const got = await fetchLocalTargets(9223, async url => {
    calls.push(url);
    return { ok: true, json: async () => [] };
  });
  assert.deepEqual(got, []);
  assert.equal(calls.length, 2);
});

test('CDP loopback lookup fails if both local debuggers return invalid results', async () => {
  const calls = [];
  await assert.rejects(fetchLocalTargets(9223, async url => {
    calls.push(url);
    return { ok: true, json: async () => ({ fake: true }) };
  }), /unexpected_cdp_target_list/);
  assert.equal(calls.length, 2);
});


test('pinned 0.164.0 desktop build excludes the incompatible shared app-server socket bridge', async () => {
  // The 26.1021.22027 bundle stalls before app-server initialize with this hook.
  // Only remove this guard after a new upstream backend has passed live chat boot.
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('../.github/community-build/features.json', import.meta.url), 'utf8'));
  assert.equal(manifest.enabled.includes('shared-app-server-socket'), false);
  assert.equal(manifest.enabled.length, 38);
});
