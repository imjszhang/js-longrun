import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertTaskId, safePath, taskPaths, defaultDefinition, validateDefinition,
  createTask, listTasks, readDefinition, loadState, saveState, enableTask, pauseTask, resumeTask, disableTask, weekId,
} from '../src/core/definitions.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-definition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const now = new Date('2026-11-09T01:00:00Z');
const create = (root, id = 'example', extra = {}) => createTask({ root, id, brief: '# 任务\n比较已保存资料的变化。', now, ...extra });

test('creation registers an inert draft and leaves unregistered project data untouched', async t => {
  const root = fixture(t), old = taskPaths(root, 'project-owned-task');
  fs.mkdirSync(old.dir, { recursive: true });
  fs.writeFileSync(old.brief, '# 旧任务\n'); fs.writeFileSync(old.state, '{"untouched":"RV0001"}\n');
  const result = await create(root);
  assert.equal(result.state.control, 'draft');
  assert.equal(result.state.running, null);
  assert.equal(result.state.nextDueAt, null);
  assert.deepEqual(result.state.week, { id: '2026-W46', runs: 0, subtasks: 0 });
  assert.equal(fs.readFileSync(old.state, 'utf8'), '{"untouched":"RV0001"}\n');
  assert.equal(readDefinition(root, 'example').type, 'change-report@1');
  assert.deepEqual(listTasks(root).map(row => [row.id, row.control]), [['example', 'draft']]);
  assert.deepEqual(fs.readdirSync(result.paths.runs), []);
  assert.deepEqual(fs.readdirSync(result.paths.artifacts), []);
});

test('concurrent creates serialize registry updates and duplicate IDs cannot overwrite', async t => {
  const root = fixture(t);
  await Promise.all([create(root, 'alpha'), create(root, 'beta')]);
  assert.deepEqual(listTasks(root).map(row => row.id), ['alpha', 'beta']);
  const before = fs.readFileSync(taskPaths(root, 'alpha').definition, 'utf8');
  await assert.rejects(create(root, 'alpha'), /已存在/);
  assert.equal(fs.readFileSync(taskPaths(root, 'alpha').definition, 'utf8'), before);
});

test('registry discovery does not activate or import an arbitrary directory', async t => {
  const root = fixture(t);
  fs.mkdirSync(taskPaths(root, 'unregistered').dir, { recursive: true });
  fs.writeFileSync(taskPaths(root, 'unregistered').definition, JSON.stringify(defaultDefinition('unregistered')));
  assert.deepEqual(listTasks(root), []);
  await assert.rejects(enableTask({ root, id: 'unregistered', reason: 'explicit instruction' }), /尚未注册/);
});

test('controls require explicit enable and preserve active runs while pausing/disabling', async t => {
  const root = fixture(t); await create(root);
  await assert.rejects(enableTask({ root, id: 'example', now }), /授权依据/);
  await assert.rejects(resumeTask({ root, id: 'example', now }), /只有已授权/);
  await assert.rejects(pauseTask({ root, id: 'example', now }), /只有启用/);
  await enableTask({ root, id: 'example', reason: '用户明确要求启用此任务', now });
  assert.equal(loadState(root, 'example').control, 'enabled');
  assert.equal(loadState(root, 'example').nextDueAt, now.toISOString());
  const active = { ticketId: 'ticket-1', runId: 'R0001' };
  saveState(root, { ...loadState(root, 'example'), running: active });
  await pauseTask({ root, id: 'example', now });
  assert.deepEqual(loadState(root, 'example').running, active);
  await resumeTask({ root, id: 'example', now });
  await disableTask({ root, id: 'example', now });
  assert.deepEqual(loadState(root, 'example').running, active);
  await assert.rejects(resumeTask({ root, id: 'example', now }), /只有已授权/);
  await enableTask({ root, id: 'example', now, reason: '重新启用' });
  assert.equal(loadState(root, 'example').authorization.reason, '重新启用');
});

test('task ID and path checks reject traversal, aliases, symlinks and non-directory ancestors', t => {
  const root = fixture(t);
  for (const id of ['', '../other', 'A', 'a/b', 'a'.repeat(65), 'a_b']) assert.throws(() => assertTaskId(id));
  for (const file of ['../other', '/tmp/file', 'a/../b', 'a//b', './a', 'a\\b']) assert.throws(() => safePath(root, file));
  fs.writeFileSync(path.join(root, 'file'), 'x');
  assert.throws(() => safePath(root, 'file/child'), /不是目录/);
  fs.symlinkSync(path.join(root, 'file'), path.join(root, 'alias'));
  assert.throws(() => safePath(root, 'alias'), /符号链接/);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'));
  assert.throws(() => safePath(root, 'outside/new/file'), /符号链接/);
  assert.equal(safePath(root, 'new/path/file'), path.join(fs.realpathSync(root), 'new/path/file'));
});

test('validation rejects unsupported effects, type capabilities and arbitrary execution', () => {
  const d = defaultDefinition('safe', 'review-items@1');
  assert.equal(validateDefinition(d).ok, true);
  for (const mutate of [
    value => { value.type = 'any-module.mjs'; },
    value => { value.executionProfile = '/bin/sh'; },
    value => { value.outputBinding = '../other'; },
    value => { value.command = 'curl'; },
    value => { value.limits.maxSubtasksPerRun = 1; },
    value => { value.limits.maxExecutionMinutes = 61; },
    value => { value.parameters.maxItems = 11; },
    value => { value.notifications.settled = 'operator'; },
    value => { value.review.mode = 'none'; },
    value => { value.review.onTimeout = 'approve'; },
    value => { value.trigger.timezone = 'Mars/Unknown'; },
    value => { value.trigger.anchor = now.toISOString(); },
    value => { value.inputs = ['../../credentials']; },
  ]) {
    const changed = structuredClone(d); mutate(changed);
    assert.equal(validateDefinition(changed).ok, false, JSON.stringify(changed));
  }
  const periodic = defaultDefinition('weekly');
  periodic.trigger = { kind: 'fixed-interval', intervalHours: 168, anchor: now.toISOString(), timezone: 'Asia/Shanghai' };
  assert.equal(validateDefinition(periodic).ok, true);
  periodic.trigger.anchor = '2026-11-09T10:00:00';
  assert.equal(validateDefinition(periodic).ok, false, 'ambiguous local anchor is rejected');
});

test('creation rejects missing inputs and existing unregistered directories without partial registry writes', async t => {
  const root = fixture(t), d = defaultDefinition('example'); d.inputs = ['missing.md'];
  await assert.rejects(create(root, 'example', { definition: d }), /ENOENT/);
  assert.deepEqual(listTasks(root), []);
  fs.mkdirSync(taskPaths(root, 'example').dir, { recursive: true });
  fs.writeFileSync(path.join(taskPaths(root, 'example').dir, 'user-file'), 'keep');
  await assert.rejects(create(root), /已存在/);
  assert.equal(fs.readFileSync(path.join(taskPaths(root, 'example').dir, 'user-file'), 'utf8'), 'keep');
  assert.deepEqual(listTasks(root), []);
});

test('readDefinition revalidates inputs against symlinks introduced after creation', async t => {
  const root = fixture(t), d = defaultDefinition('example'); d.inputs = ['input.md'];
  fs.writeFileSync(path.join(root, 'input.md'), 'facts');
  await create(root, 'example', { definition: d });
  fs.rmSync(path.join(root, 'input.md')); fs.symlinkSync('/etc/hosts', path.join(root, 'input.md'));
  assert.throws(() => readDefinition(root, 'example'), /符号链接/);
  const listed = listTasks(root);
  assert.equal(listed[0].control, 'draft');
  assert.match(listed[0].error, /符号链接/);
});

test('a broken registered instance does not prevent listing other instances', async t => {
  const root = fixture(t); await create(root, 'alpha'); await create(root, 'beta');
  fs.writeFileSync(taskPaths(root, 'alpha').definition, '{bad json');
  assert.deepEqual(listTasks(root).map(row => [row.id, row.control]), [['alpha', 'draft'], ['beta', 'draft']]);
});

test('budget weeks use the task timezone rather than the host timezone', () => {
  const boundary = new Date('2026-11-08T17:00:00Z');
  assert.equal(weekId(boundary, 'Asia/Shanghai'), '2026-W46');
  assert.equal(weekId(boundary, 'UTC'), '2026-W45');
  assert.equal(weekId(new Date('2021-01-01T00:00:00Z'), 'UTC'), '2020-W53');
});


test('invalid edited definitions retain the active run for frozen-result collection', async t => {
  const root = fixture(t); await create(root);
  await enableTask({ root, id: 'example', reason: 'explicit enable', now });
  const running = { runId: 'R0001', ticketId: 'original-ticket' };
  saveState(root, { ...loadState(root, 'example'), running });
  fs.writeFileSync(taskPaths(root, 'example').definition, '{invalid edited config');
  const [listed] = listTasks(root);
  assert.equal(listed.control, 'enabled');
  assert.deepEqual(listed.running, running);
  assert.ok(listed.error);
});

test('enable respects a future interval anchor and resume clears the failure gate', async t => {
  const root = fixture(t), d = defaultDefinition('example');
  d.trigger = { kind: 'fixed-interval', intervalHours: 24, anchor: '2026-12-01T00:00:00Z', timezone: 'UTC' };
  await create(root, 'example', { definition: d });
  await enableTask({ root, id: 'example', reason: 'schedule authorized', now });
  assert.equal(loadState(root, 'example').nextDueAt, new Date(d.trigger.anchor).toISOString());
  saveState(root, { ...loadState(root, 'example'), failures: 2 });
  await pauseTask({ root, id: 'example', now });
  await resumeTask({ root, id: 'example', now });
  assert.equal(loadState(root, 'example').failures, 0);
  await disableTask({ root, id: 'example', now });
  saveState(root, { ...loadState(root, 'example'), failures: 3 });
  await enableTask({ root, id: 'example', reason: 'retry authorized', now });
  assert.equal(loadState(root, 'example').failures, 0);
  const other = defaultDefinition('past');
  other.trigger = { ...d.trigger, anchor: '2026-01-01T00:00:00Z' };
  await create(root, 'past', { definition: other });
  await enableTask({ root, id: 'past', reason: 'coalesce old intervals', now });
  assert.equal(loadState(root, 'past').nextDueAt, now.toISOString());
});

test('failed registry write rolls back creation and leaves other tasks intact', async t => {
  const root = fixture(t); await create(root, 'existing');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('/registry.json')) throw new Error('simulated disk failure');
    return rename(from, to);
  };
  try { await assert.rejects(create(root, 'interrupted'), /simulated disk failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(taskPaths(root, 'interrupted').dir), false);
  assert.deepEqual(listTasks(root).map(row => row.id), ['existing']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'research/longrun')).filter(name => name.startsWith('.create-')), []);
});
