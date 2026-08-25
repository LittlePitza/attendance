/**
 * Identifiers the database will read as `uuid`.
 *
 * `crypto.randomUUID` is only present in a secure context, which this
 * application already requires: a service worker will not register over plain
 * HTTP. If it is missing, something is wrong with how the page was served, and
 * failing loudly here is better than minting a key the database will reject.
 */
export function newId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error(
      'crypto.randomUUID is unavailable. Serve the application over HTTPS or localhost.',
    );
  }
  return crypto.randomUUID();
}
