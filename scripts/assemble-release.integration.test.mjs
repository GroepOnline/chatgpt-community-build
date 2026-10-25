import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256,validateStaged } from './assemble-release.mjs';

const repo=resolve(new URL('..',import.meta.url).pathname);
const assembler=join(repo,'scripts/assemble-release.mjs');
const source='fc533a9346095e74d47c506e3103b7282c5c54d9';
const manifest=JSON.parse(readFileSync(join(repo,'.github/community-build/features.json'),'utf8'));
const version='2026.10.25.31';
function makeDeb(base,arch,version) {
  const dir=join(base,'pkg-'+arch);
  mkdirSync(join(dir,'DEBIAN'),{recursive:true});
  mkdirSync(join(dir,'opt'),{recursive:true});
  writeFileSync(join(dir,'DEBIAN/control'),[
    'Package: codex-desktop','Version: '+version,'Architecture: '+arch,
    'Section: misc','Priority: optional','Maintainer: Fixture <fixture@example.com>',
    'Description: synthetic fixture - never install'
  ].join('\n')+'\n');
  writeFileSync(join(dir,'opt/synthetic-fixture'),'fake package, not ChatGPT');
  const target=join(base,'input',arch,'codex-desktop_'+version+'_'+arch+'.deb');
  const result=spawnSync('dpkg-deb',['--build','--root-owner-group',dir,target],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
}
function setup(armVersion=version) {
  const root=mkdtempSync(join(tmpdir(),'community-assembler-'));
  for(const arch of ['amd64','arm64']) {
    const dir=join(root,'input',arch);
    mkdirSync(dir,{recursive:true});
    makeDeb(root,arch,arch==='arm64'?armVersion:version);
    writeFileSync(join(dir,'features.json'),JSON.stringify(manifest));
    writeFileSync(join(dir,'build-info.json'),JSON.stringify({
      source:{commit:source},linuxFeatures:{enabled:manifest.enabled},
      upstreamLinuxPackage:{version:'26.1021.22027',architecture:arch}
    }));
    writeFileSync(join(dir,'upstream-signed-metadata.json'),JSON.stringify({fixtureOnly:true}));
    writeFileSync(join(dir,'SHA256SUMS'),
      readdirSync(dir).filter(n=>n!=='SHA256SUMS').sort().map(n=>
        sha256(join(dir,n))+'  '+n).join('\n')+'\n');
  }
  return root;
}
function assemble(root,output) {
  return spawnSync(process.execPath,[
    assembler,'--mode','assemble',
    '--amd64-dir',join(root,'input/amd64'),
    '--arm64-dir',join(root,'input/arm64'),
    '--output-dir',output,
    '--run-id','40200351596','--run-number','31',
    '--run-sha','b'.repeat(40)
  ],{cwd:repo,encoding:'utf8',timeout:15000});
}
test('full two-architecture release assembles and verifies without real OpenAI software',()=>{
  const root=setup();
  try{
    const out=join(root,'release');
    const run=assemble(root,out);
    assert.equal(run.status,0,(run.stdout+run.stderr).slice(-1500));
    for(const arch of ['amd64','arm64']){
      const r=validateStaged(out,'community-v'+version,arch);
      assert.equal(r.version,version);
      assert.match(r.sha256,/^[0-9a-f]{64}$/);
    }
    const meta=JSON.parse(readFileSync(join(out,'release-metadata.json'),'utf8'));
    assert.equal(meta.runtimeAccepted,false);
    assert.equal(meta.featureCount,38);
    assert.equal(meta.buildRunId,'40200351596');
    assert.equal(meta.upstreamCommit,source);
    assert.ok(readdirSync(out).includes('SHA256SUMS'));
    const checks=spawnSync('sha256sum',['-c','SHA256SUMS'],{cwd:out,encoding:'utf8'});
    assert.equal(checks.status,0,checks.stderr);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('mismatched AMD64/ARM64 versions abort before a release exists',()=>{
  const root=setup('2026.10.25.32');
  try {
    const run=assemble(root,join(root,'output'));
    assert.notEqual(run.status,0);
    assert.match(run.stderr,/Architecture versions differ|version\/architecture mismatch|Release|Invalid/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
