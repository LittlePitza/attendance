import { api } from './api';
import { NetworkUnavailableError } from './errors';
import { forgetPunches, pendingPunches } from './queue';
import type { OfflinePunchEvent } from './types';

/**
 * Mirrors the cap in `public.sync_punches`, which refuses a batch of more than
 * 200 events because one that large is a client fault rather than a real day.
 * Chunking here means a long outage drains in several calls instead of being
 * rejected whole.
 */
export const MAX_EVENTS_PER_BATCH = 200;

export interface RejectedPunch {
  readonly event: OfflinePunchEvent;
  readonly reason: string;
}

export interface FlushSummary {
  readonly accepted: number;
  readonly rejected: readonly RejectedPunch[];
  /** True when the connection failed partway and events are still queued. */
  readonly interrupted: boolean;
}

/**
 * Sends everything that is waiting, and empties the queue of everything the
 * server answered for.
 *
 * A refusal removes the event too, and that is deliberate: the database refused
 * it because it was illegal -- a second entry for a day that already has one --
 * and it will refuse it again forever. Keeping it would mean retrying on every
 * reconnection for the rest of the installation's life. It is dropped from the
 * queue and returned here instead, so the screen can tell the employee that
 * this punch did not make it and why.
 *
 * A connection that fails partway stops the run and leaves the rest queued.
 * Nothing is lost: the events that were accepted are gone from the queue, and
 * the ones that were never sent are still in it.
 */
export async function flushPendingPunches(): Promise<FlushSummary> {
  const queued = await pendingPunches();
  if (queued.length === 0) {
    return { accepted: 0, rejected: [], interrupted: false };
  }

  const byKey = new Map(queued.map((event) => [event.idempotency_key, event]));
  const rejected: RejectedPunch[] = [];
  let accepted = 0;

  for (let start = 0; start < queued.length; start += MAX_EVENTS_PER_BATCH) {
    const batch = queued.slice(start, start + MAX_EVENTS_PER_BATCH);

    let result;
    try {
      result = await api.syncPunches(batch);
    } catch (error) {
      if (error instanceof NetworkUnavailableError) {
        return { accepted, rejected, interrupted: true };
      }
      throw error;
    }

    for (const outcome of result.events) {
      if (outcome.accepted) {
        accepted += 1;
        continue;
      }

      const event = byKey.get(outcome.idempotency_key);
      if (event !== undefined) {
        rejected.push({ event, reason: outcome.error ?? 'El servidor rechazo el marcaje' });
      }
    }

    // Every event the server reported on is settled, refused ones included.
    await forgetPunches(result.events.map((outcome) => outcome.idempotency_key));
  }

  return { accepted, rejected, interrupted: false };
}
