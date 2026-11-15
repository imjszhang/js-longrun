import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArguments, handleGenericCommand } from '../src/cli.mjs';

const cli = fileURLToPath(new URL('../bin/js-longrun.mjs', import.meta.url));
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'js-longrun-cli-')));
  const runtimeHome = `${root}-runtime`;
  const unrelated = path.join(root, 'elsewhere'); fs.mkdirSync(unrelated);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(runtimeHome, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: unrelated, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, JS_LONGRUN_HOME: runtimeHome, JS_SUPERAGENT_HOME: path.join(root, '.service-home'), JS_SUPERAGENT_MACHINE_DIRECTORY: path.join(root, '.machine') },
  });
  return { root, unrelated, run, runtimeHome };
}
function ok(result) { assert.equal(result.status, 0, result.stderr); return result.stdout; }

test('help and version work from an unrelated empty consumer without creating runtime state', t => {
  const f = fixture(t), before = fs.readdirSync(f.root);
  assert.match(ok(f.run('--help')), /js-longrun/);
  assert.equal(ok(f.run('--version')).trim(), version);
  assert.deepEqual(fs.readdirSync(f.root), before);
  assert.deepEqual(fs.readdirSync(f.unrelated), []);
});

test('argument parser rejects misspellings, inappropriate flags and conflicting scope before any writes', t => {
  const f = fixture(t), before = fs.readdirSync(f.root);
  for (const args of [
    ['create', 'example', '--goaal', 'test'], ['create', 'example', '--toString', 'test'],
    ['list', '--goal', 'unused'], ['tick', 'example', '--all'], ['watch', 'example'],
    ['create', 'example', '--goal', 'one', '--goal', 'two'], ['plan'], ['list', '--project'],
  ]) assert.notEqual(f.run(...args).status, 0, JSON.stringify(args));
  assert.deepEqual(fs.readdirSync(f.root), before);
  assert.equal(parseArguments(['--project', '../target', 'tick'], '/tmp/work').root, '/tmp/target');
});

test('create, plan, offline trial and control commands remain rooted at the selected project', t => {
  const f = fixture(t), command = (...args) => f.run('--project', f.root, ...args);
  const design = JSON.parse(ok(command('design', 'report', '--type', 'change-report@1')));
  assert.equal(design.definition.id, 'report');
  assert.equal(fs.existsSync(path.join(f.root, 'research')), false, 'design does not create an instance');
  const created = JSON.parse(ok(command('create', 'report', '--goal', 'Describe local changes')));
  assert.equal(created.state.control, 'draft');
  ok(command('validate', 'report'));
  const before = fs.readFileSync(path.join(f.root, 'research/longrun/report/state.json'), 'utf8');
  ok(command('plan', 'report'));
  assert.equal(fs.readFileSync(path.join(f.root, 'research/longrun/report/state.json'), 'utf8'), before);
  const input = path.join(f.root, 'fixture-result.json');
  fs.writeFileSync(input, JSON.stringify({ schemaVersion: 1, summary: 'No changes', report: '# Report\nNo changes', evidence: [], changed: false }));
  const trial = JSON.parse(ok(command('trial', 'report', '--result', input)));
  assert.equal(trial.production, false);
  assert.equal(fs.readFileSync(path.join(f.root, 'research/longrun/report/state.json'), 'utf8'), before);
  const enabled = JSON.parse(ok(command('enable', 'report', '--reason', 'Test-only local authorization')));
  assert.equal(enabled.control, 'enabled'); assert.equal(enabled.running, null);
  assert.equal(JSON.parse(ok(command('pause', 'report'))).control, 'paused');
  assert.equal(JSON.parse(ok(command('resume', 'report'))).control, 'enabled');
  assert.equal(JSON.parse(ok(command('disable', 'report'))).control, 'disabled');
  assert.notEqual(command('resume', 'report').status, 0, 'disabled requires explicit authorization');
  assert.equal(fs.existsSync(path.join(f.root, '.service-home')), false, 'no command submitted production work');
  assert.deepEqual(fs.readdirSync(f.unrelated), []);
});

test('host CLI injection retains custom routes and always passes the consuming project to its SDK adapter', async t => {
  const output = [], routes = { list: () => [] }, events = [];
  const { root } = fixture(t);
  const handled = await handleGenericCommand({ root, command: 'tick', flags: new Map(), routes, print: value => output.push(value),
    dependencies: {
      recordManagedTick: ({ run }) => run(),
      serviceClient(options) { assert.equal(options.projectRoot, root); return { identity: 'client' }; },
      async tickProject(options) { assert.equal(options.root, root); assert.equal(options.routes, routes); assert.equal(options.client.identity, 'client'); return [{ taskId: 'business', action: 'collected' }]; },
    }, afterTick: rows => events.push(rows[0].taskId),
  });
  assert.equal(handled, true); assert.equal(output[0].taskId, 'business'); assert.deepEqual(events, ['business']);
  assert.equal(await handleGenericCommand({ root, command: 'status', taskId: 'business', skipTask: id => id === 'business' }), false);
  const types = [];
  await handleGenericCommand({ root, command: 'types', additionalTypes: [{ id: 'host@1', creatable: false }], print: value => types.push(value) });
  assert.equal(types[0][0].id, 'host@1');
});

test('service status and health are read-only on an uninstalled project', t => {
  const f = fixture(t), before = fs.readdirSync(f.root);
  for (const action of ['status', 'health']) {
    const status = JSON.parse(ok(f.run('--project', f.root, 'service', action)));
    assert.equal(typeof status, 'object');
  }
  assert.deepEqual(fs.readdirSync(f.root), before);
  assert.equal(fs.existsSync(f.runtimeHome), false);
  assert.equal(fs.existsSync(path.join(f.root, '.service-home')), false);
});

test('host service commands retain the registered business entrypoint without opening an SDK client', async () => {
  const calls = [], root = '/consumer', entrypoint = '/consumer/business.mjs';
  await handleGenericCommand({ root, command: 'service', taskId: 'status',
    serviceOptions: { entrypoint, entryArgs: [] }, print: value => calls.push(value),
    dependencies: {
      createLongrunServiceManager(options) { assert.deepEqual(options, { projectRoot: root, entrypoint, entryArgs: [] }); return { status: () => ({ installed: false }) }; },
      serviceClient() { throw new Error('status must not open execution runtime'); },
    },
  });
  assert.deepEqual(calls, [{ installed: false }]);
});

test('fatal observer error during startup closes the acquired watcher and client once', async t => {
  const { root } = fixture(t), outputs = [];
  let collectorCloses = 0, observerCloses = 0;
  const beforeExit = process.exitCode;
  t.after(() => { process.exitCode = beforeExit; });
  await handleGenericCommand({ root, command: 'watch', print: value => outputs.push(value),
    dependencies: {
      watchServiceClient() { return { close: async () => { observerCloses++; } }; },
      startProjectWatcher({ onError }) {
        onError(Object.assign(new Error('synthetic fatal startup'), { code: 'WATCH_FAILED' }));
        return { ready: Promise.resolve(), close: async () => { collectorCloses++; } };
      },
      async runManagedWatcher({ start }) { return start({ onReady() {}, onActivity() {}, onError() {} }); },
    },
  });
  assert.equal(collectorCloses, 1); assert.equal(observerCloses, 1);
  assert.deepEqual(outputs, []); assert.equal(process.exitCode, 1);
});
