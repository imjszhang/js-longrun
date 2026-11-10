import fs from 'node:fs';
import { listTasks, loadState, safePath } from './core/definitions.mjs';
import { tickTask, collectTask } from './core/runtime.mjs';

/** Routes are trusted host code; task definitions cannot load routes or grant permissions. */
const defaultRoutes = {
  list: listTasks,
  load: (root, row) => loadState(root, row.id),
  tick: ({ root, row, ...options }) => tickTask({ root, id: row.id, ...options }),
  collect: ({ root, row, ...options }) => collectTask({ root, id: row.id, ...options }),
  canOpen: ({ state }) => state.control === 'enabled',
  preserveInitial: () => false,
  onStart: async () => {},
  afterCollect: async () => {},
};
const message = error => String(error?.message ?? error);
const selected = (rows, ids) => ids ? rows.filter(row => ids.includes(row.id)) : rows;
function ordering(a, b) {
  return Number(!!b.state?.running) - Number(!!a.state?.running)
    || String(a.state?.nextDueAt ?? '').localeCompare(String(b.state?.nextDueAt ?? '')) || a.row.id.localeCompare(b.row.id);
}

/** Reconcile active runs first. One invalid definition cannot stop other instances. */
export async function tickProject({ root, client, now = new Date(), open = false, ids, routes = {} }) {
  const api = { ...defaultRoutes, ...routes };
  const entries = selected(api.list(root), ids).map(row => {
    try { return { row, state: api.load(root, row) }; }
    catch (error) { return { row, error }; }
  }).sort(ordering);
  const results = [];
  for (const { row, state, error } of entries) {
    try {
      if (error) throw error;
      // An already bound run owns frozen inputs even if today's definition is invalid.
      if (row.error && !state.running) throw new Error(row.error);
      const mayOpen = open && !row.error && api.canOpen({ root, row, state });
      const result = await api.tick({ root, row, client, now, open: mayOpen });
      results.push({ ...result, taskId: row.id, ...(row.error ? { definitionError: row.error } : {}) });
    } catch (error) { results.push({ taskId: row.id, action: 'error', error: message(error) }); }
  }
  return results;
}

function watchDirectory(directory, listener, onError) {
  const watcher = fs.watch(directory, (_event, filename) => listener(filename == null ? null : String(filename)));
  watcher.on('error', cause => onError(Object.assign(new Error(`Task directory watcher failed: ${directory}`, { cause }), { code: 'WATCH_FAILED' })));
  return () => watcher.close();
}

/** One SDK invalidation source for all registered tasks; never opens rounds. */
export function startProjectWatcher({ root, client, onResult = () => {}, onError = () => {},
  retryMs = 5000, debounceMs = 50, now = () => new Date(), ids, routes = {}, watchDirectory: watch = watchDirectory,
}) {
  const api = { ...defaultRoutes, ...routes }, signatures = new Map(), directoryWatches = new Map(), pendingFollowups = new Map();
  const registryDirectory = safePath(root, 'research/longrun');
  // A freshly installed consumer can start watching before creating its first
  // task. Create only the registry directory, not a task or execution runtime.
  fs.mkdirSync(registryDirectory, { recursive: true });
  let closed = false, dirty = false, timer, retryTimer, registrationTimer, draining, startupPending = true;
  function error(error, taskId) {
    try { onError(error, taskId); } catch { /* diagnostics cannot stop unrelated tasks */ }
    if (!closed && !retryTimer) retryTimer = setTimeout(() => { retryTimer = null; wake(); }, retryMs);
  }
  function updateDirectoryWatches(rows) {
    const wanted = new Map([[registryDirectory, false]]);
    for (const row of rows) {
      try {
        const directory = safePath(root, `research/longrun/${row.id}`);
        if (fs.existsSync(directory)) wanted.set(directory, true);
      } catch (cause) { error(cause, row.id); }
    }
    for (const [directory, stop] of directoryWatches) if (!wanted.has(directory)) { stop(); directoryWatches.delete(directory); }
    for (const directory of wanted.keys()) if (!directoryWatches.has(directory)) {
      // Native directory events may name a temporary/renamed file or only the
      // directory itself. Treat every event as invalidation and let signatures
      // suppress unrelated changes instead of assuming a particular filename.
      directoryWatches.set(directory, watch(directory, wake, cause => error(cause)));
      // Registration can return before the native subscription is fully armed.
      // One catch-up read closes that startup gap; this is not a polling loop.
      if (!registrationTimer) registrationTimer = setTimeout(() => {
        registrationTimer = null;
        wake();
      }, 100);
    }
  }
  async function reconcile() {
    // Host projections can be repaired after a previous process exited between
    // durable settlement and rendering. Failure must not block collection, and
    // a successful repair runs only once for this watcher instance.
    if (startupPending) {
      try { await api.onStart({ root }); startupPending = false; }
      catch (cause) { error(cause); }
    }
    const rows = selected(api.list(root), ids);
    updateDirectoryWatches(rows);
    const present = new Set(rows.map(row => row.id));
    for (const id of signatures.keys()) if (!present.has(id)) signatures.delete(id);
    for (const row of rows) {
      try {
        const state = api.load(root, row), active = state.running;
        if (!active) { signatures.delete(row.id); if (row.error) throw new Error(row.error); continue; }
        const view = active.ticketId ? await client.observe(active.ticketId) : { status: 'unbound' };
        const next = JSON.stringify([active.ticketId, active.runId, view.status, view.attentionId ?? null]);
        if (['failed', 'interrupted'].includes(view.status)) { signatures.set(row.id, next); continue; }
        if (signatures.get(row.id) === next) continue;
        // A project adapter may retain an already frozen waiting review on restart.
        // This hook is only evaluated for the first observed state of each task.
        if (!signatures.has(row.id) && api.preserveInitial({ root, row, state, view })) {
          signatures.set(row.id, next); continue;
        }
        const result = await api.collect({ root, row, client, now: now() });
        if (result.error) throw new Error(result.error);
        signatures.set(row.id, next);
        if (result.action === 'collected') pendingFollowups.set(`${row.id}:${next}`, { root, row, result });
        try { onResult({ ...result, taskId: row.id }); } catch (cause) { error(cause, row.id); }
      } catch (cause) { error(cause, row.id); }
    }
    // Derived views can fail independently of durable settlement. Keep their
    // follow-up pending and retry it without collecting the completed run again.
    for (const [key, context] of pendingFollowups) {
      try { await api.afterCollect(context); pendingFollowups.delete(key); }
      catch (cause) { error(cause, context.row.id); }
    }
  }

  function drain() {
    if (closed) return Promise.resolve();
    dirty = true;
    if (draining) return draining;
    draining = (async () => {
      while (dirty && !closed) {
        dirty = false;
        try { await reconcile(); } catch (cause) { dirty = false; error(cause); break; }
      }
    })().finally(() => { draining = null; });
    return draining;
  }
  function wake() {
    if (closed) return;
    if (draining) { dirty = true; return; }
    if (!timer) timer = setTimeout(() => { timer = null; void drain(); }, debounceMs);
  }
  const stopSDK = client.watchChanges(wake, { onError: cause => error(cause) });
  const ready = drain();
  return {
    ready, wake,
    async close() {
      if (closed) { await draining; return; }
      closed = true; clearTimeout(timer); clearTimeout(retryTimer); clearTimeout(registrationTimer); stopSDK();
      for (const stop of directoryWatches.values()) stop();
      directoryWatches.clear(); await draining;
    },
  };
}
