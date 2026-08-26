import { useEffect, useState } from 'react';

/**
 * The current instant, re-read on an interval.
 *
 * It exists so a clock ticks and a counter climbs between server refreshes. It
 * decides nothing: what is being counted, and from when, both come from
 * `my_day()`. This only moves the last digit.
 *
 * `prefers-reduced-motion` is deliberately **not** consulted. A clock whose
 * seconds stop is not a calmer clock, it is a broken one -- the setting asks
 * for less movement in the interface, not for less accurate information.
 *
 * It stops while the tab is hidden and re-reads the moment it comes back, so a
 * window left open all afternoon costs nothing and never shows the morning.
 */
export function useTick(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return;
    }

    let timer = 0;

    const stop = (): void => {
      window.clearInterval(timer);
      timer = 0;
    };

    const start = (): void => {
      if (timer === 0) {
        timer = window.setInterval(() => setNow(Date.now()), intervalMs);
      }
    };

    const onVisibility = (): void => {
      setNow(Date.now());
      if (document.visibilityState === 'visible') {
        start();
      } else {
        stop();
      }
    };

    setNow(Date.now());
    if (document.visibilityState === 'visible') {
      start();
    }
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, active]);

  return now;
}
