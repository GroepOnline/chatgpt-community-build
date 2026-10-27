#!/usr/bin/env node
// Deliberately hold a previously signed OpenAI Linux payload while optional
// Community patches are incompatible with the newer stable API/renderer.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const lock = JSON.parse(readFileSync(join(repo,'.github/community-build/upstream-26.1021.lock.json')));
export function verifyPinnedLock(value) {
  if (value?.schemaVersion !== 1 || value.package !== 'chatgpt' ||
      value.version !== '26.1021.22027' ||
      value.repository !== 'https://persistent.oaistatic.com/codex-app-prod/linux/deb' ||
      !/^\d+$/.test(value.signedEvidence?.sourceBuildRunId ?? '') ||
      !/^[0-9a-f]{40}$/.test(value.signedEvidence?.sourceCommit ?? '') ||
      value.signedEvidence?.sourceRelease !== 'community-v2026.10.26.61') throw Error('Pinned OpenAI package lock invalid');
  for (const arch of ['amd64','arm64']) {
    const item=value.architectures?.[arch];
    if (!item || item.repositoryPath !== `pool/main/c/chatgpt/chatgpt_${value.version}_${arch}.deb` ||
        !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.size) || item.size < 100_000_000) throw Error('Pinned architecture invalid: '+arch);
  }
  if (Object.keys(value.architectures).length!==2) throw Error('Unrecognized architecture');
  return value;
}
export function verifyPackageBytes(file,expected) {
  if (statSync(file).size!==expected.size) throw Error('Pinned package size mismatch');
  const h=createHash('sha256').update(readFileSync(file)).digest('hex');
  if (h!==expected.sha256) throw Error('Pinned package checksum mismatch');
  return h;
}
export function metadataFor(arch, value=lock) {
  verifyPinnedLock(value);
  const entry=value.architectures[arch];
  if(!entry) throw Error('Unsupported architecture');
  return {
    package:'chatgpt',version:value.version,architecture:arch,
    repository:value.repository,repositoryPath:entry.repositoryPath,
    sha256:entry.sha256,size:entry.size,
    signedMetadataSource:value.signedEvidence,
  };
}
function download() {
  const args=process.argv.slice(2);
  if(args.length!==6) throw Error('Usage: --arch ARCH --output-dir DIR --metadata FILE');
  const fields=Object.fromEntries([0,2,4].map(i=>[args[i],args[i+1]]));
  if(Object.keys(fields).sort().join(',')!=='--arch,--metadata,--output-dir') throw Error('Unsupported arguments');
  const arch=fields['--arch'];
  const info=metadataFor(arch);
  const output=resolve(fields['--output-dir']);
  const target=join(output,basename(info.repositoryPath));
  mkdirSync(output,{recursive:true});
  if(statSync(output).isDirectory()===false)throw Error('Invalid output');
  const temporary=mkdtempSync(join(output,'.pinned-'));
  const downloaded=join(temporary,basename(info.repositoryPath));
  try {
    execFileSync('curl',['--fail','--location','--silent','--show-error',
      '--retry','3','--connect-timeout','15','--max-time','360',
      '--output',downloaded,info.repository+'/'+info.repositoryPath],{stdio:'inherit',timeout:380000});
    verifyPackageBytes(downloaded,info);
    const field=(name)=>execFileSync('dpkg-deb',['--field',downloaded,name],{encoding:'utf8',timeout:20000}).trim();
    if(field('Package')!=='chatgpt'||field('Version')!==info.version||
       field('Architecture')!==arch) throw Error('Pinned package identity mismatch');
    renameSync(downloaded,target);
    mkdirSync(dirname(resolve(fields['--metadata'])),{recursive:true});
    writeFileSync(resolve(fields['--metadata']),JSON.stringify(info,null,2)+'\n',{mode:0o600});
    console.log('PINNED_SIGNED_UPSTREAM_OK arch='+arch+' sha256='+info.sha256);
    console.log(target);
  } finally {rmSync(temporary,{recursive:true,force:true});}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{download()}catch(e){console.error('PINNED_UPSTREAM_FAILED '+e.message);process.exitCode=1}
}
