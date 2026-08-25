import type { JSX } from 'react';
import type { WorkdayState } from '../../../lib/types';
import { STATE_LABELS } from '../labels';
import { STATE_ORDER, type StateCounts } from '../summary';

const TONES: Readonly<Record<WorkdayState, string>> = {
  working: 'working',
  on_break: 'break',
  not_started: 'pending',
  finished: 'done',
};

/**
 * The whole day in one line: how the team is split across the four states.
 *
 * The segments carry a percentage in text as well as a width, because a bar
 * that only encodes its value as a length is unreadable to anyone who cannot
 * compare lengths -- and a 2% segment is unreadable to everyone.
 *
 * Widths are a CSS transition rather than a re-render, so a refresh that moves
 * one person from `working` to `on_break` slides instead of jumping.
 */
export function StateBar({ counts, total }: { counts: StateCounts; total: number }): JSX.Element {
  return (
    <div className="statebar">
      <div
        className="statebar__track"
        role="img"
        aria-label={STATE_ORDER.map((state) => `${STATE_LABELS[state]}: ${counts[state]}`).join(
          ', ',
        )}
      >
        {STATE_ORDER.map((state) => (
          <span
            key={state}
            className={`statebar__segment statebar__segment--${TONES[state]}`}
            style={{ width: `${total === 0 ? 0 : (counts[state] / total) * 100}%` }}
          />
        ))}
      </div>

      <ul className="statebar__legend">
        {STATE_ORDER.map((state) => (
          <li key={state} className="statebar__item">
            <span className={`dot dot--${TONES[state]}`} />
            <span className="statebar__name">{STATE_LABELS[state]}</span>
            <span className="statebar__count">{counts[state]}</span>
            <span className="statebar__pct">
              {total === 0 ? '0%' : `${Math.round((counts[state] / total) * 100)}%`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
