import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { SHELL_SNAPSHOT_EXPR, classify, fetchLocalTargets, inspectShell, isLocalDebuggerUrl, isPrimaryShellTarget, parseArgs } from './check-chat-boot.mjs';

const shell = { id: 'primary', type: 'page', url: 'app://-/index.html' };
const overlay = { id: 'overlay', type: 'page', url: 'app://-/overlay.html' };
const brave = { id: 'browser', type: 'page', url: 'https://learn.chatgpt.com/' };

test('known-good primary shell includes the actual interactive composer', () => {
  const result = classify([shell, overlay], new Map([
    ['primary', { webviews: 3, rootChildren: 5, runtimeIdentity: true, composerReady: true, sendControlReady: true }],
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
  assert.equal(result.reason, 'chat_composer_unavailable');
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
  assert.equal(manifest.enabled.length, 39);
});


test('one-shot CLI terminates after verified PASS even if CDP WebSocket refuses close', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('./check-chat-boot.mjs', import.meta.url));
  const preload = [
    "const handle = setInterval(() => {}, 1000);",
    "globalThis.fetch = async () => ({ok: true, json: async () => [{type:'page',id:'shell',url:'app://-/index.html',webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/page/shell'}]});",
    "globalThis.WebSocket = class {",
    "  constructor() { this.listeners={}; }",
    "  addEventListener(event, fn) { this.listeners[event]=fn; if (event==='open') queueMicrotask(fn); }",
    "  send() { queueMicrotask(() => this.listeners.message?.({data:JSON.stringify({id:17,result:{result:{value:JSON.stringify({webviews:1,rootChildren:4,runtimeIdentity:true,composerReady:true,sendControlReady:true})}}})})); }",
    "  close() { /* Simulate CDP server never acknowledging close. */ }",
    "};",
  ].join(String.fromCharCode(10));
  const loaded = 'data:text/javascript;base64,' + Buffer.from(preload).toString('base64');
  const r = spawnSync(process.execPath, ['--import', loaded, script, '--port', '9223', '--timeout', '2'], {
    encoding: 'utf8', timeout: 3000
  });
  assert.equal(r.status, 0, r.stderr || String(r.error));
  assert.match(r.stdout, /PASS chat_boot /);
});

// Regression: the hidden codex-sandbox webview is not the interactive chat UI.
// A mounted shell with a sandbox alone must not become LIVE_ACCEPTED.
test('hidden sandbox webview cannot impersonate an interactive chat composer', () => {
  const result = classify([shell], new Map([['primary', {
    webviews: 1, rootChildren: 5, runtimeIdentity: true,
    composerReady: false, sendControlReady: false
  }]]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'chat_composer_unavailable');
});

// Modern ChatGPT renders its composer in the primary app:// document, not
// necessarily inside a webview. The sandbox should be optional.
test('working interactive composer passes without any sandbox webviews', () => {
  const result = classify([shell], new Map([['primary', {
    webviews: 0, rootChildren: 5, runtimeIdentity: true,
    composerReady: true, sendControlReady: true
  }]]));
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'chat_shell_mounted');
});

test('real browser snapshot rejects hidden composer even when sandbox webview is mounted', () => {
  const element = (width, height, opacity = '1') => ({
    getBoundingClientRect: () => ({ width, height }),
    opacity
  });
  const sandbox = element(1, 150);
  const hiddenComposer = element(0, 0);
  const visibleComposer = element(400, 36);
  const sendButton = element(28, 28);
  const context = composer => ({
    window: {
      codexWindowType: 'main', electronBridge: {}, __codexRoot: {},
      getComputedStyle: e => ({ display:'block', visibility:'visible',
        pointerEvents:'auto', opacity:e.opacity })
    },
    document: {
      querySelector: selector => selector === '#root' ? { children:[1,2,3,4,5] } : null,
      querySelectorAll: selector => selector === 'webview' ? [sandbox] :
        selector.includes('[role="textbox"]') ? [composer] :
        selector.includes('button[aria-label="Send"]') ? [sendButton] : []
    }
  });
  const hidden = JSON.parse(runInNewContext(SHELL_SNAPSHOT_EXPR, context(hiddenComposer)));
  const visible = JSON.parse(runInNewContext(SHELL_SNAPSHOT_EXPR, context(visibleComposer)));
  assert.equal(hidden.webviews, 1);
  assert.equal(hidden.composerReady, false);
  assert.equal(hidden.sendControlReady, true);
  assert.equal(classify([shell], new Map([['primary', hidden]])).ok, false);
  assert.equal(visible.composerReady, true);
  assert.equal(classify([shell], new Map([['primary', visible]])).ok, true);
});

// CodeRabbit regression: CSS opacity on a parent can hide an otherwise
// visible, nonzero-size interactive chat control.
test('composer under opacity-zero ancestor cannot pass readiness', () => {
  const parent = { opacity:'0', parentElement:null };
  const item = (width, height) => ({
    opacity:'1', parentElement:parent, getBoundingClientRect:()=>({width,height})
  });
  const context = {
    window: {
      codexWindowType:'main',electronBridge:{},__codexRoot:{},
      getComputedStyle: e => ({display:'block',visibility:'visible',pointerEvents:'auto',opacity:e.opacity})
    },
    document: {
      querySelector:selector => selector==='#root' ? {children:[1,2,3,4,5]} : null,
      querySelectorAll:selector => selector==='webview' ? [{}] :
        selector.includes('[role="textbox"]') ? [item(480,36)] :
        selector.includes('button[aria-label') ? [item(28,28)] : []
    }
  };
  const snapshot=JSON.parse(runInNewContext(SHELL_SNAPSHOT_EXPR,context));
  assert.equal(snapshot.composerReady,false);
  assert.equal(snapshot.sendControlReady,false);
  assert.equal(classify([shell],new Map([['primary',snapshot]])).ok,false);
});

// Tailwind's pointer-events-none footer intentionally contains
// pointer-events-auto children. The parent alone must not fail readiness.
test('interactive child overrides pointer-events-none on footer ancestor', () => {
  const parent = { opacity:'1', pointer:'none', parentElement:null };
  const item = (width,height) => ({
    opacity:'1',pointer:'auto',parentElement:parent,
    getBoundingClientRect:()=>({width,height})
  });
  const context = {
    window:{
      codexWindowType:'main',electronBridge:{},__codexRoot:{},
      getComputedStyle:e=>({display:'block',visibility:'visible',pointerEvents:e.pointer,opacity:e.opacity})
    },
    document:{
      querySelector:s=>s==='#root'?{children:[1,2,3,4,5]}:null,
      querySelectorAll:s=>s==='webview'?[{}]:
        s.includes('[role="textbox"]')?[item(484,36)]:
        s.includes('button[aria-label="Send"]')?[item(28,28)]:[]
    }
  };
  const snapshot=JSON.parse(runInNewContext(SHELL_SNAPSHOT_EXPR,context));
  assert.equal(snapshot.composerReady,true);
  assert.equal(snapshot.sendControlReady,true);
  assert.equal(classify([shell],new Map([['primary',snapshot]])).ok,true);
});

// In a streamed reply the visible submit button is replaced by Stop.
// This is a mounted interactive composer, but not proof of backend success.
test('generating chat uses visible Stop action instead of Send', () => {
  const result = classify([shell],new Map([['primary',{
    webviews:1,rootChildren:5,runtimeIdentity:true,composerReady:true,
    sendControlReady:false,stopControlReady:true
  }]]));
  assert.equal(result.ok,true);
  assert.equal(result.interactiveComposer,true);
  assert.equal(result.generationActive,true);
});

// Exercise the real CDP expression, not only a manually constructed snapshot.
test('browser snapshot reads Stop during generation with no visible Send', () => {
  const element = (w,h) => ({
    parentElement:null, getBoundingClientRect:()=>({width:w,height:h})
  });
  const context={
    window:{codexWindowType:'main',electronBridge:{},__codexRoot:{},
      getComputedStyle:()=>({display:'block',visibility:'visible',pointerEvents:'auto',opacity:'1'})},
    document:{
      querySelector:s=>s==='#root'?{children:[1,2,3,4,5]}:null,
      querySelectorAll:s=>s==='webview'?[element(1,150)]:
        s.includes('[role="textbox"]')?[element(484,36)]:
        s.includes('button[aria-label="Stop"]')?[element(28,28)]:[]
    }
  };
  const snapshot=JSON.parse(runInNewContext(SHELL_SNAPSHOT_EXPR,context));
  assert.equal(snapshot.composerReady,true);
  assert.equal(snapshot.sendControlReady,false);
  assert.equal(snapshot.stopControlReady,true);
  const result=classify([shell],new Map([['primary',snapshot]]));
  assert.equal(result.ok,true);
  assert.equal(result.generationActive,true);
});
