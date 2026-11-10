import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

// This database holds only an OS-backed advisory lock, never business data. A
// separate connection per operation also serializes callers in the same process.
// SQLite releases the lock when a holder exits, including an unclean exit.
function openLock(root) {
  const dir = path.join(root, 'working/longrun');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'control-lock.sqlite3'));
  db.exec('PRAGMA busy_timeout = 0');
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
    finally { db.close(); }
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
    finally { db.close(); }
  }
}
