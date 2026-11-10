import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getType, listTypes, itemKey } from '../src/types/index.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const options = [{ id: 'adopted', label: '采纳' }, { id: 'rejected', label: '拒绝' }, { id: 'later', label: '稍后' }];
const input = { path: 'notes/source.md', content: 'A supported fact.\nAnother supported fact.\n' };
input.sha256 = sha(input.content);
const reportType = getType('change-report@1'), reviewType = getType('review-items@1');
const item = (id = 'I0001', title = 'A proposal') => ({ id, title, summary: 'A proposal grounded in local notes', evidence: [{ path: input.path, quote: 'A supported fact.' }], status: 'pending' });
function context(type = 'review-items@1') {
  return { definition: { id: 'example-task', type, review: { mode: type === 'review-items@1' ? 'items' : 'none', allowReReview: type === 'review-items@1' }, parameters: type === 'review-items@1' ? { maxItems: 5 } : {} },
    taskId: 'example-task', runId: 'R0001', kind: 'round', brief: 'Review our local notes.', inputs: [input], memory: '# Existing memory\n', previousItems: [], selectedItems: [], ticketId: 'ticket-1',
    memoryOutput: '# Updated memory\n', allowPending: false, snapshot: { status: 'completed', answers: [], attentionSnapshots: [] } };
}
function capture(ctx, rows, overrides = {}) {
  const content = JSON.stringify({ schemaVersion: 1, items: rows });
  return { ticketId: ctx.ticketId, attentionId: 'attention-1', at: '2026-11-09T01:00:00Z',
    files: [{ path: `research/longrun/${ctx.taskId}/runs/${ctx.runId}/result.json`, content, sha256: sha(content) }],
    decision: { items: rows.map(row => ({ id: ctx.kind === 'review' ? itemKey(row) : row.id, title: row.title, summary: row.summary })), options, reason: 'required' }, ...overrides };
}
function reviewed(patch = {}) {
  const ctx = Object.assign(context(), patch), pending = patch.pending ?? [item()];
  ctx.result = { schemaVersion: 1, items: pending.map(row => ({ ...row, status: 'adopted', reason: 'Worth keeping' })) };
  ctx.snapshot.attentionSnapshots = [capture(ctx, pending)];
  ctx.snapshot.answers = [{ ticketId: ctx.ticketId, attentionId: 'attention-1', at: '2026-11-09T01:01:00Z', kind: 'structured',
    answers: Object.fromEntries(ctx.result.items.map(row => [ctx.kind === 'review' ? itemKey(row) : row.id, { option: row.status, reason: row.reason }])) }];
  return ctx;
}
function validReport() { return { ...context('change-report@1'), result: { schemaVersion: 1, summary: 'A change was found', report: '# Report\nA supported fact.', changed: true, evidence: [{ path: input.path, quote: 'A supported fact.' }] } }; }
const errors = checked => checked.errors.join('\n');

test('registry exposes only registered local task types', () => {
  assert.deepEqual(listTypes().map(type => type.id).sort(), ['change-report@1', 'review-items@1']);
  assert.throws(() => getType('../../unknown.mjs'), /未注册/);
});

test('report plans local evidence work without topics, candidates, tools or snapshots', () => {
  const plan = reportType.prepareRun(context('change-report@1'));
  assert.equal(plan.allowedPaths.length, 2); assert.deepEqual(plan.attentionSnapshotPaths, []);
  assert.match(plan.text, /不联网/); assert.match(plan.text, /不启动受管任务/);
  assert.doesNotMatch(plan.text, /data\/topics.json|x-video-topic-radar/);
  assert.throws(() => reportType.prepareRun({ ...context('change-report@1'), kind: 'review' }), /不支持重新审核/);
});

test('report evidence validation and settlement use only instance-relative artifacts', () => {
  const ctx = validReport(), checked = reportType.validateResult(ctx);
  assert.equal(checked.ok, true, errors(checked));
  const plan = reportType.planSettlement({ ...ctx, validated: checked });
  assert.deepEqual(plan.artifacts.map(file => file.path), ['reports/R0001.md', 'reports/R0001.json', 'latest-report.json', 'memory.md']);
  assert.equal(JSON.parse(plan.artifacts[2].content).runId, 'R0001');
});

for (const [name, mutate, pattern] of [
  ['unknown evidence', ctx => { ctx.result.evidence[0].path = 'secret.env'; }, /冻结输入/],
  ['fabricated quotation', ctx => { ctx.result.evidence[0].quote = 'Not found in evidence'; }, /引用不在/],
  ['changed result without evidence', ctx => { ctx.result.evidence = []; }, /缺少/],
  ['damaged frozen input', ctx => { ctx.inputs = [{ ...input, sha256: 'bad' }]; }, /哈希/],
  ['missing memory', ctx => { ctx.memoryOutput = ''; }, /memory/],
  ['unexpected report review', ctx => { ctx.snapshot.status = 'waiting'; }, /不能等待/],
]) test(`report rejects ${name}`, () => {
  const ctx = validReport(); mutate(ctx); const checked = reportType.validateResult(ctx);
  assert.equal(checked.ok, false); assert.match(errors(checked), pattern);
});

test('an unchanged empty-input report can settle without fake evidence', () => {
  const ctx = validReport(); ctx.inputs = []; ctx.result.changed = false; ctx.result.evidence = [];
  assert.equal(reportType.validateResult(ctx).ok, true);
});

test('review plan binds snapshot paths to this instance and describes exact card contract', () => {
  const plan = reviewType.prepareRun(context());
  assert.deepEqual(plan.attentionSnapshotPaths, ['research/longrun/example-task/runs/R0001/result.json']);
  assert.match(plan.text, /reason 为 required/); assert.match(plan.text, /不提前声称正式入库/);
  assert.throws(() => reviewType.prepareRun({ ...context(), taskId: '../bad' }), /identity/);
});

test('fast structured answer validates from host snapshot without an earlier collect', () => {
  const ctx = reviewed(), checked = reviewType.validateResult(ctx);
  assert.equal(checked.ok, true, errors(checked)); assert.equal(checked.review.source, 'host-attention-snapshot');
  const plan = reviewType.planSettlement({ ...ctx, validated: checked.value });
  const rows = JSON.parse(plan.artifacts[0].content);
  assert.equal(rows[0].runId, 'R0001'); assert.equal(rows[0].status, 'adopted');
});

test('waiting review preserves pending items and requires pre-publication evidence', () => {
  const ctx = reviewed(); ctx.allowPending = true; ctx.snapshot.status = 'waiting'; ctx.snapshot.answers = []; ctx.result.items = [item()];
  assert.equal(reviewType.validateResult(ctx).ok, true);
  ctx.snapshot.attentionSnapshots = [];
  assert.match(errors(reviewType.validateResult(ctx)), /宿主内容快照/);
});

for (const [name, mutate, pattern] of [
  ['mutated candidate', ctx => { ctx.result.items[0].title = 'Replaced proposal'; }, /快照不一致/],
  ['missing snapshot', ctx => { ctx.snapshot.attentionSnapshots = []; }, /缺少/],
  ['corrupt snapshot hash', ctx => { ctx.snapshot.attentionSnapshots[0].files[0].sha256 = 'bad'; }, /哈希/],
  ['swapped ticket', ctx => { ctx.snapshot.attentionSnapshots[0].ticketId = 'other-ticket'; }, /工单/],
  ['swapped question', ctx => { ctx.snapshot.answers[0].attentionId = 'other-question'; }, /问题/],
  ['answer before snapshot', ctx => { ctx.snapshot.answers[0].at = '2026-11-09T00:00:00Z'; }, /时间/],
  ['different decision', ctx => { ctx.result.items[0].status = 'rejected'; }, /决定或理由/],
  ['rewritten reason', ctx => { ctx.result.items[0].reason = 'Paraphrased reason'; }, /决定或理由/],
  ['missing structured answer', ctx => { ctx.snapshot.answers[0].kind = 'text'; }, /结构化/],
  ['answer extra item', ctx => { ctx.snapshot.answers[0].answers.I0002 = { option: 'later', reason: 'Unasked' }; }, /全部且仅覆盖/],
  ['changed option label', ctx => { ctx.snapshot.attentionSnapshots[0].decision.options = options.map(o => o.id === 'adopted' ? { ...o, label: '拒绝' } : o); }, /卡片显示/],
  ['first snapshot already decided', ctx => { ctx.snapshot.attentionSnapshots[0] = capture(ctx, ctx.result.items); }, /首次快照/],
  ['unknown result field', ctx => { ctx.result.items[0].command = 'run this'; }, /不支持的字段/],
]) test(`review rejects ${name}`, () => {
  const ctx = reviewed(); mutate(ctx); const checked = reviewType.validateResult(ctx);
  assert.equal(checked.ok, false); assert.match(errors(checked), pattern);
});

test('empty completed review-item round needs neither card nor answer', () => {
  const ctx = context(); ctx.result = { schemaVersion: 1, items: [] };
  assert.equal(reviewType.validateResult(ctx).ok, true);
  ctx.snapshot.status = 'waiting'; ctx.allowPending = true;
  assert.equal(reviewType.validateResult(ctx).ok, false);
});

test('malformed model rows and host captures return validation errors instead of throwing', () => {
  const ctx = reviewed(); ctx.result.items = [null];
  assert.equal(reviewType.validateResult(ctx).ok, false);
  const other = reviewed();
  const content = JSON.stringify({ schemaVersion: 1, items: [null] });
  Object.assign(other.snapshot.attentionSnapshots[0].files[0], { content, sha256: sha(content) });
  assert.equal(reviewType.validateResult(other).ok, false);
  other.snapshot.attentionSnapshots = [null];
  assert.equal(reviewType.validateResult(other).ok, false);
});

test('normal rounds deduplicate prior titles while keeping local item IDs scoped by run', () => {
  const ctx = reviewed(); ctx.previousItems = [{ ...item(), runId: 'R0000', status: 'later', reason: 'Prior' }];
  assert.match(errors(reviewType.validateResult(ctx)), /已有项目标题重复/);
  ctx.previousItems[0].title = 'Different old proposal';
  const checked = reviewType.validateResult(ctx); assert.equal(checked.ok, true, errors(checked));
  const rows = JSON.parse(reviewType.planSettlement({ ...ctx, validated: checked }).artifacts[0].content);
  assert.deepEqual(rows.map(itemKey), ['R0000:I0001', 'R0001:I0001']);
});

function rereviewContext() {
  const before = [{ ...item(), runId: 'R0001', status: 'later', reason: 'Old decision' }, { ...item('I0001', 'Other proposal'), runId: 'R0002', status: 'later', reason: 'Keep this untouched' }];
  const { reason, ...raw } = before[0];
  return reviewed({ kind: 'review', runId: 'RV0001', previousItems: before, selectedItems: [before[0]], pending: [{ ...raw, status: 'pending' }], memoryOutput: '# Existing memory\n\nNew decision\n' });
}

test('rereview uses composite card IDs and changes only selected old decisions', () => {
  const ctx = rereviewContext(), plan = reviewType.prepareRun(ctx);
  assert.match(plan.text, /R0001:I0001/); assert.equal(plan.initialFiles.length, 2);
  const checked = reviewType.validateResult(ctx); assert.equal(checked.ok, true, errors(checked));
  const rows = JSON.parse(reviewType.planSettlement({ ...ctx, validated: checked }).artifacts[0].content);
  assert.equal(rows[0].status, 'adopted'); assert.equal(rows[0].runId, 'R0001');
  assert.deepEqual(rows[1], ctx.previousItems[1]);
});

test('rereview rejects content, source identity and historical memory changes', () => {
  const ctx = rereviewContext(); ctx.result.items[0].runId = 'R0002';
  assert.match(errors(reviewType.validateResult(ctx)), /重新审核不能改变/);
  const other = rereviewContext(); other.memoryOutput = '# Replaced history';
  assert.match(errors(reviewType.validateResult(other)), /只能追加记忆/);
});

test('expiry defers new proposals but preserves old rereview decisions and memory', () => {
  const ctx = reviewed(); ctx.result.items = [item()]; ctx.allowPending = true; ctx.snapshot.status = 'waiting'; ctx.snapshot.answers = [];
  const checked = reviewType.validateResult(ctx); assert.equal(checked.ok, true, errors(checked));
  const plan = reviewType.planSettlement({ ...ctx, expired: true, validated: checked });
  assert.equal(JSON.parse(plan.artifacts[0].content)[0].status, 'later');
  assert.equal(plan.artifacts[1].content, ctx.memory);
  const review = rereviewContext(); review.result.items[0].status = 'pending'; delete review.result.items[0].reason; review.allowPending = true; review.snapshot.answers = []; review.snapshot.status = 'waiting';
  const valid = reviewType.validateResult(review); assert.equal(valid.ok, true, errors(valid));
  const expired = reviewType.planSettlement({ ...review, expired: true, validated: valid });
  assert.deepEqual(JSON.parse(expired.artifacts[0].content), review.previousItems);
});

test('rereview validates evidence against each original run snapshot, not changed current inputs', () => {
  const ctx = rereviewContext();
  ctx.inputs = [{ path: input.path, content: 'Updated input no longer contains original quote.', sha256: sha('Updated input no longer contains original quote.') }];
  ctx.sourceInputs = { R0001: [input] };
  const checked = reviewType.validateResult(ctx);
  assert.equal(checked.ok, true, errors(checked));
  assert.match(reviewType.prepareRun(ctx).text, /证据按原始 runId/);
  delete ctx.sourceInputs;
  assert.match(errors(reviewType.validateResult(ctx)), /引用不在冻结输入/);
});
