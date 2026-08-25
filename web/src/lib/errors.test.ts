import { describe, expect, it } from 'vitest';
import { isTransportFailure } from './errors';

/**
 * This predicate decides whether a punch goes into the offline queue or is
 * shown to the employee as refused. Getting it backwards either loses a
 * legitimate punch or retries an illegal one on every reconnection forever, so
 * both directions are pinned here.
 */
describe('isTransportFailure', () => {
  it('treats anything carrying a SQLSTATE as a decision, not a failure to ask', () => {
    expect(
      isTransportFailure({
        message: 'Ya registraste tu entrada hoy (estado actual: working)',
        code: '22023',
      }),
    ).toBe(false);
  });

  it('does not mistake a refusal for a network problem because of its wording', () => {
    // A message can mention the network and still be a refusal the database made.
    expect(
      isTransportFailure({ message: 'network policy rejected the request', code: '42501' }),
    ).toBe(false);
  });

  it('recognises a request that never arrived', () => {
    // PostgREST leaves the code empty when `fetch` itself failed.
    for (const message of ['TypeError: Failed to fetch', 'Load failed', 'network error']) {
      expect(isTransportFailure({ message, code: '' })).toBe(true);
    }
  });

  it('leaves an unrecognised codeless error as a refusal', () => {
    // Queuing forever is the worse failure, so anything unclear is shown.
    expect(isTransportFailure({ message: 'something unexpected', code: '' })).toBe(false);
  });
});
