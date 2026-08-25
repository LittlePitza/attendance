import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { OfflinePunchEvent } from './types';

const DATABASE_NAME = 'attendance';
const DATABASE_VERSION = 1;
const STORE = 'pending_punches';
const BY_OCCURRED_AT = 'by_occurred_at';

interface AttendanceDB extends DBSchema {
  pending_punches: {
    key: string;
    value: OfflinePunchEvent;
    indexes: { by_occurred_at: string };
  };
}

/**
 * Punches taken while the device could not reach the server.
 *
 * IndexedDB and not `localStorage`: this is the only copy of a punch that
 * exists anywhere until it syncs, so it has to survive a reload, a crash and a
 * closed laptop. Losing it loses somebody's working day.
 *
 * The store is keyed by the idempotency key, which is minted when the punch is
 * queued. Queueing the same punch twice is therefore impossible, and a sync
 * that is interrupted halfway can be repeated without creating duplicates --
 * the database recognises the key and returns the original outcome.
 *
 * This module only stores. What to send, in what size batch, and what to do
 * with a refusal is in `sync.ts`.
 */
let connection: Promise<IDBPDatabase<AttendanceDB>> | null = null;

function db(): Promise<IDBPDatabase<AttendanceDB>> {
  connection ??= openDB<AttendanceDB>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database) {
      const store = database.createObjectStore(STORE, { keyPath: 'idempotency_key' });
      store.createIndex(BY_OCCURRED_AT, 'occurred_at');
    },
  });
  return connection;
}

export async function enqueuePunch(event: OfflinePunchEvent): Promise<void> {
  await (await db()).put(STORE, event);
}

/**
 * Oldest first. The database sorts the batch again before replaying it -- it
 * has to, because it cannot trust a client -- but sending them in order keeps
 * the queue readable and the rejections comprehensible when they happen.
 */
export async function pendingPunches(): Promise<OfflinePunchEvent[]> {
  return (await db()).getAllFromIndex(STORE, BY_OCCURRED_AT);
}

export async function countPendingPunches(): Promise<number> {
  return (await db()).count(STORE);
}

export async function forgetPunches(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) {
    return;
  }

  const transaction = (await db()).transaction(STORE, 'readwrite');
  await Promise.all([...keys.map((key) => transaction.store.delete(key)), transaction.done]);
}

/** Used by tests to start from an empty queue. */
export async function clearPendingPunches(): Promise<void> {
  await (await db()).clear(STORE);
}
