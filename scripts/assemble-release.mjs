#!/usr/bin/env node
// Build-side integrity assembler; never installs a package.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const REPO = 'GroepOnline/chatgpt-community-build';
const UPSTREAM = 'fc533a9346095e74d47c506e3103b7282c5c54d9';
export function packageVersion(x) {
  if (typeof x !== 'string' || !/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(x)) throw new Error('Invalid version');
  return x;
}
export function releaseTag(x) { return 'community-v' + packageVersion(x); }
export function sha256(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }
export function parseChecksums(s) {
  const rows=new Map();
  for (const line of s.trim().split('\n')) {
    const m=/^([0-9a-f]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    if (!m || rows.has(m[2])) throw new Error('Invalid or duplicated SHA256SUMS entry');
    rows.set(m[2],m[1]);
  }
  if (rows.size===0) throw new Error('Empty checksums');
  return rows;
}
const json = p=>JSON.parse(readFileSync(p,'utf8'));
function file(dir,name) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('Unsafe file name');
  const p=join(dir,name);
  if (!lstatSync(p).isFile()) throw new Error('Not a regular file: '+name);
  return p;
}
function shaCheck(dir) {
  const sums=parseChecksums(readFileSync(file(dir,'SHA256SUMS'),'utf8'));
  for (const [n,h] of sums) if (sha256(file(dir,n))!==h) throw new Error('Checksum mismatch: '+n);
  return sums;
}
const field=(deb,f)=>execFileSync('dpkg-deb',['--field',deb,f],{encoding:'utf8',timeout:15000}).trim();
const equal=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&
  JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
export function assertFeatureSet(flags,expected) {
  if (!flags || !Array.isArray(flags.enabled) || flags.enabled.length!==38 ||
      new Set(flags.enabled).size!==38 || flags.enabled.includes('shared-app-server-socket') ||
      !equal(flags.enabled,expected.enabled)) throw new Error('Unsupported Community feature set');
}
function validateInput(dir,arch,version,expected) {
  const sums=shaCheck(dir);
  for (const n of ['features.json','build-info.json','upstream-signed-metadata.json'])
    if (!sums.has(n)) throw new Error('Metadata without hash: '+n);
  const debs=readdirSync(dir).filter(n=>/^codex-desktop_.+_(amd64|arm64)\.deb$/.test(n));
  if (debs.length!==1 || !sums.has(debs[0])) throw new Error('Invalid DEB count');
  const deb=file(dir,debs[0]);
  const v=packageVersion(field(deb,'Version'));
  if (field(deb,'Package')!=='codex-desktop'||field(deb,'Architecture')!==arch||
      debs[0]!=='codex-desktop_'+v+'_'+arch+'.deb'||(version&&v!==version))
    throw new Error('Package version/architecture mismatch');
  const features=json(file(dir,'features.json'));
  const info=json(file(dir,'build-info.json'));
  const metadata=json(file(dir,'upstream-signed-metadata.json'));
  assertFeatureSet(features,expected);
  if (!equal(info.linuxFeatures?.enabled,features.enabled)||
      info.source?.commit!==UPSTREAM||
      info.upstreamLinuxPackage?.architecture!==arch||
      info.upstreamLinuxPackage?.version!=='26.1021.22027'||
      !metadata || typeof metadata!=='object') throw new Error('Signed upstream/feature provenance mismatch');
  return {version:v,deb};
}
export function validateStaged(dir,tag,arch) {
  if (!/^community-v\d{4}\.\d{2}\.\d{2}\.\d+$/.test(tag)) throw new Error('Invalid release tag');
  if (!['amd64','arm64'].includes(arch)) throw new Error('Unsupported architecture');
  const metadata=json(file(dir,'release-metadata.json'));
  if (metadata.tag!==tag||metadata.version!==tag.slice(11)||
      metadata.sourceRepository!==REPO||metadata.upstreamCommit!==UPSTREAM||
      metadata.runtimeAccepted!==false||metadata.featureCount!==38||
      !/^[0-9a-f]{40}$/.test(metadata.buildCommit)||
      !/^\d+$/.test(String(metadata.buildRunId))) throw new Error('Release provenance invalid');
  const debname='codex-desktop_'+metadata.version+'_'+arch+'.deb';
  if (metadata.packageAssets?.[arch]!==debname) throw new Error('Package asset missing');
  const sums=parseChecksums(readFileSync(file(dir,'SHA256SUMS'),'utf8'));
  for (const n of ['release-metadata.json',debname]) {
    if (!sums.has(n)||sha256(file(dir,n))!==sums.get(n)) throw new Error('Staged checksum failed');
  }
  const deb=file(dir,debname);
  if (field(deb,'Version')!==metadata.version||field(deb,'Architecture')!==arch||
      field(deb,'Package')!=='codex-desktop') throw new Error('Staged package identity mismatch');
  return {version:metadata.version,deb,sha256:sums.get(debname)};
}
const opts=args=>{
  const r={};
  for(let i=0;i<args.length;i+=2) {
    if (!args[i]?.startsWith('--')||!args[i+1]||r[args[i]]) throw new Error('Invalid arguments');
    r[args[i]]=args[i+1];
  }
  return r;
};
function assemble(o) {
  const amd=resolve(o['--amd64-dir']);
  const arm=resolve(o['--arm64-dir']);
  const out=resolve(o['--output-dir']);
  const id=String(o['--run-id']||''),number=String(o['--run-number']||''),sha=String(o['--run-sha']||'');
  if (!/^\d+$/.test(id)||!/^\d+$/.test(number)||!/^[0-9a-f]{40}$/.test(sha))
    throw new Error('Invalid source build');
  const source=json(resolve('.github/community-build/features.json'));
  const a=validateInput(amd,'amd64',null,source);
  const b=validateInput(arm,'arm64',a.version,source);
  if (!a.version.endsWith('.'+number)) throw new Error('Run number/version mismatch');
  mkdirSync(out,{recursive:true,mode:0o700});
  if (readdirSync(out).length) throw new Error('Release folder must be empty');
  for (const [input,arch,c] of [[amd,'amd64',a],[arm,'arm64',b]]) {
    copyFileSync(c.deb,join(out,basename(c.deb)));
    copyFileSync(file(input,'build-info.json'),join(out,'build-info-'+arch+'.json'));
    copyFileSync(file(input,'upstream-signed-metadata.json'),join(out,'upstream-signed-metadata-'+arch+'.json'));
  }
  copyFileSync(file(amd,'features.json'),join(out,'features.json'));
  const meta={
    schema:1,tag:releaseTag(a.version),version:a.version,sourceRepository:REPO,
    buildCommit:sha,buildRunId:id,upstreamCommit:UPSTREAM,
    upstreamPackageVersion:'26.1021.22027',featureCount:38,runtimeAccepted:false,
    packageAssets:{amd64:basename(a.deb),arm64:basename(b.deb)}
  };
  writeFileSync(join(out,'release-metadata.json'),JSON.stringify(meta,null,2)+'\n');
  const notes=[
    '# ChatGPT Community Linux '+a.version,'',
    'Verified GitHub release draft from a trusted-branch build. Public publication requires verified redistribution rights.',
    'Architectures: amd64 and arm64. Enabled Community features: 38.',
    'Official signed upstream package: 26.1021.22027.',
    'Build commit: '+sha,
    'CI: https://github.com/'+REPO+'/actions/runs/'+id,'',
    'This cloud build has NOT been installed or desktop-runtime-accepted.',
    'The local installer must enforce prior-DEB rollback, shared profile backup,',
    'zero ChatGPT/Codex processes, and logged-in chat_boot verification.'
  ].join('\n')+'\n';
  writeFileSync(join(out,'RELEASE_NOTES.md'),notes);
  const names=readdirSync(out).sort();
  writeFileSync(join(out,'SHA256SUMS'),names.map(n=>sha256(file(out,n))+'  '+n).join('\n')+'\n');
  console.log(JSON.stringify({tag:meta.tag,assets:names.length,runId:id}));
}
if (process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const o=opts(process.argv.slice(2));
    if(o['--mode']==='assemble') assemble(o);
    else if(o['--mode']==='verify') {
      const r=validateStaged(resolve(o['--stage-dir']),o['--tag'],o['--arch']);
      console.log('PASS staged_release '+JSON.stringify({version:r.version,sha256:r.sha256,arch:o['--arch']}));
    } else throw new Error('Invalid assembler mode');
  } catch(e) { console.error('FAIL release_validation '+e.message);process.exitCode=1; }
}
