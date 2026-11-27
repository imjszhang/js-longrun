import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tickProject, startProjectWatcher } from '../src/project.mjs';
const HOST_TASK_ID = 'host-review-task';

async function until(predicate, detail = 'project watcher did not reconcile') {
  // Other integration files launch worker processes in parallel; allow scheduler latency.
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) assert.fail(detail); await delay(5); }
}
function fixture(t, initial = []) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-project-')));
  fs.mkdirSync(path.join(root, 'research/longrun'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let rows = initial, sdkWake, subscriptions = 0, unsubscribed = 0;
  const states = new Map(), tickets = new Map(), events = new Map(), calls = [], errors = [], results = [];
  const add = (id, state, status = 'waiting', extra = {}) => {
    fs.mkdirSync(path.join(root, 'research/longrun', id), { recursive: true });
    rows.push({ id, control: state.control, ...extra }); states.set(id, state);
    if (state.running?.ticketId) tickets.set(state.running.ticketId, { status, attentionId: `${id}-attention` });
  };
  const client = { observe: async id => tickets.get(id), watchChanges: wake => { subscriptions++; sdkWake = wake; return () => { unsubscribed++; }; } };
  const routes = {
    list: () => rows,
    load: (_root, row) => { const state = states.get(row.id); if (!state) throw new Error('invalid state'); return state; },
    collect: async ({ row }) => { calls.push(row.id); return { action: 'pending' }; },
    preserveInitial: ({ row, state, view }) => row.id === HOST_TASK_ID && !!state.review
      && state.running.lastStatus === 'waiting' && view.status === 'waiting'
      && state.review.attentionId === view.attentionId,
  };
  const start = overrides => {
    const watcher = startProjectWatcher({ root, client, routes, debounceMs: 1, retryMs: 15,
      watchDirectory: (directory, event) => { events.set(directory, event); return () => events.delete(directory); },
      onError: (error, taskId) => errors.push({ error, taskId }), onResult: result => results.push(result), ...overrides });
    t.after(() => watcher.close()); return watcher;
  };
  return { root, add, states, tickets, calls, errors, results, events, routes, client, start,
    sdkEvent: () => sdkWake(), subscriptions: () => subscriptions, unsubscribed: () => unsubscribed,
    registryEvent: () => events.get(path.join(root, 'research/longrun'))('registry.json') };
}

test('project tick collects active instances before opening due tasks and isolates bad definitions', async t => {
  const f = fixture(t), seen = [];
  f.add('due', { control: 'enabled', running: null, nextDueAt: '2026-01-01' });
  f.add('waiting', { control: 'paused', running: { ticketId: 'ticket' } });
  f.add('broken', { control: 'invalid', running: null }, 'waiting', { error: 'bad definition' });
  f.add('draft', { control: 'draft', running: null });
  f.routes.tick = async ({ row, open }) => { seen.push([row.id, open]); return { action: open ? 'opened' : 'hold' }; };
  const result = await tickProject({ root: f.root, client: f.client, open: true, routes: f.routes });
  assert.equal(seen[0][0], 'waiting');
  assert.deepEqual(seen.find(x => x[0] === 'due'), ['due', true]);
  assert.deepEqual(seen.find(x => x[0] === 'draft'), ['draft', false]);
  assert.equal(result.find(x => x.taskId === 'broken').action, 'error');
});

test('project tick still collects bound frozen run after current definition became invalid', async t => {
  const f = fixture(t);
  f.add('changed', { control: 'enabled', running: { ticketId: 'old-ticket' } }, 'completed', { error: 'source removed' });
  f.routes.tick = async ({ row, open }) => { assert.equal(open, false); return { action: 'collected' }; };
  const [result] = await tickProject({ root: f.root, client: f.client, routes: f.routes, open: true });
  assert.equal(result.action, 'collected'); assert.equal(result.definitionError, 'source removed');
});

test('trusted host routes can gate a custom task without generic control fields', async t => {
  const f = fixture(t), seen = [];
  f.add(HOST_TASK_ID, { paused: false, running: null });
  f.routes.canOpen = ({ row, state }) => row.id === HOST_TASK_ID && !state.paused;
  f.routes.tick = async ({ open }) => { seen.push(open); return { action: open ? 'opened' : 'hold' }; };
  await tickProject({ root: f.root, client: f.client, routes: f.routes, open: true });
  f.states.get(HOST_TASK_ID).paused = true;
  await tickProject({ root: f.root, client: f.client, routes: f.routes, open: true });
  assert.deepEqual(seen, [true, false]);
});

test('watching an empty consumer creates a registry directory without submitting work', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-empty-')));
  let subscriptions = 0, stopped = 0;
  const errors = [];
  const watcher = startProjectWatcher({ root, client: {
    watchChanges: () => { subscriptions++; return () => { stopped++; }; },
    observe: () => assert.fail('empty project has no active tickets'),
  }, onError: error => errors.push(error) });
  t.after(async () => { await watcher.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await watcher.ready;
  await delay(150);
  assert.equal(fs.statSync(path.join(root, 'research/longrun')).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(path.join(root, 'research/longrun')), []);
  assert.deepEqual(errors, []);
  assert.equal(subscriptions, 1);
  await watcher.close(); assert.equal(stopped, 1);
});

test('project watcher subscribes once, preserves initialized host review, and collects another instance', async t => {
  const f = fixture(t);
  const legacy = { running: { ticketId: 'legacy', lastStatus: 'waiting' }, review: { attentionId: `${HOST_TASK_ID}-attention` } };
  const before = JSON.stringify(legacy);
  f.add(HOST_TASK_ID, legacy);
  f.add('report', { control: 'enabled', running: { ticketId: 'report-ticket', runId: 'R0001' } }, 'completed');
  const watcher = f.start(); await watcher.ready;
  assert.equal(f.subscriptions(), 1); assert.deepEqual(f.calls, ['report']);
  assert.equal(JSON.stringify(legacy), before);
  f.tickets.set('legacy', { status: 'completed', attentionId: `${HOST_TASK_ID}-attention` }); f.sdkEvent();
  await until(() => f.calls.includes(HOST_TASK_ID));
  for (let n = 0; n < 10; n++) f.sdkEvent();
  await delay(30); assert.equal(f.calls.filter(x => x === HOST_TASK_ID).length, 1);
  await watcher.close(); await watcher.close(); assert.equal(f.unsubscribed(), 1);
});

test('registry updates discover new tasks without restarting watcher', async t => {
  const f = fixture(t), watcher = f.start(); await watcher.ready;
  f.add('new-report', { control: 'enabled', running: { ticketId: 'new-ticket', runId: 'R0001' } }, 'completed');
  f.registryEvent(); await until(() => f.calls.includes('new-report'));
  assert.equal(f.subscriptions(), 1);
  assert.equal(f.events.has(path.join(f.root, 'research/longrun/new-report')), true);
});

test('one collector error retries independently and does not block another result', async t => {
  const f = fixture(t); let attempts = 0;
  f.add('bad', { running: { ticketId: 'bad-ticket' } }, 'completed');
  f.add('good', { running: { ticketId: 'good-ticket' } }, 'completed');
  f.routes.collect = async ({ row }) => {
    if (row.id === 'bad' && ++attempts === 1) throw new Error('temporary failure');
    f.calls.push(row.id); return { action: 'collected' };
  };
  const watcher = f.start(); await watcher.ready;
  assert.ok(f.calls.includes('good')); assert.ok(f.errors.length);
  await until(() => f.calls.includes('bad'));
  assert.equal(f.calls.filter(x => x === 'good').length, 1);
});

test('active invalid definition is collected and failed status waits for recovery', async t => {
  const f = fixture(t);
  f.add('report', { running: { ticketId: 'ticket' } }, 'failed', { error: 'invalid current definition' });
  const watcher = f.start(); await watcher.ready; assert.deepEqual(f.calls, []);
  f.tickets.set('ticket', { status: 'completed' }); f.sdkEvent();
  await until(() => f.calls.length === 1); assert.deepEqual(f.calls, ['report']);
});

test('host rendering failure retries after settlement without repeated collection', async t => {
  const f = fixture(t); let renders = 0;
  f.add(HOST_TASK_ID, { running: { ticketId: 'legacy' } }, 'completed');
  f.routes.collect = async ({ row }) => { f.calls.push(row.id); f.states.set(row.id, { running: null }); return { action: 'collected' }; };
  f.routes.afterCollect = async ({ row, result }) => { assert.equal(row.id, HOST_TASK_ID); assert.equal(result.action, 'collected'); if (++renders === 1) throw new Error('render failure'); };
  const watcher = f.start();
  await watcher.ready; await until(() => renders >= 2);
  assert.equal(f.calls.length, 1);
});

test('startup repair failure retries without blocking settlement or repeating collection', async t => {
  const f = fixture(t); let startupCalls = 0, followups = 0;
  f.add('report', { running: { ticketId: 'ticket', runId: 'R0001' } }, 'completed');
  f.routes.onStart = async ({ root }) => {
    assert.equal(root, f.root);
    if (++startupCalls === 1) throw new Error('startup render failed');
  };
  f.routes.collect = async ({ row }) => {
    f.calls.push(row.id); f.states.set(row.id, { running: null });
    return { action: 'collected' };
  };
  f.routes.afterCollect = async () => { followups++; };
  const watcher = f.start(); await watcher.ready;
  assert.deepEqual(f.calls, ['report'], 'failed startup repair does not stop collection');
  assert.equal(followups, 1, 'settlement follow-up is independent of startup repair');
  assert.equal(f.errors[0].error.message, 'startup render failed');
  await until(() => startupCalls === 2);
  for (let n = 0; n < 10; n++) f.sdkEvent();
  await delay(150);
  assert.equal(startupCalls, 2, 'successful startup repair does not repeat on invalidations');
  assert.equal(f.calls.length, 1);
  assert.equal(followups, 1);
});

test('successful startup repair runs once per watcher and settlement follow-up retries separately', async t => {
  const f = fixture(t); let startupCalls = 0, followups = 0;
  f.add('report', { running: { ticketId: 'ticket', runId: 'R0001' } }, 'completed');
  f.routes.onStart = async () => { startupCalls++; };
  f.routes.collect = async ({ row }) => {
    f.calls.push(row.id); f.states.set(row.id, { running: null });
    return { action: 'collected' };
  };
  f.routes.afterCollect = async () => { if (++followups === 1) throw new Error('follow-up failed'); };
  const first = f.start(); await first.ready;
  await until(() => followups === 2);
  assert.equal(startupCalls, 1);
  assert.equal(f.calls.length, 1);
  await first.close();
  const second = f.start(); await second.ready;
  assert.equal(startupCalls, 2, 'a new process repairs projections even with no active run');
  assert.equal(f.calls.length, 1);
  assert.equal(followups, 2);
});

test('real task-state file change wakes a dormant registered task', async t => {
  const f = fixture(t);
  f.add('local-report', { control: 'enabled', running: null });
  const watcher = startProjectWatcher({ root: f.root, client: f.client, routes: f.routes, debounceMs: 1,
    onError: error => f.errors.push(error), retryMs: 15 });
  t.after(() => watcher.close()); await watcher.ready;
  f.states.set('local-report', { control: 'enabled', running: { ticketId: 'file-ticket', runId: 'R0001' } });
  f.tickets.set('file-ticket', { status: 'completed' });
  fs.writeFileSync(path.join(f.root, 'research/longrun/local-report/state.json'), '{}');
  await until(() => f.calls.includes('local-report'));
  // A later write must still be delivered after the registration-only catch-up.
  await delay(200);
  f.states.set('local-report', { control: 'enabled', running: { ticketId: 'later-ticket', runId: 'R0002' } });
  f.tickets.set('later-ticket', { status: 'completed' });
  fs.writeFileSync(path.join(f.root, 'research/longrun/local-report/state.json'), '{"changed":true}');
  await until(() => f.calls.length === 2, 'later native event was lost after registration catch-up');
  assert.deepEqual(f.errors, []);
});

test('a trailing state event during collection is not lost', async t => {
  const f = fixture(t); let release;
  f.add('report', { running: { ticketId: 'ticket', runId: 'R0001' } });
  f.routes.collect = async ({ row }) => {
    f.calls.push(f.tickets.get('ticket').status);
    if (f.calls.length === 1) await new Promise(resolve => { release = resolve; });
    return { action: 'pending' };
  };
  const watcher = f.start(); await until(() => release);
  f.tickets.set('ticket', { status: 'completed' }); f.sdkEvent(); release();
  await watcher.ready; await until(() => f.calls.length === 2);
  assert.deepEqual(f.calls, ['waiting', 'completed']);
});


test('one registration catch-up closes native arming gap without periodic polling', async t => {
  const f = fixture(t); let reads = 0;
  f.add('report', { control: 'enabled', running: null });
  const load = f.routes.load;
  f.routes.load = (...args) => { reads++; return load(...args); };
  // Injected directory watch deliberately drops every event, as during native arming.
  const watcher = f.start(); await watcher.ready;
  f.states.set('report', { running: { ticketId: 'during-arm', runId: 'R0001' } });
  f.tickets.set('during-arm', { status: 'completed' });
  await until(() => f.calls.length === 1);
  const afterCatchup = reads;
  await delay(250);
  assert.equal(reads, afterCatchup, 'registration catch-up must not become a polling loop');
});

test('idle task context sync retries through existing watcher and restarts without collecting again', async t => {
  const f = fixture(t), facts = new Map(); let fail = true, writes = 0;
  f.add('finished', { control: 'enabled', running: { ticketId: 'ticket', runId: 'R0001' }, updatedAt: '2026-04-01T00:00:00.000Z' }, 'completed');
  f.client.hostFactsCapabilities = () => ({ version: 1 });
  f.client.publishHostFacts = row => {
    if (fail) throw new Error('temporary context service failure');
    if (facts.get(row.key)?.sourceVersion === row.sourceVersion) return { status: 'unchanged' };
    facts.set(row.key, row); writes++; return { status: 'stored' };
  };
  f.routes.collect = async ({ row }) => {
    f.calls.push(row.id); f.states.get(row.id).running = null;
    return { action: 'collected', record: { runId: 'R0001', status: 'settled' } };
  };
  f.routes.facts = ({ row }) => [{ scope: 'project', producer: 'js-longrun', key: `task:${row.id}`,
    sourceVersion: JSON.stringify(f.states.get(row.id)), observedAt: '2026-04-01T00:00:00.000Z', facts: { state: f.states.get(row.id) } }];
  const watcher = f.start(); await watcher.ready;
  assert.deepEqual(f.calls, ['finished']);
  assert.ok(f.errors.some(({ error }) => error.code === 'HOST_CONTEXT_SYNC_PENDING'));
  fail = false;
  await until(() => facts.has('task:finished'));
  assert.deepEqual(f.calls, ['finished']);
  assert.equal(facts.get('task:finished').facts.state.running, null);
  await watcher.close();
  const before = writes, restarted = f.start(); await restarted.ready;
  assert.equal(writes, before); assert.deepEqual(f.calls, ['finished']);
  await restarted.close();
});

test('project tick synchronizes dormant and invalid task facts without opening work', async t => {
  const f = fixture(t), seen = [];
  f.add('dormant', { control: 'paused', running: null });
  f.add('invalid', { control: 'invalid', running: null }, 'waiting', { error: 'invalid task' });
  f.client.hostFactsCapabilities = () => ({ version: 1 });
  f.client.publishHostFacts = row => { seen.push(row); return { status: 'stored' }; };
  f.routes.tick = async () => ({ action: 'hold' });
  f.routes.facts = ({ row }) => [{ scope: 'project', producer: 'js-longrun', key: `task:${row.id}`,
    sourceVersion: row.id, observedAt: '2026-04-01T00:00:00.000Z', facts: { availability: row.error ? 'unavailable' : 'available' } }];
  const results = await tickProject({ root: f.root, client: f.client, routes: f.routes });
  assert.equal(results.find(row => row.taskId === 'dormant').action, 'hold');
  assert.equal(results.find(row => row.taskId === 'invalid').action, 'error');
  assert.ok(seen.some(row => row.key === 'task:invalid' && row.facts.availability === 'unavailable'));
  assert.ok(seen.some(row => row.key === 'task:dormant'));
});

test('unchanged public status still reconciles after assignment or domain replacement', async t => {
  const f = fixture(t);
  f.add('report', { running: { ticketId: 'same-ticket', runId: 'R0001' } }, 'running');
  Object.assign(f.tickets.get('same-ticket'), { domainId: 'domain-one', assignmentId: 'assignment-one' });
  const watcher = f.start(); await watcher.ready; assert.deepEqual(f.calls, ['report']);
  f.tickets.get('same-ticket').assignmentId = 'assignment-two'; f.sdkEvent();
  await until(() => f.calls.length === 2);
  f.tickets.get('same-ticket').domainId = 'domain-two'; f.sdkEvent();
  await until(() => f.calls.length === 3);
  await watcher.close();
});
