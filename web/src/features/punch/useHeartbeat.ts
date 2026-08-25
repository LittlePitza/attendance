import { useEffect } from 'react';
import { api } from '../../lib/api';

/**
 * Five minutes, matching what `attendance.evaluate_alerts` expects when it
 * decides whether a workday has gone quiet. Sending more often would tell the
 * evaluator nothing it does not already know.
 */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Signals that this workday is still being worked.
 *
 * Only while the workday is open: a heartbeat from somebody who has not clocked
 * in means nothing, and the database refuses to create a workday from one.
 *
 * A failed beat is discarded rather than reported. It fails exactly when the
 * connection is down, which the screen is already showing, and the consequence
 * of missing beats is the point -- that silence is what raises the alert.
 */
export function useHeartbeat(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }

    const beat = (): void => {
      void api.heartbeat().catch(() => undefined);
    };

    beat();
    const timer = window.setInterval(beat, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active]);
}
