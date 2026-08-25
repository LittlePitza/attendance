/**
 * `localStorage` throws rather than returning null when a browser is set to
 * block site data, and a private window can lose it between visits. Neither is
 * a reason for the punch screen to fail to render, so every access goes through
 * here and every failure degrades to "not stored".
 *
 * Nothing that matters is kept here. What lives in this store is a device id
 * and the last measured clock drift: both are conveniences the client can
 * rebuild. The punches themselves are in IndexedDB, and the record is in
 * Postgres.
 */
export function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Losing a device id costs a new one next launch. It is not worth an error.
  }
}
