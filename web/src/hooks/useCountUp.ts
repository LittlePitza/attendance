import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * Counts from wherever the number was to wherever it now is.
 *
 * The movement is the point: on a board that refreshes itself, a figure that
 * changed silently looks exactly like one that did not, and the person watching
 * has no reason to look twice. Animating from the *previous* value rather than
 * from zero is what makes it read as a change instead of a fresh render.
 *
 * It settles on the exact target rather than the last interpolated frame, so a
 * count is never displayed one short.
 */
export function useCountUp(target: number, durationMs = 550): number {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(target);
  const from = useRef(target);

  useEffect(() => {
    if (reduced || from.current === target) {
      from.current = target;
      setShown(target);
      return;
    }

    const start = performance.now();
    const origin = from.current;
    let frame = 0;

    const step = (now: number): void => {
      const progress = Math.min(1, (now - start) / durationMs);
      // Ease-out cubic: fast enough to feel immediate, slow enough at the end
      // that the eye lands on the final figure.
      const eased = 1 - (1 - progress) ** 3;

      if (progress >= 1) {
        from.current = target;
        setShown(target);
        return;
      }

      setShown(Math.round(origin + (target - origin) * eased));
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, reduced]);

  return shown;
}
