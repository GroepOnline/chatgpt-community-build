import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const read = rel => readFileSync(fileURLToPath(new URL('../'+rel,import.meta.url)),'utf8');

test('release workflow is on free standard public GitHub runner only',()=>{
  const w=read('.github/workflows/community-release.yml');
  assert.match(w,/runs-on: ubuntu-24\.04\b/);
  assert.doesNotMatch(w,/ubuntu-latest-16-cores|runs-on:\s*self-hosted|runs-on:\s*ubuntu-latest-8-cores/);
  assert.match(w,/workflow_run:/);
  assert.match(w,/workflow_dispatch:/);
  assert.match(w,/github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(w,/head_branch == 'build\/community-20261021'/);
  assert.match(w,/sha.*==.*head|sha.*head/);
  assert.match(w,/git rev-parse HEAD/);
  assert.match(w,/Branch changed during artifact verification/);
});
test('public proprietary package upload is held as a private draft by default',()=>{
  const w=read('.github/workflows/community-release.yml');
  const draft=w.indexOf('gh release create "$tag"');
  const gate=w.indexOf('vars.COMMUNITY_BINARY_REDISTRIBUTION_AUTHORIZED');
  const publicEdit=w.indexOf('gh release edit "$tag"');
  assert.ok(draft>0 && gate>draft && publicEdit>gate,'rights gate must precede publishing');
  assert.match(w,/--draft --prerelease/);
  assert.match(w,/DRAFT_READY:/);
  assert.match(w,/--draft=false/);
  assert.doesNotMatch(w,/pull_request_target:/);
});
test('build artifact storage is ephemeral and package source pinned',()=>{
  const build=read('.github/workflows/community-build.yml');
  assert.match(build,/retention-days: 1/);
  assert.match(build,/UPSTREAM_COMMIT: fc533a9346095e74d47c506e3103b7282c5c54d9/);
  assert.match(build,/matrix:\s*\n\s*arch: \[amd64, arm64\]/);
  assert.match(build,/runs-on: \$\{\{ matrix\.arch == 'arm64' && 'ubuntu-24\.04-arm' \|\| 'ubuntu-24\.04' \}\}/);
});

test('retrying a draft requires matching provenance and bytes; published assets stay immutable',()=>{
  const w=read('.github/workflows/community-release.yml');
  const draftGuard=w.indexOf('gh release view "$tag"');
  const isDraft=w.indexOf('is_draft=');
  const provenance=w.indexOf('cmp -s "$RUNNER_TEMP/draft-existing/release-metadata.json"');
  const existingCheck=w.indexOf('cmp -s "$existing"');
  const upload=w.indexOf('gh release upload "$tag"');
  assert.ok(draftGuard>0 && isDraft>draftGuard &&
    provenance>isDraft && existingCheck>provenance && upload>existingCheck);
  assert.match(w,/Existing published tag cannot be overwritten/);
  assert.doesNotMatch(w,/gh release delete\b|--clobber\b/);
});

test('temporary Actions artifacts are deleted only after complete durable release validation',()=>{
  const w=read('.github/workflows/community-release.yml');
  const publish=w.indexOf('gh release create "$tag"');
  const verify=w.lastIndexOf('Cannot delete artifacts: release assets incomplete');
  const identity=w.lastIndexOf('Artifact identity ambiguous or missing');
  const deletion=w.lastIndexOf('gh api -X DELETE');
  assert.ok(publish>0 && verify>publish && identity>verify && deletion>identity);
  assert.match(w,/if: success\(\)/);
  assert.match(w,/actions: write/);
  assert.match(w,/codex-desktop-community-.*\$\{arch\}/);
  assert.doesNotMatch(w,/--clobber|gh release delete/);
});


test('temporary artifact cleanup step parses as valid Bash',()=>{
  const w=read('.github/workflows/community-release.yml');
  const step=w.split('      - name: Remove redundant one-day build artifacts after verified GitHub release')[1];
  assert.ok(step,'cleanup step must exist');
  const body=step.split('        run: |')[1];
  assert.ok(body,'cleanup step must have a shell body');
  const script=body.split('\n').slice(1).filter(line=>line.startsWith('          ')).map(line=>line.slice(10)).join('\n');
  const checked=spawnSync('bash',['-n'],{input:script,encoding:'utf8'});
  assert.equal(checked.status,0,checked.stderr);
});


test('release cleanup preflights both architectures before any deletion',()=>{
  const w=read('.github/workflows/community-release.yml');
  const step=w.split('      - name: Remove redundant one-day build artifacts after verified GitHub release')[1];
  const script=step.split('        run: |')[1].split('\n').slice(1).filter(line=>line.startsWith('          ')).map(line=>line.slice(10)).join('\n')
    .replace('\${{ steps.bundle.outputs.tag }}','test-tag');
  const root=mkdtempSync(join(tmpdir(),'community-release-cleanup-'));
  try {
    mkdirSync(join(root,'bin')); mkdirSync(join(root,'release'));
    writeFileSync(join(root,'release','alpha.deb'),'a');
    writeFileSync(join(root,'release','beta.deb'),'b');
    const stub=join(root,'bin','gh');
    writeFileSync(stub,`#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == release ]]; then
  find "$RUNNER_TEMP/release" -maxdepth 1 -type f -printf '%f\n'
elif [[ "$1" == api && "$2" == -X ]]; then
  printf '%s\n' "$*" >> "$RUNNER_TEMP/deletes.log"
else
  cat "$RUNNER_TEMP/artifact-list.tsv"
fi
`,{mode:0o755});
    const cases=[
      {id:'valid',rows:'101\tcodex-desktop-community-amd64-77\n202\tcodex-desktop-community-arm64-77\n',ok:true},
      {id:'missing-arm64',rows:'101\tcodex-desktop-community-amd64-77\n'},
      {id:'duplicate-amd64',rows:'101\tcodex-desktop-community-amd64-77\n102\tcodex-desktop-community-amd64-77\n202\tcodex-desktop-community-arm64-77\n'},
      {id:'nonnumeric',rows:'oops\tcodex-desktop-community-amd64-77\n202\tcodex-desktop-community-arm64-77\n'},
      {id:'shared-id',rows:'101\tcodex-desktop-community-amd64-77\n101\tcodex-desktop-community-arm64-77\n'},
    ];
    for(const c of cases){
      writeFileSync(join(root,'artifact-list.tsv'),c.rows);
      rmSync(join(root,'deletes.log'),{force:true});
      const p=spawnSync('bash',['-c',script],{
        encoding:'utf8',env:{...process.env,PATH:`${join(root,'bin')}:${process.env.PATH}`,RUNNER_TEMP:root,
          RUN_NUMBER:'77',BUILD_RUN_ID:'88',GITHUB_REPOSITORY:'GroepOnline/chatgpt-community-build'},
      });
      const deletions=readFileSyncIfPresent(join(root,'deletes.log'));
      if(c.ok){
        assert.equal(p.status,0,`${c.id}: ${p.stderr} ${p.stdout}`);
        assert.equal(deletions.trim().split('\n').length,2,c.id);
      }else{
        assert.notEqual(p.status,0,`${c.id} incorrectly accepted`);
        assert.equal(deletions,'',`${c.id} deleted an artifact before validating both`);
      }
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
function readFileSyncIfPresent(path){try{return readFileSync(path,'utf8');}catch(e){if(e?.code==='ENOENT')return '';throw e;}}
