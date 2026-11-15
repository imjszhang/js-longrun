#!/usr/bin/env node
// Opt-in macOS integration check: real login-session timers, synthetic tickets only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const script = fileURLToPath(import.meta.url);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, json(value));
const append = (file, event) => fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event })}\n`);

async function publicModule(packageRoot, subpath) {
  const manifest = read(path.join(packageRoot, 'package.json'));
  assert.equal(manifest.name, 'js-longrun');
  const exported = manifest.exports?.[subpath];
  assert.equal(typeof exported, 'string', `Public export ${subpath} required`);
  assert.ok(exported.startsWith('./') && !exported.includes('..'), 'Export must stay inside package');
  return import(pathToFileURL(path.join(packageRoot, exported)).href);
}

function configuration(file) {
  const value = read(file);
  assert.equal(value.kind, 'isolated-longrun-service-smoke');
  assert.equal(path.dirname(file), value.scratch);
  assert.equal(path.dirname(value.projectRoot), value.scratch);
  assert.ok(path.basename(value.scratch).startsWith('longrun-service-smoke-'));
  return value;
}

/** Called only by the generated, uniquely owned fixture entrypoint. */
export async function runSmokeEntry(file, command) {
  const cfg = configuration(file);
  assert.ok(['watch', 'tick'].includes(command));
  const { loadState, taskPaths } = await publicModule(cfg.packageRoot, './definitions');
  const { tickProject, startProjectWatcher } = await publicModule(cfg.packageRoot, './project');
  const { runManagedWatcher, recordManagedTick } = await publicModule(cfg.packageRoot, './service-runtime');
  const event = value => append(cfg.events, { component: command, ...value });
  function draft() { return read(path.join(taskPaths(cfg.projectRoot, cfg.id).runs, 'R0001/draft.json')); }
  function ticketStatus() {
    if (!fs.existsSync(cfg.ticket)) return 'missing';
    return Date.now() >= read(cfg.ticket).completeAfter ? 'completed' : 'queued';
  }
  const client = {
    async submit() {
      assert.equal(command, 'tick', 'Only the actual timer may open the fixture round');
      assert.equal(fs.existsSync(cfg.ticket), false, 'Duplicate submission');
      const frozen = draft(), ticketId = 'synthetic-timer-ticket', at = Date.now();
      const base = path.join(cfg.workspace, frozen.layout.runBase);
      fs.mkdirSync(base, { recursive: true });
      write(path.join(base, 'result.json'), { schemaVersion: 1, summary: 'Synthetic timer fallback',
        report: '# Synthetic timer fallback\nNo live input, model, account or message was used.', evidence: [], changed: false });
      fs.writeFileSync(path.join(base, 'memory.md'), '# Memory\nSynthetic timer acceptance only.\n');
      fs.writeFileSync(cfg.ticket, json({ ticketId, submittedAt: new Date(at).toISOString(), completeAfter: at + 3500 }), { flag: 'wx' });
      event({ kind: 'submit', ticketId, completeAfter: new Date(at + 3500).toISOString() });
      return ticketId;
    },
    async snapshot() {
      const status = ticketStatus(); event({ kind: 'snapshot', status });
      return { status, workspacePath: cfg.workspace, answers: [], attentionSnapshots: [] };
    },
    async observe() { const status = ticketStatus(); event({ kind: 'observe', status }); return { status }; },
    async changes() { return draft().plan.allowedPaths.map(relative => ({ path: relative })); },
    async jobs() { return []; },
    async cancel() { throw new Error('Fixture must not time out'); },
    watchChanges() { event({ kind: 'sdk-invalidation-suppressed' }); return () => {}; },
  };
  if (command === 'tick') {
    const result = await recordManagedTick({ projectRoot: cfg.projectRoot, runtimeHome: cfg.runtimeHome,
      run: () => tickProject({ root: cfg.projectRoot, client, open: process.env.LONGRUN_OPEN_ROUNDS === '1' }) });
    event({ kind: 'tick-result', results: result.map(row => ({ action: row.action, status: row.record?.status, runId: row.runId ?? row.record?.runId, reasons: row.reasons, error: row.error })) });
    if (result.some(row => row.error)) process.exitCode = 1;
    return;
  }
  let watcher, stopping;
  const stop = () => {
    if (!stopping) stopping = (async () => { await watcher?.close(); event({ kind: 'watch-stopped' }); })().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  watcher = await runManagedWatcher({ projectRoot: cfg.projectRoot, runtimeHome: cfg.runtimeHome,
    start: ({ onReady, onActivity, onError }) => startProjectWatcher({ root: cfg.projectRoot, client, onReady, onActivity, onError,
      onResult: result => event({ kind: 'watch-result', action: result.action, status: result.record?.status }) }) });
  await watcher.ready;
  event({ kind: 'watch-ready', active: fs.existsSync(taskPaths(cfg.projectRoot, cfg.id).state) ? loadState(cfg.projectRoot, cfg.id).running : null });
}

async function until(readCondition, message, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = readCondition(); if (value) return value; await delay(200); }
  throw new Error(`Timed out: ${message}`);
}

export async function runServiceSmoke(packageDirectory) {
  if (process.platform !== 'darwin') throw new Error('This opt-in smoke requires a macOS login session');
  assert.ok(path.isAbsolute(packageDirectory), 'Use an absolute installed package directory');
  const packageRoot = fs.realpathSync(packageDirectory);
  const { createLongrunServiceManager } = await publicModule(packageRoot, './service');
  const { createTask, defaultDefinition, enableTask, loadState, taskPaths } = await publicModule(packageRoot, './definitions');
  const { verifyGeneric } = await publicModule(packageRoot, './runtime');
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-service-smoke-')));
  const cfg = { kind: 'isolated-longrun-service-smoke', scratch, packageRoot, projectRoot: path.join(scratch, 'project'),
    runtimeHome: path.join(scratch, 'machine'), workspace: path.join(scratch, 'worker'), id: 'timer-report',
    ticket: path.join(scratch, 'ticket.json'), events: path.join(scratch, 'events.jsonl') };
  fs.mkdirSync(cfg.projectRoot); fs.mkdirSync(cfg.workspace); fs.writeFileSync(cfg.events, '');
  write(path.join(cfg.projectRoot, 'longrun.config.json'), { schemaVersion: 1, tasksDir: 'automation/tasks' });
  const configFile = path.join(scratch, 'fixture.json'), entrypoint = path.join(cfg.projectRoot, 'fixture-entry.mjs');
  write(configFile, cfg);
  fs.writeFileSync(entrypoint, `import {runSmokeEntry} from ${JSON.stringify(pathToFileURL(script).href)};\nawait runSmokeEntry(${JSON.stringify(configFile)},process.argv[2]);\n`);
  const manager = createLongrunServiceManager({ projectRoot: cfg.projectRoot, runtimeHome: cfg.runtimeHome,
    launchAgentsDir: path.join(scratch, 'LaunchAgents'), entrypoint, entryArgs: [], intervalSeconds: 2, openRounds: true, timeoutMs: 20_000 });
  const events = () => fs.readFileSync(cfg.events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  let installed = false, cleaned = false, result;
  try {
    await manager.install(); installed = true;
    const started = await manager.start();
    assert.equal(started.watch.observation.phase, 'ready');
    assert.equal(fs.existsSync(cfg.ticket), false);
    const definition = defaultDefinition(cfg.id); definition.limits.weeklyRuns = 1;
    await createTask({ root: cfg.projectRoot, id: cfg.id, definition, brief: 'Synthetic timer-only acceptance; no live input or model.' });
    await enableTask({ root: cfg.projectRoot, id: cfg.id, reason: 'Explicit isolated service acceptance only' });
    const opening = await until(() => events().find(event => event.kind === 'tick-result' && event.results.some(row => row.action === 'opened')), 'actual periodic opening');
    const collected = await until(() => events().find(event => event.kind === 'tick-result' && event.results.some(row => row.action === 'collected' && row.status === 'settled')), 'actual periodic fallback settlement');
    const paths = taskPaths(cfg.projectRoot, cfg.id), receipt = read(path.join(paths.runs, 'R0001/settlement.json'));
    assert.equal(receipt.status, 'applied');
    const frozen = read(path.join(paths.runs, 'R0001/draft.json'));
    assert.equal(frozen.layout.tasksDir, 'automation/tasks');
    const baseline = loadState(cfg.projectRoot, cfg.id);
    const duplicate = await until(() => events().find(event => event.kind === 'tick-result' && event.at > collected.at && event.results.some(row => row.action === 'hold')), 'later timer duplicate/budget gate');
    assert.deepEqual(loadState(cfg.projectRoot, cfg.id), baseline);
    assert.equal(baseline.round, 1); assert.equal(baseline.week.runs, 1); assert.equal(baseline.running, null);
    const observed = events();
    assert.equal(observed.filter(event => event.kind === 'submit').length, 1);
    assert.ok(observed.some(event => event.kind === 'observe' && event.status === 'queued'));
    assert.ok(!observed.some(event => event.kind === 'watch-result' && event.action === 'collected'), 'Watcher must not receive credit for fallback settlement');
    assert.equal(verifyGeneric({ root: cfg.projectRoot, id: cfg.id }).ok, true);
    const health = await manager.health({ dependency: false }); assert.equal(health.healthy, true);
    const report = path.join(paths.artifacts, 'reports/R0001.md');
    result = { schemaVersion: 1, ok: true, at: new Date().toISOString(), packageVersion: read(path.join(packageRoot, 'package.json')).version,
      mode: 'real-launchd-timer-synthetic-ticket', intervalSeconds: 2, tasksDir: 'automation/tasks',
      watcherReadyAt: observed.find(event => event.kind === 'watch-ready')?.at,
      openedAt: opening.at, syntheticCompletedAt: observed.find(event => event.kind === 'submit').completeAfter,
      timerSettledAt: collected.at, duplicateCheckAt: duplicate.at, tickObservation: health.tick.observation,
      round: baseline.round, weeklyRuns: baseline.week.runs, submissions: 1, watcherSettlements: 0,
      receiptStatus: receipt.status, reportSha256: createHash('sha256').update(fs.readFileSync(report)).digest('hex'),
      labels: started.labels, verification: 'No model, real SDK, messages, production project or manual collect/tick; SDK invalidations suppressed.' };
  } catch (error) {
    error.message += `; isolated fixture retained at ${scratch}`;
    try { error.diagnostics = { status: manager.status(), watch: manager.logs({ component: 'watch', stream: 'stderr' }).text, tick: manager.logs({ component: 'tick', stream: 'stderr' }).text }; } catch {}
    throw error;
  } finally {
    if (installed) {
      try {
        const stopped = await manager.stop();
        assert.equal(stopped.watch.loaded, false); assert.equal(stopped.tick.loaded, false);
        assert.ok(!['alive', 'unknown'].includes(stopped.watch.process)); assert.ok(!['alive', 'unknown'].includes(stopped.tick.process));
        const uninstalled = await manager.uninstall(); assert.equal(uninstalled.installed, false);
        cleaned = true;
      } catch (error) { console.error(`Fixture service cleanup pending at ${scratch}: ${error.code ?? error.message}`); if (result) throw error; }
    }
    if (result && cleaned) { result.servicesRemoved = true; fs.rmSync(scratch, { recursive: true }); result.fixtureRemoved = true; }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 3 || args[0] !== '--run' || args[1] !== '--package') throw new Error('Usage: node scripts/service-smoke.mjs --run --package /absolute/installed/js-longrun (creates and removes isolated macOS services)');
    console.log(json(await runServiceSmoke(args[2])));
  } catch (error) { console.error(error.message); if (error.diagnostics) console.error(json(error.diagnostics)); process.exitCode = 1; }
}
