import type { CSSProperties, JSX } from 'react';
import type { HourBucket } from '../summary';

/**
 * When the day started, hour by hour.
 *
 * Deliberately not a line chart: these are counts in discrete hours, and a line
 * between them would draw a slope that does not exist. The bars grow from the
 * baseline on mount, staggered, so the shape of the morning arrives rather than
 * appearing.
 *
 * Every bar carries its figures in a `title` and in the accessible label, so
 * the chart is readable without hovering and without seeing it at all.
 */
export function EntryHistogram({ buckets }: { buckets: readonly HourBucket[] }): JSX.Element {
  const peak = buckets.reduce((highest, bucket) => Math.max(highest, bucket.count), 0);
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);

  if (total === 0) {
    return <p className="muted">Nadie ha registrado entrada todavía.</p>;
  }

  return (
    <div className="histogram" role="img" aria-label={describe(buckets, total)}>
      {buckets.map((bucket, index) => (
        <div className="histogram__column" key={bucket.hour}>
          <div
            className={`histogram__bar${bucket.count === 0 ? ' histogram__bar--empty' : ''}`}
            style={
              {
                '--height': `${peak === 0 ? 0 : (bucket.count / peak) * 100}%`,
                '--index': index,
              } as CSSProperties
            }
            title={`${String(bucket.hour).padStart(2, '0')}:00 — ${String(bucket.count)}`}
          >
            {bucket.count > 0 && <span className="histogram__count">{bucket.count}</span>}
          </div>
          {/* Every third hour, so the axis stays readable at narrow widths. */}
          <span className="histogram__hour">
            {bucket.hour % 3 === 0 ? String(bucket.hour).padStart(2, '0') : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function describe(buckets: readonly HourBucket[], total: number): string {
  const busiest = buckets.reduce((best, bucket) => (bucket.count > best.count ? bucket : best));
  return (
    `Entradas por hora. ${total} en total, ` +
    `la mayoría a las ${String(busiest.hour).padStart(2, '0')}:00.`
  );
}
