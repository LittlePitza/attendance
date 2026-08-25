import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the reader has asked for less movement.
 *
 * Read once and then watched, because it can change while the page is open --
 * somebody turning it on mid-shift is exactly the person who needs it to take
 * effect without a reload. Every animation on the board is either driven by
 * this or by the same query in CSS.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);

    media.addEventListener('change', onChange);
    setReduced(media.matches);

    return () => media.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
