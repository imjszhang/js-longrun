import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { checkedPath } from './service-runtime.mjs';

// A suspended async callback may have no reachable resolver. V8 can then collect
// its frame even while the process remains alive; DatabaseSync's finalizer would
// release the OS lock. Keep ownership rooted until our explicit finally closes it.
const activeConnections = new Set();

// This database holds only an OS-backed advisory lock, never business data. A
// separate connection per operation also serializes callers in the same process.
// SQLite releases the lock when a holder exits, including an unclean exit.
function openLock(root) {
  const dir = checkedPath(path.join(fs.realpathSync(root), 'working/longrun'), { directory: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = checkedPath(path.join(dir, 'control-lock.sqlite3'));
  for (const suffix of ['-journal', '-wal', '-shm']) checkedPath(`${file}${suffix}`);
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA busy_timeout = 0'); }
  catch (error) { db.close(); throw error; }
  activeConnections.add(db);
  return db;
}

function tryAcquire(db) {
  try { db.exec('BEGIN IMMEDIATE'); return true; }
  catch (error) {
    if (error.code === 'ERR_SQLITE_ERROR' && [5, 6].includes(error.errcode & 255)) return false;
    throw error;
  }
}

export class LongrunBusy extends Error {
  constructor() {
    super('长期任务正在更新，请稍后重试');
    this.code = 'LONGRUN_BUSY';
  }
}

/** Serialize one complete read/modify/write operation, including awaited I/O. */
export async function withLongrunLock(root, operation, { timeoutMs = 30_000, retryMs = 20 } = {}) {
  const db = openLock(root), started = performance.now();
  let acquired = false;
  try {
    while (!(acquired = tryAcquire(db))) {
      if (performance.now() - started >= timeoutMs) throw new LongrunBusy();
      await delay(Math.min(retryMs, Math.max(1, timeoutMs - (performance.now() - started))));
    }
    return await operation();
  } finally {
    try { if (acquired) db.exec('ROLLBACK'); }
    finally { try { db.close(); } finally { activeConnections.delete(db); } }
  }
}

/** Synchronous controls fail without changing state when another action owns it. */
export function withLongrunLockSync(root, operation) {
  const db = openLock(root);
  let acquired = false;
  try {
    acquired = tryAcquire(db);
    if (!acquired) throw new LongrunBusy();
    return operation();
  } finally {
    try { if (acquired) db.exec('ROLLBACK'); }
    finally { try { db.close(); } finally { activeConnections.delete(db); } }
  }
}
