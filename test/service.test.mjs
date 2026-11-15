import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createLongrunServiceManager } from '../src/service.mjs';
import { resolveRuntimeLayout, runManagedWatcher, recordManagedTick, readRuntimeJSON, writeRuntimeJSON } from '../src/service-runtime.mjs';
import { withLongrunLockSync } from '../src/lock.mjs';

function fixture(t) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-service-')));
  const projectRoot = path.join(scratch, 'project'), runtimeHome = path.join(scratch, 'machine');
  fs.mkdirSync(projectRoot); fs.writeFileSync(path.join(projectRoot, 'entry.mjs'), '// trusted host wrapper\n');
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  return { scratch, projectRoot, runtimeHome, launchAgentsDir: path.join(scratch, 'LaunchAgents'), entrypoint: path.join(projectRoot, 'entry.mjs'), entryArgs: [], timeoutMs: 500 };
}
function files(root) { return fs.readdirSync(root, { recursive: true }).sort(); }
function harness(options) {
  const jobs = new Map(), alive = new Map(), calls = [], signals = [];
  let time = Date.now(), nextPid = 41000, onSleep = () => {};
  const dependencies = {
    platform: 'darwin', uid: 501, now: () => time, processIdentity: pid => alive.get(pid) ?? null,
    superagent: { createServiceManager: () => ({ health: () => ({ state: 'healthy', healthy: true }) }) },
    runLaunchctl(args) {
      calls.push(args);
      const action = args[0], label = args[1]?.split('/').at(-1);
      if (action === 'print') {
        const job = jobs.get(label);
        return job ? { status: 0, stdout: job.pid ? `pid = ${job.pid}\n` : 'state = waiting\n' } : { status: 113, stderr: 'Could not find service' };
      }
      if (action === 'bootstrap') {
        const text = fs.readFileSync(args[2], 'utf8'), installedLabel = /<key>Label<\/key><string>([^<]+)/.exec(text)[1];
        if (installedLabel.endsWith('.watch')) {
          const pid = nextPid++; jobs.set(installedLabel, { pid }); alive.set(pid, { pid, birth: `birth-${pid}`, uid: 501, host: 'test-host' });
        } else jobs.set(installedLabel, { pid: null });
      }
      if (action === 'bootout') jobs.delete(label);
      if (action === 'kickstart') {
        const pid = nextPid++; jobs.set(label, { pid }); alive.set(pid, { pid, birth: `birth-${pid}`, uid: 501, host: 'test-host' });
      }
      return { status: 0, stdout: '' };
    },
    signal(pid, kind) { signals.push({ pid, kind }); },
    async sleep(ms) { time += ms; await onSleep(); },
  };
  const manager = createLongrunServiceManager(options, dependencies);
  function receipt(kind, { phase = kind === 'watch' ? 'ready' : 'running', pid } = {}) {
    const label = manager.status().labels[kind];
    pid ??= jobs.get(label)?.pid ?? nextPid++;
    const identity = alive.get(pid) ?? { pid, birth: `birth-${pid}`, uid: 501, host: 'test-host' };
    alive.set(pid, identity);
    const owner = { schemaVersion: 1, ...identity, projectRoot: manager.layout.projectRoot, runtimeDir: manager.layout.runtimeDir,
      kind, runId: `run-${pid}`, at: new Date(time).toISOString() };
    writeRuntimeJSON(kind === 'watch' ? manager.layout.ownerPath : manager.layout.tickOwnerPath, owner);
    writeRuntimeJSON(kind === 'watch' ? manager.layout.watchPath : manager.layout.tickPath, { ...owner, phase, heartbeatAt: new Date(time).toISOString(), sequence: 1, startedAt: new Date(time).toISOString(), lastCheckAt: new Date(time).toISOString() });
    return owner;
  }
  return { manager, jobs, alive, calls, signals, receipt, dependencies, setOnSleep(fn) { onSleep = fn; }, advance(ms) { time += ms; } };
}

test('status, health and logs on an uninstalled project create no runtime or SDK state', async t => {
  const options = fixture(t), h = harness(options), before = files(options.scratch);
  assert.equal(h.manager.status().installed, false);
  assert.equal((await h.manager.health()).state, 'not-installed');
  assert.equal(h.manager.logs().available, false);
  assert.deepEqual(files(options.scratch), before);
  assert.ok(h.calls.every(([command]) => command === 'print'));
});

test('install is stopped, escapes a host entry, preserves tick gates and refuses secrets', async t => {
  const options = fixture(t), h = harness({ ...options, openRounds: true, intervalSeconds: 17 });
  await h.manager.install();
  const status = h.manager.status(), manifest = readRuntimeJSON(h.manager.layout.manifestPath);
  assert.equal(status.intent, 'stopped'); assert.equal(status.watch.loaded, false);
  assert.equal(manifest.intervalSeconds, 17); assert.deepEqual(manifest.entryArgs, []);
  const tick = fs.readFileSync(status.plistPaths.tick, 'utf8');
  assert.match(tick, /<integer>17<\/integer>/); assert.match(tick, /<key>LONGRUN_OPEN_ROUNDS<\/key><string>1/);
  assert.match(tick, /<key>JS_LONGRUN_HOME/); assert.doesNotMatch(tick, /<string>--project<\/string>/);
  assert.ok(!h.calls.some(([command]) => command === 'bootstrap'));
  const blocked = createLongrunServiceManager({ ...options, environment: { API_TOKEN: 'private' } }, h.dependencies);
  await assert.rejects(blocked.install(), /non-secret/);
  assert.equal(readRuntimeJSON(h.manager.layout.manifestPath).installId, manifest.installId);
});

test('start waits through launch PID / receipt race and successful catchup; stop waits through removed receipt / exit race', async t => {
  const h = harness(fixture(t)); await h.manager.install();
  let rounds = 0, owner;
  h.setOnSleep(() => {
    rounds++;
    if (rounds === 1) owner = h.receipt('watch', { phase: 'starting' });
    if (rounds === 2) { const record = readRuntimeJSON(h.manager.layout.watchPath); writeRuntimeJSON(h.manager.layout.watchPath, { ...record, phase: 'ready' }); }
  });
  assert.equal((await h.manager.start()).watch.observation.phase, 'ready'); assert.equal(rounds, 2);
  h.setOnSleep(() => {
    if (fs.existsSync(h.manager.layout.ownerPath)) fs.unlinkSync(h.manager.layout.ownerPath);
    else h.alive.delete(owner.pid);
  });
  const stopped = await h.manager.stop();
  assert.equal(stopped.intent, 'stopped'); assert.equal(stopped.watch.loaded, false); assert.equal(stopped.tick.loaded, false);
  assert.deepEqual(h.signals, [{ pid: owner.pid, kind: 'SIGTERM' }]);
});

test('PID without owner is never signalled or reported ready', async t => {
  const h = harness(fixture(t)); await h.manager.install();
  await assert.rejects(h.manager.start(), { code: 'LONGRUN_UNKNOWN_OWNER' });
  assert.equal((await h.manager.health()).healthy, false);
  await assert.rejects(h.manager.stop(), { code: 'LONGRUN_UNKNOWN_OWNER' });
  assert.equal(h.manager.status().intent, 'stopped'); assert.deepEqual(h.signals, []);
});

test('start waits for an already-owned starting watcher without replacing the process or resetting running intent', async t => {
  const h = harness(fixture(t)); await h.manager.install();
  h.setOnSleep(() => h.receipt('watch'));
  const running = await h.manager.start(), original = readRuntimeJSON(h.manager.layout.manifestPath);
  const snapshot = readRuntimeJSON(h.manager.layout.watchPath);
  writeRuntimeJSON(h.manager.layout.watchPath, { ...snapshot, phase: 'starting' });
  let waits = 0;
  h.setOnSleep(() => { waits++; if (waits === 2) writeRuntimeJSON(h.manager.layout.watchPath, { ...snapshot, phase: 'ready' }); });
  const ready = await h.manager.start();
  assert.equal(waits, 2); assert.equal(ready.watch.pid, running.watch.pid); assert.equal(ready.watch.observation.phase, 'ready');
  assert.deepEqual(readRuntimeJSON(h.manager.layout.manifestPath), original);
  assert.equal(h.calls.filter(([command]) => command === 'kickstart').length, 0);
  writeRuntimeJSON(h.manager.layout.watchPath, { ...snapshot, phase: 'starting' }); h.setOnSleep(() => {});
  await assert.rejects(h.manager.start(), { code: 'LONGRUN_START_PENDING' });
  assert.deepEqual(readRuntimeJSON(h.manager.layout.manifestPath), original);
});

test('start explicitly starts an owned loaded idle watcher after clean exit without force-killing or resetting intent', async t => {
  const h = harness(fixture(t)); await h.manager.install(); h.setOnSleep(() => h.receipt('watch'));
  const originalState = await h.manager.start(), originalManifest = readRuntimeJSON(h.manager.layout.manifestPath);
  h.alive.delete(originalState.watch.pid); h.jobs.set(originalState.labels.watch, { pid: null });
  fs.unlinkSync(h.manager.layout.ownerPath);
  const restarted = await h.manager.start();
  assert.notEqual(restarted.watch.pid, originalState.watch.pid); assert.equal(restarted.watch.observation.phase, 'ready');
  assert.deepEqual(h.calls.filter(([command]) => command === 'kickstart'), [['kickstart', `gui/501/${originalState.labels.watch}`]]);
  assert.deepEqual(h.signals, []); assert.deepEqual(readRuntimeJSON(h.manager.layout.manifestPath), originalManifest);
});

test('stop lets in-flight tick drain and keeps stopped intent on timeout', async t => {
  const h = harness(fixture(t)); await h.manager.install();
  const tick = h.receipt('tick');
  await assert.rejects(h.manager.stop(), { code: 'LONGRUN_STOP_PENDING' });
  assert.equal(h.manager.status().intent, 'stopped'); assert.deepEqual(h.signals, []);
  h.alive.delete(tick.pid); fs.unlinkSync(h.manager.layout.tickOwnerPath);
  assert.equal((await h.manager.stop()).intent, 'stopped');
});

test('health separates heartbeat, timer and dependency observations; stale heartbeat cannot be healthy', async t => {
  const h = harness(fixture(t)); await h.manager.install(); h.setOnSleep(() => h.receipt('watch'));
  await h.manager.start(); assert.equal((await h.manager.health()).healthy, true);
  h.advance(31000); const stale = await h.manager.health();
  assert.equal(stale.localState, 'degraded'); assert.ok(stale.reasons.includes('watch-heartbeat-stale-or-unobserved'));
  assert.equal(stale.dependency.healthy, true);
  const older = createLongrunServiceManager({ projectRoot: h.manager.layout.projectRoot }, { ...h.dependencies, superagent: {} });
  // Explicit alternate plist directory is required when inspecting an alternate test deployment.
  assert.throws(() => older.status(), { code: 'LONGRUN_SERVICE_CONFLICT' });
});

test('old SDK without a standalone public health API stays unavailable without initialization', async t => {
  const options = fixture(t), h = harness(options), before = files(options.scratch);
  const manager = createLongrunServiceManager(options, { ...h.dependencies, superagent: { createProjectAgent() { assert.fail('must not initialize SDK'); } } });
  const report = await manager.health(); assert.equal(report.dependency.state, 'unavailable');
  assert.deepEqual(files(options.scratch), before);
});

test('a live heartbeat cannot hide a hung reconciliation and stopped service controls serialize', async t => {
  const options = fixture(t), h = harness(options); await h.manager.install(); h.setOnSleep(() => h.receipt('watch'));
  await h.manager.start();
  const record = readRuntimeJSON(h.manager.layout.watchPath);
  h.advance(301000);
  writeRuntimeJSON(h.manager.layout.watchPath, { ...record, checkStartedAt: record.startedAt, heartbeatAt: h.manager.status().observedAt });
  assert.ok((await h.manager.health()).reasons.includes('watch-check-overdue'));
  let unblock;
  h.dependencies.sleep = () => new Promise(resolve => { unblock = resolve; });
  // The manager captures the sleep function at creation.
  const manager = createLongrunServiceManager(options, h.dependencies);
  const stopping = manager.stop();
  await Promise.resolve();
  await assert.rejects(manager.start(), { code: 'LONGRUN_SERVICE_BUSY' });
  h.alive.clear(); unblock(); await stopping;
  assert.equal(manager.status().intent, 'stopped');
});

test('closing during startup rejects readiness and releases ownership', async t => {
  const options = fixture(t);
  const watcher = await runManagedWatcher({ ...options, start: () => ({ ready: Promise.resolve(), close: async () => {} }) });
  await watcher.close(); await assert.rejects(watcher.ready, { code: 'LONGRUN_WATCH_CLOSED' });
  assert.equal(readRuntimeJSON(watcher.layout.ownerPath), null);
});

test('foreground watcher owns singleton before opening client, pins runtime home, and only explicit successful callback makes it ready', async t => {
  const options = fixture(t); let callbacks, starts = 0;
  const watcher = await runManagedWatcher({ ...options, start: input => { callbacks = input; starts++; return { ready: Promise.resolve(), close: async () => {} }; } });
  let becameReady = false; watcher.ready.then(() => { becameReady = true; }); await Promise.resolve();
  assert.equal(becameReady, false);
  assert.equal(readRuntimeJSON(watcher.layout.watchPath).phase, 'starting');
  await assert.rejects(runManagedWatcher({ ...options, start: () => { starts++; } }), { code: 'LONGRUN_SERVICE_BUSY' });
  assert.equal(starts, 1);
  await assert.rejects(runManagedWatcher({ ...options, runtimeHome: path.join(options.scratch, 'elsewhere'), start: () => {} }), { code: 'LONGRUN_RUNTIME_CONFLICT' });
  callbacks.onActivity({ kind: 'error', code: 'OBSERVE_FAILED' }); callbacks.onActivity({ kind: 'reconcile', ok: false });
  assert.equal(readRuntimeJSON(watcher.layout.watchPath).lastError.code, 'OBSERVE_FAILED');
  callbacks.onActivity({ kind: 'reconcile', ok: true }); callbacks.onReady();
  await watcher.ready; assert.equal(becameReady, true);
  assert.equal(readRuntimeJSON(watcher.layout.watchPath).phase, 'ready');
  await watcher.close(); assert.equal(readRuntimeJSON(watcher.layout.watchPath).phase, 'stopped');
  const restarted = await runManagedWatcher({ ...options, start: ({ onReady }) => { onReady(); return { ready: Promise.resolve(), close: async () => {} }; } });
  await restarted.close();
});

test('tick records failures without copying exception contents and does not bypass stopped service intent', async t => {
  const options = fixture(t);
  await assert.rejects(recordManagedTick({ ...options, run: () => { throw Object.assign(new Error('private result'), { code: 'CHECK_FAILED' }); } }), /private result/);
  const layout = resolveRuntimeLayout(options), record = readRuntimeJSON(layout.tickPath);
  assert.equal(record.phase, 'failed'); assert.equal(record.errorCode, 'CHECK_FAILED'); assert.doesNotMatch(JSON.stringify(record), /private result/);
  const previous = process.env.JS_LONGRUN_SERVICE_ID; process.env.JS_LONGRUN_SERVICE_ID = 'test-stopped';
  try { await assert.rejects(recordManagedTick({ ...options, run: () => assert.fail('must not execute') }), { code: 'LONGRUN_SERVICE_STOPPED' }); }
  finally { if (previous === undefined) delete process.env.JS_LONGRUN_SERVICE_ID; else process.env.JS_LONGRUN_SERVICE_ID = previous; }
  assert.equal(readRuntimeJSON(layout.tickOwnerPath), null);
});

test('unowned plist edits, symlink locks and runtime directories are rejected', async t => {
  const options = fixture(t), h = harness(options); await h.manager.install();
  fs.appendFileSync(h.manager.status().plistPaths.watch, '\n<!-- external -->');
  await assert.rejects(h.manager.start(), { code: 'LONGRUN_SERVICE_CONFLICT' });
  const outside = path.join(options.scratch, 'external-lock'); fs.writeFileSync(outside, 'preserved');
  fs.symlinkSync(outside, path.join(options.projectRoot, 'working/longrun/control-lock.sqlite3'));
  assert.throws(() => withLongrunLockSync(options.projectRoot, () => assert.fail()), { code: 'LONGRUN_UNSAFE_PATH' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserved');
});

test('read-only executable hard links are supported while runtime control hard links remain rejected', async t => {
  const options = fixture(t), executable = path.join(options.scratch, 'node-original'), nodePath = path.join(options.scratch, 'node-linked');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); fs.linkSync(executable, nodePath);
  const entrypoint = path.join(options.projectRoot, 'entry-linked.mjs'); fs.linkSync(options.entrypoint, entrypoint);
  const h = harness({ ...options, nodePath, entrypoint });
  assert.equal((await h.manager.install()).installed, true);
  assert.equal(readRuntimeJSON(h.manager.layout.manifestPath).nodePath, nodePath);
  fs.linkSync(h.manager.layout.manifestPath, path.join(options.scratch, 'manifest-linked.json'));
  assert.throws(() => h.manager.status(), { code: 'LONGRUN_UNSAFE_PATH' });
  const lock = path.join(options.projectRoot, 'working/longrun/control-lock.sqlite3');
  fs.writeFileSync(lock, ''); fs.linkSync(lock, path.join(options.scratch, 'lock-linked.sqlite3'));
  assert.throws(() => withLongrunLockSync(options.projectRoot, () => assert.fail()), { code: 'LONGRUN_UNSAFE_PATH' });
});

test('process exit releases watcher singleton so a new process can recover without deleting locks', async t => {
  const options = fixture(t), module = new URL('../src/service-runtime.mjs', import.meta.url).href;
  const code = `import {runManagedWatcher} from ${JSON.stringify(module)};const w=await runManagedWatcher({...${JSON.stringify(options)},start:({onReady})=>{onReady();return {ready:Promise.resolve(),close:async()=>{}}}});await w.ready;console.log('ready');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([code]) => { throw new Error(`child exited ${code}`); })]);
  await assert.rejects(runManagedWatcher({ ...options, start: () => assert.fail() }), { code: 'LONGRUN_SERVICE_BUSY' });
  child.kill('SIGKILL'); await once(child, 'exit');
  const next = await runManagedWatcher({ ...options, start: ({ onReady }) => { onReady(); return { ready: Promise.resolve(), close: async () => {} }; } });
  await next.close();
});
