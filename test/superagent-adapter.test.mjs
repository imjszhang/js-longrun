import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serviceClient, watchServiceClient } from '../src/superagent.mjs';

test('adapter requires an explicit consumer root and does not use installation cwd', () => {
  assert.throws(() => serviceClient(), /projectRoot is required/);
  assert.throws(() => watchServiceClient(), /projectRoot is required/);
});

test('adapter submits only requested options, snapshots host evidence, and closes each connection', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-adapter-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = []; let stops = 0, closes = 0;
  const open = projectRoot => {
    assert.equal(projectRoot, root);
    return {
      submit: options => { calls.push(options); return { id: 'ticket' }; },
      get: id => ({ id, status: 'waiting' }),
      getDomainTicket: () => ({ assignments: [{ report: { state: 'waiting', summary: 'Review' } }] }),
      getWorkspace: () => ({ path: root }),
      listAnswers: () => [{ kind: 'structured' }],
      listAttentionSnapshots: () => [{ attentionId: 'question' }],
      stop: async () => { stops++; }, close: () => { closes++; },
    };
  };
  const client = serviceClient({ projectRoot: root, open });
  await client.submit('plain');
  assert.deepEqual(calls[0], { text: 'plain' }, 'no project-specific defaults or snapshot paths');
  await client.submit('review', { operatorNotifications: true, managedJobs: false, attentionSnapshotPaths: ['research/longrun/report/runs/R0001/result.json'] });
  assert.equal(calls[1].managedJobs, false);
  assert.deepEqual(calls[1].attentionSnapshotPaths, ['research/longrun/report/runs/R0001/result.json']);
  const snapshot = await client.snapshot('ticket');
  assert.equal(snapshot.status, 'waiting');
  assert.equal(snapshot.report, 'waiting');
  assert.equal(snapshot.attentionSnapshots[0].attentionId, 'question');
  assert.equal(stops, 3); assert.equal(closes, 3);
});

test('observer closes once without starting execution or channel listeners', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-observer-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let opens = 0, stops = 0, closes = 0, observed;
  const client = watchServiceClient({ projectRoot: root, open: () => {
    opens++;
    return { get: () => ({ status: 'completed' }), getDomainTicket: () => ({ attention: { id: 'question' } }),
      watchChanges: callback => { observed = callback; return () => {}; },
      stop: async () => { stops++; }, close: () => { closes++; } };
  } });
  assert.deepEqual(client.observe('ticket'), { status: 'completed', attentionId: 'question' });
  const callback = () => {}; client.watchChanges(callback); assert.equal(observed, callback);
  await client.close(); await client.close();
  assert.equal(opens, 1); assert.equal(stops, 1); assert.equal(closes, 1);
});

test('material adapter forwards only explicit frozen contract and does not fall back to project root', async t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'longrun-material-adapter-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let submitted;
  const capabilities={version:1,boundedReadsVersion:1,workspacePreparationVersion:1,localApplicationVersion:1,schemaVersion:15};
  const materials={version:1,access:'native',workspaceSourceId:'inputs',sources:[{id:'inputs',view:{kind:'snapshot',snapshotId:'snap-1'}}],allowPreparation:true,allowApply:false,owner:{kind:'longrun',contractHash:'a'.repeat(64)}};
  const client=serviceClient({projectRoot:root,open:()=>({
    materialCapabilities:()=>capabilities,createMaterialSnapshot:options=>({id:'snap-1',source:options.sourceId}),
    submit:options=>{submitted=options;return{id:'ticket'};},get:()=>({status:'queued'}),getDomainTicket:()=>({assignments:[]}),
    getWorkspace:()=>null,getDetailed:()=>({materialBinding:materials}),listAnswers:()=>[],listAttentionSnapshots:()=>[],stop(){},close(){},
  })});
  assert.deepEqual(await client.materialCapabilities(),capabilities);
  assert.deepEqual(await client.createMaterialSnapshot({sourceId:'inputs'}),{id:'snap-1',source:'inputs'});
  await client.submit('frozen task',{materials});assert.deepEqual(submitted.materials,materials);
  const observed=await client.snapshot('ticket',{contractHash:'a'.repeat(64)});
  assert.equal(observed.workspacePath,null);assert.equal(observed.workspace,null);assert.equal(observed.workerChanges,null);
});
