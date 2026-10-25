import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, isLocalDebuggerUrl, parseArgs } from './check-chat-boot.mjs';

const shell = { id: 'primary', type: 'page', url: 'app://-/index.html' };
const overlay = { id: 'overlay', type: 'page', url: 'app://-/overlay.html' };
const brave = { id: 'browser', type: 'page', url: 'https://learn.chatgpt.com/' };

test('known-good primary shell mounts chat webviews', () => {
  const result = classify([shell, overlay], new Map([
    ['primary', { webviews: 3, rootChildren: 5 }],
    ['overlay', { webviews: 0, rootChildren: 2 }]
  ]));
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'chat_shell_mounted');
});

test('26.1021 stuck shell fails even though React exists', () => {
  const result = classify([shell], new Map([
    ['primary', { webviews: 0, rootChildren: 2 }]
  ]));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'shell_without_chat_webview');
});

test('partial overlay webview is insufficient for a primary chat mount', () => {
  const result = classify([shell], new Map([
    ['primary', { webviews: 1, rootChildren: 2 }]
  ]));
  assert.equal(result.ok, false);
});

test('Brave debugging port cannot impersonate the ChatGPT desktop', () => {
  const result = classify([brave], new Map());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wrong_debugger_or_no_shell');
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
  assert.equal(isLocalDebuggerUrl('ws://localhost:9223/devtools/page/a', 9223), true);
  assert.equal(isLocalDebuggerUrl('ws://127.0.0.1:9224/devtools/page/a', 9223), false);
  assert.equal(isLocalDebuggerUrl('ws://example.com:9223/devtools/page/a', 9223), false);
  assert.equal(isLocalDebuggerUrl('wss://127.0.0.1:9223/devtools/page/a', 9223), false);
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
