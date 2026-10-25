import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { matchesChatGptCodex, checkQuiescence, isDirectInvocation } from './verify-desktop-quiescence.mjs';

test('blocks both official and Community ChatGPT executables', () => {
  assert.equal(matchesChatGptCodex({comm:'ChatGPT',exe:'/usr/lib/chatgpt/ChatGPT'}),true);
  assert.equal(matchesChatGptCodex({comm:'ChatGPT',exe:'/opt/codex-desktop/ChatGPT'}),true);
  assert.equal(matchesChatGptCodex({comm:'MainThread',exe:'/opt/codex-desktop/ChatGPT (deleted)'}),true);
});

test('blocks Codex CLI and bundled helpers even with changed Linux comm', () => {
  assert.equal(matchesChatGptCodex({comm:'codex',exe:'/home/joep/.local/bin/codex'}),true);
  assert.equal(matchesChatGptCodex({comm:'MainThread',exe:'/opt/codex-desktop/resources/cua_node/bin/node'}),true);
  assert.equal(matchesChatGptCodex({comm:'node_repl',exe:'/usr/lib/chatgpt/resources/cua_node/bin/node_repl'}),true);
  assert.equal(matchesChatGptCodex({comm:'start.sh',exe:'/usr/bin/bash',argv:['/bin/bash','/opt/codex-desktop/start.sh']}),true);
});

test('detects Electron with single argv0 containing all arguments', () => {
  assert.equal(matchesChatGptCodex({
    comm:'MainThread',exe:'/usr/bin/node',
    argv:['/opt/codex-desktop/ChatGPT --type=renderer --user-data-dir=/home/joep/.config/Codex']
  }),true);
});

test('never matches unrelated programs with ChatGPT/Codex names only in arguments', () => {
  assert.equal(matchesChatGptCodex({comm:'earlyoom',exe:'/usr/bin/earlyoom',argv:['earlyoom','--ignore','ChatGPT|codex']}),false);
  assert.equal(matchesChatGptCodex({comm:'python3',exe:'/usr/bin/python3',argv:['python3','-c','print("codex app-server")']}),false);
  assert.equal(matchesChatGptCodex({comm:'ZCode',exe:'/home/joep/Applications/ZCode.AppImage'}),false);
  assert.equal(matchesChatGptCodex({comm:'code',exe:'/usr/bin/code',argv:['code','--folder-uri','/opt/codex-desktop/test']}),false);
});

test('quiescence gate refuses on first scan and on late respawn', () => {
  const blocked = [{pid:123,comm:'ChatGPT'}];
  assert.deepEqual(checkQuiescence(() => blocked),{ok:false,count:1,processes:blocked});
  let scans=0;
  assert.deepEqual(checkQuiescence(() => (++scans===1 ? [] : blocked)),{ok:false,count:1,processes:blocked});
  assert.equal(scans,2);
});

test('quiescence gate accepts only two empty scans', () => {
  let scans=0;
  assert.deepEqual(checkQuiescence(() => {scans++;return [];}),{ok:true,count:0,processes:[]});
  assert.equal(scans,2);
});


test('a symlinked guard entrypoint still runs the CLI gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'community-guard-symlink-'));
  try {
    const source = fileURLToPath(new URL('./verify-desktop-quiescence.mjs', import.meta.url));
    const link = join(root, 'verify-quiescent');
    symlinkSync(source, link);
    assert.equal(isDirectInvocation(source), true);
    assert.equal(isDirectInvocation(link), true);
    assert.equal(isDirectInvocation(join(root, 'missing')), false);
    const actual = spawnSync(process.execPath, [source], {encoding:'utf8',timeout:12000});
    const linked = spawnSync(process.execPath, [link], {encoding:'utf8',timeout:12000});
    assert.equal(actual.status, linked.status);
    assert.match(actual.stdout + actual.stderr, /install_quiescence/);
    assert.match(linked.stdout + linked.stderr, /install_quiescence/);
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
