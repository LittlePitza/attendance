import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { describeReadFailure } from '../../lib/errors';
import type { EmployeeDay } from '../../lib/types';

export interface EmployeeDayState {
  readonly day: EmployeeDay | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
}

/**
 * The evidence behind one flagged day.
 *
 * No refresh loop, unlike `useTeamDay`. This is opened deliberately to decide
 * something and closed again; a timer that reloaded it underneath a half-typed
 * reason would be actively unhelpful. It reloads when the reviewer asks and
 * after every decision.
 *
 * `null` for `employeeId` means nothing is selected, which is the resting state
 * of the screen rather than an error.
 */
export function useEmployeeDay(employeeId: string | null, date: string | null): EmployeeDayState {
  const [day, setDay] = useState<EmployeeDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (employeeId === null) {
      setDay(null);
      setError(null);
      return;
    }

    try {
      setDay(await api.employeeDay(employeeId, date ?? undefined));
      setError(null);
    } catch (failure) {
      // Reported, never re-thrown. Same reasoning as the board's hooks: this
      // runs in a detached promise, and an error thrown into one leaves the
      // last answer on screen looking current.
      setError(describeReadFailure(failure));
    } finally {
      setLoading(false);
    }
  }, [employeeId, date]);

  useEffect(() => {
    setLoading(employeeId !== null);
    void refresh();
  }, [refresh, employeeId]);

  return { day, error, loading, refresh };
}
