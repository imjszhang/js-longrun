import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTask, defaultDefinition, enableTask, pauseTask, resumeTask, disableTask, loadState, taskPaths } from '../src/core/definitions.mjs';
import { startRun, collectTask, tickTask } from '../src/core/runtime.mjs';
import { makeTaskFact, makeRunFact, readTaskFacts, syncTaskFacts, syncProjectFacts } from '../src/context.mjs';

const now = new Date('2026-04-01T00:00:00.000Z');
const json = value => JSON.stringify(value, null, 2) + '\n';
function directory(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-context-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function host() {
  const facts = new Map(), published = []; let writes = 0, fail = false;
  return { facts, published, writes: () => writes, fail: value => { fail = value; },
    hostFactsCapabilities: async () => ({ version: 1 }),
    listHostFacts: async filters => [...facts.values()].filter(row => Object.entries(filters).every(([key, value]) => row[key] === value)),
    identity: async () => ({ domainId: 'generation-one', initialDomainId: 'generation-one', assignmentId: 'assignment-one', initialAssignmentId: 'assignment-one',
      hostReferenceDomainId: 'generation-one', hostReferenceAssignmentId: 'assignment-one', hostReference: { producer: 'js-longrun', taskId: 'report', runId: 'R0001', kind: 'round' } }),
    publishHostFacts: async record => {
      if (fail) throw new Error('fixture host unavailable');
      published.push(record);
      const key = `${record.scope}:${record.key}:${record.domainId ?? ''}:${record.assignmentId ?? ''}`, previous = facts.get(key);
      if (previous?.sourceVersion === record.sourceVersion) return { status: 'unchanged' };
      if (previous && record.observedAt < previous.observedAt) return { status: 'stale' };
      if (previous && record.observedAt === previous.observedAt) throw new Error('same-time conflict');
      facts.set(key, structuredClone(record)); writes++; return { status: 'stored' };
    },
  };
}
async function fixture(t) {
  const root = directory(t), workspace = directory(t);
  fs.writeFileSync(path.join(root, 'longrun.config.json'), json({ schemaVersion: 1, tasksDir: 'records/tasks' }));
  fs.writeFileSync(path.join(root, 'source.md'), 'An original fact.');
  const definition = defaultDefinition('report'); definition.inputs = ['source.md'];
  await createTask({ root, id: 'report', brief: 'Report changes', definition, now });
  await enableTask({ root, id: 'report', reason: 'Fictional test authorization', now });
  let submissions = 0, snapshots = 0, status = 'completed', submitOptions;
  const stops = [], client = { ...host(),
    submit: async (_text, options) => { submissions++; submitOptions = options; return 'ticket-one'; },
    snapshot: async () => { snapshots++; return { status, domainId: 'generation-one', assignmentId: 'assignment-one', workspacePath: workspace, answers: [], attentionSnapshots: [] }; },
    changes: async () => ['result.json', 'memory.md'].map(name => ({ path: `records/tasks/report/runs/R0001/${name}` })),
    jobs: async () => [], cancel: async (id, options) => { stops.push({ id, options }); status = 'cancelled'; },
  };
  const writeResult = () => {
    const base = path.join(workspace, 'records/tasks/report/runs/R0001'); fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'result.json'), json({ schemaVersion: 1, summary: 'One change', report: '# Report\nAn original fact.', evidence: [{ path: 'source.md', quote: 'An original fact.' }], changed: true }));
    fs.writeFileSync(path.join(base, 'memory.md'), '# Memory\nAn original fact.');
  };
  return { root, client, writeResult, stops, status: value => { status = value; }, submissions: () => submissions,
    snapshots: () => snapshots, submitOptions: () => submitOptions,
    start: () => startRun({ root, id: 'report', client, now }),
    collect: (at = now) => collectTask({ root, id: 'report', client, now: at }) };
}

test('pure task projections cover offline controls, unavailable state and configured layout', async t => {
  const f = await fixture(t), paths = taskPaths(f.root, 'report');
  assert.equal(readTaskFacts({ root: f.root, id: 'report' })[0].facts.control, 'enabled');
  await pauseTask({ root: f.root, id: 'report', now });
  assert.equal(readTaskFacts({ root: f.root, id: 'report' })[0].facts.control, 'paused');
  await resumeTask({ root: f.root, id: 'report', now });
  await disableTask({ root: f.root, id: 'report', now });
  const before = fs.readFileSync(paths.state, 'utf8');
  const projection = readTaskFacts({ root: f.root, id: 'report' });
  assert.equal(projection[0].facts.control, 'disabled');
  assert.equal(fs.readFileSync(paths.state, 'utf8'), before);
  assert.deepEqual(readTaskFacts({ root: f.root, id: 'report' }), projection, 'reads neither write nor invent an observation time');
  assert.equal(f.submissions(), 0);
  fs.writeFileSync(paths.state, '{corrupt');
  assert.equal(readTaskFacts({ root: f.root, id: 'report' })[0].facts.availability, 'unavailable');
});

test('active task is visible before any outcome and stopped ticket is not business settlement', async t => {
  const f = await fixture(t); f.status('cancelled');
  await f.start();
  assert.deepEqual(f.submitOptions().hostReference, { producer: 'js-longrun', taskId: 'report', runId: 'R0001', kind: 'round' });
  const active = readTaskFacts({ root: f.root, id: 'report' });
  assert.equal(active.length, 1); assert.equal(active[0].facts.running.ticketId, 'ticket-one');
  assert.equal(active[0].facts.running.runId, 'R0001');
  const collected = await f.collect();
  assert.equal(collected.record.status, 'cancelled');
  const outcome = [...f.client.facts.values()].find(row => row.scope === 'ticket');
  assert.equal(outcome.facts.result.settlement, 'not-applied'); assert.equal(outcome.domainId, 'generation-one');
});

test('frozen settlement projects after definition failure; sync failure does not resubmit or recollect', async t => {
  const f = await fixture(t); f.client.fail(true);
  const started = await f.start();
  assert.equal(started.action, 'opened'); assert.equal(started.contextSync.status, 'pending');
  assert.equal(loadState(f.root, 'report').running.phase, 'queued');
  f.writeResult(); fs.writeFileSync(taskPaths(f.root, 'report').definition, '{new invalid revision');
  const collected = await f.collect();
  assert.equal(collected.record.status, 'settled'); assert.equal(collected.contextSync.status, 'pending');
  assert.equal(loadState(f.root, 'report').running, null);
  f.client.fail(false);
  const recovered = await f.collect();
  assert.equal(recovered.action, 'none'); assert.equal(recovered.contextSync.status, 'synced');
  assert.equal(f.submissions(), 1); assert.equal(f.snapshots(), 1);
  const rows = readTaskFacts({ root: f.root, id: 'report' });
  assert.equal(rows[0].facts.availability, 'unavailable');
  assert.equal(rows[0].facts.nextDueAt, '2026-04-04T00:00:00.000Z');
  assert.equal(rows[1].facts.status, 'settled'); assert.equal(rows[1].facts.result.settlement, 'applied');
  assert.equal(rows[1].assignmentId, 'assignment-one', 'new outcome freezes the actual settled assignment');
  f.client.identity = async () => { throw new Error('retry identity must not rebind the saved outcome'); };
  const before = f.client.writes();
  assert.equal((await syncTaskFacts({ root: f.root, id: 'report', client: f.client })).status, 'synced');
  assert.equal(f.client.writes(), before, 'restart reconciliation writes no semantically identical facts');
  fs.writeFileSync(path.join(taskPaths(f.root, 'report').runs, 'R0001/settlement.json'), json({ status: 'applying' }));
  assert.equal(readTaskFacts({ root: f.root, id: 'report' }).length, 1, 'never assert settlement without applied receipt');
});

test('repairing a historical receipt replaces unavailable context without touching task state', async t => {
  const f = await fixture(t); await f.start(); f.writeResult(); await f.collect();
  const paths = taskPaths(f.root, 'report'), receiptPath = path.join(paths.runs, 'R0001/settlement.json');
  const stateBefore = fs.readFileSync(paths.state, 'utf8'), stateMtime = fs.statSync(paths.state).mtimeMs;
  const receiptBefore = fs.readFileSync(receiptPath, 'utf8');
  const changedAt = new Date(Date.now() + 10000), repairedAt = new Date(+changedAt + 1000);
  fs.writeFileSync(receiptPath, '{damaged receipt'); fs.utimesSync(receiptPath, changedAt, changedAt);
  assert.equal((await syncTaskFacts({ root: f.root, id: 'report', client: f.client })).status, 'synced');
  const overview = () => [...f.client.facts.values()].find(row => row.key === 'task:report');
  const unavailableAt = overview().observedAt;
  assert.equal(overview().facts.availability, 'unavailable');
  fs.writeFileSync(receiptPath, receiptBefore); fs.utimesSync(receiptPath, repairedAt, repairedAt);
  assert.equal((await syncTaskFacts({ root: f.root, id: 'report', client: f.client })).status, 'synced');
  assert.equal(overview().facts.availability, 'available');
  assert.ok(overview().observedAt > unavailableAt, 'repair must advance the same source observation timeline');
  assert.equal(fs.readFileSync(paths.state, 'utf8'), stateBefore);
  assert.equal(fs.statSync(paths.state).mtimeMs, stateMtime);
  const writes = f.client.writes();
  await syncTaskFacts({ root: f.root, id: 'report', client: f.client });
  assert.equal(f.client.writes(), writes, 'repaired history remains idempotent');
});

test('known and original generations bind outcomes without reassigning history to retries', async () => {
  const client = host(), record = { status: 'expired', finishedAt: now.toISOString() };
  const row = makeRunFact({ taskId: 'report', runId: 'R0001', ticketId: 'ticket-one', record });
  const sync = () => syncTaskFacts({ id: 'report', client, readFacts: () => [row] });
  client.identity = async () => ({ domainId: 'retried-generation', hostReference: null });
  assert.equal((await sync()).unresolved, 1); assert.equal(client.published.length, 0);
  client.identity = async () => ({ domainId: 'retried-generation', initialDomainId: 'original-generation', assignmentId: 'retried-assignment', initialAssignmentId: 'original-assignment', hostReference: null });
  assert.equal((await sync()).status, 'synced');
  assert.equal(client.published[0].domainId, 'original-generation');
  assert.equal(client.published[0].assignmentId, 'original-assignment');
  client.identity = async () => ({ domainId: 'original-generation', assignmentId: 'continued-assignment',
    hostReferenceDomainId: 'original-generation', hostReferenceAssignmentId: 'original-assignment',
    hostReference: { producer: 'js-longrun', taskId: 'report', runId: 'R0001', kind: 'round' } });
  assert.equal((await sync()).status, 'synced');
  assert.equal(client.published.at(-1).assignmentId, 'original-assignment', 'reference match is not proof of the current epoch');
  client.identity = async () => ({ domainId: 'wrong-generation', initialDomainId: 'original-generation', hostReference: { producer: 'another-producer' } });
  assert.equal((await sync()).unresolved, 1);
  row.domainId = 'known-generation'; row.assignmentId = 'known-assignment';
  assert.equal((await sync()).status, 'synced');
  assert.equal(client.published.at(-1).domainId, 'known-generation');
});

test('empty inventory is explicit, errors are unavailable, and old peers keep normal business behavior', async t => {
  const root = directory(t), client = host();
  assert.equal((await syncProjectFacts({ root, client })).status, 'synced');
  const inventory = client.published.at(-1).facts;
  assert.equal(inventory.complete, true); assert.deepEqual(inventory.taskIds, []);
  const failed = await syncProjectFacts({ root, client, routes: { list: () => { throw new Error('bad registry'); } } });
  assert.equal(failed.status, 'pending'); assert.equal(client.published.at(-1).facts.availability, 'unavailable');
  assert.equal(client.published.at(-1).facts.complete, false);
  const unavailableAt = client.published.at(-1).observedAt;
  assert.equal((await syncProjectFacts({ root, client })).status, 'synced', 'transient list failure recovers without changing source files');
  assert.ok(client.published.at(-1).observedAt > unavailableAt);
  assert.equal(client.published.at(-1).facts.availability, 'available');
  const before = client.writes();
  assert.equal((await syncProjectFacts({ root, client })).status, 'synced');
  assert.equal(client.writes(), before, 'inventory observations are not heartbeat writes');
  const f = await fixture(t); delete f.client.hostFactsCapabilities;
  assert.equal((await f.start()).contextSync.status, 'unavailable');
  f.writeResult(); assert.equal((await f.collect()).record.status, 'settled');
  assert.equal((await tickTask({ root: f.root, id: 'report', client: f.client })).action, 'hold');
});

test('queue timeout provenance identifies cause and observed domain, without changing business outcome', async t => {
  const f = await fixture(t); await f.start(); f.status('queued');
  const result = await f.collect(new Date(+now + 8 * 86400000));
  assert.equal(result.record.status, 'failed');
  assert.deepEqual(f.stops, [{ id: 'ticket-one', options: { source: 'js-longrun', reason: 'queue_timeout',
    expectedDomainId: 'generation-one', expectedAssignmentId: 'assignment-one', reference: { taskId: 'report', runId: 'R0001' } } }]);
});

test('task builder is generic and does not copy business text or source paths', () => {
  const row = makeTaskFact({ taskId: 'legacy-task', type: 'host-owned', state: { updatedAt: now.toISOString(), round: 9,
    cooldownUntil: '2026-04-05T00:00:00.000Z', running: { round: 9, ticketId: 'ticket-nine', lastStatus: 'running' }, brief: 'never disclose raw material' } });
  assert.equal(row.facts.running.runId, 'R0009');
  assert.doesNotMatch(JSON.stringify(row), /never disclose/);
  assert.equal(row.observedAt, now.toISOString());
});
