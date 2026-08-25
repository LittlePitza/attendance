import { useId, type CSSProperties, type JSX } from 'react';
import type { ArrivalPoint } from '../summary';

/**
 * How the day filled up: people who had arrived, hour by hour.
 *
 * A line and not bars, because a running total genuinely holds its value
 * between one hour and the next -- joining the points describes something real.
 * (Bars would be right for arrivals *within* each hour, which is the series
 * this is derived from.) The curve only ever climbs, so its shape is the shape
 * of the morning: steep where everyone arrived together, flat afterwards.
 *
 * **Only the plot is SVG.** The card is far wider than it is tall, so the
 * drawing is stretched to fill it -- and anything inside a stretched viewport
 * stretches with it. A stroke can opt out of that with `non-scaling-stroke`;
 * text cannot, which is why axis labels drawn in SVG came out twice as wide as
 * they should be and visibly soft. The labels, the grid and the end point are
 * therefore HTML, positioned as percentages against the same scale the line
 * uses, so they land exactly on it and stay crisp at any width.
 *
 * Drawn by hand rather than with a charting library: it is one series and about
 * fifty lines of geometry, against a dependency to keep current and audit for
 * the life of the project.
 */
export function ArrivalsChart({
  points,
  total,
}: {
  readonly points: readonly ArrivalPoint[];
  readonly total: number;
}): JSX.Element {
  const fillId = useId();
  const arrived = points.at(-1)?.arrived ?? 0;

  if (points.length < 2 || arrived === 0) {
    return <p className="empty">Nadie ha registrado entrada todavía.</p>;
  }

  // The axis is the size of the team, not the size of the series: a morning
  // where four of eighteen arrived should look like four of eighteen.
  const ceiling = Math.max(total, arrived, 1);

  // Both axes run 0..100, so the SVG stretches to whatever the card is and
  // every HTML label can be placed by the same percentages.
  const x = (index: number): number => (index / (points.length - 1)) * 100;
  const y = (value: number): number => 100 - (value / ceiling) * 100;

  const line = points.map((point, index) => `${String(x(index))},${String(y(point.arrived))}`);
  const area = ['0,100', ...line, '100,100'].join(' ');

  const ticks = [ceiling, Math.round(ceiling / 2), 0];

  return (
    <figure className="chart">
      <div className="chart__scale" aria-hidden="true">
        {ticks.map((value) => (
          <span
            className="chart__tick"
            key={value}
            style={{ '--at': `${String(y(value))}%` } as CSSProperties}
          >
            {value}
          </span>
        ))}
      </div>

      <div className="chart__plot">
        {ticks.map((value) => (
          <span
            className="chart__rule"
            key={value}
            style={{ '--at': `${String(y(value))}%` } as CSSProperties}
            aria-hidden="true"
          />
        ))}

        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Llegadas acumuladas: ${String(arrived)} de ${String(total)} personas habían entrado.`}
        >
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#18181a" stopOpacity="0.13" />
              <stop offset="100%" stopColor="#18181a" stopOpacity="0" />
            </linearGradient>
          </defs>

          <polygon className="chart__area" points={area} fill={`url(#${fillId})`} />
          <polyline
            className="chart__line"
            points={line.join(' ')}
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* HTML, because a circle in a stretched viewport is an ellipse. */}
        <span
          className="chart__dot"
          style={{ '--at': `${String(y(arrived))}%` } as CSSProperties}
          aria-hidden="true"
        />
      </div>

      <div className="chart__hours" aria-hidden="true">
        {points.map((point, index) =>
          // Every third hour, so the axis stays legible when the card is narrow.
          point.hour % 3 === 0 ? (
            <span
              className="chart__tick"
              key={point.hour}
              style={{ '--at': `${String(x(index))}%` } as CSSProperties}
            >
              {String(point.hour).padStart(2, '0')}
            </span>
          ) : null,
        )}
      </div>

      <figcaption className="sr-only">
        {points
          .filter((point) => point.hour % 3 === 0)
          .map((point) => `${String(point.hour)}:00, ${String(point.arrived)}`)
          .join('; ')}
      </figcaption>
    </figure>
  );
}
