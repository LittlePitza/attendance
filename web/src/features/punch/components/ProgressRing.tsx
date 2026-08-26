import type { JSX, ReactNode } from 'react';

/** Radius in the ring's own coordinates. The stroke sits inside a 120 box. */
const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The day, drawn as a ring around the counter.
 *
 * A ring rather than a bar because the number lives in the middle of it: the
 * figure and its context are one object the eye takes in at once, which is what
 * somebody glancing at a phone for two seconds actually gets.
 *
 * `progress` arrives uncapped and is clamped here for the drawing only, so a
 * ten-hour day fills the ring exactly once instead of wrapping round to look
 * like a short one. That the day went over is said in words beside it, where a
 * number can be exact.
 *
 * The viewBox is square and `preserveAspectRatio` is left at its default, so
 * nothing here is stretched -- the lesson the board's chart had to learn about
 * text in a stretched viewport does not apply, and the label can safely sit
 * inside as HTML anyway.
 */
export function ProgressRing({
  progress,
  tone,
  label,
  children,
}: {
  /** Null on a day with no schedule: the ring becomes a plain frame. */
  readonly progress: number | null;
  readonly tone: 'run' | 'rest' | 'done' | 'idle';
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  const filled = progress === null ? 0 : Math.min(1, Math.max(0, progress));

  return (
    <div className={`ring ring--${tone}`}>
      <svg viewBox="0 0 120 120" role="img" aria-label={label}>
        <circle className="ring__track" cx="60" cy="60" r={RADIUS} />
        {progress !== null && (
          <circle
            className="ring__fill"
            cx="60"
            cy="60"
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            // Drawn from the top: the SVG default starts at three o'clock, and
            // a day that starts on the right-hand side reads as a gauge nobody
            // asked for.
            strokeDashoffset={CIRCUMFERENCE * (1 - filled)}
            transform="rotate(-90 60 60)"
          />
        )}
      </svg>

      <div className="ring__inner">{children}</div>
    </div>
  );
}
