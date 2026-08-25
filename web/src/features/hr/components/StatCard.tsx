import type { CSSProperties, JSX, ReactNode } from 'react';
import { useCountUp } from '../../../hooks/useCountUp';

export type PillTone = 'good' | 'warn' | 'bad' | 'info' | 'mute';

interface StatCardProps {
  readonly label: string;
  readonly value: number;
  readonly caption: string;
  readonly icon: ReactNode;
  readonly index: number;
  /** The share or count beside the figure. Always a fact, never a trend. */
  readonly pill?: { readonly text: string; readonly tone: PillTone };
  readonly selected?: boolean;
  readonly onSelect?: () => void;
}

/**
 * One figure, large enough to read from across a room.
 *
 * The whole card is the control when it filters the board, rather than a small
 * button inside it: the number and its label are what somebody is aiming at,
 * and a 44px target tucked into the corner of a large card is a target that
 * gets missed. When it filters nothing it renders as plain markup, never as a
 * button that does nothing.
 *
 * The pill carries a share of the team or a count of the severe ones -- both
 * facts about right now. It deliberately never shows a trend against
 * yesterday: `team_day()` answers for one date, and a figure comparing a
 * half-finished day against a whole one would be a comparison nobody asked for
 * and nobody could trust.
 *
 * `--index` feeds the entrance stagger in CSS, so the row assembles left to
 * right instead of appearing all at once.
 */
export function StatCard({
  label,
  value,
  caption,
  icon,
  index,
  pill,
  selected = false,
  onSelect,
}: StatCardProps): JSX.Element {
  const shown = useCountUp(value);

  const content = (
    <>
      <span className="stat__icon">{icon}</span>
      <span className="stat__label">{label}</span>
      <span className="stat__figure">
        <span className="stat__value">{shown}</span>
        {pill !== undefined && <span className={`pill pill--${pill.tone}`}>{pill.text}</span>}
      </span>
      <span className="stat__caption">{caption}</span>
    </>
  );

  const className = `stat${selected ? ' stat--on' : ''}`;
  const style = { '--index': index } as CSSProperties;

  if (onSelect === undefined) {
    return (
      <div className={className} style={style}>
        {content}
      </div>
    );
  }

  return (
    <button type="button" className={className} style={style} onClick={onSelect} aria-pressed={selected}>
      {content}
    </button>
  );
}
