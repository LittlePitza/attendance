import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { describeReadFailure } from '../../lib/errors';
import type { AppSession } from '../../lib/types';

export interface EmployeeSessionsState {
  readonly sessions: readonly AppSession[];
  readonly error: string | null;
  readonly loading: boolean;
}

/**
 * Where the person was signed in from on the day being reviewed.
 *
 * It is evidence beside the punches, not a verdict about them, and it is
 * genuinely the thing a reviewer reaches for: a punch flagged because the
 * device clock was minutes out reads very differently once you can see the
 * machine it came from was open all afternoon.
 *
 * Scope is not decided here. `employee_sessions()` is `SECURITY INVOKER` and
 * the policy on `attendance.app_sessions` is `can_view_employee()`, so a
 * manager gets their department and HR gets everyone -- and somebody outside
 * that scope gets an empty list from the database rather than a check written
 * in this file.
 *
 * A failure is held and shown in place of the list. This sits under the punches
 * a decision is being made about, and blanking that screen because a secondary
 * panel could not load would be the wrong trade.
 */
export function useEmployeeSessions(
  employeeId: string | null,
  date: string | null,
): EmployeeSessionsState {
  const [sessions, setSessions] = useState<readonly AppSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (employeeId === null || date === null) {
      setSessions([]);
      setError(null);
      return;
    }

    let active = true;
    setLoading(true);

    // One day, both ends. The reviewer is looking at one date, and a month of
    // accesses under it would bury the one that matters.
    void api
      .employeeSessions(employeeId, date, date)
      .then((rows) => {
        if (active) {
          setSessions(rows);
          setError(null);
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setSessions([]);
          setError(describeReadFailure(failure));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [employeeId, date]);

  return { sessions, error, loading };
}
