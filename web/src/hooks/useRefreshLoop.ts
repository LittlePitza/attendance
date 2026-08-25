import { useEffect } from 'react';

/**
 * Re-runs something on a timer, when the tab comes back, and when the
 * connection returns.
 *
 * The board is read by somebody watching a shift start, so it has to be current
 * without being asked. Three triggers rather than one because a timer alone
 * shows the morning to whoever comes back to a tab that sat open all afternoon,
 * and firing on reconnection turns a dropped connection into a gap of seconds
 * instead of a gap of one interval.
 *
 * `active` is what stops it running against a connection that is already known
 * to be down, or on a screen nobody is looking at.
 */
export function useRefreshLoop(refresh: () => void, intervalMs: number, active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }

    const timer = window.setInterval(refresh, intervalMs);

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', refresh);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', refresh);
    };
  }, [refresh, intervalMs, active]);
}
