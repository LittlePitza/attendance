import type { CSSProperties, JSX, ReactNode } from 'react';
import { useCountUp } from '../../../hooks/useCountUp';

/**
 * One figure from the employee's own record.
 *
 * The number counts from wherever it was to wherever it now is, which matters
 * more here than it looks: this panel refreshes itself after every punch, and a
 * figure that changed silently looks exactly like one that did not. Animating
 * from the previous value is what makes a finished day visibly add to the
 * streak.
 *
 * `format` is taken rather than a formatted string, so the count-up can run on
 * the underlying number and be rendered as hours, or a percentage, or days, at
 * every frame. Passing `7:30` in would leave nothing to count.
 *
 * `--index` feeds the entrance stagger in CSS, so the row assembles left to
 * right instead of appearing all at once.
 */
export function StatTile({
  label,
  value,
  format,
  caption,
  icon,
  index,
  tone = 'plain',
}: {
  readonly label: string;
  readonly value: number;
  readonly format: (value: number) => string;
  readonly caption: string;
  readonly icon: ReactNode;
  readonly index: number;
  readonly tone?: 'plain' | 'good' | 'warn';
}): JSX.Element {
  const shown = useCountUp(value);

  return (
    <div className={`tile tile--${tone}`} style={{ '--index': index } as CSSProperties}>
      <span className="tile__icon">{icon}</span>
      <span className="tile__label">{label}</span>
      <span className="tile__value">{format(shown)}</span>
      <span className="tile__caption">{caption}</span>
    </div>
  );
}
