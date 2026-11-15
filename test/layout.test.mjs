import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLayout, withTaskLayout, frozenRunLayout } from '../src/layout.mjs';
import { createTask, listTasks, taskPaths, defaultDefinition } from '../src/core/definitions.mjs';
import { trialTask } from '../src/core/trial.mjs';
import { startProjectWatcher } from '../src/project.mjs';

function fixture(t, tasksDir) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-layout-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configure = value => fs.writeFileSync(path.join(root, 'longrun.config.json'), JSON.stringify({ schemaVersion: 1, tasksDir: value }));
  if (tasksDir) configure(tasksDir);
  return { root, configure };
}

test('layout discovery is read-only and does not create machine or business state', t => {
  const f = fixture(t);
  assert.equal(resolveLayout(f.root).tasksDir, 'research/longrun');
  assert.deepEqual(listTasks(f.root), []);
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('layout validates paths and rejects overlapping runtime, dependency and symlink directories', t => {
  const f = fixture(t);
  for (const value of ['/absolute', '../outside', '.', 'tasks//items', 'tasks\\items', 'working', 'working/longrun/tasks', '.git/tasks', 'node_modules/tasks', 'longrun.config.json']) {
    f.configure(value); assert.throws(() => resolveLayout(f.root), undefined, value);
  }
  fs.mkdirSync(path.join(f.root, 'real'));
  fs.symlinkSync('real', path.join(f.root, 'link'));
  f.configure('link/tasks'); assert.throws(() => resolveLayout(f.root), /符号链接/);
});

test('existing generic and unregistered legacy task roots prevent silent directory migration', async t => {
  const f = fixture(t);
  await createTask({ root: f.root, id: 'original', brief: 'Original task' });
  const before = fs.readFileSync(taskPaths(f.root, 'original').state);
  f.configure('automation/tasks');
  assert.throws(() => listTasks(f.root), /LONGRUN_LAYOUT_CONFLICT/);
  await assert.rejects(async () => createTask({ root: f.root, id: 'original', brief: 'Duplicate' }), /LONGRUN_LAYOUT_CONFLICT/);
  assert.equal(fs.existsSync(path.join(f.root, 'automation')), false);
  f.configure('research/longrun');
  assert.deepEqual(fs.readFileSync(taskPaths(f.root, 'original').state), before);
  fs.rmSync(path.join(f.root, 'working/longrun/layout.json'));
  fs.rmSync(path.join(f.root, 'research/longrun/registry.json'));
  f.configure('automation/tasks');
  assert.throws(() => resolveLayout(f.root), /旧任务目录/);
});

test('custom layout remains bound when configuration is removed or redirected', async t => {
  const f = fixture(t, 'automation/tasks');
  await createTask({ root: f.root, id: 'original', brief: 'Custom task' });
  const before = fs.readFileSync(taskPaths(f.root, 'original').state);
  fs.rmSync(path.join(f.root, 'longrun.config.json'));
  assert.throws(() => resolveLayout(f.root), /LONGRUN_LAYOUT_CONFLICT/);
  f.configure('elsewhere/tasks');
  assert.throws(() => listTasks(f.root), /LONGRUN_LAYOUT_CONFLICT/);
  f.configure('automation/tasks');
  assert.deepEqual(fs.readFileSync(taskPaths(f.root, 'original').state), before);
});

test('one async operation retains its resolved layout while nested projects remain independent', async t => {
  const f = fixture(t, 'automation/tasks'), other = fixture(t, 'other/tasks');
  await withTaskLayout(f.root, async initial => {
    f.configure('changed/tasks'); await Promise.resolve();
    assert.equal(resolveLayout(f.root), initial);
    await withTaskLayout(other.root, async nested => {
      assert.equal(resolveLayout(other.root), nested);
      assert.equal(resolveLayout(f.root), initial);
    });
  });
  assert.equal(resolveLayout(f.root).tasksDir, 'changed/tasks');
});

test('frozen layouts reject aliases and retain legacy defaults without modifying the draft', () => {
  const frozen = { taskId: 'report', runId: 'R0001' }, before = JSON.stringify(frozen);
  assert.equal(frozenRunLayout(frozen).runBase, 'research/longrun/report/runs/R0001');
  assert.equal(JSON.stringify(frozen), before);
  assert.throws(() => frozenRunLayout({ ...frozen, layout: { schemaVersion: 1, tasksDir: 'automation/tasks', taskBase: 'automation/tasks/report', runBase: 'automation/tasks/other/runs/R0001', artifactBase: 'automation/tasks/report/artifacts' } }), /escapes/);
});

test('offline trial uses custom task layout in machine runtime and leaves production bytes unchanged', async t => {
  const f = fixture(t, 'automation/tasks'), runtimeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-trial-home-')));
  t.after(() => fs.rmSync(runtimeHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(f.root, 'source.md'), 'Frozen trial input.');
  const definition = defaultDefinition('report'); definition.inputs = ['source.md'];
  await createTask({ root: f.root, id: 'report', brief: 'Report the frozen input', definition });
  const before = fs.readFileSync(taskPaths(f.root, 'report').state);
  const trial = await trialTask({ root: f.root, id: 'report', runtimeHome, result: { schemaVersion: 1, summary: 'No changes', changed: false, report: '# Trial', evidence: [] } });
  assert.equal(trial.result.record.status, 'settled');
  assert.equal(trial.verification.ok, true);
  assert.ok(trial.directory.startsWith(fs.realpathSync(runtimeHome) + path.sep));
  assert.ok(fs.existsSync(path.join(trial.directory, 'automation/tasks/report/artifacts/memory.md')));
  assert.equal(fs.existsSync(path.join(trial.directory, 'research/longrun')), false);
  assert.deepEqual(fs.readFileSync(taskPaths(f.root, 'report').state), before);
  assert.deepEqual(fs.readdirSync(taskPaths(f.root, 'report').artifacts), []);
});

test('watcher monitors configured directories and trusted legacy routes with successful catch-up evidence', async t => {
  const f = fixture(t, 'automation/tasks');
  // A host-owned legacy location is explicit, not discovered as another registry.
  fs.mkdirSync(path.join(f.root, 'legacy/radar'), { recursive: true });
  const watched = [], activities = [], ready = [];
  const watcher = startProjectWatcher({ root: f.root,
    client: { watchChanges: () => () => {}, observe: async () => ({ status: 'waiting' }) },
    routes: { list: () => [{ id: 'radar' }], load: () => ({ running: null }), registryDirectories: () => ['automation/tasks', 'legacy'], instanceDirectory: () => 'legacy/radar' },
    watchDirectory(directory) { watched.push(path.relative(f.root, directory)); return () => {}; },
    onActivity: value => activities.push(value), onReady: value => ready.push(value),
  });
  await watcher.ready; await watcher.close();
  assert.deepEqual(watched.sort(), ['automation/tasks', 'legacy', 'legacy/radar']);
  assert.equal(ready.length, 1);
  assert.equal(activities.at(-1).kind, 'reconcile');
  assert.equal(activities.at(-1).ok, true);
  assert.equal(fs.existsSync(path.join(f.root, 'research')), false);
});
