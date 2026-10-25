import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
