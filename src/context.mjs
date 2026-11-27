import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadState, readDefinition, listTasks, taskPaths } from './core/definitions.mjs';
import { resolveLayout, safePath, frozenRunLayout, withTaskLayout } from './layout.mjs';

const PRODUCER = 'js-longrun';
const EPOCH = '1970-01-01T00:00:00.000Z';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : EPOCH;
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sourceTime = files => files.reduce((at, file) => {
  try { const value = fs.statSync(file).mtime.toISOString(); return value > at ? value : at; } catch { return at; }
}, EPOCH);
function fact(scope, key, observedAt, facts, binding = {}) {
  return { scope, producer: PRODUCER, key, sourceVersion: digest(facts), observedAt: iso(observedAt), facts, ...binding };
}

/** Operational metadata only; never copies task briefs, review contents or paths. */
export function makeTaskFact({ taskId, type = null, state, observedAt = state?.updatedAt, availability = 'available', error = null }) {
  const active = state?.running, nextDueAt = state?.nextDueAt ?? state?.cooldownUntil ?? null;
  return fact('project', `task:${taskId}`, observedAt, {
    kind: 'longrun-task', taskId, type, availability, error,
    control: state?.control ?? (state?.pauseReason ? 'paused' : state ? 'legacy' : null),
    status: state?.status ?? active?.phase ?? (state ? nextDueAt ? 'scheduled' : 'idle' : null),
    round: state?.round ?? null, nextDueAt,
    running: active ? { runId: active.runId ?? active.reviewId ?? (Number.isSafeInteger(active.round) ? `R${String(active.round).padStart(4, '0')}` : null),
      kind: active.kind ?? 'round', ticketId: active.ticketId ?? null, phase: active.phase ?? active.lastStatus ?? null } : null,
  });
}

/** Historical business outcome, separate from the host's current ticket status. */
export function makeRunFact({ taskId, runId, kind = 'round', ticketId, record, domainId = record?.domainId ?? null,
  assignmentId = record?.assignmentId ?? null, observedAt = record?.finishedAt, result }) {
  return fact('ticket', `run:${taskId}:${runId}`, observedAt, {
    kind: 'longrun-outcome', taskId, runId, runKind: kind,
    status: record.status, finishedAt: iso(record.finishedAt),
    result: result ?? { summary: String(record.summary ?? '').slice(0, 1200) },
  }, { ticketId, ...(domainId ? { domainId } : {}), ...(assignmentId ? { assignmentId } : {}) });
}

/** Pure filesystem projection. It never initializes an SDK, collects or rewrites history. */
export function readTaskFacts({ root, id }) {
  return withTaskLayout(root, () => {
    const paths = taskPaths(root, id), rows = [];
    let state, definition, error;
    try { state = loadState(root, id); } catch { error = 'state-unavailable'; }
    try { definition = readDefinition(root, id); }
    catch { error ??= 'definition-unavailable'; }
    let observedAt = [iso(state?.updatedAt), sourceTime([paths.state, paths.definition])].sort().at(-1);
    for (const runId of fs.existsSync(paths.runs) ? fs.readdirSync(paths.runs).sort() : []) {
      if (!/^(R|RV)\d{4,}$/.test(runId)) continue;
      try {
        const runDirectory = safePath(root, `${resolveLayout(root).tasksDir}/${id}/runs/${runId}`);
        const outcomePath = safePath(root, path.relative(root, path.join(runDirectory, 'outcome.json')));
        if (!fs.existsSync(outcomePath)) continue;
        const frozen = readJSON(safePath(root, path.relative(root, path.join(runDirectory, 'draft.json'))));
        const layout = frozenRunLayout(frozen);
        if (frozen.taskId !== id || frozen.runId !== runId || safePath(root, layout.runBase) !== runDirectory) throw new Error('Fact source run identity mismatch');
        const record = readJSON(outcomePath), binding = readJSON(safePath(root, `${layout.runBase}/binding.json`));
        if (record.taskId !== id || record.runId !== runId || binding.taskId !== id || binding.runId !== runId || binding.ticketId !== record.ticketId) throw new Error('Fact source ticket identity mismatch');
        if (!['settled', 'expired', 'cancelled', 'failed', 'invalid', 'conflict'].includes(record.status) || !Number.isFinite(Date.parse(record.finishedAt))) throw new Error('Fact source outcome is incomplete');
        let settlement = 'not-applied';
        if (['settled', 'expired'].includes(record.status)) {
          const receipt = readJSON(safePath(root, `${layout.runBase}/settlement.json`));
          if (receipt.status !== 'applied') throw new Error('Fact source settlement is not applied');
          settlement = 'applied';
        }
        rows.push(makeRunFact({ taskId: id, runId, kind: frozen.kind, ticketId: record.ticketId,
          domainId: record.domainId ?? binding.domainId, assignmentId: record.assignmentId ?? binding.assignmentId, record,
          result: { settlement, summary: String(record.summary ?? '').slice(0, 1200), errorCount: record.errors?.length ?? 0 } }));
      } catch {
        error ??= 'run-history-unavailable';
        observedAt = [observedAt, sourceTime(['draft.json', 'binding.json', 'outcome.json', 'settlement.json']
          .map(name => path.join(paths.runs, runId, name)))].sort().at(-1);
      }
    }
    rows.unshift(makeTaskFact({ taskId: id, type: definition?.type ?? null, state, observedAt,
      availability: error ? 'unavailable' : 'available', error }));
    return rows;
  });
}

/** Capability absence is diagnostic, never a reason to resubmit or recollect work. */
export async function syncTaskFacts({ root, id, client, readFacts = readTaskFacts }) {
  if (!client?.hostFactsCapabilities || !client?.publishHostFacts) return { status: 'unavailable', reason: 'host-facts-unsupported' };
  try {
    if ((await client.hostFactsCapabilities())?.version !== 1) return { status: 'unavailable', reason: 'host-facts-unsupported' };
    const rows = await readFacts({ root, id });
    let published = 0, unresolved = 0, stale = 0, observedAt = EPOCH;
    for (const source of rows) {
      const row = structuredClone(source);
      observedAt = [observedAt, iso(row.observedAt)].sort().at(-1);
      if (row.scope === 'ticket' && (!row.domainId || !row.assignmentId)) {
        const identity = await client.identity?.(row.ticketId), ref = identity?.hostReference;
        const matches = ref?.producer === row.producer && ref.taskId === row.facts.taskId && ref.runId === row.facts.runId && ref.kind === row.facts.runKind;
        // Reference tuples describe the original submission, not necessarily
        // today's assignment after continuation/retry. Never substitute current.
        const domainId = matches ? identity.hostReferenceDomainId : !ref ? identity?.initialDomainId : null;
        const assignmentId = matches ? identity.hostReferenceAssignmentId : !ref ? identity?.initialAssignmentId : null;
        if (!domainId || !assignmentId || row.domainId && row.domainId !== domainId || row.assignmentId && row.assignmentId !== assignmentId) { unresolved++; continue; }
        row.domainId = domainId; row.assignmentId = assignmentId;
      }
      const receipt = await client.publishHostFacts(row);
      if (receipt?.status === 'unavailable') return { status: 'unavailable', reason: 'host-facts-unsupported' };
      if (receipt?.status === 'stale') stale++;
      else if (!['stored', 'unchanged'].includes(receipt?.status)) throw new Error('Invalid host fact receipt');
      else published++;
    }
    return { status: unresolved || stale ? 'partial' : 'synced', published, unresolved, stale, observedAt };
  } catch { return { status: 'pending', reason: 'host-facts-sync-failed' }; }
}

/** All registered tasks, including idle ones. Host routes keep legacy business in its owner. */
export async function syncProjectFacts({ root, client, routes = {}, rows, ids } = {}) {
  const read = routes.facts ?? (({ root, row }) => readTaskFacts({ root, id: row.id }));
  if (!client?.hostFactsCapabilities || !client?.publishHostFacts) return { status: 'unavailable', reason: 'host-facts-unsupported' };
  try {
    if ((await client.hostFactsCapabilities())?.version !== 1) return { status: 'unavailable', reason: 'host-facts-unsupported' };
  } catch { return { status: 'pending', reason: 'host-facts-sync-failed' }; }
  let entries, listError = false;
  try { entries = rows ?? (routes.list ?? listTasks)(root); }
  catch { entries = []; listError = true; }
  const tasks = [];
  for (const row of entries.filter(row => !ids || ids.includes(row.id))) {
    tasks.push({ taskId: row.id, ...await syncTaskFacts({ root, id: row.id, client,
      readFacts: () => read({ root, row }) }) });
  }
  const taskStatus = () => tasks.some(row => row.status === 'pending') ? 'pending' : tasks.some(row => row.status !== 'synced') ? 'partial' : 'synced';
  if (ids) return { status: listError ? 'pending' : taskStatus(), ...(listError ? { reason: 'task-list-unavailable' } : {}), tasks };
  try {
    // Inventory distinguishes a checked empty project from no observation. The
    // task cards hold individual state; no business state is inferred here.
    // Inventory availability is an observation of this list attempt, unlike
    // authoritative task/outcome timestamps. The stored prior time closes a
    // same-millisecond failure/recovery gap; identical semantics remain a no-op.
    const previous = (await client.listHostFacts?.({ scope: 'project', producer: PRODUCER }))?.find(row => row.key === 'inventory');
    const priorTime = Date.parse(previous?.observedAt);
    const observedAt = new Date(Math.max(Date.now(), Number.isFinite(priorTime) ? priorTime + 1 : 0)).toISOString();
    // A partial/failed list must never masquerade as a verified empty registry.
    // SDK payloads are bounded; large registries retain individually keyed facts.
    const taskIds = entries.map(row => row.id).sort();
    const receipt = await client.publishHostFacts(fact('project', 'inventory', observedAt, { kind: 'longrun-inventory',
      availability: listError ? 'unavailable' : 'available', complete: !ids && !listError && taskIds.length <= 100,
      taskIds: taskIds.slice(0, 100), taskCount: taskIds.length }));
    if (receipt?.status === 'unavailable') return { status: 'unavailable', reason: 'host-facts-unsupported', tasks };
    if (!['stored', 'unchanged'].includes(receipt?.status)) return { status: 'partial', reason: 'inventory-not-current', tasks };
  } catch { return { status: 'pending', reason: 'host-facts-sync-failed', tasks }; }
  if (listError) return { status: 'pending', reason: 'task-list-unavailable', tasks };
  return { status: taskStatus(), tasks };
}
