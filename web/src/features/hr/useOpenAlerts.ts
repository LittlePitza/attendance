import { useCallback, useEffect, useState } from 'react';
import { useRefreshLoop } from '../../hooks/useRefreshLoop';
import { api } from '../../lib/api';
import { describeReadFailure } from '../../lib/errors';
import type { OpenAlert } from '../../lib/types';

/**
 * The evaluator runs every five minutes, so asking more often than that cannot
 * surface anything new. Offset from the board's own minute so the two are not
 * always in flight together.
 */
const REFRESH_MS = 5 * 60_000;

export interface OpenAlertsState {
  readonly alerts: readonly OpenAlert[];
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
}

/**
 * Open alerts, newest and most severe first -- the order the database already
 * put them in, which is not re-sorted here.
 *
 * Nothing on this screen closes one. An alert is a record of what happened, and
 * deciding it was acceptable is HR's judgement made somewhere that writes it
 * down, not a button that makes a row disappear from a dashboard.
 */
export function useOpenAlerts(since: string | null, online: boolean): OpenAlertsState {
  const [alerts, setAlerts] = useState<readonly OpenAlert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setAlerts(await api.openAlerts(since ?? undefined));
      setError(null);
    } catch (failure) {
      setError(describeReadFailure(failure));
    } finally {
      setLoading(false);
    }
  }, [since]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const tick = useCallback((): void => void refresh(), [refresh]);
  useRefreshLoop(tick, REFRESH_MS, online);

  return { alerts, error, loading, refresh };
}
