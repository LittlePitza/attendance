import { api } from './api';
import { readLocal, writeLocal } from './storage';

const SKEW_KEY = 'attendance.clock_skew_ms';

/**
 * How far this device's clock is from the server's, in milliseconds, positive
 * when the device is ahead.
 *
 * It is never used to decide when something happened -- the server stamps that.
 * It is sent with an offline punch so the database can judge how much to trust
 * the only timestamp it has: past two minutes of drift the punch is stored
 * flagged for review rather than silently accepted.
 *
 * The last measurement is kept so that a launch which is offline from the
 * first second still has a number to send, instead of claiming a drift of zero
 * it never measured.
 */
export function storedClockSkewMs(): number {
  const raw = readLocal(SKEW_KEY);
  if (raw === null) {
    return 0;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function measureClockSkewMs(): Promise<number> {
  const before = Date.now();
  const server = await api.serverTime();
  const after = Date.now();

  // The server's answer was true at some instant between the request leaving
  // and the reply arriving. The midpoint is the least wrong single guess, and
  // it keeps a slow connection from being reported as a drifting clock.
  const deviceAtServerInstant = (before + after) / 2;
  const skew = Math.round(deviceAtServerInstant - server.epoch_ms);

  writeLocal(SKEW_KEY, String(skew));
  return skew;
}
