import { useCallback, useEffect, useRef, useState } from 'react';
import { countPendingPunches } from '../../lib/queue';
import { flushPendingPunches, type RejectedPunch } from '../../lib/sync';

export interface PunchQueueState {
  readonly pending: number;
  readonly rejected: readonly RejectedPunch[];
  readonly dismissRejected: () => void;
  readonly recount: () => Promise<void>;
}

/**
 * The queue as the screen needs to see it: how much is waiting, and what came
 * back refused once it was finally sent.
 *
 * Draining is triggered by coming back online rather than by a timer. A punch
 * taken offline is the employee's word for something that already happened, so
 * there is nothing to gain by delaying it, and a timer would keep firing
 * against a connection that is still down.
 *
 * Refusals are surfaced and held until dismissed. They are rare and they matter
 * -- a punch that did not make it is a gap in somebody's day -- so they must not
 * scroll past in a toast that disappears while the laptop is closed.
 */
export function usePunchQueue(online: boolean, onDrained: () => void): PunchQueueState {
  const [pending, setPending] = useState(0);
  const [rejected, setRejected] = useState<readonly RejectedPunch[]>([]);
  const draining = useRef(false);

  const recount = useCallback(async (): Promise<void> => {
    setPending(await countPendingPunches());
  }, []);

  useEffect(() => {
    void recount();
  }, [recount]);

  useEffect(() => {
    if (!online || draining.current) {
      return;
    }

    let cancelled = false;
    draining.current = true;

    void (async () => {
      try {
        const summary = await flushPendingPunches();
        if (cancelled) {
          return;
        }

        if (summary.rejected.length > 0) {
          setRejected((current) => [...current, ...summary.rejected]);
        }
        if (summary.accepted > 0) {
          onDrained();
        }
      } finally {
        draining.current = false;
        if (!cancelled) {
          await recount();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [online, onDrained, recount]);

  const dismissRejected = useCallback((): void => setRejected([]), []);

  return { pending, rejected, dismissRejected, recount };
}
