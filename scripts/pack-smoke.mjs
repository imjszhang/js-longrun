import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Verify the actual tarball in an unrelated consumer, with all runtime state
// isolated from the operator's projects. This never starts a Worker or channel.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'js-longrun-pack-'));
const env = { ...process.env, JS_SUPERAGENT_HOME: join(scratch, 'service-home'), JS_SUPERAGENT_MACHINE_DIRECTORY: join(scratch, 'machine') };
delete env.LONGRUN_OPEN_ROUNDS;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args, cwd = scratch) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.error ?? result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
try {
  const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], packageRoot))[0];
  const tarball = join(scratch, packed.filename);
  assert.equal(packed.name, sourceManifest.name);
  assert.equal(packed.version, sourceManifest.version);
  assert.equal(packed.integrity, 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64'));
  const allowedRoots = new Set(['src', 'bin', 'docs', 'templates']);
  const allowedFiles = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md']);
  for (const { path } of packed.files) {
    assert.ok(allowedFiles.has(path) || allowedRoots.has(path.split('/')[0]), `Unexpected package file: ${path}`);
    assert.ok(!path.split('/').some(part => ['..', 'node_modules', '.git', '.cache', 'cache', 'test', 'tests', 'release'].includes(part)), `Private/cache file: ${path}`);
    assert.ok(!/(?:^|\/)\.env(?:\.|$)|(?:\.sqlite(?:3)?|\.db|\.pem|\.key)(?:$|[.-])|credentials|(?:^|\/)(?:R\d{4,}|RV\d{4,})(?:\/|\.)/.test(path), `State/credential file: ${path}`);
  }
  for (const name of ['package.json', 'LICENSE', 'src/index.mjs', 'bin/js-longrun.mjs']) assert.ok(packed.files.some(file => file.path === name), `Missing package entry: ${name}`);
  const archivePaths = run('tar', ['-tzf', tarball]).split('\n').filter(Boolean);
  for (const name of archivePaths) assert.ok(name.startsWith('package/') && !name.split('/').includes('..'), `Unsafe archive path: ${name}`);
  const unpacked = join(scratch, 'unpacked'); mkdirSync(unpacked);
  run('tar', ['-xzf', tarball, '-C', unpacked]);
  for (const { path } of packed.files) {
    if (!/\.(?:mjs|js|json|md|yaml|yml)$/.test(path)) continue;
    const text = readFileSync(join(unpacked, 'package', path), 'utf8');
    assert.ok(!/\/Users\/[^/\s]+\//.test(text), `Machine-specific path leaked in ${path}`);
    assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text), `Private key in ${path}`);
  }

  const consumer = join(scratch, 'consumer'); mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', tarball, 'js-superagent@0.14.0-alpha.0'], consumer);
  const installedRoot = join(consumer, 'node_modules/js-longrun');
  const installed = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installed.version, sourceManifest.version);
  assert.ok(!installed.dependencies?.['js-agent-runtime'], 'longrun must not depend on concrete agent execution');
  const cli = join(installedRoot, 'bin/js-longrun.mjs');
  const project = join(scratch, 'project'); mkdirSync(project);
  assert.match(run(process.execPath, [cli, '--help'], project), /js-longrun|longrun/i);
  assert.match(run(process.execPath, [cli, '--version'], project), new RegExp(sourceManifest.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(readdirSync(project), [], 'help/version must not create project state');
  assert.equal(existsSync(env.JS_SUPERAGENT_HOME), false, 'help/version must not initialize service state');
  assert.equal(existsSync(env.JS_SUPERAGENT_MACHINE_DIRECTORY), false, 'help/version must not register a project');

  const id = 'local-report';
  const command = (...args) => JSON.parse(run(process.execPath, [cli, '--project', project, ...args], consumer));
  const created = command('create', id, '--type', 'change-report@1', '--goal', 'Summarize supplied local notes.');
  assert.equal(created.state.control, 'draft');
  assert.equal(command('validate', id).ok, true);
  const plan = command('plan', id);
  assert.equal(plan.taskId, id); assert.equal(plan.runId, 'R0001');
  assert.ok(plan.plan.allowedPaths.every(path => path.startsWith(`research/longrun/${id}/runs/R0001/`)));
  const beforeState = readFileSync(join(project, `research/longrun/${id}/state.json`), 'utf8');
  writeFileSync(join(project, 'trial-result.json'), JSON.stringify({ schemaVersion: 1, summary: 'No supplied changes.', report: '# Report\nNo new evidence.', evidence: [], changed: false }));
  const trial = command('trial', id, '--result', 'trial-result.json');
  assert.equal(trial.production, false); assert.equal(trial.mode, 'offline-fixture');
  assert.equal(trial.result.record.status, 'settled'); assert.equal(trial.verification.ok, true);
  assert.equal(readFileSync(join(project, `research/longrun/${id}/state.json`), 'utf8'), beforeState, 'trial must preserve the production draft byte-for-byte');
  assert.deepEqual(readdirSync(join(project, `research/longrun/${id}/runs`)), [], 'trial cannot create a production run');
  assert.deepEqual(readdirSync(join(project, `research/longrun/${id}/artifacts`)), [], 'trial cannot publish production output');

  writeFileSync(join(consumer, 'sdk-smoke.mjs'), `
    import assert from 'node:assert/strict';
    import * as sdk from 'js-longrun';
    import { loadState } from 'js-longrun/definitions';
    for (const name of ['definitions','runtime','trial','project','superagent','types','types/review-items','lock','cli']) {
      const entry = await import('js-longrun/' + name);
      assert.ok(Object.keys(entry).length, 'empty public entry: ' + name);
    }
    assert.ok(Object.keys(sdk).length, 'root SDK export must be usable');
    const state = loadState(process.argv[2], 'local-report');
    assert.equal(state.control, 'draft'); assert.equal(state.running, null); assert.equal(state.round, 0);
  `);
  run(process.execPath, [join(consumer, 'sdk-smoke.mjs'), project], consumer);
  assert.equal(existsSync(env.JS_SUPERAGENT_HOME), false, 'offline commands must not initialize the execution service');
  assert.equal(existsSync(env.JS_SUPERAGENT_MACHINE_DIRECTORY), false, 'offline commands must not register an execution project');
  console.log(`Clean npm package ${sourceManifest.name}@${sourceManifest.version}: archive boundaries, CLI, SDK exports, offline report trial and unchanged production draft passed.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
