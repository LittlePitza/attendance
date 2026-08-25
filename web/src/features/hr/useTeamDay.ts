import { useCallback, useEffect, useState } from 'react';
import { useRefreshLoop } from '../../hooks/useRefreshLoop';
import { api } from '../../lib/api';
import { describeReadFailure } from '../../lib/errors';
import type { TeamMember } from '../../lib/types';

/** A shift changes on the scale of minutes; a faster poll would tell nobody anything. */
const REFRESH_MS = 60_000;

export interface TeamDayState {
  readonly team: readonly TeamMember[];
  readonly error: string | null;
  readonly loading: boolean;
  readonly loadedAt: Date | null;
  readonly refresh: () => Promise<void>;
}

/**
 * The board for one date.
 *
 * A previously loaded board is kept when a refresh fails, so a dropped
 * connection leaves the last known truth on screen with the staleness visible
 * rather than blanking the room's monitor.
 */
export function useTeamDay(date: string | null, online: boolean): TeamDayState {
  const [team, setTeam] = useState<readonly TeamMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setTeam(await api.teamDay(date ?? undefined));
      setError(null);
      setLoadedAt(new Date());
    } catch (failure) {
      setError(describeReadFailure(failure));
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const tick = useCallback((): void => void refresh(), [refresh]);
  useRefreshLoop(tick, REFRESH_MS, online);

  return { team, error, loading, loadedAt, refresh };
}
