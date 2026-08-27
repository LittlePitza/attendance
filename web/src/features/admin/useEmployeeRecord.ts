import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { describeReadFailure } from '../../lib/errors';
import type { AppSession, EmployeeSummary } from '../../lib/types';

export interface EmployeeRecord {
  readonly summary: EmployeeSummary | null;
  readonly sessions: readonly AppSession[];
  /** The summary failed, so the box has nothing to show. */
  readonly error: string | null;
  /** The access log failed on its own, and is reported in place of the list. */
  readonly sessionsError: string | null;
  readonly loading: boolean;
  readonly refresh: () => void;
}

/**
 * Everything the box shows about one person, in two reads that fail apart.
 *
 * They are deliberately not a `Promise.all`. The summary is what the box is
 * *for*; the access log under it is corroborating evidence, and blanking a
 * person's attendance record because a secondary panel could not load would be
 * the wrong trade -- the same reasoning `useEmployeeSessions` states for the
 * review screen.
 *
 * No refresh loop, for the reason `useAdminData` gives: nothing on this screen
 * changes except when the person reading it changes something, and a timer
 * would reload underneath a half-typed reason. It reloads when asked and after
 * every write.
 *
 * The access log is not narrowed to the range the summary covers. It is
 * `employee_sessions()`'s own default -- the recent ones -- and the heading says
 * so, because a log that claimed to match a 90-day range while showing 30 days
 * of it would be lying quietly.
 */
export function useEmployeeRecord(employeeId: string | null, days: number): EmployeeRecord {
  const [summary, setSummary] = useState<EmployeeSummary | null>(null);
  const [sessions, setSessions] = useState<readonly AppSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback((): void => setNonce((current) => current + 1), []);

  useEffect(() => {
    if (employeeId === null) {
      setSummary(null);
      setSessions([]);
      setError(null);
      setSessionsError(null);
      return;
    }

    let active = true;
    setLoading(true);

    void api
      .employeeSummary(employeeId, days)
      .then((answer) => {
        if (active) {
          setSummary(answer);
          setError(null);
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setSummary(null);
          setError(describeReadFailure(failure));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    void api
      .employeeSessions(employeeId)
      .then((rows) => {
        if (active) {
          setSessions(rows);
          setSessionsError(null);
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setSessions([]);
          setSessionsError(describeReadFailure(failure));
        }
      });

    return () => {
      active = false;
    };
  }, [employeeId, days, nonce]);

  return { summary, sessions, error, sessionsError, loading, refresh };
}
