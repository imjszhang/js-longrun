import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createTask, defaultDefinition, taskPaths, enableTask, disableTask, loadState, saveState } from '../src/core/definitions.mjs';
import { planTask, startRun, collectTask, tickTask, genericStatus, verifyGeneric } from '../src/core/runtime.mjs';

const day = n => new Date(Date.parse('2026-11-09T00:00:00Z') + n * 86400000);
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, { id = 'report', type = 'change-report@1', mutateDefinition, enabled = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-generic-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'longrun-generic-worker-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(workspace, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(root, 'source.md'), '# Source\nA frozen fact.\n');
  const definition = defaultDefinition(id, type); definition.inputs = ['source.md']; mutateDefinition?.(definition);
  await createTask({ root, id, brief: '# Analyze local source\nReport changes only.', definition, now: day(0) });
  if (enabled) await enableTask({ root, id, reason: 'explicit fixture authorization', now: day(0) });
  let submissions = 0, cancellations = 0, extraChanges = [], status = 'completed';
  const client = {
    submit: async (_text, options) => { submissions++; assert.ok(Array.isArray(options.attentionSnapshotPaths)); return `ticket-${id}-${submissions}`; },
    snapshot: async () => ({ status, workspacePath: workspace, answers: [], attentionSnapshots: [] }),
    changes: async () => [...plan().plan.allowedPaths.map(p => ({ path: p })), ...extraChanges],
    jobs: async () => [], cancel: async () => { cancellations++; status = 'cancelled'; },
  };
  const draftPath = () => path.join(taskPaths(root, id).runs, loadState(root, id).running?.runId ?? 'R0001', 'draft.json');
  const plan = () => JSON.parse(fs.readFileSync(draftPath(), 'utf8'));
  const writeResult = (result = { schemaVersion: 1, summary: 'New evidence', report: '# Report\nA frozen fact.', evidence: [{ path: 'source.md', quote: 'A frozen fact.' }], changed: true }, memory = '# Memory\nA frozen fact.\n') => {
    const p = plan(), relative = `research/longrun/${id}/runs/${p.runId}`;
    fs.mkdirSync(path.join(workspace, relative), { recursive: true });
    fs.writeFileSync(path.join(workspace, relative, 'result.json'), json(result));
    fs.writeFileSync(path.join(workspace, relative, 'memory.md'), memory);
  };
  return { root, id, workspace, definition, client, plan, writeResult,
    start: (now = day(0), options = {}) => startRun({ root, id, client, now, ...options }),
    collect: (now = day(0)) => collectTask({ root, id, client, now }),
    status: value => { status = value; }, changes: value => { extraChanges = value; },
    submissions: () => submissions, cancellations: () => cancellations };
}

test('generic report settles without topics or candidate storage and collects only once', async t => {
  const f = await fixture(t);
  assert.equal(fs.existsSync(path.join(f.root, 'data/topics.json')), false);
  const preview = planTask({ root: f.root, id: f.id, now: day(0) });
  assert.equal(f.submissions(), 0, 'plan does not submit');
  assert.equal(preview.runId, 'R0001');
  assert.equal((await f.start()).action, 'opened');
  f.writeResult();
  const results = await Promise.all([f.collect(), f.collect()]);
  assert.deepEqual(results.map(r => r.action).sort(), ['collected', 'none']);
  assert.equal(results.find(r => r.record).record.status, 'settled');
  assert.match(fs.readFileSync(path.join(taskPaths(f.root, f.id).artifacts, 'reports/R0001.md'), 'utf8'), /A frozen fact/);
  assert.equal(loadState(f.root, f.id).running, null);
  assert.equal(loadState(f.root, f.id).round, 1);
  assert.equal(loadState(f.root, f.id).nextDueAt, day(3).toISOString());
  assert.equal(fs.existsSync(path.join(f.root, 'data/topics.json')), false);
  assert.equal(verifyGeneric({ root: f.root, id: f.id }).ok, true);
});

test('two instances can use R0001 independently and do not overwrite each other', async t => {
  const f = await fixture(t, { id: 'alpha' });
  const definition = defaultDefinition('beta'); definition.inputs = ['source.md'];
  await createTask({ root: f.root, id: 'beta', brief: '# Other report', definition, now: day(0) });
  await enableTask({ root: f.root, id: 'beta', reason: 'separate task authorized', now: day(0) });
  await f.start(); f.writeResult();
  const otherWorkspace = path.join(f.workspace, 'other'); fs.mkdirSync(otherWorkspace);
  const relative = 'research/longrun/beta/runs/R0001';
  const otherClient = { ...f.client, submit: async () => 'ticket-beta',
    snapshot: async () => ({ status: 'completed', workspacePath: otherWorkspace, answers: [], attentionSnapshots: [] }),
    changes: async () => ['result.json', 'memory.md'].map(name => ({ path: `${relative}/${name}` })) };
  await startRun({ root: f.root, id: 'beta', client: otherClient, now: day(0) });
  fs.mkdirSync(path.join(otherWorkspace, relative), { recursive: true });
  fs.writeFileSync(path.join(otherWorkspace, relative, 'result.json'), json({ schemaVersion: 1, summary: 'No changes', report: '# Beta only', evidence: [], changed: false }));
  fs.writeFileSync(path.join(otherWorkspace, relative, 'memory.md'), '# Beta memory');
  assert.equal((await collectTask({ root: f.root, id: 'beta', client: otherClient, now: day(0) })).record.status, 'settled');
  assert.notEqual(loadState(f.root, 'alpha').running, null);
  assert.equal((await f.collect()).record.status, 'settled');
  assert.match(fs.readFileSync(path.join(taskPaths(f.root, 'alpha').artifacts, 'memory.md'), 'utf8'), /frozen fact/);
  assert.equal(fs.readFileSync(path.join(taskPaths(f.root, 'beta').artifacts, 'memory.md'), 'utf8'), '# Beta memory');
});

test('active collection uses frozen definition and inputs despite invalid config edits or removed source', async t => {
  const f = await fixture(t); await f.start(); f.writeResult();
  fs.writeFileSync(taskPaths(f.root, f.id).definition, '{broken new revision');
  fs.rmSync(path.join(f.root, 'source.md'));
  const result = await f.collect();
  assert.equal(result.record.status, 'settled');
  const frozen = f.plan();
  assert.equal(frozen.definition.revision, 1);
  assert.match(frozen.inputs[0].content, /A frozen fact/);
  assert.equal(frozen.inputs[0].sha256, hash(frozen.inputs[0].content));
});

test('draft and disabled tasks never start; disabled active tasks still settle', async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.start()).action, 'hold');
  assert.equal(f.submissions(), 0);
  await enableTask({ root: f.root, id: f.id, reason: 'test', now: day(0) });
  await f.start(); f.writeResult();
  await disableTask({ root: f.root, id: f.id, now: day(0) });
  assert.equal((await tickTask({ root: f.root, id: f.id, client: f.client, now: day(0), open: true })).record.status, 'settled');
  assert.equal((await f.start(day(4))).action, 'hold');
  assert.equal(f.submissions(), 1);
});

test('weekly reservations and fixed intervals coalesce offline periods without bursts', async t => {
  const f = await fixture(t, { mutateDefinition: d => {
    d.limits.weeklyRuns = 1;
    d.trigger = { kind: 'fixed-interval', intervalHours: 24, anchor: day(-30).toISOString(), timezone: 'UTC' };
  } });
  await f.start(); f.writeResult(); await f.collect(day(2));
  assert.equal(loadState(f.root, f.id).nextDueAt, day(3).toISOString());
  const next = await f.start(day(4));
  assert.equal(next.action, 'hold'); assert.ok(next.reasons.includes('weekly-budget'));
  assert.equal((await f.start(day(7))).action, 'opened');
  assert.equal(loadState(f.root, f.id).week.runs, 1);
  assert.equal(f.submissions(), 2);
});

test('out-of-scope writes and forbidden child jobs prevent formal settlement', async t => {
  const f = await fixture(t); await f.start(); f.writeResult();
  f.changes([{ path: 'data/topics.json' }]);
  const result = await f.collect();
  assert.equal(result.record.status, 'invalid');
  assert.match(result.record.errors.join('\n'), /Out-of-scope/);
  assert.deepEqual(fs.readdirSync(taskPaths(f.root, f.id).artifacts), []);
  const other = await fixture(t, { id: 'child-job' }); await other.start(); other.writeResult();
  other.client.jobs = async () => [{ id: 'unexpected-child' }];
  const blocked = await other.collect();
  assert.equal(blocked.record.status, 'invalid');
  assert.match(blocked.record.errors.join('\n'), /forbids managed jobs/);
});

test('changed formal memory is retained instead of being overwritten by an old result', async t => {
  const f = await fixture(t); await f.start(); f.writeResult();
  const memory = path.join(taskPaths(f.root, f.id).artifacts, 'memory.md');
  fs.writeFileSync(memory, '# User changed memory');
  const result = await f.collect();
  assert.equal(result.record.status, 'conflict');
  assert.equal(fs.readFileSync(memory, 'utf8'), '# User changed memory');
});

test('interrupted applying resumes idempotently and reports conflicting human edits', async t => {
  const f = await fixture(t); await f.start(); f.writeResult();
  const target = path.join(taskPaths(f.root, f.id).artifacts, 'memory.md');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === target) throw new Error('simulated crash during apply'); return rename(from, to); };
  try { await assert.rejects(f.collect(), /simulated crash/); }
  finally { fs.renameSync = rename; }
  const state = loadState(f.root, f.id);
  assert.equal(state.running.phase, 'applying');
  const report = path.join(taskPaths(f.root, f.id).artifacts, 'reports/R0001.md');
  const reportBefore = fs.readFileSync(report, 'utf8');
  fs.writeFileSync(target, '# Concurrent human edit');
  await assert.rejects(f.collect(), /Settlement conflict/);
  assert.equal(loadState(f.root, f.id).running.phase, 'applying');
  assert.equal(fs.readFileSync(target, 'utf8'), '# Concurrent human edit');
  fs.rmSync(target);
  const resumed = await f.collect();
  assert.equal(resumed.record.status, 'settled');
  assert.equal(fs.readFileSync(report, 'utf8'), reportBefore);
  assert.equal((await f.collect()).action, 'none');
  assert.equal(loadState(f.root, f.id).week.runs, 1);
});

test('submission ambiguity blocks retry rather than enqueueing duplicate tickets', async t => {
  const f = await fixture(t); f.client.submit = async () => { throw new Error('network lost after remote submit'); };
  assert.equal((await f.start()).action, 'blocked');
  assert.equal(loadState(f.root, f.id).running.phase, 'needs_attention');
  assert.equal((await f.start()).action, 'hold');
  assert.equal((await f.collect()).action, 'blocked');
});

function materialFixture(f) {
  const source={root:fs.realpathSync(f.root),projectId:'fixture-project',instanceId:'fixture-instance',entryId:'inputs',view:{kind:'current'}};
  const materials={sources:[{id:'inputs',snapshotId:'frozen-inputs',digest:'a'.repeat(64),source}]};
  let submitted;
  const submit=f.client.submit, snapshot=f.client.snapshot;
  f.client.materialCapabilities=async()=>({version:1,boundedReadsVersion:1,workspacePreparationVersion:1,localApplicationVersion:1,schemaVersion:15});
  f.client.submit=async(text,options)=>{submitted=options;return submit(text,options);};
  const workspace={state:'ready',mode:'copy',path:f.workspace,projectRoot:source.root,ticketId:`ticket-${f.id}-1`,
    snapshotOrigin:'project-materials',materialSnapshotDigest:materials.sources[0].digest,materialSource:source,
    sourceSnapshotDigest:'b'.repeat(64),provisionId:'provision-0',preparationId:'initial-material-copy'};
  const evidence={workspace,workspaceHistory:[],workspacePreparation:null};
  f.client.snapshot=async(...args)=>({...await snapshot(...args),...structuredClone(evidence),
    materialBinding:{...submitted.materials,sources:[{id:'inputs',view:{kind:'snapshot',snapshotId:'frozen-inputs'},project:{root:source.root,projectId:source.projectId,instanceId:source.instanceId}}]},
    workerChanges:await f.client.changes()});
  return {materials,evidence,submitted:()=>submitted};
}

test('unsupported material contract is rejected before draft, budget reservation or submission', async t => {
  const f=await fixture(t), m=materialFixture(f), before=fs.readFileSync(taskPaths(f.root,f.id).state,'utf8');
  f.client.materialCapabilities=async()=>({version:1,schemaVersion:14});
  const result=await f.start(day(0),{materials:m.materials});
  assert.equal(result.action,'blocked');assert.equal(result.code,'LONGRUN_MATERIAL_UNSUPPORTED');
  assert.equal(f.submissions(),0);assert.equal(loadState(f.root,f.id).round,0);
  assert.equal(fs.readFileSync(taskPaths(f.root,f.id).state,'utf8'),before);
  assert.equal(fs.existsSync(path.join(taskPaths(f.root,f.id).runs,'R0001/draft.json')),false);
});

test('explicit frozen materials retain the original inputs and only longrun settles artifacts', async t => {
  const f=await fixture(t), m=materialFixture(f);
  assert.equal((await f.start(day(0),{materials:m.materials})).action,'opened');
  const contract=f.plan().executionContract;
  assert.equal(contract.profile,'frozen-project-materials@1');assert.equal(f.plan().definition.executionProfile,'local-worker@1');
  assert.equal(m.submitted().materials.owner.kind,'longrun');assert.equal(m.submitted().materials.owner.contractHash,contract.hash);
  assert.equal(m.submitted().materials.allowApply,false);assert.equal(m.submitted().materials.workspaceSourceId,'inputs');
  assert.equal(m.submitted().managedJobs,false);
  fs.writeFileSync(path.join(f.root,'source.md'),'Changed after freezing'); f.writeResult();
  const result=await f.collect();assert.equal(result.record.status,'settled');
  assert.equal(fs.readFileSync(path.join(f.root,'source.md'),'utf8'),'Changed after freezing');
  const receipt=JSON.parse(fs.readFileSync(path.join(taskPaths(f.root,f.id).runs,'R0001/settlement.json'),'utf8'));
  assert.equal(receipt.contractHash,contract.hash);
  assert.equal((await f.collect()).action,'none');
});

test('material preparation lineage may advance under the same frozen contract', async t => {
  const f=await fixture(t), m=materialFixture(f);await f.start(day(0),{materials:m.materials});f.writeResult();
  const previous=structuredClone(m.evidence.workspace);
  m.evidence.workspace={...previous,generation:1,previousProvisionId:previous.provisionId,provisionId:'provision-1',preparationId:'prepare-1'};
  m.evidence.workspaceHistory=[{preparationId:'prepare-1',workspace:previous}];
  m.evidence.workspacePreparation={id:'prepare-1',status:'ready',materialId:'inputs',previousProvisionId:previous.provisionId,workspace:m.evidence.workspace};
  assert.equal((await f.collect()).record.status,'settled');
  const binding=JSON.parse(fs.readFileSync(path.join(taskPaths(f.root,f.id).runs,'R0001/binding.json'),'utf8'));
  assert.equal(binding.workspaceLineage.length,2);assert.equal(binding.workspaceLineage[1].generation,1);
});

test('preparation waiting is not business collection and retains the original execution deadline', async t => {
  const f=await fixture(t), m=materialFixture(f);await f.start(day(0),{materials:m.materials});
  const state=loadState(f.root,f.id);state.running.executionSince=day(0).toISOString();state.running.phase='running';saveState(f.root,state);
  f.status('waiting');m.evidence.workspacePreparation={status:'queued',createdAt:new Date(+day(0)+1000).toISOString()};
  const pending=await f.collect(new Date(+day(0)+2000));
  assert.equal(pending.action,'pending');assert.equal(pending.ticket,'preparing');assert.equal(f.cancellations(),0);
  assert.equal(loadState(f.root,f.id).running.executionSince,day(0).toISOString());
  m.evidence.workspacePreparation.status='ready';f.status('running');
  assert.equal((await f.collect(new Date(+day(0)+3000))).action,'pending');
  assert.equal(loadState(f.root,f.id).running.executionSince,day(0).toISOString());
  m.evidence.workspacePreparation.status='blocked';f.status('waiting');
  const expired=await f.collect(new Date(+day(0)+61*60000));
  assert.equal(expired.record.status,'failed');assert.equal(f.cancellations(),1);
  assert.equal(loadState(f.root,f.id).round,1);
});

test('new material contract blocks missing workspace and material evidence instead of falling back to root', async t => {
  const f=await fixture(t), m=materialFixture(f);await f.start(day(0),{materials:m.materials});f.writeResult();
  const previous=m.evidence.workspace;m.evidence.workspace=null;
  let result=await f.collect();assert.equal(result.action,'blocked');assert.match(result.error,/workspace/);
  assert.equal(loadState(f.root,f.id).running.ticketId,`ticket-${f.id}-1`);
  assert.deepEqual(fs.readdirSync(taskPaths(f.root,f.id).artifacts),[]);
  m.evidence.workspace={...previous,generation:2,previousProvisionId:'unknown'};
  result=await f.collect();assert.equal(result.action,'blocked');assert.match(result.error,/lineage/);
  m.evidence.workspace={...previous,materialSnapshotDigest:'c'.repeat(64)};
  result=await f.collect();assert.equal(result.action,'blocked');assert.match(result.error,/lineage/);
});

test('new material contract keeps unknown submission ownership and rejects live/cross-project widening', async t => {
  const f=await fixture(t), m=materialFixture(f);
  const other=structuredClone(m.materials);other.sources[0].source.root='/another/project';
  assert.equal((await f.start(day(0),{materials:other})).action,'blocked');assert.equal(f.submissions(),0);
  f.client.submit=async()=>{throw new Error('unknown after submission');};
  assert.equal((await f.start(day(0),{materials:m.materials})).action,'blocked');
  assert.equal(loadState(f.root,f.id).running.phase,'needs_attention');
  assert.equal((await f.start(day(0),{materials:m.materials})).action,'hold');
});

test('material source and output contract tampering blocks settlement without resetting round ownership', async t => {
  const f=await fixture(t), m=materialFixture(f);await f.start(day(0),{materials:m.materials});f.writeResult();
  const draftFile=path.join(taskPaths(f.root,f.id).runs,'R0001/draft.json'), frozen=f.plan();
  frozen.inputs[0].content='Changed frozen input';fs.writeFileSync(draftFile,json(frozen));
  const result=await f.collect();assert.equal(result.action,'blocked');assert.match(result.error,/contract changed/);
  assert.equal(loadState(f.root,f.id).round,1);assert.equal(f.submissions(),1);
});

test('waiting time does not consume resumed execution timeout', async t => {
  const f = await fixture(t); await f.start();
  // Simulate the durable waiting checkpoint; no report-mode attention is fabricated.
  const state = loadState(f.root, f.id);
  state.running.phase = 'awaiting_input';
  state.running.executionSince = day(0).toISOString();
  state.running.reviewSince = day(0).toISOString();
  saveState(f.root, state);
  f.status('running');
  const result = await f.collect(day(2));
  assert.equal(result.action, 'pending');
  assert.equal(f.cancellations(), 0);
  assert.equal(loadState(f.root, f.id).running.executionSince, day(2).toISOString());
});

function reviewSnapshot(f, items, { at = day(0), attentionId = 'question-1' } = {}) {
  const ticketId = loadState(f.root, f.id).running.ticketId;
  const body = json({ schemaVersion: 1, items });
  const capture = { ticketId, attentionId, at: at.toISOString(),
    files: [{ path: f.plan().plan.attentionSnapshotPaths[0], content: body, sha256: hash(body) }],
    decision: { items: items.map(row => ({ id: row.runId ? `${row.runId}:${row.id}` : row.id, title: row.title, summary: row.summary })),
      options: [{ id: 'adopted', label: '采纳' }, { id: 'rejected', label: '拒绝' }, { id: 'later', label: '稍后' }], reason: 'required' } };
  const snapshot = { status: 'waiting', workspacePath: f.workspace, answers: [], attentionSnapshots: [capture] };
  f.client.snapshot = async () => structuredClone(snapshot);
  return { snapshot, complete(decided, { now = new Date(+at + 60000), memory = '# Memory\nDecisions recorded.\n' } = {}) {
    f.writeResult({ schemaVersion: 1, items: decided }, memory);
    snapshot.status = 'completed';
    snapshot.answers = [{ ticketId, attentionId, at: now.toISOString(), kind: 'structured', via: 'feishu-card',
      answers: Object.fromEntries(decided.map(row => [row.runId ? `${row.runId}:${row.id}` : row.id, { option: row.status, reason: row.reason }])) }];
  } };
}
function reviewRows() {
  return ['First proposal', 'Second proposal'].map((title, index) => ({ id: `I000${index + 1}`, title,
    summary: `${title} summary`, evidence: [{ path: 'source.md', quote: 'A frozen fact.' }], status: 'pending' }));
}

test('review round waits for real host evidence then rereviews one deferred item without changing other items or budget', async t => {
  const f = await fixture(t, { type: 'review-items@1' }); await f.start();
  const rows = reviewRows(); f.writeResult({ schemaVersion: 1, items: rows });
  const first = reviewSnapshot(f, rows);
  assert.equal((await f.collect()).action, 'awaiting_review');
  assert.equal(loadState(f.root, f.id).running.phase, 'awaiting_input');
  const firstDecision = rows.map(row => ({ ...row, status: 'later', reason: 'Reconsider later' }));
  first.complete(firstDecision);
  const definitionPath = taskPaths(f.root, f.id).definition;
  const originalDefinition = fs.readFileSync(definitionPath, 'utf8');
  fs.writeFileSync(definitionPath, '{broken while waiting');
  assert.equal((await f.collect()).record.status, 'settled', 'current definition cannot reinterpret frozen review');
  fs.writeFileSync(definitionPath, originalDefinition);
  const paths = taskPaths(f.root, f.id), before = JSON.parse(fs.readFileSync(path.join(paths.artifacts, 'items.json')));
  const beforeState = loadState(f.root, f.id);
  assert.equal((await f.start(day(1), { kind: 'review', selectedKeys: ['R0001:I0001'] })).runId, 'RV0001');
  const selected = f.plan().selectedItems.map(row => { const { reason, ...rest } = row; return { ...rest, status: 'pending' }; });
  const memoryBefore = fs.readFileSync(path.join(paths.artifacts, 'memory.md'), 'utf8');
  f.writeResult({ schemaVersion: 1, items: selected }, memoryBefore);
  const again = reviewSnapshot(f, selected, { at: day(1), attentionId: 'question-2' });
  assert.equal((await f.collect(day(1))).action, 'awaiting_review');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.artifacts, 'items.json'))), before, 'official decisions unchanged until new review settles');
  again.complete(selected.map(row => ({ ...row, status: 'adopted', reason: 'Now useful' })), { memory: memoryBefore + '\nAdopted first proposal.\n' });
  assert.equal((await f.collect(day(1))).record.status, 'settled');
  const after = JSON.parse(fs.readFileSync(path.join(paths.artifacts, 'items.json')));
  assert.equal(after[0].runId, 'R0001'); assert.equal(after[0].id, 'I0001'); assert.equal(after[0].status, 'adopted');
  assert.deepEqual(after[1], before[1]);
  const afterState = loadState(f.root, f.id);
  assert.equal(afterState.round, beforeState.round); assert.deepEqual(afterState.week, beforeState.week);
  assert.equal(afterState.nextDueAt, beforeState.nextDueAt);
});

test('unanswered review expires to deferred items and rereview expiry preserves original decisions and memory', async t => {
  const f = await fixture(t, { type: 'review-items@1' }); await f.start();
  const rows = reviewRows(); f.writeResult({ schemaVersion: 1, items: rows });
  reviewSnapshot(f, rows);
  assert.equal((await f.collect(day(8))).record.status, 'expired');
  const paths = taskPaths(f.root, f.id), before = JSON.parse(fs.readFileSync(path.join(paths.artifacts, 'items.json')));
  assert.ok(before.every(row => row.status === 'later'));
  assert.equal(f.cancellations(), 1);
  const memory = fs.readFileSync(path.join(paths.artifacts, 'memory.md'), 'utf8');
  await f.start(day(9), { kind: 'review', selectedKeys: ['R0001:I0001'] });
  const selected = f.plan().selectedItems.map(row => { const { reason, ...rest } = row; return { ...rest, status: 'pending' }; });
  f.writeResult({ schemaVersion: 1, items: selected }, memory + '\nUnconfirmed speculation');
  reviewSnapshot(f, selected, { at: day(9), attentionId: 'expired-again' });
  assert.equal((await f.collect(day(17))).record.status, 'expired');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(paths.artifacts, 'items.json'))), before);
  assert.equal(fs.readFileSync(path.join(paths.artifacts, 'memory.md'), 'utf8'), memory);
});

test('review cannot settle a changed item even when its decision matches the answer', async t => {
  const f = await fixture(t, { type: 'review-items@1' }); await f.start();
  const rows = reviewRows(); f.writeResult({ schemaVersion: 1, items: rows });
  const r = reviewSnapshot(f, rows);
  r.complete(rows.map((row, index) => ({ ...row, title: index ? row.title : 'Replacement proposal', status: 'adopted', reason: 'User choice' })));
  const result = await f.collect();
  assert.equal(result.record.status, 'invalid');
  assert.match(result.record.errors.join('\n'), /快照不一致|显示内容/);
  assert.deepEqual(fs.readdirSync(taskPaths(f.root, f.id).artifacts), []);
});

test('re-review binds each original run evidence even after source revisions and removal', async t => {
  const f = await fixture(t, { type: 'review-items@1' });
  await f.start();
  const firstRows = reviewRows().slice(0, 1);
  f.writeResult({ schemaVersion: 1, items: firstRows });
  reviewSnapshot(f, firstRows).complete(firstRows.map(row => ({ ...row, status: 'later', reason: 'Keep first revision' })));
  await f.collect();
  fs.writeFileSync(path.join(f.root, 'source.md'), '# Source\nA later revised fact.\n');
  await f.start(day(4));
  const secondRows = [{ ...firstRows[0], title: 'Later revision proposal', summary: 'Uses later source', evidence: [{ path: 'source.md', quote: 'A later revised fact.' }] }];
  f.writeResult({ schemaVersion: 1, items: secondRows });
  reviewSnapshot(f, secondRows, { at: day(4), attentionId: 'revision-2' }).complete(secondRows.map(row => ({ ...row, status: 'later', reason: 'Keep second revision' })));
  assert.equal((await f.collect(day(4))).record.status, 'settled');
  fs.rmSync(path.join(f.root, 'source.md'));
  assert.equal((await f.start(day(5), { kind: 'review', selectedKeys: ['R0001:I0001', 'R0002:I0001'] })).action, 'opened');
  const plan = f.plan();
  assert.match(plan.sourceInputs.R0001[0].content, /A frozen fact/);
  assert.match(plan.sourceInputs.R0002[0].content, /A later revised fact/);
  const pending = plan.selectedItems.map(row => { const { reason, ...rest } = row; return { ...rest, status: 'pending' }; });
  const memory = fs.readFileSync(path.join(taskPaths(f.root, f.id).artifacts, 'memory.md'), 'utf8');
  f.writeResult({ schemaVersion: 1, items: pending }, memory);
  const re = reviewSnapshot(f, pending, { at: day(5), attentionId: 'review-both' });
  assert.equal((await f.collect(day(5))).action, 'awaiting_review');
  re.complete(pending.map(row => ({ ...row, status: 'adopted', reason: 'Reviewed original evidence' })), { memory: memory + '\nReviewed both original inputs.\n' });
  assert.equal((await f.collect(day(5))).record.status, 'settled');
  const saved = JSON.parse(fs.readFileSync(path.join(taskPaths(f.root, f.id).artifacts, 'items.json')));
  assert.deepEqual(saved.map(row => `${row.runId}:${row.id}`), ['R0001:I0001', 'R0002:I0001']);
  assert.ok(saved.every(row => row.status === 'adopted'));
});
