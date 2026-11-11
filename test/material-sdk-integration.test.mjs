import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serviceClient } from '../src/superagent.mjs';
import { createTask, defaultDefinition, enableTask, taskPaths } from '../src/core/definitions.mjs';
import { startRun, collectTask } from '../src/core/runtime.mjs';

// The legacy peer remains covered by the normal suite. This explicit candidate
// matrix seam runs against a packed SDK or a reviewed local SDK entrypoint.
const candidate = process.env.JS_LONGRUN_MATERIAL_SDK;
test('candidate SDK preserves frozen materials through preparation and longrun-only settlement', { skip: !candidate && 'Set JS_LONGRUN_MATERIAL_SDK to the material-capable SDK entrypoint' }, async t => {
  const stateHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-material-sdk-state-'))), previousHome = process.env.JS_SUPERAGENT_HOME;
  process.env.JS_SUPERAGENT_HOME = stateHome;
  t.after(() => { if (previousHome === undefined) delete process.env.JS_SUPERAGENT_HOME; else process.env.JS_SUPERAGENT_HOME = previousHome; fs.rmSync(stateHome, { recursive: true, force: true }); });
  const sdk = await import(pathToFileURL(path.resolve(candidate)).href);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-material-sdk-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'source.md'), 'Frozen original fact.');
  const definition = defaultDefinition('report'); definition.inputs = ['source.md'];
  await createTask({ root, id: 'report', brief: 'Report the frozen fact', definition });
  await enableTask({ root, id: 'report', reason: 'Isolated test authorization' });
  const registry = sdk.createHarnessRegistry(); let runs = 0;
  registry.register({ id: 'material-fixture', version: '1', roles: ['worker', 'child'], validate: value => value, createDriver: () => ({
    reportVersion: 2, capabilities: { reportVersion: 2, agentTools: true, boundedMaterialReadsVersion: 1, workspacePreparationVersion: 1, sessionResume: true },
    async run(input) {
      runs++;
      assert.equal(fs.readFileSync(path.join(input.projectRoot, 'source.md'), 'utf8'), 'Frozen original fact.');
      input.checkpoint({ driver: 'material-fixture', id: `session-${input.runId}` });
      if (runs === 1) {
        await input.agentTools.call({ name: 'js_superagent_prepare_workspace', arguments: { materialId: 'inputs', provisionId: input.workspace.provisionId, reason: 'Verify a same-contract prepared generation' }, callId: 'prepare', sessionId: `session-${input.runId}`, turnId: 'turn-1' });
      } else {
        const output = path.join(input.projectRoot, 'research/longrun/report/runs/R0001'); fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ schemaVersion: 1, summary: 'Frozen report', report: '# Report\nFrozen original fact.', evidence: [{ path: 'source.md', quote: 'Frozen original fact.' }], changed: true }));
        fs.writeFileSync(path.join(output, 'memory.md'), '# Memory\nFrozen original fact.');
      }
      return { version: 2, state: 'ready', summary: 'Frozen report complete', artifacts: [], attention: null };
    },
  }) });
  const open = projectRoot => sdk.createProjectAgent({ projectRoot, harnessRegistry: registry, workspace: { mode: 'copy' }, execution: { driver: 'material-fixture', enableAgentTools: true } }).init();
  const setup = open(root), principal = { source: 'local', id: 'operator' };
  setup.configureMaterials({ entries: [{ id: 'inputs', project: 'self', include: ['source.md'], exclude: [], views: ['current', 'snapshot'], readers: [principal], destinations: [principal] }] }, { expectedRevision: 0 });
  await setup.stop(); setup.close();
  const client = serviceClient({ projectRoot: root, open });
  const material = await client.createMaterialSnapshot({ sourceId: 'inputs' });
  const started = await startRun({ root, id: 'report', client, materials: { sources: [{ id: 'inputs', snapshotId: material.id, digest: material.digest, source: material.source }] } });
  assert.equal(started.action, 'opened', JSON.stringify(started));
  fs.writeFileSync(path.join(root, 'source.md'), 'Later source content must not be consumed.');
  const worker = open(root);
  try {
    await worker.runNext();
    const preparation = await collectTask({ root, id: 'report', client });
    assert.equal(preparation.action, 'pending', JSON.stringify(preparation));
    assert.equal(preparation.ticket, 'preparing');
    assert.equal(worker.get(started.ticketId).status, 'waiting');
    await worker.runNext();
    assert.equal(worker.get(started.ticketId).status, 'completed', JSON.stringify(worker.get(started.ticketId)));
    assert.equal(worker.getWorkspace(started.ticketId).generation, 1);
    assert.throws(() => worker.previewMaterialApplication(started.ticketId, { paths: ['.'] }), /authoriz|owner|grant|permit/i);
  } finally { await worker.stop(); worker.close(); }
  const collected = await collectTask({ root, id: 'report', client });
  assert.equal(collected.record?.status, 'settled', JSON.stringify(collected));
  assert.equal(runs, 2);
  assert.equal(fs.readFileSync(path.join(root, 'source.md'), 'utf8'), 'Later source content must not be consumed.');
  assert.match(fs.readFileSync(path.join(taskPaths(root, 'report').artifacts, 'reports/R0001.md'), 'utf8'), /Frozen original fact/);
  assert.equal((await collectTask({ root, id: 'report', client })).action, 'none');
});
