import { newId } from './ids';
import { readLocal, writeLocal } from './storage';

const DEVICE_ID_KEY = 'attendance.device_id';

/**
 * A stable identifier for this installation.
 *
 * It exists so HR can revoke a lost laptop without closing the account: the
 * engine refuses a punch from a device that was revoked. It identifies the
 * install, never the person -- the person always comes from the token.
 *
 * Losing it is harmless. A cleared browser simply becomes a new device, which
 * is exactly what it is.
 */
export function deviceId(): string {
  const stored = readLocal(DEVICE_ID_KEY);
  if (stored !== null && stored !== '') {
    return stored;
  }

  const created = newId();
  writeLocal(DEVICE_ID_KEY, created);
  return created;
}
