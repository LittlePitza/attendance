import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { closeSessionOnUnload, describeDevice } from '../../lib/session';
import type { ClosableReason } from '../../lib/types';
import { drainEvents, noteEvent } from './connectivity';

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
 *
 * **What it also records now is the middle.** The three endings above said when a
 * session stopped; none of them could say why the application was unreachable
 * for twenty minutes while it stayed open, and `last_seen_at` going stale and
 * coming back leaves a row that looks exactly like one never interrupted. The
 * connectivity observations close that, and the reason they go through a buffer
 * rather than straight out is that the one worth having -- the connection
 * dropping -- is the one that cannot be sent when it happens.
 *
 * It records observations, never intent. A person who closed the window, one
 * whose laptop lost power and one who pulled the cable on purpose all arrive as
 * the same silence, and nothing here pretends to tell them apart. What the log
 * gives is what surrounded it.
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

    // A connection that dropped and took the tab with it left its observation in
    // storage, where it has been waiting for a session to report into. This is
    // that session -- which is why the buffer outlives the page.
    void drainEvents(result.session_id).catch(() => undefined);
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
        // A backgrounded tab is throttled by the browser, so a gap in reports
        // that follows one of these is explained rather than suspicious. That is
        // the whole value of recording it.
        noteEvent('foregrounded');
        report();
      } else {
        noteEvent('backgrounded');
      }
    };

    // Written down, not sent: there is no connection to send it on. The moment
    // is the device's to remember, and `drain` carries it out on the way back.
    const onOffline = (): void => noteEvent('connection_lost');

    const onOnline = (): void => {
      noteEvent('connection_back');
      report();

      const id = current.current;
      if (id !== null) {
        void drainEvents(id).catch(() => undefined);
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
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', onUnload);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
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
