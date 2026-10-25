import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256 } from './assemble-release.mjs';

const repo = resolve(new URL('..', import.meta.url).pathname);
const script = join(repo,'scripts/install-from-release.sh');
const version='2026.10.25.26';
const tag='community-v'+version;
const arch='amd64';

function fixture(corrupt=false) {
  const root=mkdtempSync(join(tmpdir(),'community-stage-test-'));
  const assets=join(root,'assets'),home=join(root,'home'),bin=join(root,'bin');
  const pkg=join(root,'pkg'),meta=join(pkg,'DEBIAN');
  for (const p of [assets,home,bin,meta,join(pkg,'opt')]) mkdirSync(p,{recursive:true});
  writeFileSync(join(meta,'control'),[
    'Package: codex-desktop',
    'Version: '+version,
    'Architecture: amd64',
    'Section: misc',
    'Priority: optional',
    'Maintainer: Test Runner <test@example.com>',
    'Description: fixture only - never install'
  ].join('\n')+'\n');
  writeFileSync(join(pkg,'opt','fixture-only'),'not an application');
  const deb='codex-desktop_'+version+'_'+arch+'.deb';
  const assembled=spawnSync('dpkg-deb',['--build','--root-owner-group',pkg,join(assets,deb)],{encoding:'utf8'});
  assert.equal(assembled.status,0,assembled.stderr);
  const metadata={schema:1,tag,version,
    sourceRepository:'GroepOnline/chatgpt-community-build',
    upstreamCommit:'fc533a9346095e74d47c506e3103b7282c5c54d9',
    buildCommit:'a'.repeat(40),buildRunId:'40200351596',
    featureCount:38,runtimeAccepted:false,
    packageAssets:{amd64:deb,arm64:'codex-desktop_'+version+'_arm64.deb'}
  };
  writeFileSync(join(assets,'release-metadata.json'),JSON.stringify(metadata,null,2)+'\n');
  writeFileSync(join(assets,'SHA256SUMS'),[
    sha256(join(assets,deb))+'  '+deb,
    sha256(join(assets,'release-metadata.json'))+'  release-metadata.json'
  ].join('\n')+'\n');
  if(corrupt)writeFileSync(join(assets,deb),'bad corrupted payload');
  const mockGh=join(bin,'gh');
  writeFileSync(mockGh,[
    '#!/usr/bin/env bash','set -euo pipefail',
    '[[ "$1" == release && "$2" == download ]] || exit 99',
    'dir=""',
    'while [[ "$#" -gt 0 ]]; do',
    '  if [[ "$1" == "-D" ]]; then dir="$2"; shift 2; else shift; fi',
    'done',
    '[[ -n "$dir" ]] || exit 98',
    'mkdir -p "$dir"',
    'cp "$MOCK_ASSETS/"* "$dir/"'
  ].join('\n')+'\n');
  chmodSync(mockGh,0o755);
  const mockSudo=join(bin,'sudo');
  writeFileSync(mockSudo,'#!/usr/bin/env bash\nprintf "UNEXPECTED_SUDO\\n" >> "$MOCK_SIDE_EFFECTS"\nexit 94\n');
  chmodSync(mockSudo,0o755);
  const sideEffects=join(root,'sudo-calls.log');
  return {
    root,assets,home,sideEffects,
    env:{...process.env,HOME:home,PATH:bin+':'+process.env.PATH,
      MOCK_ASSETS:assets,MOCK_SIDE_EFFECTS:sideEffects},
    dispose:()=>rmSync(root,{recursive:true,force:true})
  };
}
test('explicit --stage verifies a real DEB fixture without touching applications, packages, or sudo',()=>{
  const f=fixture();
  try {
    const run=spawnSync('bash',[script,'--stage','--tag',tag],{cwd:repo,env:f.env,encoding:'utf8',timeout:20000});
    assert.equal(run.status,0,(run.stdout+run.stderr).slice(-700));
    assert.match(run.stdout,/PASS staged_release/);
    assert.match(run.stdout,/STAGED_ONLY/);
    assert.equal(existsSync(f.sideEffects),false);
    assert.equal(existsSync(join(f.home,'.local/share/chatgpt-community/receipts',version+'.json')),false);
    assert.ok(existsSync(join(f.home,'.local/share/chatgpt-community/staged',tag,arch,
      'codex-desktop_'+version+'_'+arch+'.deb')));
    const again=spawnSync('bash',[script,'--tag',tag],{cwd:repo,env:f.env,encoding:'utf8',timeout:20000});
    assert.equal(again.status,0,again.stderr);
    assert.match(again.stdout,/STAGED_ONLY/);
  } finally {f.dispose();}
});
test('corrupted release bytes abort before any system or profile mutation',()=>{
  const f=fixture(true);
  try {
    const run=spawnSync('bash',[script,'--stage','--tag',tag],{cwd:repo,env:f.env,encoding:'utf8',timeout:20000});
    assert.notEqual(run.status,0);
    assert.match(run.stderr,/validation failed|checksum failed|Staged/);
    assert.equal(existsSync(f.sideEffects),false);
    assert.equal(existsSync(join(f.home,'.codex')),false);
  } finally {f.dispose();}
});
