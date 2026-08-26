import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { NetworkUnavailableError, RpcError } from '../../lib/errors';
import type { AppSession, MySummary } from '../../lib/types';

/**
 * The two things on the punch screen that are about more than today: the last
 * few weeks of the employee's own record, and the log of where they have signed
 * in from.
 *
 * Both are secondary to the punch. Neither is allowed to keep the screen from
 * rendering or to interrupt somebody who is standing there about to clock in,
 * so a failure here is held quietly and shown in place of the panel it belongs
 * to -- never as a banner across the top, which is reserved for things that
 * affect whether a punch will land.
 *
 * `reloadKey` is bumped by the screen after a punch is accepted. A day that
 * just finished changes the streak and the fortnight beside it, and a panel
 * still showing the figures from before the button was pressed reads as a bug.
 */
export interface MyRecordState {
  readonly summary: MySummary | null;
  readonly sessions: readonly AppSession[];
  readonly summaryError: string | null;
  readonly sessionsError: string | null;
  readonly loading: boolean;
}

/** Thirty days: enough for a month's shape, well inside the 92-day ceiling. */
const SUMMARY_DAYS = 30;

/** Six accesses. Enough to recognise a machine that is not yours. */
const SESSION_COUNT = 6;

export function useMyRecord(reloadKey: number): MyRecordState {
  const [summary, setSummary] = useState<MySummary | null>(null);
  const [sessions, setSessions] = useState<readonly AppSession[]>([]);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    // Settled rather than all: one panel failing must not blank the other.
    const [summaryOutcome, sessionsOutcome] = await Promise.allSettled([
      api.mySummary(SUMMARY_DAYS),
      api.mySessions(SESSION_COUNT),
    ]);

    if (summaryOutcome.status === 'fulfilled') {
      setSummary(summaryOutcome.value);
      setSummaryError(null);
    } else {
      setSummaryError(describe(summaryOutcome.reason));
    }

    if (sessionsOutcome.status === 'fulfilled') {
      setSessions(sessionsOutcome.value);
      setSessionsError(null);
    } else {
      setSessionsError(describe(sessionsOutcome.reason));
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  useEffect(() => {
    // A window left open overnight should not still be showing yesterday's
    // fortnight when somebody comes back to it.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void load();
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  return { summary, sessions, summaryError, sessionsError, loading };
}

/**
 * The sentence a panel shows in its own place.
 *
 * A previously loaded value is kept when a refresh fails, so this is what
 * appears beside stale figures or in an empty panel -- never instead of the
 * screen. Anything unrecognised is logged rather than re-thrown: this runs in a
 * detached promise, where a throw becomes an unhandled rejection nobody reads.
 */
function describe(reason: unknown): string {
  if (reason instanceof NetworkUnavailableError) {
    return 'Sin conexión. Se muestra lo último que se pudo consultar.';
  }
  if (reason instanceof RpcError) {
    return reason.message;
  }

  console.error(reason);
  return 'No se pudo cargar esta sección.';
}
