#!/usr/bin/env node
// Scoped graceful shutdown; never pkill/grep; do not run under sudo.
import { scanOwnedDesktopProcesses } from './verify-desktop-quiescence.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function signalTargets(processes, send=process.kill) {
  for (const p of processes) {
    // Recheck the PID still belongs to a known ChatGPT/Codex executable.
    const current=scanOwnedDesktopProcesses().find(x=>x.pid===p.pid && x.comm===p.comm);
    if (!current) continue;
    try { send(p.pid,'SIGTERM'); }
    catch (err) { if (err?.code!=='ESRCH') throw err; }
  }
}
export async function closeDesktop({timeoutMs=30000,quietMs=3000}={}) {
  if (process.getuid?.()===0) throw new Error('Must run as the desktop user');
  const deadline=Date.now()+timeoutMs;
  let lastSignal=0, emptySince=null;
  while (Date.now()<deadline) {
    const found=scanOwnedDesktopProcesses();
    if (found.length===0) {
      if (emptySince===null) emptySince=Date.now();
      if (Date.now()-emptySince>=quietMs) return {ok:true,count:0};
    } else {
      emptySince=null;
      if (Date.now()-lastSignal>3000) {
        signalTargets(found);
        lastSignal=Date.now();
      }
    }
    await delay(250);
  }
  const remaining=scanOwnedDesktopProcesses();
  return {ok:false,count:remaining.length,processes:remaining};
}
if (process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  if (process.argv.slice(2).join(' ')!=='--close') {
    console.error('Usage: node scripts/stop-chatgpt-desktop.mjs --close');
    process.exit(2);
  }
  try {
    const r=await closeDesktop();
    if (!r.ok) {
      console.error('BLOCK desktop_shutdown '+r.count+' still active');
      process.exitCode=1;
    } else console.log('PASS desktop_shutdown zero owned ChatGPT/Codex processes for 3 seconds');
  } catch (e) {console.error('BLOCK desktop_shutdown '+e.message);process.exitCode=1;}
}
