import type { CSSProperties, JSX } from 'react';
import type { SummaryDay } from '../../../lib/types';
import { formatClock, formatShortDate } from '../labels';
import { chartCeiling } from '../live';

/**
 * A fortnight of days, as bars.
 *
 * Bars and not a line, and that is the same distinction the board's chart makes
 * in the other direction: hours worked on Tuesday and hours worked on Wednesday
 * are two separate quantities, and a line drawn between them would slope
 * through values that never existed. A running total would deserve a line; this
 * does not.
 *
 * **HTML rather than SVG**, and deliberately. The board learned that anything
 * inside a stretched viewport stretches with it -- a stroke can opt out, text
 * cannot -- and it had to move its labels out to HTML to keep them crisp. This
 * chart is nothing but rectangles and labels, so there is no drawing left worth
 * an SVG: percentage heights against a shared scale do the whole job, animate
 * on the compositor, and stay sharp at any width.
 *
 * Both series share one ceiling. Scaling each bar to itself would make every
 * day the same height, which is the one thing this chart exists not to do.
 */
export function FortnightChart({
  days,
  timeZone,
}: {
  readonly days: readonly SummaryDay[];
  readonly timeZone: string;
}): JSX.Element {
  if (days.length === 0) {
    return <p className="blank">Todavía no hay días que mostrar.</p>;
  }

  const ceiling = chartCeiling(days);
  const height = (seconds: number): string => `${String((seconds / ceiling) * 100)}%`;

  return (
    <figure className="bars">
      <ol className="bars__row">
        {days.map((day, index) => (
          <li
            className={`bars__day${day.scheduled ? '' : ' bars__day--off'}`}
            key={day.date}
            style={{ '--index': index } as CSSProperties}
          >
            <span className="bars__track">
              {/* Where the schedule expected the bar to reach. Drawn even on a
                  day with no hours, so an absence is visible as a gap under a
                  target rather than as nothing at all. */}
              {day.expected_seconds > 0 && (
                <span
                  className="bars__target"
                  style={{ '--at': height(day.expected_seconds) } as CSSProperties}
                  aria-hidden="true"
                />
              )}
              <span
                className={`bars__fill${day.late ? ' bars__fill--late' : ''}`}
                style={{ '--h': height(day.worked_seconds) } as CSSProperties}
                aria-hidden="true"
              />
            </span>
            <span className="bars__label">{formatShortDate(day.date)}</span>
          </li>
        ))}
      </ol>

      <p className="bars__key">
        <span className="key key--fill">Trabajado</span>
        <span className="key key--target">Esperado</span>
        <span className="key key--late">Entrada tarde</span>
      </p>

      {/* The same series in words, since none of the above is readable aloud.
          The zone is named once rather than on every day: it is the same zone
          for all of them, and repeating it fourteen times is unbearable. */}
      <figcaption className="sr-only">
        Horas trabajadas por día, hora de {timeZone}:{' '}
        {days
          .map(
            (day) =>
              `${formatShortDate(day.date)}, ${formatClock(day.worked_seconds)}${
                day.late ? ', entrada tarde' : ''
              }`,
          )
          .join('; ')}
        .
      </figcaption>
    </figure>
  );
}
