import type { CSSProperties, JSX } from 'react';
import type { DayPunch, PunchKind } from '../../../lib/types';
import { IconCoffee, IconPlay, IconStop } from '../../shell/icons';
import { PUNCH_HISTORY_LABELS, formatTimeOfDay } from '../labels';

/**
 * Today's punches, in the order they happened.
 *
 * A timeline rather than a table because the shape of a day is the information:
 * an entry, a gap, a break, a gap, an exit. Four rows of a table say the same
 * words and none of the same thing.
 *
 * Nothing here judges a punch. `needs_review` and the offline tag are both
 * fields the database set -- the engine flags a punch whose device clock was
 * badly out or that arrived half a day late -- and this only shows them. What
 * they turn out to be worth is HR's decision, on the review screen.
 */
export function DayTimeline({
  punches,
  timeZone,
}: {
  readonly punches: readonly DayPunch[];
  readonly timeZone: string;
}): JSX.Element {
  if (punches.length === 0) {
    return <p className="blank">Todavía no has marcado nada hoy.</p>;
  }

  return (
    <ol className="line">
      {punches.map((punch, index) => (
        <li className="line__item" key={punch.id} style={{ '--index': index } as CSSProperties}>
          <span className={`line__mark line__mark--${punch.kind}`}>
            {PUNCH_ICONS[punch.kind]}
          </span>

          <span className="line__time">{formatTimeOfDay(punch.occurred_at, timeZone)}</span>

          <span className="line__what">
            {PUNCH_HISTORY_LABELS[punch.kind]}
            <span className="line__tags">
              {punch.source === 'offline' && <span className="tag">sin conexión</span>}
              {punch.needs_review && (
                // The engine's own words for why it was not trusted, on the
                // element rather than in the row: it is a footnote, and it
                // would push the times out of line if it were spelled out.
                <span className="tag tag--review" title={punch.review_reason ?? undefined}>
                  por revisar
                </span>
              )}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

const PUNCH_ICONS: Readonly<Record<PunchKind, JSX.Element>> = {
  clock_in: <IconPlay />,
  break_start: <IconCoffee />,
  break_end: <IconPlay />,
  clock_out: <IconStop />,
};
