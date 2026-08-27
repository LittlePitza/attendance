import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { describeReadFailure } from '../../lib/errors';
import type { AttendanceReport, ReportScope } from '../../lib/types';

export interface ReportState {
  readonly report: AttendanceReport | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refresh: () => void;
}

/**
 * One period, read once.
 *
 * **No refresh loop, unlike the board.** The board is a live view of a day and
 * goes stale by the minute; a report is a period somebody has chosen to look at,
 * and a closed one cannot change at all. Reloading underneath a reader who is
 * comparing two rows would move the rows.
 *
 * The anchor is sent as-is and the bounds come back with the answer, so the
 * screen never computes a period. Asking for the scope alone -- with no anchor
 * -- lets the database pick today in its own zone, which is what makes the first
 * load correct on a browser whose clock is wrong.
 *
 * It reads nothing until the screen is open. A month across everybody is the
 * heaviest query this client makes, and the board mounts whether or not anybody
 * is looking at a report -- so `active` is what stops every visit to the team
 * view paying for one.
 */
export function useReport(
  scope: ReportScope,
  anchor: string | null,
  active: boolean,
): ReportState {
  const [report, setReport] = useState<AttendanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback((): void => setNonce((current) => current + 1), []);

  useEffect(() => {
    if (!active) {
      return;
    }

    let live = true;
    setLoading(true);

    void api
      .attendanceReport(scope, anchor ?? undefined)
      .then((answer) => {
        if (live) {
          setReport(answer);
          setError(null);
        }
      })
      .catch((failure: unknown) => {
        if (live) {
          // The previous period is left on screen rather than cleared: a failed
          // reload is a reason to say so, not a reason to lose what was read.
          setError(describeReadFailure(failure));
        }
      })
      .finally(() => {
        if (live) {
          setLoading(false);
        }
      });

    return () => {
      live = false;
    };
  }, [scope, anchor, nonce, active]);

  return { report, error, loading, refresh };
}
