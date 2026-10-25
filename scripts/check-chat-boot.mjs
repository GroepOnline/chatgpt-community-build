#!/usr/bin/env node
// Authenticated desktop mount probe: counts webviews only; never reads user content.
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const ROOT_MIN = 3;
const EXPR = 'JSON.stringify({webviews:document.querySelectorAll("webview").length,rootChildren:(document.querySelector("#root")?.children?.length ?? 0)})';

export function parseArgs(args) {
  const result = { port: 9223, timeoutSeconds: 20, intervalMs: 800 };
  const keys = new Map([['--port', 'port'], ['--timeout', 'timeoutSeconds'], ['--interval-ms', 'intervalMs']]);
  for (let i = 0; i < args.length; i += 2) {
    const key = keys.get(args[i]);
    const value = args[i + 1];
    if (!key || !value || !/^[0-9]+$/.test(value)) {
      throw new Error('Usage: node scripts/check-chat-boot.mjs [--port 9223] [--timeout 20] [--interval-ms 800]');
    }
    result[key] = Number(value);
  }
  if (!Number.isSafeInteger(result.port) || result.port < 1 || result.port > 65535 ||
      !Number.isSafeInteger(result.timeoutSeconds) || result.timeoutSeconds < 1 || result.timeoutSeconds > 180 ||
      !Number.isSafeInteger(result.intervalMs) || result.intervalMs < 100 || result.intervalMs > 10000) {
    throw new Error('Out-of-range port/timeout/interval');
  }
  return result;
}

export function isLocalDebuggerUrl(value, port) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      Number(url.port) === port;
  } catch {
    return false;
  }
}

export function classify(targets, snapshots) {
  const shells = targets.filter(t => t.type === 'page' && String(t.url || '').startsWith('app://'));
  const observed = shells.map(t => snapshots.get(t.id) || { error: 'missing_snapshot' });
  const unsupportedNode = observed.some(s => s.error === 'node_22_websocket_required');
  const mounted = observed.some(s =>
    Number.isInteger(s.webviews) && s.webviews >= 1 &&
    Number.isInteger(s.rootChildren) && s.rootChildren >= ROOT_MIN);
  return {
    ok: mounted,
    reason: mounted ? 'chat_shell_mounted' :
      shells.length === 0 ? 'wrong_debugger_or_no_shell' :
      unsupportedNode ? 'node_22_websocket_required' :
      observed.every(s => s.error) ? 'shell_inspection_failed' : 'shell_without_chat_webview',
    shellCount: shells.length,
    maxWebviews: Math.max(0, ...observed.map(s => Number(s.webviews) || 0)),
    maxRootChildren: Math.max(0, ...observed.map(s => Number(s.rootChildren) || 0))
  };
}

export function inspectShell(target, port, timeoutMs = 2000) {
  if (!isLocalDebuggerUrl(target.webSocketDebuggerUrl, port)) {
    return Promise.resolve({ error: 'invalid_local_cdp_endpoint' });
  }
  if (typeof globalThis.WebSocket !== 'function') {
    return Promise.resolve({ error: 'node_22_websocket_required' });
  }
  return new Promise(resolve => {
    const ws = new globalThis.WebSocket(target.webSocketDebuggerUrl);
    let finished = false;
    const complete = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* socket may still be connecting */ }
      resolve(value);
    };
    const timer = setTimeout(() => complete({ error: 'cdp_timeout' }), timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 17, method: 'Runtime.evaluate',
        params: { expression: EXPR, returnByValue: true }
      }));
    });
    ws.addEventListener('message', event => {
      try {
        const packet = JSON.parse(String(event.data));
        if (packet.id !== 17) return;
        if (packet.error || typeof packet.result?.result?.value !== 'string') {
          complete({ error: 'cdp_evaluate_failed' });
          return;
        }
        complete(JSON.parse(packet.result.result.value));
      } catch {
        complete({ error: 'cdp_invalid_response' });
      }
    });
    ws.addEventListener('error', () => complete({ error: 'cdp_socket_error' }));
    ws.addEventListener('close', () => complete({ error: 'cdp_socket_closed' }));
  });
}

export async function probe(port) {
  const response = await fetch('http://127.0.0.1:' + port + '/json/list', {
    signal: AbortSignal.timeout(2300)
  });
  if (!response.ok) throw new Error('debugger_http_' + response.status);
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error('unexpected_cdp_target_list');
  const shells = targets.filter(t => t.type === 'page' && String(t.url || '').startsWith('app://'));
  const entries = await Promise.all(shells.map(async t => [t.id, await inspectShell(t, port)]));
  return classify(targets, new Map(entries));
}

export async function run(options) {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let last = null;
  do {
    try {
      last = await probe(options.port);
    } catch (error) {
      last = { ok: false, reason: 'debugger_unavailable', errorType: error.name };
    }
    if (last.ok) {
      console.log('PASS chat_boot ' + JSON.stringify({ port: options.port, ...last }));
      return true;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(options.intervalMs, Math.max(100, deadline - Date.now())));
  } while (true);
  console.error('FAIL chat_boot ' + JSON.stringify({ port: options.port, ...last }));
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const ok = await run(parseArgs(process.argv.slice(2)));
    if (!ok) process.exitCode = 1;
  } catch (error) {
    console.error('FAIL chat_boot ' + error.message);
    process.exitCode = 2;
  }
}
