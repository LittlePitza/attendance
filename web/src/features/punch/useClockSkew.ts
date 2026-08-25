import { useEffect } from 'react';
import { measureClockSkewMs } from '../../lib/clock';

/**
 * Measures how far this device's clock is from the server's, once the
 * connection allows it.
 *
 * The number is only used when a punch has to be queued offline, and it is read
 * back from storage at that moment -- so this runs for its side effect and
 * returns nothing. A measurement that fails leaves the previous one in place,
 * which is a better answer than claiming a drift of zero that was never
 * measured.
 */
export function useClockSkew(online: boolean): void {
  useEffect(() => {
    if (!online) {
      return;
    }
    void measureClockSkewMs().catch(() => undefined);
  }, [online]);
}
