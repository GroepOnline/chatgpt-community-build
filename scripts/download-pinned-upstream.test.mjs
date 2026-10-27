import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,chmodSync,existsSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lock, verifyPinnedLock, verifyPackageBytes,metadataFor } from './download-pinned-upstream.mjs';
test('both fixed architectures match a previously signed, versioned OpenAI package',()=>{
  assert.doesNotThrow(()=>verifyPinnedLock(lock));
  for(const arch of ['amd64','arm64']){
    const m=metadataFor(arch);
    assert.match(m.repositoryPath,/26\.1021\.22027_/);
    assert.equal(m.version,'26.1021.22027');
    assert.match(m.sha256,/^[a-f0-9]{64}$/);
  }
});
test('pin metadata and unknown architectures fail closed',()=>{
  assert.throws(()=>metadataFor('i386'),/Unsupported/);
  assert.throws(()=>verifyPinnedLock({...lock,version:'latest'}),/invalid/i);
  assert.throws(()=>verifyPinnedLock({...lock,architectures:{...lock.architectures,amd64:{...lock.architectures.amd64,sha256:'0'.repeat(64),size:0}}}),/invalid/i);
});
test('actual package bytes require exact size and SHA-256',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pinned-upstream-test-'));
  const file=join(dir,'package.deb');
  try{
    const bytes='test payload';
    writeFileSync(file,bytes);
    const sha256=createHash('sha256').update(bytes).digest('hex');
    assert.equal(verifyPackageBytes(file,{size:bytes.length,sha256}),sha256);
    assert.throws(()=>verifyPackageBytes(file,{size:13,sha256}),/size/);
    assert.throws(()=>verifyPackageBytes(file,{size:bytes.length,sha256:'f'.repeat(64)}),/checksum/);
  }finally{rmSync(dir,{recursive:true,force:true})}
});

test('CLI reaches byte validation and rejects mocked corrupt downloads',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pinned-cli-test-'));
  try{
    const bin=join(dir,'bin'),out=join(dir,'out'),metadata=join(dir,'metadata.json');
    mkdirSync(bin);
    const curl=join(bin,'curl');
    writeFileSync(curl,'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--output" ]; then printf test > "$2"; exit 0; fi; shift; done\nexit 3\n');
    chmodSync(curl,0o755);
    const entry=fileURLToPath(new URL('./download-pinned-upstream.mjs',import.meta.url));
    const run=spawnSync(process.execPath,[entry,'--arch','amd64','--output-dir',out,'--metadata',metadata],{
      encoding:'utf8',timeout:3000,env:{...process.env,PATH:bin+':'+process.env.PATH},
    });
    assert.notEqual(run.status,0);
    assert.match(run.stderr,/Pinned package size mismatch/);
    assert.doesNotMatch(run.stderr,/not defined|ReferenceError/);
    assert.equal(existsSync(metadata),false);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
