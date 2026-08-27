import { api } from '../../lib/api';
import type { SessionEventKind } from '../../lib/types';

/**
 * The buffer that makes a lost connection recordable.
 *
 * **An offline event cannot be sent while offline.** That is not an obstacle to
 * work around, it is the shape of the problem, and it is the reason this module
 * exists rather than a `void api.reportSessionEvent(...)` at the call site. The
 * moment the connection dropped is seen only by the device, so it is written
 * down locally and reported on reconnection, carrying the device's own timestamp.
 * The server stamps when it heard, and the two together are what let a reader
 * say "unreachable from 11:20 to 11:45" instead of "quiet for a while".
 *
 * It survives a reload, in `localStorage`. A connection that drops and takes the
 * tab with it is exactly the case worth recording, and an in-memory buffer would
 * lose precisely those. Every read and write is guarded: a private window, a
 * browser with site data blocked, or a quota that is full must not stop the
 * application, and the cost of failing is a gap nobody can explain rather than a
 * screen nobody can use.
 *
 * It is capped. A machine that flaps for an hour must not queue three hundred
 * events to replay on reconnection; past the cap the oldest are dropped and the
 * count of what was lost rides along, so the log says it is incomplete rather
 * than pretending to be whole.
 */

const STORAGE_KEY = 'attendance.connectivity.v1';

/** Enough to describe a bad afternoon; not enough to be a payload. */
const MAX_BUFFERED = 40;

interface BufferedEvent {
  readonly kind: SessionEventKind;
  /** The device's clock, ISO. The only one that saw the moment. */
  readonly at: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

interface Buffer {
  readonly events: readonly BufferedEvent[];
  /** How many were dropped at the cap. Reported so the log admits the hole. */
  readonly dropped: number;
}

const EMPTY: Buffer = { events: [], dropped: 0 };

function read(): Buffer {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return EMPTY;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as Buffer).events)
    ) {
      return EMPTY;
    }
    const buffer = parsed as Buffer;
    return { events: buffer.events, dropped: buffer.dropped ?? 0 };
  } catch {
    // Unreadable or unparseable. Starting empty loses a gap; throwing here would
    // lose the application.
    return EMPTY;
  }
}

function write(buffer: Buffer): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(buffer));
  } catch {
    // Quota, a private window, or site data blocked. Nothing to do about it and
    // nothing worth interrupting somebody's shift over.
  }
}

function clear(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // As above.
  }
}

/** Records one observation for later. Nothing is sent from here. */
export function noteEvent(
  kind: SessionEventKind,
  detail?: Readonly<Record<string, unknown>>,
): void {
  const buffer = read();
  const event: BufferedEvent = {
    kind,
    at: new Date().toISOString(),
    ...(detail === undefined ? {} : { detail }),
  };

  const events = [...buffer.events, event];
  const overflow = Math.max(0, events.length - MAX_BUFFERED);

  write({
    // The oldest go, not the newest: what the reader needs most is how the
    // trouble ended, and the count says how much is missing.
    events: events.slice(overflow),
    dropped: buffer.dropped + overflow,
  });
}

/** How many observations are waiting. Used by the tests and by nothing else. */
export function bufferedCount(): number {
  return read().events.length;
}

/**
 * Sends what was buffered, oldest first, and forgets it.
 *
 * Everything the server answered for is dropped, **including what it refused**.
 * `recorded: false` means the session is gone or this build's vocabulary is
 * ahead of the migration, and neither improves by being retried on every
 * reconnection for the life of the installation -- the same decision the punch
 * queue makes about a refusal. A send that never got an answer keeps its place,
 * because that decided nothing.
 */
export async function drainEvents(sessionId: string): Promise<void> {
  const buffer = read();
  if (buffer.events.length === 0 && buffer.dropped === 0) {
    return;
  }

  // Taken before the first send, so an event observed mid-drain is not dropped
  // along with the ones being reported.
  clear();

  const unsent: BufferedEvent[] = [];

  for (const [index, event] of buffer.events.entries()) {
    const detail: Record<string, unknown> = { ...(event.detail ?? {}) };

    // The hole, declared on the first event that carries it out.
    if (index === 0 && buffer.dropped > 0) {
      detail.dropped_before = buffer.dropped;
    }

    try {
      await api.reportSessionEvent(
        sessionId,
        event.kind,
        event.at,
        Object.keys(detail).length === 0 ? undefined : detail,
      );
    } catch {
      // No answer, so nothing was decided. It waits.
      unsent.push(event);
    }
  }

  if (unsent.length > 0) {
    const now = read();
    write({ events: [...unsent, ...now.events].slice(-MAX_BUFFERED), dropped: now.dropped });
  }
}
