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
