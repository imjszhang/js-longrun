import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { processIdentity, ownerState } from './process-identity.mjs';
export { processIdentity, ownerState } from './process-identity.mjs';
import { DatabaseSync } from 'node:sqlite';

// Native lock handles must survive suspended async frames until explicit release.
const activeRuntimeConnections = new Set();

export function serviceError(code, message) { return Object.assign(new Error(message), { code }); }

/** Reject links and non-directory parents before opening control files. */
export function checkedPath(file, { directory = false, allowHardLinks = false } = {}) {
  const absolute = path.resolve(file), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const final = current === absolute;
    if (stat.isSymbolicLink() || ((!final || directory) && !stat.isDirectory()) || (final && !directory && !stat.isFile())) {
      throw serviceError('LONGRUN_UNSAFE_PATH', 'Runtime paths must use regular files and real directories');
    }
    if (final && !directory && !allowHardLinks && stat.nlink !== 1) throw serviceError('LONGRUN_UNSAFE_PATH', 'Runtime files must not be hard-linked');
  }
  return absolute;
}

export function readRuntimeJSON(file) {
  checkedPath(file);
  try {
    const stat = fs.statSync(file);
    if (stat.size > 1024 * 1024) throw serviceError('LONGRUN_INVALID_RUNTIME', 'Runtime record is too large');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function writeRuntimeJSON(file, value) {
  checkedPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

/** Pure path discovery. It neither creates a deployment nor initializes a task/SDK. */
export function resolveRuntimeLayout({ projectRoot, runtimeHome = process.env.JS_LONGRUN_HOME } = {}) {
  const root = fs.realpathSync(path.resolve(projectRoot ?? process.cwd()));
  if (!fs.statSync(root).isDirectory()) throw serviceError('LONGRUN_INVALID_PROJECT', 'Project root must be a directory');
  const key = `${path.basename(root).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40) || 'project'}-${createHash('sha256').update(root).digest('hex').slice(0, 20)}`;
  const anchorDir = checkedPath(path.join(root, 'working/longrun'), { directory: true });
  const bindingPath = path.join(anchorDir, 'runtime-binding.json');
  const binding = readRuntimeJSON(bindingPath);
  if (binding && (binding.schemaVersion !== 1 || binding.projectRoot !== root || binding.key !== key || !path.isAbsolute(binding.runtimeHome ?? ''))) {
    throw serviceError('LONGRUN_RUNTIME_CONFLICT', 'Runtime binding does not belong to this project');
  }
  const home = path.resolve(runtimeHome ?? binding?.runtimeHome ?? path.join(os.homedir(), '.js-longrun'));
  checkedPath(home, { directory: true });
  const runtimeDir = path.join(home, 'projects', key);
  if (binding && (binding.runtimeHome !== home || binding.runtimeDir !== runtimeDir)) {
    throw serviceError('LONGRUN_RUNTIME_CONFLICT', 'Changing runtime home requires a stopped, explicit migration');
  }
  if (runtimeDir === root || runtimeDir.startsWith(`${root}${path.sep}`)) throw serviceError('LONGRUN_RUNTIME_CONFLICT', 'Machine runtime must be outside the project');
  checkedPath(runtimeDir, { directory: true });
  return Object.freeze({ projectRoot: root, key, runtimeHome: home, runtimeDir, anchorDir, bindingPath,
    manifestPath: path.join(runtimeDir, 'service.json'), watchPath: path.join(runtimeDir, 'watch.json'), tickPath: path.join(runtimeDir, 'tick.json'),
    ownerPath: path.join(anchorDir, 'watch-owner.json'), tickOwnerPath: path.join(anchorDir, 'tick-owner.json'),
    logDir: path.join(runtimeDir, 'logs'),
  });
}

export function ensureRuntime(layout) {
  checkedPath(layout.anchorDir, { directory: true }); checkedPath(layout.runtimeDir, { directory: true });
  fs.mkdirSync(layout.anchorDir, { recursive: true, mode: 0o700 });
  const expected = { schemaVersion: 1, projectRoot: layout.projectRoot, key: layout.key, runtimeHome: layout.runtimeHome, runtimeDir: layout.runtimeDir };
  try { fs.writeFileSync(layout.bindingPath, `${JSON.stringify(expected, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (JSON.stringify(readRuntimeJSON(layout.bindingPath)) !== JSON.stringify(expected)) throw serviceError('LONGRUN_RUNTIME_CONFLICT', 'Another runtime home is bound to this project');
  }
  fs.mkdirSync(layout.runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(layout.logDir, { recursive: true, mode: 0o700 });
}

/** OS-backed lock is anchored in the project, independent of tasksDir/runtimeHome. */
export function acquireRuntimeLock(layout, name) {
  if (!['watch', 'tick', 'control'].includes(name)) throw new Error('Invalid runtime lock');
  ensureRuntime(layout);
  const file = checkedPath(path.join(layout.anchorDir, `service-${name}-lock.sqlite3`));
  for (const suffix of ['-journal', '-wal', '-shm']) checkedPath(`${file}${suffix}`);
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA busy_timeout = 0'); db.exec('BEGIN IMMEDIATE'); }
  catch (error) {
    db.close();
    if (error.code === 'ERR_SQLITE_ERROR' && [5, 6].includes(error.errcode & 255)) throw serviceError('LONGRUN_SERVICE_BUSY', `Another ${name} operation already owns this project`);
    throw error;
  }
  activeRuntimeConnections.add(db);
  let closed = false;
  return () => { if (closed) return; closed = true; try { db.exec('ROLLBACK'); } finally { try { db.close(); } finally { activeRuntimeConnections.delete(db); } } };
}

function ownProcess(layout, kind) {
  const identity = processIdentity();
  if (!identity || identity.unknown) throw serviceError('LONGRUN_UNKNOWN_OWNER', 'Unable to establish process ownership');
  return { schemaVersion: 1, projectRoot: layout.projectRoot, runtimeDir: layout.runtimeDir, runId: randomUUID(), kind, ...identity, at: new Date().toISOString() };
}

function assertStartIntent(layout) {
  const serviceId = process.env.JS_LONGRUN_SERVICE_ID;
  if (!serviceId) return;
  const manifest = readRuntimeJSON(layout.manifestPath);
  if (manifest?.projectRoot !== layout.projectRoot || manifest.installId !== serviceId || manifest.intent !== 'running') {
    throw serviceError('LONGRUN_SERVICE_STOPPED', 'The installed service is stopped or no longer owns this entry');
  }
}

function clearOwner(file, runId) {
  if (readRuntimeJSON(file)?.runId === runId) fs.unlinkSync(file);
}

export function runtimeLogPaths(layout, component) {
  if (!['watch', 'tick'].includes(component)) throw new Error('Unknown service component');
  return { stdout: path.join(layout.logDir, `${component}.log`), stderr: path.join(layout.logDir, `${component}.err.log`) };
}

/** Keep log descriptors valid: retain the final portion in the same regular file. */
export function boundRuntimeLogs(layout, maxBytes = 5 * 1024 * 1024) {
  for (const component of ['watch', 'tick']) for (const file of Object.values(runtimeLogPaths(layout, component))) {
    checkedPath(file);
    let stat; try { stat = fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.size <= maxBytes) continue;
    const fd = fs.openSync(file, 'r+');
    try {
      const bytes = Buffer.alloc(Math.floor(maxBytes / 2));
      const count = fs.readSync(fd, bytes, 0, bytes.length, stat.size - bytes.length);
      fs.writeSync(fd, bytes, 0, count, 0); fs.ftruncateSync(fd, count);
    } finally { fs.closeSync(fd); }
  }
}

/** Acquire singleton before the caller opens an SDK client or subscribes. */
export async function runManagedWatcher({ projectRoot, runtimeHome, start, heartbeatMs = 5000 }) {
  const layout = resolveRuntimeLayout({ projectRoot, runtimeHome });
  const release = acquireRuntimeLock(layout, 'watch');
  let owner, watcher, timer, closed = false, closing;
  let snapshot;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  const onReady = () => { if (!closed) { snapshot.phase = 'ready'; onActivity({ kind: 'ready' }); resolveReady(); } };
  const persist = () => writeRuntimeJSON(layout.watchPath, { ...snapshot, heartbeatAt: new Date().toISOString(), sequence: ++snapshot.sequence });
  const onActivity = (event = {}) => {
    if (closed) return;
    snapshot.lastActivityAt = new Date().toISOString();
    if (event.kind === 'checking') snapshot.checkStartedAt = snapshot.lastActivityAt;
    if (event.kind === 'reconcile') snapshot.checkStartedAt = null;
    if (event.kind === 'reconcile' && event.ok === true) { snapshot.lastCheckAt = snapshot.lastActivityAt; snapshot.lastError = null; }
    if (event.kind === 'ready') snapshot.lastCheckAt = snapshot.lastActivityAt;
    if (event.kind === 'collected') { snapshot.lastSettlementAt = snapshot.lastActivityAt; snapshot.settlements++; }
    if (event.kind === 'error') snapshot.lastError = { at: snapshot.lastActivityAt, code: String(event.code ?? event.error?.code ?? 'LONGRUN_OBSERVATION_ERROR').slice(0, 100) };
    persist();
  };
  const close = async () => {
    if (closing) return closing;
    closed = true; clearInterval(timer);
    rejectReady(serviceError('LONGRUN_WATCH_CLOSED', 'Watcher closed before successful startup'));
    closing = (async () => {
      try { await watcher?.close(); }
      finally {
        try {
          if (snapshot) { snapshot.phase = 'stopped'; snapshot.stoppedAt = new Date().toISOString(); persist(); }
          if (owner) clearOwner(layout.ownerPath, owner.runId);
        } finally { release(); }
      }
    })();
    return closing;
  };
  try {
    assertStartIntent(layout);
    owner = ownProcess(layout, 'watch'); writeRuntimeJSON(layout.ownerPath, owner);
    snapshot = { ...owner, phase: 'starting', sequence: 0, startedAt: owner.at, lastCheckAt: null, lastError: null, settlements: 0 };
    persist();
    watcher = await start({ onReady, onActivity, onError: error => onActivity({ kind: 'error', code: error?.code }) });
    timer = setInterval(() => { try { persist(); boundRuntimeLogs(layout); } catch { /* Last persisted heartbeat becomes stale; do not hide it. */ } }, heartbeatMs); timer.unref();
    Promise.resolve(watcher.ready).catch(rejectReady);
    return { ...watcher, ready, close, layout, runId: owner.runId, onActivity };
  } catch (error) { await close(); throw error; }
}

/** Records one real tick. It never changes task enablement or manufactures work. */
export async function recordManagedTick({ projectRoot, runtimeHome, run }) {
  const layout = resolveRuntimeLayout({ projectRoot, runtimeHome });
  const release = acquireRuntimeLock(layout, 'tick');
  let owner, snapshot;
  try {
    assertStartIntent(layout);
    owner = ownProcess(layout, 'tick'); writeRuntimeJSON(layout.tickOwnerPath, owner);
    snapshot = { ...owner, phase: 'running', startedAt: owner.at };
    writeRuntimeJSON(layout.tickPath, snapshot);
    const result = await run();
    const results = Array.isArray(result) ? result : [result];
    const errors = results.filter(row => row?.action === 'error' || row?.error).length;
    writeRuntimeJSON(layout.tickPath, { ...snapshot, phase: errors ? 'degraded' : 'completed', finishedAt: new Date().toISOString(), tasks: results.length, errors });
    boundRuntimeLogs(layout);
    return result;
  } catch (error) {
    if (snapshot) writeRuntimeJSON(layout.tickPath, { ...snapshot, phase: 'failed', finishedAt: new Date().toISOString(), errorCode: String(error.code ?? 'LONGRUN_TICK_FAILED').slice(0, 100) });
    throw error;
  } finally { try { if (owner) clearOwner(layout.tickOwnerPath, owner.runId); } finally { release(); } }
}
