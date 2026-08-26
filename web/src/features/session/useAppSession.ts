import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { closeSessionOnUnload, describeDevice } from '../../lib/session';
import type { ClosableReason } from '../../lib/types';

/**
 * Five minutes, matching `useHeartbeat`. The sweeper in Postgres closes a
 * session that has been quiet for two hours, so twenty-four missed reports in a
 * row is what it takes to be declared gone -- a threshold no working machine
 * crosses and no closed one survives.
 */
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

export interface AppSessionState {
  readonly sessionId: string | null;
  /** HR revoked this machine. The engine refuses its punches; the screen says so. */
  readonly deviceRevoked: boolean;
  /** Closes the access log entry. Awaited before signing out, so the hour is recorded. */
  readonly end: (reason: ClosableReason) => Promise<void>;
}

/**
 * The application's own record of being open: which machine, from where, from
 * when, until when.
 *
 * It is not the auth session and does not manage one. Supabase decides who is
 * signed in; this decides nothing at all. Every rule about what counts as one
 * session -- whether a reload starts a new one, when a quiet machine is
 * declared gone, what hour a session that never said goodbye ended at -- lives
 * in `public.open_session()` and `attendance.expire_stale_sessions()`. This
 * hook reports, and reports again.
 *
 * Three ways it can end, and all three are accounted for:
 *
 *   sign_out    the person pressed the button. Awaited, so the hour is exact.
 *   app_closed  the window went away. Best effort through `keepalive`.
 *   expired     nothing was heard again. The sweeper closes it at the last
 *               report, which is the last moment anybody knows they were there.
 *
 * A failed report is swallowed rather than surfaced, and deliberately: it fails
 * exactly when the connection is down, which the screen is already saying, and
 * the consequence is a session closed at its last known moment instead of its
 * real one. Interrupting somebody's shift with an error about bookkeeping would
 * be the worse trade.
 */
export function useAppSession(enabled: boolean): AppSessionState {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [deviceRevoked, setDeviceRevoked] = useState(false);

  // The unload handler cannot read state: it runs while the page is being torn
  // down, long after the last render it could have closed over.
  const current = useRef<string | null>(null);

  const open = useCallback(async (): Promise<void> => {
    const result = await api.openSession(describeDevice());
    current.current = result.session_id;
    setSessionId(result.session_id);
    setDeviceRevoked(result.device_revoked);
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    // Opening twice is harmless: the database resumes rather than inserting, so
    // StrictMode's double effect in development produces one session, not two.
    void open().catch(() => undefined);

    const report = (): void => {
      const id = current.current;
      if (id === null) {
        void open().catch(() => undefined);
        return;
      }

      void api
        .touchSession(id)
        .then(async (result) => {
          // The sweeper decided this machine was gone. It was not, so a new
          // session starts here rather than reporting into a closed row.
          if (!result.active && !cancelled) {
            current.current = null;
            await open();
          }
        })
        .catch(() => undefined);
    };

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        report();
      }
    };

    // Best effort, and the only path that can name the real closing hour. A
    // machine that loses power never reaches it, which is what the sweeper is
    // for.
    const onUnload = (): void => {
      const id = current.current;
      if (id !== null) {
        closeSessionOnUnload(id, 'app_closed');
      }
    };

    const timer = window.setInterval(report, KEEPALIVE_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', report);
    window.addEventListener('pagehide', onUnload);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', report);
      window.removeEventListener('pagehide', onUnload);
      // The session is deliberately NOT closed here. This runs on every
      // StrictMode remount in development and on every route change, neither of
      // which is somebody leaving. Closing is `end()`, `pagehide` or the
      // sweeper -- three things that mean it, rather than one that guesses.
    };
  }, [enabled, open]);

  const end = useCallback(async (reason: ClosableReason): Promise<void> => {
    const id = current.current;
    if (id === null) {
      return;
    }

    current.current = null;
    setSessionId(null);

    try {
      await api.closeSession(id, reason);
    } catch {
      // Signing out must not be blocked by the access log. The sweeper closes
      // it at the last report, which is a few minutes early rather than absent.
    }
  }, []);

  return { sessionId, deviceRevoked, end };
}
