import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, packageVersion, releaseTag, parseChecksums, assertFeatureSet, validateStaged } from './assemble-release.mjs';

test('pins version syntax and derives a safe release tag', () => {
  assert.equal(releaseTag('2026.10.25.26'),'community-v2026.10.25.26');
  for(const x of ['latest','2026.10.25','2026.10.25.26;rm -rf /','2026.10.25.26\n'])
    assert.throws(()=>packageVersion(x));
});
test('checksums reject duplicate names and path traversal', () => {
  const h='0'.repeat(64);
  assert.equal(parseChecksums(h+'  build.deb\n').get('build.deb'),h);
  assert.throws(()=>parseChecksums(h+'  build.deb\n'+h+'  build.deb\n'));
  assert.throws(()=>parseChecksums(h+'  ../evil\n'));
  assert.throws(()=>parseChecksums(h+' *build.deb\n'));
});
test('feature manifest must match 39 supported nonduplicated features', () => {
  const expected=Array.from({length:39},(_,i)=>'feature-'+i);
  assert.doesNotThrow(()=>assertFeatureSet({enabled:expected},{enabled:expected}));
  assert.throws(()=>assertFeatureSet({enabled:[...expected,'shared-app-server-socket']},{enabled:[...expected,'shared-app-server-socket']}));
  assert.throws(()=>assertFeatureSet({enabled:[...expected.slice(0,38),expected[0]]},{enabled:expected}));
  assert.throws(()=>assertFeatureSet({enabled:expected.slice(1)},{enabled:expected}));
});
test('release validation fails closed before invoking dpkg on bad metadata', () => {
  const d=mkdtempSync(join(tmpdir(),'release-test-'));
  try {
    writeFileSync(join(d,'release-metadata.json'),JSON.stringify({tag:'community-v2026.10.25.26',runtimeAccepted:true}));
    writeFileSync(join(d,'SHA256SUMS'),sha256(join(d,'release-metadata.json'))+'  release-metadata.json\n');
    assert.throws(()=>validateStaged(d,'community-v2026.10.25.26','amd64'),/provenance invalid/);
    assert.throws(()=>validateStaged(d,'../../evil','amd64'));
    assert.throws(()=>validateStaged(d,'community-v2026.10.25.26','386'));
  } finally {rmSync(d,{recursive:true,force:true});}
});
