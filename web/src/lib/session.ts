import { deviceId } from './device';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, supabase } from './supabase';
import type { ClosableReason, DeviceDescription } from './types';

/**
 * What this installation reports about itself when it opens a session.
 *
 * All of it is the device's own account of what it is, which makes it evidence
 * rather than proof -- the same standing `punches.client_reported_at` has. The
 * two facts nobody can fake arrive with the request and are read in Postgres:
 * the address it came from and the token it carried.
 *
 * `userAgentData` is Chromium-only and the plain `platform` string is
 * deprecated everywhere, so both are tried and neither is required. A null
 * reaches the database as a null and the row is still a complete record of when
 * somebody signed in and from where.
 */
export function describeDevice(): DeviceDescription {
  return {
    deviceId: deviceId(),
    platform: platformName(),
    timeZone: timeZoneName(),
    locale: navigator.language === '' ? null : navigator.language,
    appVersion: APP_VERSION,
  };
}

/**
 * Stamped at build time by Vite from `package.json`, so a session row says
 * which build of the application wrote it. Worth having the day a bug turns
 * out to affect only the machines that never took an update.
 */
const APP_VERSION = __APP_VERSION__;

interface UserAgentData {
  readonly platform?: string;
}

function platformName(): string | null {
  // `navigator.userAgentData` is the replacement for the deprecated
  // `navigator.platform` and exists only in Chromium. Edge is what these
  // machines run, so it is usually the one that answers.
  const data = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
  const modern = data?.platform;
  if (typeof modern === 'string' && modern !== '') {
    return modern;
  }

  const legacy = (navigator as Navigator & { platform?: string }).platform;
  return typeof legacy === 'string' && legacy !== '' ? legacy : null;
}

function timeZoneName(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone === undefined || zone === '' ? null : zone;
  } catch {
    // A browser with no ICU data reports nothing rather than failing a sign-in.
    return null;
  }
}

/**
 * Closes the session from inside a page that is being torn down.
 *
 * This is the one request in the application that does not go through
 * `supabase-js`, and the reason is narrow: `pagehide` gives no chance to await
 * anything, so the request has to be handed to the browser with `keepalive` and
 * left behind. `sendBeacon` cannot carry an `Authorization` header, and
 * PostgREST will not accept the call without one, so `fetch` is the only tool
 * that fits.
 *
 * It is best effort by construction, and that is accounted for rather than
 * hoped over: `attendance.expire_stale_sessions()` closes anything that never
 * reported a close, stamping the last moment the device was heard from instead
 * of the moment the sweeper happened to run. A lost beacon costs precision in
 * the record, never a row.
 */
export function closeSessionOnUnload(sessionId: string, reason: ClosableReason): void {
  const token = lastKnownAccessToken;
  if (token === null) {
    return;
  }

  try {
    void fetch(`${SUPABASE_URL}/rest/v1/rpc/close_session`, {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ p_session_id: sessionId, p_reason: reason }),
    }).catch(() => undefined);
  } catch {
    // Nothing to do and nowhere to report it: the page is going away.
  }
}

/**
 * The access token, kept current so the unload path has one without awaiting.
 *
 * `supabase.auth.getSession()` is a promise, and there is no promise to await
 * inside `pagehide`. Watching the auth client instead means the token is
 * already in hand at the moment the window closes.
 */
let lastKnownAccessToken: string | null = null;

supabase.auth.onAuthStateChange((_event, session) => {
  lastKnownAccessToken = session?.access_token ?? null;
});

void supabase.auth.getSession().then(({ data }) => {
  lastKnownAccessToken ??= data.session?.access_token ?? null;
});
