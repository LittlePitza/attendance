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
 * Drawn by hand in SVG rather than with a charting library: it is one series
 * and about forty lines of geometry, against a dependency that would have to be
 * kept current and audited for the life of the project.
 *
 * The figures are in the accessible label and in a `<title>` per point, so the
 * chart is readable without hovering and without seeing it at all.
 */
const WIDTH = 720;
const HEIGHT = 208;
const PAD = { top: 12, right: 8, bottom: 22, left: 28 };

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
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;

  const x = (index: number): number => PAD.left + (index / (points.length - 1)) * plotWidth;
  const y = (value: number): number => PAD.top + plotHeight - (value / ceiling) * plotHeight;

  const line = points.map((point, index) => `${x(index)},${y(point.arrived)}`).join(' ');
  const area = `${PAD.left},${y(0)} ${line} ${x(points.length - 1)},${y(0)}`;

  // Close enough for the dash animation; it only has to exceed the true length.
  const length = plotWidth + plotHeight;

  const gridValues = [0, Math.round(ceiling / 2), ceiling];
  const last = points.at(-1);

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Llegadas acumuladas: ${String(arrived)} de ${String(total)} personas habían entrado al final del día.`}
      >
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#18181a" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#18181a" stopOpacity="0" />
          </linearGradient>
        </defs>

        {gridValues.map((value) => (
          <g key={value}>
            <line
              className="chart__grid"
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={y(value)}
              y2={y(value)}
              vectorEffect="non-scaling-stroke"
            />
            <text className="chart__tick" x={0} y={y(value) + 3}>
              {value}
            </text>
          </g>
        ))}

        <polygon className="chart__area" points={area} fill={`url(#${fillId})`} />
        {/* The viewBox is stretched to the card's width, which would thin the
          * stroke with it. This keeps the line one weight at any size. */}
        <polyline
          className="chart__line chart__line--draw"
          points={line}
          vectorEffect="non-scaling-stroke"
          style={{ '--len': length } as CSSProperties}
        />

        {last !== undefined && (
          <circle className="chart__dot" cx={x(points.length - 1)} cy={y(last.arrived)} r="3" />
        )}

        {points.map((point, index) => (
          <g key={point.hour}>
            <title>{`${String(point.hour).padStart(2, '0')}:00 — ${String(point.arrived)} de ${String(total)}`}</title>
            {/* Every third hour, so the axis stays legible when the card is narrow. */}
            {point.hour % 3 === 0 && (
              <text className="chart__tick" x={x(index)} y={HEIGHT - 6} textAnchor="middle">
                {String(point.hour).padStart(2, '0')}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
