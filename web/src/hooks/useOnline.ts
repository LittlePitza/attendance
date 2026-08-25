import { useEffect, useState } from 'react';

/**
 * Whether the browser believes it can reach the network.
 *
 * `navigator.onLine` is a hint, not a guarantee -- a captive portal reports
 * online and answers nothing. It is used to avoid waiting for a timeout that is
 * already known to fail, never to decide that a punch succeeded. What actually
 * settles a punch is the reply from the database.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    // The state can have changed between the first render and this effect.
    setOnline(navigator.onLine);

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
