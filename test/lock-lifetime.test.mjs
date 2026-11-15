import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { LongrunBusy, withLongrunLock } from '../src/lock.mjs';
import { acquireRuntimeLock, resolveRuntimeLayout } from '../src/service-runtime.mjs';

for (const kind of ['business', 'watch']) test(`${kind} ownership survives garbage collection of an indefinitely suspended async operation`, { timeout: 10_000 }, async t => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-lock-lifetime-')));
  const projectRoot = path.join(scratch, 'project'), runtimeHome = path.join(scratch, 'machine'); fs.mkdirSync(projectRoot);
  const options = { projectRoot, runtimeHome };
  const module = new URL(kind === 'business' ? '../src/lock.mjs' : '../src/service-runtime.mjs', import.meta.url).href;
  const hold = `() => { let announced = false; setInterval(() => { global.gc(); if (!announced) { announced = true; process.send('held-after-gc'); } }, 5); return new Promise(() => {}); }`;
  const code = kind === 'business'
    ? `import {withLongrunLock} from ${JSON.stringify(module)}; await withLongrunLock(${JSON.stringify(projectRoot)},${hold});`
    : `import {runManagedWatcher} from ${JSON.stringify(module)}; await runManagedWatcher({...${JSON.stringify(options)},start:${hold}});`;
  const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL'); await exited; fs.rmSync(scratch, { recursive: true, force: true }); });
  await Promise.race([once(child, 'message'), exited.then(([code]) => { throw new Error(`Lock holder exited ${code}: ${stderr}`); })]);
  if (kind === 'business') {
    await assert.rejects(withLongrunLock(projectRoot, () => assert.fail('Another process still owns the lock'), { timeoutMs: 60, retryMs: 5 }), LongrunBusy);
  } else {
    assert.throws(() => acquireRuntimeLock(resolveRuntimeLayout(options), 'watch'), { code: 'LONGRUN_SERVICE_BUSY' });
  }
  child.kill('SIGKILL'); await exited;
  if (kind === 'business') await withLongrunLock(projectRoot, () => {});
  else acquireRuntimeLock(resolveRuntimeLayout(options), 'watch')();
});
